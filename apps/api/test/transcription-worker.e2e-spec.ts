import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MeetingFileCategory, TranscriptionJob, TranscriptionJobStatus } from '@prisma/client';
import * as filesystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureHttpApplication } from '../src/http-application';
import { LocalMeetingFileStorageService } from '../src/files/services/local-meeting-file-storage.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { TranscriptFileService } from '../src/transcription/services/transcript-file.service';
import { TranscriptionWorker } from '../src/transcription/worker/transcription-worker';
import { TranscriptionWorkerModule } from '../src/transcription/worker/transcription-worker.module';
import { teardownStorageSuite } from './support/storage-cleanup';
import { findStorageLeftovers } from './support/storage-leftovers';
import {
  transcriptionWorkRoot,
  uploadDirectory,
  uploadRoot,
  uploadTempDirectory,
} from './support/storage-roots';
import {
  TranscriptionFixtureControl,
  clearTranscriptionFixtures,
  setTranscriptionFixtures,
} from './support/transcription-fixtures';
import { TrustedProxyClients } from './support/trusted-proxy';

type UserSession = { accessToken: string };
type UploadedFile = { id: string };
type ListedFile = {
  id: string;
  name: string;
  category: string;
  mimeType: string;
  uploadedBy: unknown;
};

const validPassword = 'secure-password-123';
const validDate = '2026-08-03T10:00:00.000Z';

/**
 * Header bytes each content validator accepts, under the 64-byte
 * UPLOAD_MAX_BYTES of this suite. Neither fixture program reads them: the real
 * pair would decode audio and load a model, which no run of this suite may do.
 */
const recordings = {
  audio: { content: Buffer.from('ID3\x04'), filename: 'standup.mp3', contentType: 'audio/mpeg' },
  video: {
    content: Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom', 'ascii')]),
    filename: 'standup.mp4',
    contentType: 'video/mp4',
  },
};

const failureCases: [string, TranscriptionFixtureControl, string][] = [
  ['audio preparation fails', { ffmpegExitCode: 4 }, 'AUDIO_PREPARATION_FAILED'],
  ['recognition fails', { recognizerExitCode: 3 }, 'RECOGNITION_FAILED'],
  ['recognition prints no JSON', { stdout: 'loading model' }, 'RECOGNITION_OUTPUT_INVALID'],
  ['the recording holds no speech', { segments: [] }, 'NO_SPEECH_DETECTED'],
];

