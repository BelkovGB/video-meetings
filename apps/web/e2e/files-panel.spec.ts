import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';

type Session = {
  accessToken: string;
  email: string;
  userId: string;
};

type Meeting = {
  id: string;
  title: string;
};

type UploadedFile = {
  id: string;
};

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const password = 'secure-password-123';
const prisma = new PrismaClient();
const createdUserIds = new Set<string>();
const createdMeetingIds = new Set<string>();
const createdFiles = new Map<string, { meetingId: string; ownerAccessToken: string }>();

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

async function createMeeting(
  request: APIRequestContext,
  owner: Session,
  title = `Файлы проекта ${Date.now()}`,
): Promise<Meeting> {
  const response = await request.post(`${apiUrl}/meetings`, {
    headers: { Authorization: `Bearer ${owner.accessToken}` },
    data: {
      title,
      date: '2026-08-15T10:30:00.000Z',
    },
  });
  expect(response.ok()).toBeTruthy();

  const meeting = (await response.json()) as Meeting;
  createdMeetingIds.add(meeting.id);

  return meeting;
}

async function uploadPdf(
  request: APIRequestContext,
  owner: Session,
  meeting: Meeting,
  options: { name?: string } = {},
): Promise<UploadedFile> {
  const response = await request.post(`${apiUrl}/meetings/${meeting.id}/files`, {
    headers: { Authorization: `Bearer ${owner.accessToken}` },
    multipart: {
      file: {
        name: options.name ?? 'phase-3-notes.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from('%PDF-1.7\nphase-3'),
      },
    },
  });
  expect(response.ok()).toBeTruthy();

  const uploaded = (await response.json()) as UploadedFile;
  createdFiles.set(uploaded.id, {
    meetingId: meeting.id,
    ownerAccessToken: owner.accessToken,
  });

  return uploaded;
}

async function createUserRecord(prefix: string): Promise<{ userId: string; email: string }> {
  const user = await prisma.user.create({
    data: { email: uniqueEmail(prefix), passwordHash: 'not-a-usable-hash' },
  });
  createdUserIds.add(user.id);

  return { userId: user.id, email: user.email };
}

async function createForeignMeeting(prefix: string): Promise<Meeting> {
  const outsider = await createUserRecord(prefix);
  const meeting = await prisma.meeting.create({
    data: {
      title: `Чужая встреча ${Date.now()}`,
      date: new Date('2026-08-15T10:30:00.000Z'),
      ownerId: outsider.userId,
    },
  });
  createdMeetingIds.add(meeting.id);

  return { id: meeting.id, title: meeting.title };
}

async function setDisplayName(
  request: APIRequestContext,
  session: Session,
  displayName: string,
): Promise<void> {
  const response = await request.patch(`${apiUrl}/users/me`, {
    headers: { Authorization: `Bearer ${session.accessToken}` },
    data: { displayName },
  });
  expect(response.ok()).toBeTruthy();
}

async function setAvatar(
  request: APIRequestContext,
  session: Session,
  buffer: Buffer,
): Promise<void> {
  const response = await request.post(`${apiUrl}/users/me/avatar`, {
    headers: { Authorization: `Bearer ${session.accessToken}` },
    multipart: { avatar: { name: 'avatar.png', mimeType: 'image/png', buffer } },
  });
  expect(response.ok()).toBeTruthy();
}

async function removeAvatar(request: APIRequestContext, session: Session): Promise<void> {
  const response = await request.delete(`${apiUrl}/users/me/avatar`, {
    headers: { Authorization: `Bearer ${session.accessToken}` },
  });
  expect(response.ok()).toBeTruthy();
}

async function addParticipant(meeting: Meeting, participant: Session): Promise<void> {
  await prisma.meetingParticipant.create({
    data: { meetingId: meeting.id, userId: participant.userId },
  });
}

async function authenticate(page: Page, session: Session): Promise<void> {
  await page.addInitScript(({ accessToken, email }) => {
    window.sessionStorage.setItem('accessToken', accessToken);
    window.sessionStorage.setItem('userEmail', email);
  }, session);
}

