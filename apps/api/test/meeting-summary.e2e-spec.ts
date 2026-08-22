import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MeetingSummaryStatus } from '@prisma/client';
import { rm } from 'node:fs/promises';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';
import { claudeAgentApiKey } from '../src/claude-agent/claude-agent.config';
import { configureHttpApplication } from '../src/http-application';
import { PrismaService } from '../src/prisma/prisma.service';
import { teardownStorageSuite } from './support/storage-cleanup';
import { uploadRoot } from './support/storage-roots';
import { TrustedProxyClients } from './support/trusted-proxy';

type UserSession = { accessToken: string };
type Meeting = { id: string };
type SummaryTask = { id: string; title: string; assignee: string | null };
type SummaryDecision = { id: string; text: string };
type SummaryResponse = {
  status: 'queued' | 'processing' | 'ready' | 'error' | null;
  summary: string | null;
  failureCode: string | null;
  tasks: SummaryTask[];
  decisions: SummaryDecision[];
};

const validPassword = 'secure-password-123';
const validDate = '2026-08-03T10:00:00.000Z';

// Stays under the 64-byte UPLOAD_MAX_BYTES this e2e run enforces (see
// test/setup.ts) while still giving the model a real exchange to summarise.
const transcript = {
  content: Buffer.from('Alice: Ship the report by Friday.\nBob: Agreed.\n'),
  filename: 'standup.txt',
  contentType: 'text/plain',
};

function createUniqueValue(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((settle) => setTimeout(settle, ms));
}

// This suite calls the real Anthropic API through MeetingSummaryRunnerService,
// so it needs network and the token in apps/api/.env, and it bills the
// account. Haiku keeps a run at a fraction of a cent. Skipping without a token
// rather than failing keeps a checkout that never configured one able to run
// the rest of the suite; jest prints the skip, so the gap stays visible.
const describeWithToken = claudeAgentApiKey ? describe : describe.skip;

