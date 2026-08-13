import { INestApplication } from '@nestjs/common';
import { access, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

type Meeting = { id: string };
type UserSession = { accessToken: string };
type UploadedFile = { id: string };

const validPassword = 'secure-password-123';
const validDate = '2026-08-03T10:00:00.000Z';
const uploadRoot = join(tmpdir(), 'video-meetings-api-e2e-uploads');

function createUniqueValue(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createEmail(prefix: string) {
  return `${createUniqueValue(prefix)}@example.com`;
}

describe('Meeting files (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    await rm(uploadRoot, { recursive: true, force: true });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
    await rm(uploadRoot, { recursive: true, force: true });
  });

  async function registerUser(): Promise<UserSession> {
    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: createEmail('file-user'), password: validPassword })
      .expect(201);

    return response.body as UserSession;
  }

  async function createMeeting(accessToken: string): Promise<Meeting> {
    const response = await request(app.getHttpServer())
      .post('/meetings')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ title: createUniqueValue('File meeting'), date: validDate })
      .expect(201);

    return response.body as Meeting;
  }

  function getUserId(accessToken: string): string {
    const payload = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString()) as {
      sub: string;
    };

    return payload.sub;
  }

  async function addParticipant(meetingId: string, participant: UserSession): Promise<void> {
    await prisma.meetingParticipant.create({
      data: { meetingId, userId: getUserId(participant.accessToken) },
    });
  }

  async function uploadPdf(meetingId: string, owner: UserSession): Promise<UploadedFile> {
    const response = await request(app.getHttpServer())
      .post(`/meetings/${meetingId}/files`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .attach('file', Buffer.from('%PDF-1.7\nphase-2'), {
        filename: 'phase-2-notes.pdf',
        contentType: 'application/pdf',
      })
      .expect(201);

    return response.body as UploadedFile;
  }

  it('stores an allowed file and returns its metadata in the meeting list', async () => {
    const owner = await registerUser();
    const meeting = await createMeeting(owner.accessToken);

    const uploaded = await request(app.getHttpServer())
      .post(`/meetings/${meeting.id}/files`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .attach('file', Buffer.from('%PDF-1.7\n'), {
        filename: 'meeting-notes.pdf',
        contentType: 'application/pdf',
      })
      .expect(201);

    expect(uploaded.body).toMatchObject({
      name: 'meeting-notes.pdf',
      category: 'document',
      mimeType: 'application/pdf',
      sizeBytes: 9,
    });
    expect(uploaded.body).toHaveProperty('id');
    expect(uploaded.body).toHaveProperty('uploadedAt');
    expect(uploaded.body).not.toHaveProperty('storageKey');

    const listed = await request(app.getHttpServer())
      .get(`/meetings/${meeting.id}/files`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);

    expect(listed.body).toEqual([expect.objectContaining(uploaded.body)]);
  });

  it('preserves a UTF-8 filename through upload, listing, and download', async () => {
    const owner = await registerUser();
    const meeting = await createMeeting(owner.accessToken);
    const filename = 'отчёт встречи.pdf';

    const uploaded = await request(app.getHttpServer())
      .post(`/meetings/${meeting.id}/files`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .attach('file', Buffer.from('%PDF-1.7\n'), {
        filename,
        contentType: 'application/pdf',
      })
      .expect(201);

    expect(uploaded.body).toMatchObject({ name: filename });

    const ticket = await request(app.getHttpServer())
      .post(`/meetings/${meeting.id}/files/${uploaded.body.id}/download-ticket`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(201);

    const downloaded = await request(app.getHttpServer())
      .get(`/file-downloads/${ticket.body.ticket}`)
      .expect(200);

    expect(downloaded.headers['content-disposition']).toContain(
      `filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
  });

  it('allows a meeting participant to upload and list files', async () => {
    const owner = await registerUser();
    const participant = await registerUser();
    const meeting = await createMeeting(owner.accessToken);
    await addParticipant(meeting.id, participant);

    await request(app.getHttpServer())
      .post(`/meetings/${meeting.id}/files`)
      .set('Authorization', `Bearer ${participant.accessToken}`)
      .attach('file', Buffer.from('ID3\x04'), {
        filename: 'recording.mp3',
        contentType: 'audio/mpeg',
      })
      .expect(201);

    const listed = await request(app.getHttpServer())
      .get(`/meetings/${meeting.id}/files`)
      .set('Authorization', `Bearer ${participant.accessToken}`)
      .expect(200);

    expect(listed.body).toHaveLength(1);
  });

  it('rejects a disallowed file type without retaining metadata', async () => {
    const owner = await registerUser();
    const meeting = await createMeeting(owner.accessToken);

    const response = await request(app.getHttpServer())
      .post(`/meetings/${meeting.id}/files`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .attach('file', Buffer.from('MZ'), {
        filename: 'malware.exe',
        contentType: 'application/octet-stream',
      })
      .expect(415);

    expect(response.body).toMatchObject({ code: 'UNSUPPORTED_FILE_TYPE' });

    await request(app.getHttpServer())
      .get(`/meetings/${meeting.id}/files`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200, []);
  });

  it('rejects a file whose PDF name and MIME type do not match its content', async () => {
    const owner = await registerUser();
    const meeting = await createMeeting(owner.accessToken);

    const response = await request(app.getHttpServer())
      .post(`/meetings/${meeting.id}/files`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .attach('file', Buffer.from('MZ'), {
        filename: 'disguised.pdf',
        contentType: 'application/pdf',
      })
      .expect(415);

    expect(response.body).toMatchObject({ code: 'UNSUPPORTED_FILE_TYPE' });
    expect(await readdir(join(uploadRoot, 'temp'))).toEqual([]);
  });

  it('rejects a file larger than the configured maximum', async () => {
    const owner = await registerUser();
    const meeting = await createMeeting(owner.accessToken);

    const response = await request(app.getHttpServer())
      .post(`/meetings/${meeting.id}/files`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .attach('file', Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(56)]), {
        filename: 'too-large.pdf',
        contentType: 'application/pdf',
      })
      .expect(413);

    expect(response.body).toMatchObject({ code: 'UPLOAD_TOO_LARGE' });
  });

  it('accepts a file exactly at the configured maximum', async () => {
    const owner = await registerUser();
    const meeting = await createMeeting(owner.accessToken);
    const exactLimitPdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(55)]);

    await request(app.getHttpServer())
      .post(`/meetings/${meeting.id}/files`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .attach('file', exactLimitPdf, {
        filename: 'exact-limit.pdf',
        contentType: 'application/pdf',
      })
      .expect(201)
      .expect(({ body }) => expect(body).toMatchObject({ sizeBytes: 64 }));
  });

  it('does not reveal or accept files for a meeting outside the user access', async () => {
    const owner = await registerUser();
    const outsider = await registerUser();
    const meeting = await createMeeting(owner.accessToken);

    await request(app.getHttpServer())
      .post(`/meetings/${meeting.id}/files`)
      .set('Authorization', `Bearer ${outsider.accessToken}`)
      .attach('file', Buffer.from('%PDF-1.7\n'), {
        filename: 'private.pdf',
        contentType: 'application/pdf',
      })
      .expect(404);

    await request(app.getHttpServer())
      .get(`/meetings/${meeting.id}/files`)
      .set('Authorization', `Bearer ${outsider.accessToken}`)
      .expect(404);
  });

  it('streams a file to its owner and meeting participants through one-time tickets', async () => {
    const owner = await registerUser();
    const participant = await registerUser();
    const meeting = await createMeeting(owner.accessToken);
    await addParticipant(meeting.id, participant);
    const uploaded = await uploadPdf(meeting.id, owner);

    for (const session of [owner, participant]) {
      const ticketResponse = await request(app.getHttpServer())
        .post(`/meetings/${meeting.id}/files/${uploaded.id}/download-ticket`)
        .set('Authorization', `Bearer ${session.accessToken}`)
        .expect(201);

      expect(ticketResponse.body).toMatchObject({
        ticket: expect.any(String),
        expiresAt: expect.any(String),
      });

      const download = await request(app.getHttpServer())
        .get(`/file-downloads/${ticketResponse.body.ticket as string}`)
        .expect('Content-Type', /application\/pdf/)
        .expect('Content-Disposition', /attachment/)
        .expect('Cache-Control', 'private, no-store')
        .expect('X-Content-Type-Options', 'nosniff')
        .expect(200);

      expect(Buffer.from(download.body as Buffer).toString()).toBe('%PDF-1.7\nphase-2');

      await request(app.getHttpServer())
        .get(`/file-downloads/${ticketResponse.body.ticket as string}`)
        .expect(404);
    }
  });

  it('lets the meeting owner delete file content and metadata', async () => {
    const owner = await registerUser();
    const meeting = await createMeeting(owner.accessToken);
    const uploaded = await uploadPdf(meeting.id, owner);
    const storedFile = await prisma.meetingFile.findUniqueOrThrow({
      where: { id: uploaded.id },
      select: { storageKey: true },
    });
    const storedPath = join(uploadRoot, 'files', storedFile.storageKey, 'content');
    await expect(access(storedPath)).resolves.toBeUndefined();

    await request(app.getHttpServer())
      .delete(`/meetings/${meeting.id}/files/${uploaded.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(204);

    await expect(access(storedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(prisma.meetingFile.findUnique({ where: { id: uploaded.id } })).resolves.toBeNull();

    await request(app.getHttpServer())
      .get(`/meetings/${meeting.id}/files`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200, []);
  });

  it('rejects file deletion by a meeting participant with 403 Forbidden', async () => {
    const owner = await registerUser();
    const participant = await registerUser();
    const meeting = await createMeeting(owner.accessToken);
    await addParticipant(meeting.id, participant);
    const uploaded = await uploadPdf(meeting.id, owner);

    await request(app.getHttpServer())
      .delete(`/meetings/${meeting.id}/files/${uploaded.id}`)
      .set('Authorization', `Bearer ${participant.accessToken}`)
      .expect(403);

    await expect(
      prisma.meetingFile.findUnique({ where: { id: uploaded.id } }),
    ).resolves.not.toBeNull();
  });
});
