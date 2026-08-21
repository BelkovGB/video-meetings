import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TranscriptionJobStatus } from '@prisma/client';
import { access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureHttpApplication } from '../src/http-application';
import { PrismaService } from '../src/prisma/prisma.service';
import { teardownStorageSuite } from './support/storage-cleanup';
import { uploadRoot } from './support/storage-roots';
import { TrustedProxyClients } from './support/trusted-proxy';

type UserSession = { accessToken: string };
type UploadedFile = { id: string; category: string };

const validPassword = 'secure-password-123';
const validDate = '2026-08-03T10:00:00.000Z';

/**
 * The smallest content each validator accepts, kept under the 64-byte
 * UPLOAD_MAX_BYTES of this suite: what a job is created for is decided by the
 * category, and the category is decided by these bytes.
 */
const recordings = {
  audio: {
    content: Buffer.from('ID3\x04'),
    filename: 'standup recording.mp3',
    contentType: 'audio/mpeg',
  },
  video: {
    // An ISO container: `ftyp` at offset 4 and a brand that is not QuickTime.
    content: Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom', 'ascii')]),
    filename: 'standup recording.mp4',
    contentType: 'video/mp4',
  },
  document: {
    content: Buffer.from('%PDF-1.7\n'),
    filename: 'agenda.pdf',
    contentType: 'application/pdf',
  },
  transcript: {
    content: Buffer.from('[00:00:00 - 00:00:01] typed by hand\n'),
    filename: 'notes.txt',
    contentType: 'text/plain',
  },
};

function createUniqueValue(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

describe('Transcription job queue (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  // Every registration needs its own client address: this suite creates more
  // accounts per minute than one client may, and a shared address would fail it
  // on the authentication rate limit instead of on a queueing defect.
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
    await teardownStorageSuite({
      close: () => app.close(),
      storageRoots: [uploadRoot],
      restoreEnvironment: () => clients.restore(),
    });
  });

  async function registerUser(): Promise<UserSession> {
    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .set('X-Forwarded-For', clients.nextAddress())
      .send({ email: `${createUniqueValue('queue-user')}@example.com`, password: validPassword })
      .expect(201);

    return response.body as UserSession;
  }

  async function createMeeting(owner: UserSession): Promise<{ id: string }> {
    const response = await request(app.getHttpServer())
      .post('/meetings')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ title: createUniqueValue('Queue meeting'), date: validDate })
      .expect(201);

    return response.body as { id: string };
  }

  async function upload(
    meetingId: string,
    owner: UserSession,
    file: (typeof recordings)[keyof typeof recordings],
  ): Promise<UploadedFile> {
    const response = await request(app.getHttpServer())
      .post(`/meetings/${meetingId}/files`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .attach('file', file.content, { filename: file.filename, contentType: file.contentType })
      .expect(201);

    return response.body as UploadedFile;
  }

  it.each([
    ['audio', recordings.audio],
    ['video', recordings.video],
  ])('queues a transcription job for an uploaded %s recording', async (_category, file) => {
    const owner = await registerUser();
    const meeting = await createMeeting(owner);

    const uploaded = await upload(meeting.id, owner, file);

    await expect(
      prisma.transcriptionJob.findUnique({ where: { sourceFileId: uploaded.id } }),
    ).resolves.toMatchObject({
      status: TranscriptionJobStatus.QUEUED,
      attemptCount: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
      startedAt: null,
      finishedAt: null,
      failureCode: null,
    });
  });

  it.each([
    ['document', recordings.document],
    ['transcript', recordings.transcript],
  ])('creates no transcription job for an uploaded %s', async (category, file) => {
    const owner = await registerUser();
    const meeting = await createMeeting(owner);

    const uploaded = await upload(meeting.id, owner, file);

    expect(uploaded.category).toBe(category);
    await expect(
      prisma.transcriptionJob.findUnique({ where: { sourceFileId: uploaded.id } }),
    ).resolves.toBeNull();
  });

  it('reports the queued transcription status for a recording and null for a document in the file list', async () => {
    const owner = await registerUser();
    const meeting = await createMeeting(owner);
    const recording = await upload(meeting.id, owner, recordings.audio);
    const document = await upload(meeting.id, owner, recordings.document);

    const listed = await request(app.getHttpServer())
      .get(`/meetings/${meeting.id}/files`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);

    expect(listed.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: recording.id, transcriptionStatus: 'queued' }),
        expect.objectContaining({ id: document.id, transcriptionStatus: null }),
      ]),
    );
  });

  it('removes the queued job and the stored bytes when the recording is deleted', async () => {
    const owner = await registerUser();
    const meeting = await createMeeting(owner);
    const uploaded = await upload(meeting.id, owner, recordings.audio);
    const stored = await prisma.meetingFile.findUniqueOrThrow({
      where: { id: uploaded.id },
      select: { storageKey: true },
    });
    const storedPath = join(uploadRoot, 'files', stored.storageKey, 'content');
    await expect(access(storedPath)).resolves.toBeUndefined();

    await request(app.getHttpServer())
      .delete(`/meetings/${meeting.id}/files/${uploaded.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(204);

    await expect(
      prisma.transcriptionJob.findUnique({ where: { sourceFileId: uploaded.id } }),
    ).resolves.toBeNull();
    await expect(prisma.meetingFile.findUnique({ where: { id: uploaded.id } })).resolves.toBeNull();
    await expect(access(storedPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