describeWithToken('Meeting summary (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  // Every registration needs its own client address: this suite creates more
  // accounts per minute than one client may, and a shared address would fail
  // it on the authentication rate limit instead of on a summary defect.
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
      .send({ email: `${createUniqueValue('summary-user')}@example.com`, password: validPassword })
      .expect(201);

    return response.body as UserSession;
  }

  async function createMeeting(owner: UserSession): Promise<Meeting> {
    const response = await request(app.getHttpServer())
      .post('/meetings')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ title: createUniqueValue('Summary meeting'), date: validDate })
      .expect(201);

    return response.body as Meeting;
  }

  async function uploadTranscript(meetingId: string, owner: UserSession): Promise<void> {
    await request(app.getHttpServer())
      .post(`/meetings/${meetingId}/files`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .attach('file', transcript.content, {
        filename: transcript.filename,
        contentType: transcript.contentType,
      })
      .expect(201);
  }

  function startSummary(meetingId: string, caller: UserSession): request.Test {
    return request(app.getHttpServer())
      .post(`/meetings/${meetingId}/summary`)
      .set('Authorization', `Bearer ${caller.accessToken}`);
  }

  function getSummary(meetingId: string, caller: UserSession): request.Test {
    return request(app.getHttpServer())
      .get(`/meetings/${meetingId}/summary`)
      .set('Authorization', `Bearer ${caller.accessToken}`);
  }

  /**
   * Polls until the runner leaves QUEUED/PROCESSING, or the budget runs out.
   * No timers: a summary the model never finishes fails the test instead of
   * hanging it.
   */
  async function waitForSummaryResult(
    meetingId: string,
    owner: UserSession,
    budgetMs: number,
  ): Promise<SummaryResponse> {
    const deadline = Date.now() + budgetMs;

    while (Date.now() < deadline) {
      const response = await getSummary(meetingId, owner).expect(200);
      const body = response.body as SummaryResponse;

      if (body.status === 'ready' || body.status === 'error') {
        return body;
      }

      await sleep(2_000);
    }

    throw new Error(`Timed out waiting for the summary of meeting ${meetingId} to finish`);
  }

  it('rejects starting a summary when the meeting has no transcript file', async () => {
    const owner = await registerUser();
    const meeting = await createMeeting(owner);

    const response = await startSummary(meeting.id, owner).expect(422);

    expect(response.body).toMatchObject({ code: 'NO_TRANSCRIPT_FILES' });
  });

  it('answers the start request immediately as queued, then completes through a real model call', async () => {
    const owner = await registerUser();
    const meeting = await createMeeting(owner);
    await uploadTranscript(meeting.id, owner);

    const started = await startSummary(meeting.id, owner).expect(202);
    // The body reflects the row written before the fire-and-forget runner was
    // started, not an awaited model answer: this is what proves the request
    // did not wait, without depending on wall-clock timing.
    expect(started.body).toEqual({
      status: 'queued',
      summary: null,
      failureCode: null,
      tasks: [],
      decisions: [],
    });

    const finished = await waitForSummaryResult(meeting.id, owner, 170_000);

    expect(finished.status).toBe('ready');
    expect(typeof finished.summary).toBe('string');
    expect((finished.summary as string).trim().length).toBeGreaterThan(0);
    expect(finished.failureCode).toBeNull();

    // The model call is real and non-deterministic, so only the shape is
    // checked here, never specific content or a specific count (same reason
    // the summary text above is checked for non-emptiness, not a value).
    expect(Array.isArray(finished.tasks)).toBe(true);
    expect(Array.isArray(finished.decisions)).toBe(true);

    // Soft/conditional: the fixture transcript does not guarantee the model
    // extracts a task, so this only checks the shape of whatever came back.
    for (const task of finished.tasks) {
      expect(typeof task.id).toBe('string');
      expect(typeof task.title).toBe('string');
      expect(task.title.trim().length).toBeGreaterThan(0);
      expect(task.assignee === null || typeof task.assignee === 'string').toBe(true);
    }
  }, 180_000);

  it('returns seeded tasks and decisions in position order', async () => {
    const owner = await registerUser();
    const meeting = await createMeeting(owner);
    // Seeded directly, never through the real model: this is about the
    // response mapping and ordering, not the runner, and must stay fast and
    // deterministic.
    const summary = await prisma.meetingSummary.create({
      data: {
        meetingId: meeting.id,
        status: MeetingSummaryStatus.COMPLETED,
        summaryText: 'Ship the report by Friday.',
      },
    });
    const assignedTask = await prisma.meetingSummaryTask.create({
      data: { summaryId: summary.id, position: 0, title: 'Ship the report', assignee: 'Alice' },
    });
    const unassignedTask = await prisma.meetingSummaryTask.create({
      data: { summaryId: summary.id, position: 1, title: 'Review the deck', assignee: null },
    });
    const decision = await prisma.meetingSummaryDecision.create({
      data: { summaryId: summary.id, position: 0, text: 'Ship on Friday.' },
    });

    const response = await getSummary(meeting.id, owner).expect(200);

    expect(response.body).toMatchObject({
      status: 'ready',
      tasks: [
        { id: assignedTask.id, title: assignedTask.title, assignee: assignedTask.assignee },
        { id: unassignedTask.id, title: unassignedTask.title, assignee: null },
      ],
      decisions: [{ id: decision.id, text: decision.text }],
    });
  });

  it('rejects starting a second summary while one is already running', async () => {
    const owner = await registerUser();
    const meeting = await createMeeting(owner);
    await uploadTranscript(meeting.id, owner);
    // Seeded directly, never through the real model: this assertion is about
    // the conflict guard, not the runner, and must stay fast and deterministic.
    await prisma.meetingSummary.create({
      data: { meetingId: meeting.id, status: MeetingSummaryStatus.PROCESSING },
    });

    const response = await startSummary(meeting.id, owner).expect(409);

    expect(response.body).toMatchObject({ code: 'SUMMARY_ALREADY_RUNNING' });
  });

  it('hides the meeting from an outsider on both the start and the status route', async () => {
    const owner = await registerUser();
    const outsider = await registerUser();
    const meeting = await createMeeting(owner);

    const posted = await startSummary(meeting.id, outsider).expect(404);
    expect(posted.body).toMatchObject({ message: 'Meeting not found' });

    const got = await getSummary(meeting.id, outsider).expect(404);
    expect(got.body).toMatchObject({ message: 'Meeting not found' });
  });
});