async function dropFile(
  page: Page,
  file: { name: string; mimeType: string; content: string; sizeBytes?: number },
): Promise<void> {
  await page.getByTestId('upload-dropzone').evaluate((dropzone, droppedFile) => {
    const browserFile = new File([droppedFile.content], droppedFile.name, {
      type: droppedFile.mimeType,
    });

    if (droppedFile.sizeBytes !== undefined) {
      Object.defineProperty(browserFile, 'size', { value: droppedFile.sizeBytes });
    }

    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(browserFile);
    dropzone.dispatchEvent(
      new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }),
    );
  }, file);
}

test.afterEach(async ({ request }) => {
  let fileCleanupError: Error | null = null;

  try {
    for (const [fileId, file] of createdFiles) {
      const response = await request.delete(
        `${apiUrl}/meetings/${file.meetingId}/files/${fileId}`,
        { headers: { Authorization: `Bearer ${file.ownerAccessToken}` } },
      );

      if (!response.ok() && response.status() !== 404 && !fileCleanupError) {
        fileCleanupError = new Error(
          `Unable to clean up meeting file ${fileId}: HTTP ${response.status()}`,
        );
      }
    }
  } catch (error) {
    fileCleanupError =
      error instanceof Error ? error : new Error('Unable to clean up meeting files');
  }

  try {
    const fileIds = [...createdFiles.keys()];
    const meetingIds = [...createdMeetingIds];
    const userIds = [...createdUserIds];

    if (fileIds.length > 0) {
      await prisma.meetingFileDownloadTicket.deleteMany({ where: { fileId: { in: fileIds } } });
      await prisma.meetingFile.deleteMany({ where: { id: { in: fileIds } } });
    }

    if (meetingIds.length > 0) {
      await prisma.meeting.deleteMany({ where: { id: { in: meetingIds } } });
    }

    if (userIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
  } finally {
    createdFiles.clear();
    createdMeetingIds.clear();
    createdUserIds.clear();
  }

  if (fileCleanupError) {
    throw fileCleanupError;
  }
});

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('meeting form shows validation errors in one shared summary', async ({ page, request }) => {
  const owner = await register(request, 'phase-3-date-validation');
  await authenticate(page, owner);

  let createRequestCount = 0;
  page.on('request', (browserRequest) => {
    if (browserRequest.method() === 'POST' && browserRequest.url() === `${apiUrl}/meetings`) {
      createRequestCount += 1;
    }
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Создать встречу' }).click();
  const titleInput = page.getByRole('textbox', { name: 'Название*' });
  await titleInput.focus();

  const dateInput = page.locator('input[type="datetime-local"]');
  await expect(dateInput).toHaveAttribute('min', '2000-01-01T00:00');
  await expect(dateInput).toHaveAttribute('max', '2100-12-31T23:59');
  await dateInput.focus();
  await page.getByRole('button', { name: 'Создать', exact: true }).click();

  const errorSummary = page.locator('#create-meeting-errors');
  await expect(errorSummary).toHaveCount(1);
  await expect(errorSummary).toContainText('Название: Введите название встречи.');
  await expect(errorSummary).toContainText('Дата и время: Укажите дату и время встречи.');

  await titleInput.fill('Проверка диапазона даты');
  await dateInput.fill('99999-09-09T09:59');
  await page.getByRole('button', { name: 'Создать', exact: true }).click();

  await expect(errorSummary).not.toContainText('Название:');
  await expect(errorSummary).toContainText('Дата и время: Укажите год с 2000 по 2100.');
  await expect(
    page.getByText('Не удалось создать встречу. Проверьте соединение и повторите попытку.'),
  ).toHaveCount(0);
  expect(createRequestCount).toBe(0);

  await page.route(`${apiUrl}/meetings`, async (route) => {
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'Сервис временно недоступен. Повторите попытку.' }),
    });
  });
  await dateInput.fill('2026-08-20T10:30');
  await page.getByRole('button', { name: 'Создать', exact: true }).click();

  await expect(errorSummary).toHaveCount(1);
  await expect(errorSummary).toContainText('Не удалось создать встречу');
  await expect(errorSummary).toContainText('Сервис временно недоступен. Повторите попытку.');
  expect(createRequestCount).toBe(1);

  // Field validation is the one rejection the API answers in English prose. The
  // dialog words its own guidance instead, so the server's sentence must not
  // reach the screen.
  await page.route(`${apiUrl}/meetings`, async (route) => {
    await route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({ message: ['title must not be empty'], code: 'VALIDATION_FAILED' }),
    });
  });
  await titleInput.fill('Проверка ответа валидации');
  await page.getByRole('button', { name: 'Создать', exact: true }).click();

  await expect(errorSummary).toContainText('Проверьте название и дату встречи.');
  await expect(page.getByText('title must not be empty')).toHaveCount(0);
});

