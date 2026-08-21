import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { PrismaClient, MeetingFileCategory, TranscriptionJobStatus } from '@prisma/client';

import {
  transcriptionFailureReasons,
  transcriptionStatusLabels,
} from '../app/meetings/[id]/transcription-status';

type Session = {
  accessToken: string;
  email: string;
  userId: string;
};

type Meeting = {
  id: string;
  title: string;
};

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const password = 'secure-password-123';
const prisma = new PrismaClient();
const createdUserIds = new Set<string>();
const createdMeetingIds = new Set<string>();
const createdFileIds = new Set<string>();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

function getUserId(accessToken: string): string {
  const payload = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString()) as {
    sub: string;
  };

  return payload.sub;
}

async function register(request: APIRequestContext, prefix: string): Promise<Session> {
  const email = uniqueEmail(prefix);
  const response = await request.post(`${apiUrl}/auth/register`, {
    data: { email, password },
  });
  expect(response.ok()).toBeTruthy();

  const { accessToken } = (await response.json()) as { accessToken: string };
  const userId = getUserId(accessToken);
  createdUserIds.add(userId);

  return { accessToken, email, userId };
}

async function createMeeting(request: APIRequestContext, owner: Session): Promise<Meeting> {
  const response = await request.post(`${apiUrl}/meetings`, {
    headers: { Authorization: `Bearer ${owner.accessToken}` },
    data: {
      title: `Расшифровка ${Date.now()}`,
      date: '2026-08-15T10:30:00.000Z',
    },
  });
  expect(response.ok()).toBeTruthy();

  const meeting = (await response.json()) as Meeting;
  createdMeetingIds.add(meeting.id);

  return meeting;
}

async function createFileWithJob(
  meeting: Meeting,
  owner: Session,
  options: {
    name: string;
    category: MeetingFileCategory;
    jobStatus: TranscriptionJobStatus;
    failureCode?: string;
  },
): Promise<void> {
  const file = await prisma.meetingFile.create({
    data: {
      meetingId: meeting.id,
      uploadedById: owner.userId,
      originalName: options.name,
      storageKey: `transcription-status-e2e/${meeting.id}/${options.name}`,
      category: options.category,
      mimeType: options.category === MeetingFileCategory.AUDIO ? 'audio/mpeg' : 'video/mp4',
      sizeBytes: 16,
    },
  });
  createdFileIds.add(file.id);

  await prisma.transcriptionJob.create({
    data: {
      sourceFileId: file.id,
      status: options.jobStatus,
      failureCode: options.failureCode,
    },
  });
}

async function authenticate(page: Page, session: Session): Promise<void> {
  await page.addInitScript(({ accessToken, email }) => {
    window.sessionStorage.setItem('accessToken', accessToken);
    window.sessionStorage.setItem('userEmail', email);
  }, session);
}

test.afterEach(async () => {
  const fileIds = [...createdFileIds];
  const meetingIds = [...createdMeetingIds];
  const userIds = [...createdUserIds];

  if (fileIds.length > 0) {
    await prisma.meetingFileDownloadTicket.deleteMany({ where: { fileId: { in: fileIds } } });
    await prisma.transcriptionJob.deleteMany({ where: { sourceFileId: { in: fileIds } } });
    await prisma.meetingFile.deleteMany({ where: { id: { in: fileIds } } });
  }

  if (meetingIds.length > 0) {
    await prisma.meeting.deleteMany({ where: { id: { in: meetingIds } } });
  }

  if (userIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }

  createdFileIds.clear();
  createdMeetingIds.clear();
  createdUserIds.clear();
});

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('shows the matching Russian label for each transcription status', async ({
  page,
  request,
}) => {
  const owner = await register(request, 'phase-7-transcription-status');
  const meeting = await createMeeting(request, owner);

  await createFileWithJob(meeting, owner, {
    name: 'phase-7-queued.mp3',
    category: MeetingFileCategory.AUDIO,
    jobStatus: TranscriptionJobStatus.QUEUED,
  });
  await createFileWithJob(meeting, owner, {
    name: 'phase-7-processing.mp3',
    category: MeetingFileCategory.AUDIO,
    jobStatus: TranscriptionJobStatus.PROCESSING,
  });
  await createFileWithJob(meeting, owner, {
    name: 'phase-7-completed.mp4',
    category: MeetingFileCategory.VIDEO,
    jobStatus: TranscriptionJobStatus.COMPLETED,
  });
  await createFileWithJob(meeting, owner, {
    name: 'phase-7-failed.mp4',
    category: MeetingFileCategory.VIDEO,
    jobStatus: TranscriptionJobStatus.FAILED,
    failureCode: 'NO_SPEECH_DETECTED',
  });

  await authenticate(page, owner);
  await page.goto(`/meetings/${meeting.id}`);

  const rowFor = (name: string) => page.getByRole('listitem').filter({ hasText: name });

  await expect(rowFor('phase-7-queued.mp3').getByTestId('transcription-status')).toHaveText(
    transcriptionStatusLabels.queued,
  );
  await expect(rowFor('phase-7-processing.mp3').getByTestId('transcription-status')).toHaveText(
    transcriptionStatusLabels.processing,
  );
  await expect(rowFor('phase-7-completed.mp4').getByTestId('transcription-status')).toHaveText(
    transcriptionStatusLabels.ready,
  );
  await expect(rowFor('phase-7-failed.mp4').getByTestId('transcription-status')).toHaveText(
    transcriptionStatusLabels.error,
  );
  await expect(rowFor('phase-7-failed.mp4').getByTestId('transcription-failure-reason')).toHaveText(
    transcriptionFailureReasons.NO_SPEECH_DETECTED,
  );
});