function createUniqueValue(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function waitFor(reached: () => Promise<boolean>, description: string): Promise<void> {
  const deadline = Date.now() + 20_000;

  while (Date.now() < deadline) {
    if (await reached()) {
      return;
    }

    await new Promise((settle) => setTimeout(settle, 20));
  }

  throw new Error(`Timed out waiting for ${description}`);
}

describe('Transcription worker (e2e)', () => {
  let app: INestApplication;
  let workerContext: TestingModule;
  let worker: TranscriptionWorker;
  let prisma: PrismaService;
  // Every registration needs its own client address: this suite creates more
  // accounts per minute than one client may, and a shared address would fail it
  // on the authentication rate limit instead of on a worker defect.
  const clients = new TrustedProxyClients();
  // Outside every storage root: the recognizer fixture appends to this from its
  // own process, and the leftover guard fails a suite for anything found under
  // the storage directories.
  const traceRoot = join(tmpdir(), 'video-meetings-api-e2e-transcription-trace');
  const tracePath = join(traceRoot, 'recognizer-runs.log');

  beforeAll(async () => {
    await filesystem.rm(uploadRoot, { recursive: true, force: true });
    await filesystem.rm(transcriptionWorkRoot, { recursive: true, force: true });
    await filesystem.rm(traceRoot, { recursive: true, force: true });
    await filesystem.mkdir(traceRoot, { recursive: true });
    await clearTranscriptionFixtures();
    clients.enable();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureHttpApplication(app);
    await app.init();
    prisma = app.get(PrismaService);

    // Assembled the way the worker process assembles it, in a context of its
    // own: `AppModule` must not carry the worker, so it cannot come from `app`.
    workerContext = await Test.createTestingModule({
      imports: [TranscriptionWorkerModule],
    }).compile();
    await workerContext.init();
    worker = workerContext.get(TranscriptionWorker);

    // The e2e database is not reset between runs, and earlier suites leave
    // recordings whose stored bytes went with their storage root. Their jobs
    // are still queued, and this worker would claim them and report failures
    // belonging to no test here. Suites are serialized (see maxWorkers in
    // test/jest-e2e.json), so nothing else queues work meanwhile.
    await prisma.transcriptionJob.deleteMany({});
  });

  afterEach(async () => {
    await clearTranscriptionFixtures();
  });

  afterAll(async () => {
    // The worker directory is cleared here as well: it holds a conversion per
    // recording, and it is not one of the directories the leftover guard reads.
    await teardownStorageSuite({
      close: async () => {
        await worker.stop();
        await workerContext.close();
        await app.close();
      },
      storageRoots: [uploadRoot, transcriptionWorkRoot, traceRoot],
      restoreEnvironment: () => clients.restore(),
    });
  });

  async function registerUser(): Promise<UserSession> {
    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .set('X-Forwarded-For', clients.nextAddress())
      .send({ email: `${createUniqueValue('worker-user')}@example.com`, password: validPassword })
      .expect(201);

    return response.body as UserSession;
  }

  async function createMeeting(owner: UserSession): Promise<{ id: string }> {
    const response = await request(app.getHttpServer())
      .post('/meetings')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ title: createUniqueValue('Worker meeting'), date: validDate })
      .expect(201);

    return response.body as { id: string };
  }

  async function upload(
    meetingId: string,
    owner: UserSession,
    recording: (typeof recordings)[keyof typeof recordings] = recordings.audio,
  ): Promise<UploadedFile> {
    const response = await request(app.getHttpServer())
      .post(`/meetings/${meetingId}/files`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .attach('file', recording.content, {
        filename: recording.filename,
        contentType: recording.contentType,
      })
      .expect(201);

    return response.body as UploadedFile;
  }

  async function listFiles(meetingId: string, owner: UserSession): Promise<ListedFile[]> {
    const response = await request(app.getHttpServer())
      .get(`/meetings/${meetingId}/files`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);

    return response.body as ListedFile[];
  }

  async function download(
    meetingId: string,
    fileId: string,
    owner: UserSession,
  ): Promise<request.Response> {
    const ticket = await request(app.getHttpServer())
      .post(`/meetings/${meetingId}/files/${fileId}/download-ticket`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(201);

    return request(app.getHttpServer())
      .get(`/file-downloads/${(ticket.body as { ticket: string }).ticket}`)
      .expect(200);
  }

  function jobOf(sourceFileId: string): Promise<TranscriptionJob> {
    return prisma.transcriptionJob.findUniqueOrThrow({ where: { sourceFileId } });
  }

  /**
   * Drives the queue by hand until the named job stops waiting: no timers, and
   * a job nothing takes fails the test instead of hanging it.
   */
  async function processUntilSettled(jobId: string): Promise<TranscriptionJob> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const job = await prisma.transcriptionJob.findUniqueOrThrow({ where: { id: jobId } });

      if (job.status !== TranscriptionJobStatus.QUEUED) {
        return job;
      }

      if (!(await worker.processNextJob())) {
        throw new Error('The queue held no job the worker could take');
      }
    }

    throw new Error(`Job ${jobId} was still queued after five attempts`);
  }

  /**
   * Stored directories no meeting-file row names: bytes nothing can reach and
   * nothing deletes until storage reconciliation notices, a day later.
   */
  async function findOrphanedStorage(): Promise<string[]> {
    const [directories, files] = await Promise.all([
      filesystem.readdir(uploadDirectory),
      prisma.meetingFile.findMany({ select: { storageKey: true } }),
    ]);
    const known = new Set(files.map((file) => file.storageKey));

    return directories.filter((directory) => !known.has(directory));
  }

  it('turns a queued recording into a transcript file with timecodes', async () => {
    await setTranscriptionFixtures({
      segments: [
        { start: 0, end: 1.5, text: 'first utterance' },
        { start: 61.2, end: 3725.4, text: '  second   utterance ' },
      ],
    });
    const owner = await registerUser();
    const meeting = await createMeeting(owner);
    const recording = await upload(meeting.id, owner);
    const queued = await jobOf(recording.id);
    expect(queued.status).toBe(TranscriptionJobStatus.QUEUED);

    const finished = await processUntilSettled(queued.id);

    expect(finished).toMatchObject({
      status: TranscriptionJobStatus.COMPLETED,
      attemptCount: 1,
      failureCode: null,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    expect(finished.finishedAt).toBeInstanceOf(Date);

    const transcript = await prisma.meetingFile.findFirstOrThrow({
      where: { sourceFileId: recording.id },
    });
    expect(transcript).toMatchObject({
      meetingId: meeting.id,
      category: MeetingFileCategory.TRANSCRIPT,
      mimeType: 'text/plain',
      originalName: 'standup.txt',
      // Written by the system, so no uploader identity is attached to it.
      uploadedById: null,
    });

    const listed = await listFiles(meeting.id, owner);
    expect(listed).toHaveLength(2);
    expect(listed.find((file) => file.id === transcript.id)).toMatchObject({
      name: 'standup.txt',
      category: 'transcript',
      mimeType: 'text/plain',
      uploadedBy: null,
    });

    const downloaded = await download(meeting.id, transcript.id, owner);
    expect(downloaded.text).toBe(
      '[00:00:00 - 00:00:01] first utterance\n[00:01:01 - 01:02:05] second utterance\n',
    );
    expect(transcript.sizeBytes).toBe(Buffer.byteLength(downloaded.text));

    // The conversion goes whatever the outcome: the work directory takes a wav
    // per recording, and a leaked one outlives the run.
    await expect(filesystem.readdir(transcriptionWorkRoot)).resolves.toEqual([]);
    await expect(findStorageLeftovers([uploadTempDirectory])).resolves.toEqual([]);
  });

  it('runs two queued recordings one after the other', async () => {
    // The hold is long enough that a recognition started before the previous
    // one returned would overlap it: one GPU, one recognition at a time.
    await setTranscriptionFixtures({ tracePath, holdMs: 200 });
    const owner = await registerUser();
    const meeting = await createMeeting(owner);
    const first = await upload(meeting.id, owner, recordings.audio);
    const second = await upload(meeting.id, owner, recordings.video);

    // The polling loop, not `processNextJob`: taking one job at a time is what
    // the loop is for, so the loop is what this drives.
    worker.run();
    try {
      await waitFor(
        async () =>
          (await prisma.transcriptionJob.count({
            where: {
              sourceFileId: { in: [first.id, second.id] },
              status: TranscriptionJobStatus.COMPLETED,
            },
          })) === 2,
        'both recordings to be transcribed',
      );
    } finally {
      await worker.stop();
    }

    const trace = await filesystem.readFile(tracePath, 'utf8');
    // Overlapping runs interleave as start, start, end, end.
    expect(trace.trim().split(/\r?\n/)).toEqual(['start', 'end', 'start', 'end']);
    await expect(
      prisma.meetingFile.count({ where: { sourceFileId: { in: [first.id, second.id] } } }),
    ).resolves.toBe(2);
    await expect(filesystem.readdir(transcriptionWorkRoot)).resolves.toEqual([]);
  });

  it.each(failureCases)(
    'records the reason and stores nothing when %s',
    async (_case, control, failureCode) => {
      await setTranscriptionFixtures(control);
      const owner = await registerUser();
      const meeting = await createMeeting(owner);
      const recording = await upload(meeting.id, owner);

      const finished = await processUntilSettled((await jobOf(recording.id)).id);

      expect(finished).toMatchObject({
        status: TranscriptionJobStatus.FAILED,
        attemptCount: 1,
        failureCode,
        leaseOwner: null,
        leaseExpiresAt: null,
      });
      await expect(
        prisma.meetingFile.count({ where: { sourceFileId: recording.id } }),
      ).resolves.toBe(0);
      await expect(listFiles(meeting.id, owner)).resolves.toHaveLength(1);
      await expect(filesystem.readdir(transcriptionWorkRoot)).resolves.toEqual([]);
      await expect(findStorageLeftovers([uploadTempDirectory])).resolves.toEqual([]);
      await expect(findOrphanedStorage()).resolves.toEqual([]);
    },
  );

  it('deletes the transcript, the job and both stored files with the recording', async () => {
    const owner = await registerUser();
    const meeting = await createMeeting(owner);
    const recording = await upload(meeting.id, owner);
    const job = await jobOf(recording.id);
    await processUntilSettled(job.id);
    const stored = await prisma.meetingFile.findMany({
      where: { meetingId: meeting.id },
      select: { id: true, storageKey: true },
    });
    expect(stored).toHaveLength(2);
    for (const file of stored) {
      await expect(
        filesystem.access(join(uploadDirectory, file.storageKey, 'content')),
      ).resolves.toBeUndefined();
    }

    await request(app.getHttpServer())
      .delete(`/meetings/${meeting.id}/files/${recording.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(204);

    await expect(prisma.meetingFile.count({ where: { meetingId: meeting.id } })).resolves.toBe(0);
    await expect(prisma.transcriptionJob.findUnique({ where: { id: job.id } })).resolves.toBeNull();
    for (const file of stored) {
      await expect(
        filesystem.access(join(uploadDirectory, file.storageKey, 'content')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    }
    await expect(listFiles(meeting.id, owner)).resolves.toEqual([]);
    await expect(findOrphanedStorage()).resolves.toEqual([]);
  });

  it('stores no transcript for a recording deleted while its job runs', async () => {
    // The worker stays inside recognition until the recording is gone, which is
    // the window its completion check exists for.
    await setTranscriptionFixtures({ holdMs: 500 });
    const owner = await registerUser();
    const meeting = await createMeeting(owner);
    const recording = await upload(meeting.id, owner);
    const job = await jobOf(recording.id);

    const processing = worker.processNextJob();
    await waitFor(
      async () =>
        (await prisma.transcriptionJob.findUnique({ where: { id: job.id } }))?.status ===
        TranscriptionJobStatus.PROCESSING,
      'the worker to claim the job',
    );

    await request(app.getHttpServer())
      .delete(`/meetings/${meeting.id}/files/${recording.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(204);
    await expect(processing).resolves.toBe(true);

    await expect(prisma.meetingFile.count({ where: { meetingId: meeting.id } })).resolves.toBe(0);
    await expect(prisma.transcriptionJob.findUnique({ where: { id: job.id } })).resolves.toBeNull();
    await expect(listFiles(meeting.id, owner)).resolves.toEqual([]);
    await expect(findOrphanedStorage()).resolves.toEqual([]);
    await expect(findStorageLeftovers([uploadTempDirectory])).resolves.toEqual([]);
    await expect(filesystem.readdir(transcriptionWorkRoot)).resolves.toEqual([]);
  });
});

describe('Transcript storage reserve', () => {
  it('fails the job instead of writing a transcript the volume has no room for', async () => {
    // UPLOAD_MIN_FREE_BYTES is 0 in this run, so only a full volume refuses the
    // write here; the reserve arithmetic itself is covered in
    // local-meeting-file-storage.e2e-spec.ts, which shares this code path.
    const statfs = jest
      .spyOn(filesystem, 'statfs')
      .mockResolvedValue({ bavail: 0n, bsize: 4_096n } as never);
    const transcriptFile = new TranscriptFileService(new LocalMeetingFileStorageService());

    await expect(transcriptFile.write('standup.mp3', 'transcript text')).rejects.toMatchObject({
      code: 'INSUFFICIENT_STORAGE',
    });

    statfs.mockRestore();
    await expect(findStorageLeftovers([uploadTempDirectory, uploadDirectory])).resolves.toEqual([]);
  });
});