test('uploads files by selection and drag-and-drop with progress and processing feedback', async ({
  page,
  request,
}) => {
  const owner = await register(request, 'phase-4-upload');
  const meeting = await createMeeting(request, owner);
  await authenticate(page, owner);
  await page.goto(`/meetings/${meeting.id}`);

  await expect(page.getByRole('region', { name: 'Загрузка файла' })).toBeVisible();
  await expect(page.getByTestId('upload-dropzone')).toContainText('Перетащите файл сюда');

  await page.route(`${apiUrl}/meetings/${meeting.id}/files`, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }

    const response = await route.fetch();
    const uploaded = (await response.json()) as UploadedFile;
    if (response.ok()) {
      createdFiles.set(uploaded.id, {
        meetingId: meeting.id,
        ownerAccessToken: owner.accessToken,
      });
    }
    await route.fulfill({ response });
  });

  const fileInput = page.locator('input[type="file"]');
  await expect(fileInput).toHaveAttribute('accept', /\.pdf/);
  await fileInput.setInputFiles({
    name: 'phase-4-selection.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.7\nselected'),
  });

  const progressbar = page.getByRole('progressbar', { name: 'Загрузка phase-4-selection.pdf' });
  await expect(progressbar).toBeVisible();
  await expect(page.getByText('Файл передан. Проверяем и сохраняем…')).toBeVisible();
  await expect(progressbar).toHaveAttribute('aria-valuenow', '100');
  await expect(page.getByRole('status')).toContainText('Файл «phase-4-selection.pdf» загружен.');
  await expect(
    page.getByRole('listitem').filter({ hasText: 'phase-4-selection.pdf' }),
  ).toBeVisible();

  await dropFile(page, {
    name: 'phase-4-drop.pdf',
    mimeType: 'application/pdf',
    content: '%PDF-1.7\ndropped',
  });

  await expect(page.getByRole('progressbar', { name: 'Загрузка phase-4-drop.pdf' })).toBeVisible();
  await expect(page.getByText('Файл передан. Проверяем и сохраняем…')).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Файл «phase-4-drop.pdf» загружен.');
  await expect(page.getByRole('listitem').filter({ hasText: 'phase-4-drop.pdf' })).toBeVisible();
});

test('rejects unsupported and oversized files before upload in one error area', async ({
  page,
  request,
}) => {
  const owner = await register(request, 'phase-4-validation');
  const meeting = await createMeeting(request, owner);
  await authenticate(page, owner);

  let uploadRequestCount = 0;
  page.on('request', (browserRequest) => {
    if (
      browserRequest.method() === 'POST' &&
      browserRequest.url() === `${apiUrl}/meetings/${meeting.id}/files`
    ) {
      uploadRequestCount += 1;
    }
  });

  await page.goto(`/meetings/${meeting.id}`);
  await page.locator('input[type="file"]').setInputFiles({
    name: 'malware.exe',
    mimeType: 'application/x-msdownload',
    buffer: Buffer.from('MZ'),
  });

  const errorAlert = page.locator('main').getByRole('alert');
  await expect(errorAlert).toHaveCount(1);
  await expect(errorAlert).toContainText(
    'Этот формат не поддерживается. Выберите аудио, видео, транскрипт, PDF или DOCX.',
  );
  expect(uploadRequestCount).toBe(0);

  await dropFile(page, {
    name: 'too-large.pdf',
    mimeType: 'application/pdf',
    content: '%PDF-1.7',
    sizeBytes: 1_073_741_825,
  });

  await expect(errorAlert).toHaveCount(1);
  await expect(errorAlert).toContainText('Файл больше 1 ГБ. Выберите файл размером до 1 ГБ.');
  expect(uploadRequestCount).toBe(0);
});

