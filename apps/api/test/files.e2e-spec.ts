import { INestApplication } from '@nestjs/common';
import { MeetingFileStatus } from '@prisma/client';
import { createHash } from 'node:crypto';
import { access, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureHttpApplication } from '../src/http-application';
import { MeetingFileDeletionReconciliationService } from '../src/files/services/meeting-file-deletion-reconciliation.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { TrustedProxyClients } from './support/trusted-proxy';

type Meeting = { id: string };
type UserSession = { accessToken: string };
type UploadedFile = {
  id: string;
  uploadedBy: {
    handle: string;
    displayName: string | null;
    avatar: { updatedAt: string } | null;
  } | null;
};

const validPassword = 'secure-password-123';
const validDate = '2026-08-03T10:00:00.000Z';
const uploadRoot = join(tmpdir(), 'video-meetings-api-e2e-uploads');
const validPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC',
  'base64',
);
const replacementPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWM4IRd1Qi6KAUIBACTGBQFoaYMtAAAAAElFTkSuQmCC',
  'base64',
);

function createUniqueValue(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createEmail(prefix: string) {
  return `${createUniqueValue(prefix)}@example.com`;
}

function createTicketHash() {
  return createHash('sha256').update(createUniqueValue('ticket')).digest('hex');
}

describe('Meeting files (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  // Each registration comes from its own client address: the suite creates more
  // accounts per minute than one client may, and sharing an address would fail
  // it on the authentication rate limit instead of on a meeting-file defect.
  const clients = new TrustedProxyClients();

  beforeAll(async () => {
    await rm(uploadRoot, { recursive: true, force: true });
    clients.enable();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureHttpApplication(app);
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
    await rm(uploadRoot, { recursive: true, force: true });
    clients.restore();
  });

  async function registerUser(): Promise<UserSession> {
    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .set('X-Forwarded-For', clients.nextAddress())
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

  async function setDisplayName(user: UserSession, displayName: string): Promise<void> {
    await request(app.getHttpServer())
      .patch('/users/me')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ displayName })
      .expect(200);
  }

  async function uploadAvatar(user: UserSession, image: Buffer = validPng): Promise<void> {
    await request(app.getHttpServer())
      .post('/users/me/avatar')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .attach('avatar', image, { filename: 'portrait.png', contentType: 'image/png' })
      .expect(201);
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

  function getUploaderHandle(file: UploadedFile): string {
    if (!file.uploadedBy) {
      throw new Error('The uploaded file carries no uploader identity');
    }

    return file.uploadedBy.handle;
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

  it('removes expired and consumed tickets while retaining active tickets', async () => {
    const owner = await registerUser();
    const meeting = await createMeeting(owner.accessToken);
    const uploaded = await uploadPdf(meeting.id, owner);
    const userId = getUserId(owner.accessToken);
    const now = new Date('2026-08-14T12:00:00.000Z');
    const expiredTicketHash = createTicketHash();
    const consumedTicketHash = createTicketHash();
    const activeTicketHash = createTicketHash();

    await prisma.meetingFileDownloadTicket.createMany({
      data: [
        {
          tokenHash: expiredTicketHash,
          fileId: uploaded.id,
          issuedToUserId: userId,
          expiresAt: new Date('2026-08-14T11:59:00.000Z'),
        },
        {
          tokenHash: consumedTicketHash,
          fileId: uploaded.id,
          issuedToUserId: userId,
          expiresAt: new Date('2026-08-14T12:01:00.000Z'),
          usedAt: new Date('2026-08-14T11:59:00.000Z'),
        },
        {
          tokenHash: activeTicketHash,
          fileId: uploaded.id,
          issuedToUserId: userId,
          expiresAt: new Date('2026-08-14T12:01:00.000Z'),
        },
      ],
    });

    await app.get(MeetingFileDeletionReconciliationService).reconcileDownloadTickets(now);

    await expect(
      prisma.meetingFileDownloadTicket.findUnique({ where: { tokenHash: expiredTicketHash } }),
    ).resolves.toBeNull();
    await expect(
      prisma.meetingFileDownloadTicket.findUnique({ where: { tokenHash: consumedTicketHash } }),
    ).resolves.toBeNull();
    await expect(
      prisma.meetingFileDownloadTicket.findUnique({ where: { tokenHash: activeTicketHash } }),
    ).resolves.not.toBeNull();
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

  it('returns the uploader current display name and avatar state to owners and participants', async () => {
    const owner = await registerUser();
    const participant = await registerUser();
    const meeting = await createMeeting(owner.accessToken);
    await addParticipant(meeting.id, participant);
    await setDisplayName(participant, 'Ada Lovelace');
    await uploadAvatar(participant);

    const uploaded = await uploadPdf(meeting.id, participant);

    expect(uploaded.uploadedBy).toEqual({
      handle: expect.any(String),
      displayName: 'Ada Lovelace',
      avatar: { updatedAt: expect.any(String) },
    });

    for (const viewer of [owner, participant]) {
      const listed = await request(app.getHttpServer())
        .get(`/meetings/${meeting.id}/files`)
        .set('Authorization', `Bearer ${viewer.accessToken}`)
        .expect(200);

      expect(listed.body).toEqual([
        expect.objectContaining({
          id: uploaded.id,
          uploadedBy: {
            handle: getUploaderHandle(uploaded),
            displayName: 'Ada Lovelace',
            avatar: { updatedAt: expect.any(String) },
          },
        }),
      ]);
    }
  });

  it('never exposes the uploader email, identifier, or avatar storage details', async () => {
    const owner = await registerUser();
    const meeting = await createMeeting(owner.accessToken);
    await setDisplayName(owner, 'Grace Hopper');
    await uploadAvatar(owner);
    await uploadPdf(meeting.id, owner);

    const listed = await request(app.getHttpServer())
      .get(`/meetings/${meeting.id}/files`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);

    const serialized = JSON.stringify(listed.body);
    expect(serialized).not.toContain('@example.com');
    expect(serialized).not.toContain(getUserId(owner.accessToken));
    expect(Object.keys(listed.body[0].uploadedBy)).toEqual(['handle', 'displayName', 'avatar']);
    expect(Object.keys(listed.body[0].uploadedBy.avatar)).toEqual(['updatedAt']);
  });

  it('reports the display name the uploader has now, not the one stored at upload time', async () => {
    const owner = await registerUser();
    const meeting = await createMeeting(owner.accessToken);
    await setDisplayName(owner, 'Original Name');
    const uploaded = await uploadPdf(meeting.id, owner);
    await setDisplayName(owner, 'Renamed Owner');

    const listed = await request(app.getHttpServer())
      .get(`/meetings/${meeting.id}/files`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);

    expect(listed.body).toEqual([
      expect.objectContaining({
        id: uploaded.id,
        uploadedBy: {
          handle: getUploaderHandle(uploaded),
          displayName: 'Renamed Owner',
          avatar: null,
        },
      }),
    ]);
  });

  it('reports an absent avatar and an unset display name as null', async () => {
    const owner = await registerUser();
    const meeting = await createMeeting(owner.accessToken);
    await uploadAvatar(owner);
    const uploaded = await uploadPdf(meeting.id, owner);

    await request(app.getHttpServer())
      .delete('/users/me/avatar')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);

    const listed = await request(app.getHttpServer())
      .get(`/meetings/${meeting.id}/files`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);

    expect(listed.body).toEqual([
      expect.objectContaining({
        id: uploaded.id,
        uploadedBy: {
          handle: getUploaderHandle(uploaded),
          displayName: null,
          avatar: null,
        },
      }),
    ]);
  });

  it('keeps listing a file whose uploader account is gone, without an uploader identity', async () => {
    const owner = await registerUser();
    const participant = await registerUser();
    const meeting = await createMeeting(owner.accessToken);
    await addParticipant(meeting.id, participant);
    await setDisplayName(participant, 'Departing Participant');
    const uploaded = await uploadPdf(meeting.id, participant);

    await prisma.user.delete({ where: { id: getUserId(participant.accessToken) } });

    const listed = await request(app.getHttpServer())
      .get(`/meetings/${meeting.id}/files`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);

    expect(listed.body).toEqual([expect.objectContaining({ id: uploaded.id, uploadedBy: null })]);
  });

  it('does not reveal the uploader identity to a user outside the meeting', async () => {
    const owner = await registerUser();
    const outsider = await registerUser();
    const meeting = await createMeeting(owner.accessToken);
    await setDisplayName(owner, 'Hidden Owner');
    await uploadPdf(meeting.id, owner);

    const denied = await request(app.getHttpServer())
      .get(`/meetings/${meeting.id}/files`)
      .set('Authorization', `Bearer ${outsider.accessToken}`)
      .expect(404);

    expect(JSON.stringify(denied.body)).not.toContain('Hidden Owner');
  });
  it('gives every file of one uploader the same meeting-scoped handle', async () => {
    const owner = await registerUser();
    const participant = await registerUser();
    const meeting = await createMeeting(owner.accessToken);
    const otherMeeting = await createMeeting(owner.accessToken);
    await addParticipant(meeting.id, participant);

    const first = await uploadPdf(meeting.id, owner);
    const second = await uploadPdf(meeting.id, owner);
    const byParticipant = await uploadPdf(meeting.id, participant);
    const elsewhere = await uploadPdf(otherMeeting.id, owner);

    expect(getUploaderHandle(second)).toBe(getUploaderHandle(first));
    expect(getUploaderHandle(byParticipant)).not.toBe(getUploaderHandle(first));
    expect(getUploaderHandle(elsewhere)).not.toBe(getUploaderHandle(first));
    expect(getUploaderHandle(first)).not.toContain(getUserId(owner.accessToken));

    const listed = await request(app.getHttpServer())
      .get(`/meetings/${meeting.id}/files`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);

    const handles = (listed.body as UploadedFile[]).map(getUploaderHandle);
    expect(new Set(handles).size).toBe(2);
  });

  it('streams the uploader current avatar to the meeting owner and to participants', async () => {
    const owner = await registerUser();
    const participant = await registerUser();
    const meeting = await createMeeting(owner.accessToken);
    await addParticipant(meeting.id, participant);
    await uploadAvatar(participant);
    const uploaded = await uploadPdf(meeting.id, participant);

    for (const viewer of [owner, participant]) {
      const response = await request(app.getHttpServer())
        .get(`/meetings/${meeting.id}/uploaders/${getUploaderHandle(uploaded)}/avatar`)
        .set('Authorization', `Bearer ${viewer.accessToken}`)
        .expect('Content-Type', /image\/png/)
        .expect('Cache-Control', 'private, max-age=0, must-revalidate')
        // The route appends its own field to the `Vary: Origin` that the CORS
        // layer contributes, instead of replacing it: on a URL this route makes
        // cache-eligible, dropping a field a shared middleware added would let a
        // cache key the entry on too little.
        .expect('Vary', 'Origin, Authorization')
        .expect('X-Content-Type-Options', 'nosniff')
        .expect(200);

      expect(response.headers.etag).toEqual(expect.any(String));
      expect(Buffer.from(response.body as Buffer)).toEqual(validPng);
    }
  });

  it('answers a revalidation with 304 until the avatar is replaced', async () => {
    const owner = await registerUser();
    const meeting = await createMeeting(owner.accessToken);
    await uploadAvatar(owner);
    const uploaded = await uploadPdf(meeting.id, owner);
    const url = `/meetings/${meeting.id}/uploaders/${getUploaderHandle(uploaded)}/avatar`;

    const first = await request(app.getHttpServer())
      .get(url)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);

    const etag = first.headers.etag as string;
    expect(etag).toMatch(/^"[^"]+"$/);

    const revalidated = await request(app.getHttpServer())
      .get(url)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .set('If-None-Match', etag)
      .expect(304);

    expect(revalidated.headers['content-length']).toBeUndefined();
    expect(revalidated.body).toEqual({});
    // A 304 that drops the validator or the directives leaves the stored copy
    // unrevalidatable, so the header block is asserted on this path too.
    expect(revalidated.headers.etag).toBe(etag);
    expect(revalidated.headers['cache-control']).toBe('private, max-age=0, must-revalidate');
    expect(revalidated.headers.vary).toBe('Origin, Authorization');

    await request(app.getHttpServer())
      .get(url)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .set('If-None-Match', `W/${etag}, "other"`)
      .expect(304);

    await uploadAvatar(owner, replacementPng);

    const refreshed = await request(app.getHttpServer())
      .get(url)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .set('If-None-Match', etag)
      .expect(200);

    expect(refreshed.headers.etag).not.toBe(etag);
    expect(Buffer.from(refreshed.body as Buffer)).toEqual(replacementPng);
  });

  it('denies the uploader avatar outside the meeting and to an unauthenticated caller', async () => {
    const owner = await registerUser();
    const outsider = await registerUser();
    const meeting = await createMeeting(owner.accessToken);
    await setDisplayName(owner, 'Hidden Uploader');
    await uploadAvatar(owner);
    const uploaded = await uploadPdf(meeting.id, owner);
    const url = `/meetings/${meeting.id}/uploaders/${getUploaderHandle(uploaded)}/avatar`;

    const served = await request(app.getHttpServer())
      .get(url)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);

    const denied = await request(app.getHttpServer())
      .get(url)
      .set('Authorization', `Bearer ${outsider.accessToken}`)
      .expect(404);

    expect(denied.body).toMatchObject({ message: 'Meeting not found' });
    expect(JSON.stringify(denied.body)).not.toContain('Hidden Uploader');
    // A 404 is heuristically cacheable, and this URL is otherwise made
    // cache-eligible, so a shared cache must not keep the outsider denial and
    // replay it to a participant. It must also never carry the avatar's own
    // validator, or a client would revalidate the error body successfully and
    // go on serving it in place of the image.
    expect(denied.headers['cache-control']).toBe('private, no-store');
    expect(denied.headers.vary).toBe('Origin, Authorization');
    expect(denied.headers.etag).not.toBe(served.headers.etag);

    await request(app.getHttpServer()).get(url).expect(401);
  });

  it('refuses a handle minted for another meeting and an unknown handle', async () => {
    const owner = await registerUser();
    const meeting = await createMeeting(owner.accessToken);
    const otherMeeting = await createMeeting(owner.accessToken);
    await uploadAvatar(owner);
    const uploaded = await uploadPdf(meeting.id, owner);
    const handle = getUploaderHandle(uploaded);

    const foreignHandle = await request(app.getHttpServer())
      .get(`/meetings/${otherMeeting.id}/uploaders/${handle}/avatar`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(404);

    const unknownHandle = await request(app.getHttpServer())
      .get(`/meetings/${meeting.id}/uploaders/${getUserId(owner.accessToken)}/avatar`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(404);

    // The caller owns both meetings, so these two must come from the handle
    // lookup and not from the meeting guard: a bare status assertion would keep
    // passing if the route started refusing the caller the meeting itself.
    expect(foreignHandle.body).toMatchObject({ message: 'Avatar not found' });
    expect(unknownHandle.body).toMatchObject({ message: 'Avatar not found' });
  });

  // The handle names an uploader with a ready file in the meeting, so a file
  // that left that state must no longer answer for them. Deletion removes the
  // row; these states leave one behind, and only the query's status filter
  // keeps it from minting a handle.
  it.each([MeetingFileStatus.DELETING, MeetingFileStatus.MISSING])(
    'stops serving the avatar once the uploader last file turns %s',
    async (status) => {
      const owner = await registerUser();
      const participant = await registerUser();
      const meeting = await createMeeting(owner.accessToken);
      await addParticipant(meeting.id, participant);
      await uploadAvatar(participant);
      const uploaded = await uploadPdf(meeting.id, participant);
      const url = `/meetings/${meeting.id}/uploaders/${getUploaderHandle(uploaded)}/avatar`;

      await request(app.getHttpServer())
        .get(url)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);

      await prisma.meetingFile.update({ where: { id: uploaded.id }, data: { status } });

      const revoked = await request(app.getHttpServer())
        .get(url)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(404);

      expect(revoked.body).toMatchObject({ message: 'Avatar not found' });
    },
  );

  it('does not label a 404 body with the avatar validator when the object is gone', async () => {
    const owner = await registerUser();
    const meeting = await createMeeting(owner.accessToken);
    await uploadAvatar(owner);
    const uploaded = await uploadPdf(meeting.id, owner);
    const url = `/meetings/${meeting.id}/uploaders/${getUploaderHandle(uploaded)}/avatar`;

    const served = await request(app.getHttpServer())
      .get(url)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);

    // The metadata naming a version survives; the object behind it does not, so
    // the version resolves but the open fails.
    await prisma.user.update({
      where: { id: getUserId(owner.accessToken) },
      data: { avatarStorageKey: null },
    });

    const missing = await request(app.getHttpServer())
      .get(url)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(404);

    expect(missing.body).toMatchObject({ message: 'Avatar not found' });
    // Shipping the avatar's tag here would let a client revalidate the error
    // body and keep serving it in place of the image for as long as the
    // recorded version is unchanged.
    expect(missing.headers.etag).not.toBe(served.headers.etag);
    expect(missing.headers['cache-control']).toBe('private, no-store');
  });

  it('revokes the avatar handle once the uploader has no ready file left in the meeting', async () => {
    const owner = await registerUser();
    const participant = await registerUser();
    const meeting = await createMeeting(owner.accessToken);
    await addParticipant(meeting.id, participant);
    await uploadAvatar(owner);
    const first = await uploadPdf(meeting.id, owner);
    const second = await uploadPdf(meeting.id, owner);
    const url = `/meetings/${meeting.id}/uploaders/${getUploaderHandle(first)}/avatar`;

    await request(app.getHttpServer())
      .delete(`/meetings/${meeting.id}/files/${first.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(204);

    // The handle names the uploader, not the file it was read from, so any
    // other ready file of theirs keeps the same URL alive.
    await request(app.getHttpServer())
      .get(url)
      .set('Authorization', `Bearer ${participant.accessToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .delete(`/meetings/${meeting.id}/files/${second.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(204);

    const revoked = await request(app.getHttpServer())
      .get(url)
      .set('Authorization', `Bearer ${participant.accessToken}`)
      .expect(404);

    expect(revoked.body).toMatchObject({ message: 'Avatar not found' });
  });

  it('serves the replacement avatar for a file uploaded before the replacement', async () => {
    const owner = await registerUser();
    const meeting = await createMeeting(owner.accessToken);
    await uploadAvatar(owner);
    const uploaded = await uploadPdf(meeting.id, owner);

    await uploadAvatar(owner, replacementPng);

    const response = await request(app.getHttpServer())
      .get(`/meetings/${meeting.id}/uploaders/${getUploaderHandle(uploaded)}/avatar`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);

    expect(Buffer.from(response.body as Buffer)).toEqual(replacementPng);
  });

  it('stops serving the avatar once the uploader removes it', async () => {
    const owner = await registerUser();
    const participant = await registerUser();
    const meeting = await createMeeting(owner.accessToken);
    await addParticipant(meeting.id, participant);
    await uploadAvatar(participant);
    const uploaded = await uploadPdf(meeting.id, participant);

    await request(app.getHttpServer())
      .delete('/users/me/avatar')
      .set('Authorization', `Bearer ${participant.accessToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .get(`/meetings/${meeting.id}/uploaders/${getUploaderHandle(uploaded)}/avatar`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(404);
  });

  it('reports an avatar the uploader never had and a deleted uploader account as absent', async () => {
    const owner = await registerUser();
    const participant = await registerUser();
    const meeting = await createMeeting(owner.accessToken);
    await addParticipant(meeting.id, participant);
    const withoutAvatar = await uploadPdf(meeting.id, participant);

    await request(app.getHttpServer())
      .get(`/meetings/${meeting.id}/uploaders/${getUploaderHandle(withoutAvatar)}/avatar`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(404);

    await uploadAvatar(participant);
    const uploaded = await uploadPdf(meeting.id, participant);
    const handle = getUploaderHandle(uploaded);
    await prisma.user.delete({ where: { id: getUserId(participant.accessToken) } });

    await request(app.getHttpServer())
      .get(`/meetings/${meeting.id}/uploaders/${handle}/avatar`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(404);
  });
});