function countFileListRequests(page: Page, meeting: Meeting): () => number {
  let count = 0;
  page.on('request', (req) => {
    if (req.method() === 'GET' && req.url().includes(`/meetings/${meeting.id}/files`)) {
      count += 1;
    }
  });

  return () => count;
}

test('picks up transcription status changes and the new transcript file without a reload', async ({
  page,
  request,
}) => {
  const owner = await register(request, 'phase-8-transcription-poll');
  const meeting = await createMeeting(request, owner);

  const sourceFile = await prisma.meetingFile.create({
    data: {
      meetingId: meeting.id,
      uploadedById: owner.userId,
      originalName: 'phase-8-source.mp3',
      storageKey: `transcription-status-e2e/${meeting.id}/phase-8-source.mp3`,
      category: MeetingFileCategory.AUDIO,
      mimeType: 'audio/mpeg',
      sizeBytes: 16,
    },
  });
  createdFileIds.add(sourceFile.id);

  const job = await prisma.transcriptionJob.create({
    data: {
      sourceFileId: sourceFile.id,
      status: TranscriptionJobStatus.QUEUED,
    },
  });

  const requestCount = countFileListRequests(page, meeting);

  await authenticate(page, owner);
  await page.goto(`/meetings/${meeting.id}`);

  const sourceRow = page.getByRole('listitem').filter({ hasText: 'phase-8-source.mp3' });

  await expect(sourceRow.getByTestId('transcription-status')).toHaveText(
    transcriptionStatusLabels.queued,
  );

  await prisma.transcriptionJob.update({
    where: { id: job.id },
    data: { status: TranscriptionJobStatus.PROCESSING },
  });

  await expect(sourceRow.getByTestId('transcription-status')).toHaveText(
    transcriptionStatusLabels.processing,
    { timeout: 8000 },
  );

  await prisma.transcriptionJob.update({
    where: { id: job.id },
    data: { status: TranscriptionJobStatus.COMPLETED, finishedAt: new Date() },
  });

  const transcriptFile = await prisma.meetingFile.create({
    data: {
      meetingId: meeting.id,
      sourceFileId: sourceFile.id,
      uploadedById: null,
      originalName: 'phase-8-source.txt',
      storageKey: `transcription-status-e2e/${meeting.id}/phase-8-source.txt`,
      category: MeetingFileCategory.TRANSCRIPT,
      mimeType: 'text/plain',
      sizeBytes: 42,
    },
  });
  createdFileIds.add(transcriptFile.id);

  await expect(sourceRow.getByTestId('transcription-status')).toHaveText(
    transcriptionStatusLabels.ready,
    { timeout: 8000 },
  );

  await expect(page.getByRole('listitem').filter({ hasText: 'phase-8-source.txt' })).toBeVisible({
    timeout: 8000,
  });

  // The list has nothing left pending: the poll must not keep hitting the API
  // forever. Give it two poll intervals' worth of room, then check the count
  // is no longer climbing.
  const settledCount = requestCount();
  await page.waitForTimeout(9000);
  expect(requestCount()).toBe(settledCount);
});

test('stops polling and shows the access-lost screen when the meeting stops being visible mid-poll', async ({
  page,
  request,
}) => {
  const owner = await register(request, 'phase-9-transcription-poll-404');
  const meeting = await createMeeting(request, owner);

  await createFileWithJob(meeting, owner, {
    name: 'phase-9-source.mp3',
    category: MeetingFileCategory.AUDIO,
    jobStatus: TranscriptionJobStatus.QUEUED,
  });

  const requestCount = countFileListRequests(page, meeting);
  let pollsShouldFail = false;

  await page.route(`${apiUrl}/meetings/${meeting.id}/files`, async (route) => {
    if (pollsShouldFail) {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Meeting not found' }),
      });
      return;
    }

    await route.continue();
  });

  await authenticate(page, owner);
  await page.goto(`/meetings/${meeting.id}`);

  await expect(
    page
      .getByRole('listitem')
      .filter({ hasText: 'phase-9-source.mp3' })
      .getByTestId('transcription-status'),
  ).toHaveText(transcriptionStatusLabels.queued);

  // The initial load and the first poll already went through the route above
  // as a pass-through; only requests from here on should see the 404.
  pollsShouldFail = true;

  await expect(page.locator('p[role="alert"]')).toHaveText(
    'Встреча не найдена или у вас больше нет к ней доступа.',
    { timeout: 8000 },
  );

  const settledCount = requestCount();
  await page.waitForTimeout(9000);
  expect(requestCount()).toBe(settledCount);
});