test('uploads an allowed file when the browser leaves its MIME type empty', async ({
  page,
  request,
}) => {
  const owner = await register(request, 'phase-4-empty-mime');
  const meeting = await createMeeting(request, owner);
  await authenticate(page, owner);
  await page.goto(`/meetings/${meeting.id}`);

  await page.route(`${apiUrl}/meetings/${meeting.id}/files`, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }

    const response = await route.fetch();
    const uploaded = (await response.json()) as UploadedFile;
    if (response.ok()) {
      createdFiles.set(uploaded.id, {
        meetingId: meeting.id,
        ownerAccessToken: owner.accessToken,
      });
    }
    await route.fulfill({ response });
  });

  await dropFile(page, {
    name: 'transcript.srt',
    mimeType: '',
    content: '1\n00:00:00,000 --> 00:00:01,000\nПривет\n',
  });

  await expect(page.getByRole('status')).toContainText('Файл «transcript.srt» загружен.');
  await expect(page.getByRole('listitem').filter({ hasText: 'transcript.srt' })).toBeVisible();
  await expect(page.locator('main').getByRole('alert')).toHaveCount(0);
});

test('keeps processing feedback visible until the server rejects the upload', async ({
  page,
  request,
}) => {
  const owner = await register(request, 'phase-4-server-error');
  const meeting = await createMeeting(request, owner);
  await authenticate(page, owner);
  await page.goto(`/meetings/${meeting.id}`);

  await page.route(`${apiUrl}/meetings/${meeting.id}/files`, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }

    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'STORAGE_UNAVAILABLE', message: 'Storage is unavailable' }),
    });
  });

  await page.locator('input[type="file"]').setInputFiles({
    name: 'server-rejection.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.7\nrejected'),
  });

  await expect(page.getByText('Файл передан. Проверяем и сохраняем…')).toBeVisible();
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  await expect(page.locator('main').getByRole('alert')).toContainText(
    'Хранилище временно недоступно. Попробуйте ещё раз.',
  );
  await expect(page.getByRole('listitem').filter({ hasText: 'server-rejection.pdf' })).toHaveCount(
    0,
  );
});

test('owner navigates to files, downloads metadata, and deletes with feedback', async ({
  page,
  request,
}) => {
  const owner = await register(request, 'phase-3-owner');
  const meeting = await createMeeting(request, owner);
  await uploadPdf(request, owner, meeting);
  await prisma.meeting.update({
    where: { id: meeting.id },
    data: { createdAt: new Date('2020-01-01T00:00:00.000Z') },
  });
  for (let index = 1; index <= 3; index += 1) {
    await createMeeting(request, owner, `Более новая встреча ${index} ${Date.now()}`);
  }
  await authenticate(page, owner);

  await page.goto('/');
  await page.getByRole('link', { name: `Открыть встречу ${meeting.title}` }).click();

  await expect(page).toHaveURL(`/meetings/${meeting.id}`);
  await expect(page.getByRole('heading', { name: meeting.title })).toBeVisible();
  await expect(page.getByText('Владелец')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Файлы встречи' })).toBeVisible();
  await expect(page.getByText('phase-3-notes.pdf')).toBeVisible();
  await expect(page.getByText('PDF-документ')).toBeVisible();
  await expect(page.getByText('16 Б')).toBeVisible();

  // A refused ticket is reported in the API's own words, through the shared
  // reader; only a body with nothing to say falls back to the file name.
  const ticketRoute = `**/meetings/${meeting.id}/files/*/download-ticket`;
  await page.route(ticketRoute, async (route) => {
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'Файл ещё обрабатывается. Повторите попытку позже.' }),
    });
  });
  await page.getByRole('button', { name: 'Скачать phase-3-notes.pdf' }).click();
  await expect(page.locator('main').getByRole('alert')).toHaveText(
    'Файл ещё обрабатывается. Повторите попытку позже.',
  );

  await page.unroute(ticketRoute);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать phase-3-notes.pdf' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('phase-3-notes.pdf');

  const deleteButton = page.getByRole('button', { name: 'Удалить phase-3-notes.pdf' });
  await deleteButton.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Удалить файл без возможности восстановления?')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Отмена' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(deleteButton).toBeFocused();

  // A rejection the server answers in HTML is still an answer: the screen says
  // the deletion failed, not that the connection did.
  const deleteRoute = `**/meetings/${meeting.id}/files/*`;
  await page.route(deleteRoute, async (route) => {
    if (route.request().method() !== 'DELETE') {
      await route.fallback();
      return;
    }

    await route.fulfill({ status: 500, contentType: 'text/html', body: '<html>500</html>' });
  });
  await deleteButton.click();
  await page.getByRole('button', { name: 'Подтвердить удаление phase-3-notes.pdf' }).click();

  await expect(page.locator('main').getByRole('alert')).toHaveText(
    'Не удалось удалить «phase-3-notes.pdf».',
  );
  await expect(page.getByRole('button', { name: 'Удалить phase-3-notes.pdf' })).toBeVisible();

  await page.unroute(deleteRoute);
  await page.getByRole('button', { name: 'Подтвердить удаление phase-3-notes.pdf' }).click();

  await expect(page.getByRole('button', { name: 'Удалить phase-3-notes.pdf' })).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('Файл «phase-3-notes.pdf» удалён');
  await expect(page.getByRole('status')).toBeFocused();
  await expect(page.getByText('У встречи пока нет файлов')).toBeVisible();
});

