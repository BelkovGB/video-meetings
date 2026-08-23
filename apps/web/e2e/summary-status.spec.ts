import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { PrismaClient, MeetingFileCategory, MeetingSummaryStatus } from '@prisma/client';

import { summaryFailureReasons, summaryStatusLabels } from '../app/meetings/[id]/summary-status';

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
      title: `Выжимка ${Date.now()}`,
      date: '2026-08-15T10:30:00.000Z',
    },
  });
  expect(response.ok()).toBeTruthy();

  const meeting = (await response.json()) as Meeting;
  createdMeetingIds.add(meeting.id);

  return meeting;
}

async function createTranscriptFile(meeting: Meeting, owner: Session, name: string): Promise<void> {
  const file = await prisma.meetingFile.create({
    data: {
      meetingId: meeting.id,
      uploadedById: owner.userId,
      originalName: name,
      storageKey: `summary-status-e2e/${meeting.id}/${name}`,
      category: MeetingFileCategory.TRANSCRIPT,
      mimeType: 'text/plain',
      sizeBytes: 16,
    },
  });
  createdFileIds.add(file.id);
}

async function authenticate(page: Page, session: Session): Promise<void> {
  await page.addInitScript(({ accessToken, email }) => {
    window.sessionStorage.setItem('accessToken', accessToken);
    window.sessionStorage.setItem('userEmail', email);
  }, session);
}

function countSummaryRequests(page: Page, meeting: Meeting): () => number {
  let count = 0;
  page.on('request', (req) => {
    if (req.method() === 'GET' && req.url().includes(`/meetings/${meeting.id}/summary`)) {
      count += 1;
    }
  });

  return () => count;
}