test('names the uploader of every file and shows none of it outside the meeting', async ({
  page,
  request,
}) => {
  const owner = await register(request, 'phase-6-uploader');
  const meeting = await createMeeting(request, owner);
  await setDisplayName(request, owner, 'Ада Лавлейс');
  const namedFile = await uploadPdf(request, owner, meeting, { name: 'phase-6-named.pdf' });
  const unnamedFile = await uploadPdf(request, owner, meeting, { name: 'phase-6-unnamed.pdf' });

  // The second uploader is created directly: every extra registration here
  // spends the shared per-IP auth rate limit that the whole suite runs against.
  const unnamedUploader = await createUserRecord('phase-6-uploader-unnamed');
  await prisma.meetingFile.update({
    where: { id: unnamedFile.id },
    data: { uploadedById: unnamedUploader.userId, createdAt: new Date('2026-08-14T10:00:00.000Z') },
  });
  // The row below is photographed, and its upload date is part of the picture.
  await prisma.meetingFile.update({
    where: { id: namedFile.id },
    data: { createdAt: new Date('2026-08-15T10:00:00.000Z') },
  });
  await authenticate(page, owner);

  await page.goto(`/meetings/${meeting.id}`);

  const namedRow = page.getByRole('listitem').filter({ hasText: 'phase-6-named.pdf' });
  const unnamedRow = page.getByRole('listitem').filter({ hasText: 'phase-6-unnamed.pdf' });
  await expect(namedRow).toContainText('Загрузил(а): Ада Лавлейс');
  await expect(unnamedRow).toContainText('Загрузил(а): участник без имени');

  // Naming the uploader is all this list does with the identity: no email, and
  // no way from here into a private profile.
  await expect(page.getByText(owner.email)).toHaveCount(0);
  await expect(page.getByText(unnamedUploader.email)).toHaveCount(0);
  await expect(namedRow.getByRole('link')).toHaveCount(0);

  await expect(namedRow).toHaveScreenshot('meeting-file-uploader-identity.png');

  // A deleted account leaves the file listed and downloadable, under an
  // identity that no longer names anyone.
  await prisma.user.delete({ where: { id: unnamedUploader.userId } });
  await page.reload();

  await expect(unnamedRow).toContainText('Загрузил(а): участник недоступен');
  await expect(
    unnamedRow.getByRole('button', { name: 'Скачать phase-6-unnamed.pdf' }),
  ).toBeVisible();

  const foreignMeeting = await createForeignMeeting('phase-6-uploader-outsider');
  await page.goto(`/meetings/${foreignMeeting.id}`);

  await expect(
    page.getByText('Встреча не найдена или у вас больше нет к ней доступа.'),
  ).toBeVisible();
  await expect(page.getByText('Ада Лавлейс')).toHaveCount(0);
});

test('shows the uploader avatar through the meeting, and falls back neutrally', async ({
  page,
  request,
}) => {
  // Two sizes tell the images apart: a replaced avatar keeps the same route and
  // the same blob: URL shape, and only the decoded picture changes.
  const firstAvatar = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGO4o6Z2R02NAUIBACNGBKHo5yw4AAAAAElFTkSuQmCC',
    'base64',
  );
  const replacementAvatar = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAMAAAADCAIAAADZSiLoAAAAEElEQVR4nGPgmLgJghiwsACosQukZ7GQBAAAAABJRU5ErkJggg==',
    'base64',
  );
  const owner = await register(request, 'phase-6-avatar');
  const meeting = await createMeeting(request, owner);
  await setDisplayName(request, owner, 'Ада Лавлейс');
  await setAvatar(request, owner, firstAvatar);
  const namedFile = await uploadPdf(request, owner, meeting, { name: 'phase-6-avatar.pdf' });
  const plainFile = await uploadPdf(request, owner, meeting, { name: 'phase-6-no-avatar.pdf' });

  const uploaderWithoutAvatar = await createUserRecord('phase-6-avatar-none');
  await prisma.meetingFile.update({
    where: { id: plainFile.id },
    data: {
      uploadedById: uploaderWithoutAvatar.userId,
      createdAt: new Date('2026-08-14T10:00:00.000Z'),
    },
  });
  // The row below is photographed, and its upload date is part of the picture.
  await prisma.meetingFile.update({
    where: { id: namedFile.id },
    data: { createdAt: new Date('2026-08-15T10:00:00.000Z') },
  });
  await authenticate(page, owner);

  await page.goto(`/meetings/${meeting.id}`);

  const namedRow = page.getByRole('listitem').filter({ hasText: 'phase-6-avatar.pdf' });
  const plainRow = page.getByRole('listitem').filter({ hasText: 'phase-6-no-avatar.pdf' });
  const namedAvatar = namedRow.getByTestId('meeting-file-uploader-avatar');
  const plainAvatar = plainRow.getByTestId('meeting-file-uploader-avatar');
  const decodedWidth = () =>
    namedAvatar.evaluate((element) => (element as HTMLImageElement).naturalWidth);

  await expect(namedAvatar).toHaveAccessibleName('Аватар: Ада Лавлейс');
  await expect(namedAvatar).toHaveAttribute('src', /^blob:/);
  await expect.poll(decodedWidth).toBe(2);

  // An uploader who never set an avatar gets the neutral fallback, and the
  // avatar adds no email and no way into a private profile.
  await expect(plainAvatar).toHaveAccessibleName('Аватар: участник без имени');
  await expect(plainAvatar).toHaveText('?');
  await expect(plainAvatar).not.toHaveAttribute('src');
  await expect(namedRow.getByRole('link')).toHaveCount(0);
  await expect(page.getByText(owner.email)).toHaveCount(0);

  await expect(namedRow).toHaveScreenshot('meeting-file-uploader-avatar.png');

  // A replacement reaches the historical file: the route is read again, not a
  // copy captured when the file was uploaded.
  await setAvatar(request, owner, replacementAvatar);
  await page.reload();

  await expect(namedAvatar).toHaveAttribute('src', /^blob:/);
  await expect.poll(decodedWidth).toBe(3);

  // A removal falls back to the initial without losing the uploader's name.
  await removeAvatar(request, owner);
  await page.reload();

  await expect(namedAvatar).toHaveAccessibleName('Аватар: Ада Лавлейс');
  await expect(namedAvatar).toHaveText('А');
  await expect(namedAvatar).not.toHaveAttribute('src');

  // A deleted uploading account leaves the file listed under an identity that
  // names nobody.
  await prisma.user.delete({ where: { id: uploaderWithoutAvatar.userId } });
  await page.reload();

  await expect(plainAvatar).toHaveAccessibleName('Аватар: участник недоступен');
  await expect(plainAvatar).toHaveText('?');

  // An image the browser cannot load falls back instead of showing a broken one.
  await setAvatar(request, owner, firstAvatar);
  await page.route('**/uploader-avatar', (route) => route.fulfill({ status: 500 }));
  await page.reload();

  await expect(namedAvatar).toHaveAccessibleName('Аватар: Ада Лавлейс');
  await expect(namedAvatar).toHaveText('А');
  await expect(namedAvatar).not.toHaveAttribute('src');
  await page.unroute('**/uploader-avatar');

  // Outside the meeting there is no authorized context, so there is no avatar.
  const foreignMeeting = await createForeignMeeting('phase-6-avatar-outsider');
  await page.goto(`/meetings/${foreignMeeting.id}`);

  await expect(
    page.getByText('Встреча не найдена или у вас больше нет к ней доступа.'),
  ).toBeVisible();
  await expect(page.getByTestId('meeting-file-uploader-avatar')).toHaveCount(0);
});