test.afterEach(async () => {
  const meetingIds = [...createdMeetingIds];
  const fileIds = [...createdFileIds];
  const userIds = [...createdUserIds];

  if (meetingIds.length > 0) {
    await prisma.meetingSummaryTask.deleteMany({
      where: { summary: { meetingId: { in: meetingIds } } },
    });
    await prisma.meetingSummaryDecision.deleteMany({
      where: { summary: { meetingId: { in: meetingIds } } },
    });
    await prisma.meetingSummary.deleteMany({ where: { meetingId: { in: meetingIds } } });
  }

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

test('shows the matching Russian label for each meeting-summary status', async ({
  page,
  request,
}) => {
  const owner = await register(request, 'summary-status-labels');
  const meeting = await createMeeting(request, owner);

  const row = await prisma.meetingSummary.create({
    data: { meetingId: meeting.id, status: MeetingSummaryStatus.QUEUED },
  });

  await authenticate(page, owner);
  await page.goto(`/meetings/${meeting.id}`);

  await expect(page.getByTestId('summary-status')).toHaveText(summaryStatusLabels.queued);

  await prisma.meetingSummary.update({
    where: { id: row.id },
    data: { status: MeetingSummaryStatus.PROCESSING },
  });
  await page.reload();

  await expect(page.getByTestId('summary-status')).toHaveText(summaryStatusLabels.processing);

  await prisma.meetingSummary.update({
    where: { id: row.id },
    data: {
      status: MeetingSummaryStatus.COMPLETED,
      summaryText: 'Итоговая выжимка встречи для проверки статической разметки.',
    },
  });
  await page.reload();

  // The "ready" status paragraph is never rendered: the panel shows the
  // summary text itself instead of a status label once the job completes.
  await expect(page.getByTestId('summary-status')).toHaveCount(0);
  await expect(page.getByTestId('summary-text')).toHaveText(
    'Итоговая выжимка встречи для проверки статической разметки.',
  );

  await prisma.meetingSummary.update({
    where: { id: row.id },
    data: {
      status: MeetingSummaryStatus.FAILED,
      summaryText: null,
      failureCode: 'MODEL_OUTPUT_INVALID',
    },
  });
  await page.reload();

  await expect(page.getByTestId('summary-status')).toHaveText(summaryStatusLabels.error);
  await expect(page.getByTestId('summary-failure-reason')).toHaveText(
    summaryFailureReasons.MODEL_OUTPUT_INVALID,
  );
});

test('picks up meeting-summary status changes without a reload and stops polling once ready', async ({
  page,
  request,
}) => {
  const owner = await register(request, 'summary-status-poll');
  const meeting = await createMeeting(request, owner);

  const row = await prisma.meetingSummary.create({
    data: { meetingId: meeting.id, status: MeetingSummaryStatus.QUEUED },
  });

  const requestCount = countSummaryRequests(page, meeting);

  await authenticate(page, owner);
  await page.goto(`/meetings/${meeting.id}`);

  await expect(page.getByTestId('summary-status')).toHaveText(summaryStatusLabels.queued);

  await prisma.meetingSummary.update({
    where: { id: row.id },
    data: { status: MeetingSummaryStatus.PROCESSING },
  });

  await expect(page.getByTestId('summary-status')).toHaveText(summaryStatusLabels.processing, {
    timeout: 8000,
  });

  await prisma.meetingSummary.update({
    where: { id: row.id },
    data: {
      status: MeetingSummaryStatus.COMPLETED,
      summaryText: 'Готовая выжимка появилась без перезагрузки страницы.',
    },
  });

  // The "ready" status paragraph is never rendered: the panel shows the
  // summary text itself instead of a status label once the job completes.
  await expect(page.getByTestId('summary-text')).toHaveText(
    'Готовая выжимка появилась без перезагрузки страницы.',
    { timeout: 8000 },
  );
  await expect(page.getByTestId('summary-status')).toHaveCount(0);

  // The status has nothing left pending: the poll must not keep hitting the
  // API forever. Give it two poll intervals' worth of room, then check the
  // count is no longer climbing.
  const settledCount = requestCount();
  await page.waitForTimeout(9000);
  expect(requestCount()).toBe(settledCount);
});

test('stops polling the summary when access is lost mid-poll', async ({ page, request }) => {
  const owner = await register(request, 'summary-status-poll-404');
  const meeting = await createMeeting(request, owner);

  await prisma.meetingSummary.create({
    data: { meetingId: meeting.id, status: MeetingSummaryStatus.QUEUED },
  });

  const requestCount = countSummaryRequests(page, meeting);
  let pollsShouldFail = false;

  await page.route(`${apiUrl}/meetings/${meeting.id}/summary`, async (route) => {
    if (route.request().method() === 'GET' && pollsShouldFail) {
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

  await expect(page.getByTestId('summary-status')).toHaveText(summaryStatusLabels.queued);

  // The initial load already went through the route above as a pass-through;
  // only requests from here on should see the 404.
  pollsShouldFail = true;

  // useMeetingSummary's own "stop polling on 403/404" flag is internal to the
  // hook (unlike useMeetingFiles', it is never returned to the component), so
  // a lost summary poll has no page-level alert to wait on. Give one poll
  // interval room for the failing request to land and the hook to stop
  // scheduling further ones, then check the count settles.
  await page.waitForTimeout(5000);
  const settledCount = requestCount();
  await page.waitForTimeout(9000);
  expect(requestCount()).toBe(settledCount);

  // The panel keeps showing the last known status rather than blanking out,
  // and the meeting page itself never learns the summary lost access, so the
  // shared "meeting not found" alert (owned by useMeetingFiles) stays absent.
  await expect(page.getByTestId('summary-status')).toHaveText(summaryStatusLabels.queued);
  await expect(
    page.getByText('Встреча не найдена или у вас больше нет к ней доступа.'),
  ).toHaveCount(0);
});

test('disables the start button until the meeting has a transcript', async ({ page, request }) => {
  const owner = await register(request, 'summary-status-no-transcript');
  const meeting = await createMeeting(request, owner);

  await authenticate(page, owner);
  await page.goto(`/meetings/${meeting.id}`);

  await expect(page.getByTestId('summary-start-hint')).toHaveText('Ждём расшифровку.');
  await expect(page.getByRole('button', { name: 'Обновить выжимку' })).toBeDisabled();
});

test('starts a summary run and shows the queued status immediately', async ({ page, request }) => {
  const owner = await register(request, 'summary-status-start');
  const meeting = await createMeeting(request, owner);
  await createTranscriptFile(meeting, owner, 'summary-status-start.txt');

  await authenticate(page, owner);
  await page.goto(`/meetings/${meeting.id}`);

  const startButton = page.getByRole('button', { name: 'Обновить выжимку' });
  await expect(startButton).toBeEnabled();
  await expect(page.getByTestId('summary-start-hint')).toHaveCount(0);

  await startButton.click();

  await expect(page.getByTestId('summary-status')).toHaveText(summaryStatusLabels.queued);
});

test('renders each task with its assignee (or "not named") and each decision in the ready state', async ({
  page,
  request,
}) => {
  const owner = await register(request, 'summary-status-tasks');
  const meeting = await createMeeting(request, owner);

  const row = await prisma.meetingSummary.create({
    data: {
      meetingId: meeting.id,
      status: MeetingSummaryStatus.COMPLETED,
      summaryText: 'Выжимка встречи с задачами и решениями.',
    },
  });

  await prisma.meetingSummaryTask.create({
    data: {
      summaryId: row.id,
      title: 'Подготовить черновик договора',
      assignee: 'Мария Иванова',
      position: 0,
    },
  });
  await prisma.meetingSummaryTask.create({
    data: {
      summaryId: row.id,
      title: 'Согласовать бюджет на следующий квартал',
      assignee: null,
      position: 1,
    },
  });

  await prisma.meetingSummaryDecision.create({
    data: { summaryId: row.id, text: 'Перенести запуск на вторник.', position: 0 },
  });
  await prisma.meetingSummaryDecision.create({
    data: { summaryId: row.id, text: 'Выбрать нового подрядчика для интеграции.', position: 1 },
  });

  await authenticate(page, owner);
  await page.goto(`/meetings/${meeting.id}`);

  await expect(page.getByTestId('summary-tasks')).toBeVisible();

  const assignedTask = page
    .getByTestId('summary-task')
    .filter({ hasText: 'Подготовить черновик договора' });
  await expect(assignedTask).toContainText('Мария Иванова');

  const unassignedTask = page
    .getByTestId('summary-task')
    .filter({ hasText: 'Согласовать бюджет на следующий квартал' });
  await expect(unassignedTask).toContainText('не назначен');

  await expect(page.getByTestId('summary-decisions')).toBeVisible();
  await expect(
    page.getByTestId('summary-decision').filter({ hasText: 'Перенести запуск на вторник.' }),
  ).toBeVisible();
  await expect(
    page
      .getByTestId('summary-decision')
      .filter({ hasText: 'Выбрать нового подрядчика для интеграции.' }),
  ).toBeVisible();
});

test('omits the tasks and decisions blocks when a completed summary has neither', async ({
  page,
  request,
}) => {
  const owner = await register(request, 'summary-status-empty-lists');
  const meeting = await createMeeting(request, owner);

  await prisma.meetingSummary.create({
    data: {
      meetingId: meeting.id,
      status: MeetingSummaryStatus.COMPLETED,
      summaryText: 'Выжимка встречи без задач и решений.',
    },
  });

  await authenticate(page, owner);
  await page.goto(`/meetings/${meeting.id}`);

  await expect(page.getByTestId('summary-text')).toHaveText('Выжимка встречи без задач и решений.');
  await expect(page.getByTestId('summary-tasks')).toHaveCount(0);
  await expect(page.getByTestId('summary-decisions')).toHaveCount(0);
});