test('reads one uploader avatar for all of their rows, and drops it on leaving', async ({
  page,
  request,
}) => {
  const avatar = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGO4o6Z2R02NAUIBACNGBKHo5yw4AAAAAElFTkSuQmCC',
    'base64',
  );
  const owner = await register(request, 'phase-6-avatar-shared');
  const meeting = await createMeeting(request, owner);
  await setDisplayName(request, owner, 'Ада Лавлейс');
  await setAvatar(request, owner, avatar);
  for (const name of ['phase-6-shared-1.pdf', 'phase-6-shared-2.pdf', 'phase-6-shared-3.pdf']) {
    await uploadPdf(request, owner, meeting, { name });
  }
  await authenticate(page, owner);

  const avatarRequests: string[] = [];
  page.on('request', (sent) => {
    if (sent.method() === 'GET' && sent.url().includes('/uploader-avatar')) {
      avatarRequests.push(sent.url());
    }
  });

  await page.goto(`/meetings/${meeting.id}`);

  const avatars = page.getByTestId('meeting-file-uploader-avatar');
  await expect(avatars).toHaveCount(3);
  for (const index of [0, 1, 2]) {
    await expect(avatars.nth(index)).toHaveAttribute('src', /^blob:/);
  }

  // The rows differ only by file: the picture behind them is one download and
  // one decoded image, not one per row.
  const sources = await avatars.evaluateAll((elements) =>
    elements.map((element) => (element as HTMLImageElement).src),
  );
  expect(new Set(sources).size).toBe(1);
  expect(avatarRequests).toHaveLength(1);

  // Leaving the list while the image is still arriving stops the download,
  // instead of letting a page nobody is looking at finish it.
  await page.route('**/uploader-avatar', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    await route.fulfill({ status: 200, contentType: 'image/png', body: avatar }).catch(() => {});
  });
  const abandoned = page.waitForEvent('requestfailed', (failed) =>
    failed.url().includes('/uploader-avatar'),
  );
  await page.reload();
  await expect(avatars.first()).toBeVisible();
  await page.getByRole('link', { name: 'Все встречи' }).click();

  await expect(page).toHaveURL('/');
  expect((await abandoned).failure()?.errorText).toBeTruthy();
  await page.unroute('**/uploader-avatar');
});

test('participant can download but never sees the delete action', async ({ page, request }) => {
  const owner = await register(request, 'phase-3-shared-owner');
  const participant = await register(request, 'phase-3-participant');
  const meeting = await createMeeting(request, owner);
  await setDisplayName(request, owner, 'Ада Лавлейс');
  await setAvatar(
    request,
    owner,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGO4o6Z2R02NAUIBACNGBKHo5yw4AAAAAElFTkSuQmCC',
      'base64',
    ),
  );
  await uploadPdf(request, owner, meeting);
  await addParticipant(meeting, participant);
  await authenticate(page, participant);

  await page.goto('/');
  await page.getByRole('link', { name: `Открыть встречу ${meeting.title}` }).click();

  await expect(page).toHaveURL(`/meetings/${meeting.id}`);
  await expect(page.getByRole('heading', { name: meeting.title })).toBeVisible();
  await expect(page.getByText('Участник', { exact: true })).toBeVisible();
  await expect(page.getByText('phase-3-notes.pdf')).toBeVisible();
  const sharedRow = page.getByRole('listitem').filter({ hasText: 'phase-3-notes.pdf' });
  await expect(sharedRow).toContainText('Загрузил(а): Ада Лавлейс');
  // A participant is not the uploader, and still reads the avatar: the meeting
  // file is what authorizes it.
  await expect(sharedRow.getByTestId('meeting-file-uploader-avatar')).toHaveAttribute(
    'src',
    /^blob:/,
  );
  await expect(page.getByText(owner.email)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Скачать phase-3-notes.pdf' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Удалить phase-3-notes.pdf' })).toHaveCount(0);

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать phase-3-notes.pdf' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('phase-3-notes.pdf');
});
