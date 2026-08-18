import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { createHmac } from 'node:crypto';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';

type Session = {
  accessToken: string;
  email: string;
  userId: string;
};

type Meeting = {
  id: string;
  title: string;
};

loadEnvFile(resolve(__dirname, '../../../.env'));

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const password = 'secure-password-123';
const prisma = new PrismaClient();
const createdUserIds = new Set<string>();
const createdMeetingIds = new Set<string>();
let testClientAddress = 1;

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

function getUserId(accessToken: string): string {
  const payload = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString()) as {
    sub: string;
  };

  return payload.sub;
}

function createExpiredAccessToken(accessToken: string): string {
  const [header, encodedPayload] = accessToken.split('.');
  const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString()) as Record<
    string,
    unknown
  >;
  const jwtSecret = process.env.JWT_SECRET;

  if (!jwtSecret) {
    throw new Error('JWT_SECRET is required to create an expired access token');
  }

  const expiredPayload = Buffer.from(
    JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) - 60 }),
  ).toString('base64url');
  const signingInput = `${header}.${expiredPayload}`;
  const signature = createHmac('sha256', jwtSecret).update(signingInput).digest('base64url');

  return `${signingInput}.${signature}`;
}

async function register(request: APIRequestContext, prefix: string): Promise<Session> {
  const email = uniqueEmail(prefix);
  const response = await request.post(`${apiUrl}/auth/register`, {
    headers: { 'X-Forwarded-For': `198.51.100.${testClientAddress++}` },
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
    data: { title: `Встреча после смены пароля ${Date.now()}`, date: '2026-08-15T10:30:00.000Z' },
  });
  expect(response.ok()).toBeTruthy();

  const meeting = (await response.json()) as Meeting;
  createdMeetingIds.add(meeting.id);

  return meeting;
}

async function authenticate(page: Page, session: Session): Promise<void> {
  await page.addInitScript(({ accessToken, email }) => {
    window.sessionStorage.setItem('accessToken', accessToken);
    window.sessionStorage.setItem('userEmail', email);
  }, session);
}

// Lets a focus move that the page deferred with `requestAnimationFrame` land
// before the next assertion. Two frames because the React effect that schedules
// it is passive: the first `evaluate` round trip gives that effect its task, the
// wait itself covers the frame the callback runs in.
async function settleAnimationFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

test.afterAll(async () => {
  await prisma.meeting.deleteMany({ where: { id: { in: [...createdMeetingIds] } } });
  await prisma.user.deleteMany({ where: { id: { in: [...createdUserIds] } } });
  await prisma.$disconnect();
});

test('renders the current-user avatar with accessible image and fallback states', async ({
  page,
  request,
}) => {
  const session = await register(request, 'profile-avatar');
  const avatarImage = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL9HwAAAABJRU5ErkJggg==',
    'base64',
  );
  const invalidAvatarImage = Buffer.from('not a decodable image');
  let profileResponse: { displayName: string | null; avatar: object | null } = {
    displayName: 'Алексей',
    avatar: {
      mimeType: 'image/png',
      sizeBytes: avatarImage.length,
      updatedAt: new Date().toISOString(),
    },
  };
  let avatarResponse: 'image' | 'request-error' | 'load-error' = 'image';

  await page.addInitScript(() => {
    const revokedObjectUrls: string[] = [];
    const revokeObjectUrl = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url) => {
      revokedObjectUrls.push(url);
      revokeObjectUrl(url);
    };
    (window as Window & { __revokedObjectUrls?: string[] }).__revokedObjectUrls = revokedObjectUrls;
  });

  await page.route('**/users/me', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ email: session.email, ...profileResponse }),
    });
  });
  await page.route('**/users/me/avatar', async (route) => {
    if (avatarResponse === 'request-error') {
      await route.fulfill({ status: 500 });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: avatarResponse === 'load-error' ? invalidAvatarImage : avatarImage,
    });
  });
  await authenticate(page, session);

  await page.goto('/profile');
  const avatar = page.getByTestId('current-user-avatar');
  await expect(avatar).toHaveAccessibleName('Аватар пользователя Алексей');
  await expect(avatar).toHaveAttribute('src', /^blob:/);
  await expect(avatar).toHaveScreenshot('current-user-avatar-image.png');

  await page.goto('/');
  const accountEntry = page.locator('a[href="/profile"]');
  await expect(
    accountEntry.getByRole('img', { name: 'Аватар пользователя Алексей' }),
  ).toHaveAttribute('src', /^blob:/);
  await expect(accountEntry).toHaveScreenshot('dashboard-account-entry.png');
  await expect(page.locator('header')).toHaveScreenshot('dashboard-account-header.png');
  await page.keyboard.press('Tab');
  await expect(accountEntry).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL('/profile');

  profileResponse = { displayName: 'Нина', avatar: null };
  await page.goto('/profile');
  await expect(avatar).toHaveAccessibleName('Аватар пользователя Нина');
  await expect(avatar).toHaveText('Н');
  await expect(avatar).not.toHaveAttribute('src');

  profileResponse = {
    displayName: 'Мария',
    avatar: {
      mimeType: 'image/png',
      sizeBytes: avatarImage.length,
      updatedAt: new Date().toISOString(),
    },
  };
  avatarResponse = 'request-error';
  await page.reload();
  await expect(avatar).toHaveAccessibleName('Аватар пользователя Мария');
  await expect(avatar).toHaveText('М');
  await expect(avatar).not.toHaveAttribute('src');

  avatarResponse = 'load-error';
  await page.reload();
  await expect(avatar).toHaveAccessibleName('Аватар пользователя Мария');
  await expect(avatar).toHaveText('М');
  await expect(avatar).not.toHaveAttribute('src');
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as Window & { __revokedObjectUrls?: string[] }).__revokedObjectUrls?.length,
      ),
    )
    .toBeGreaterThan(0);
  await expect(avatar).toHaveScreenshot('current-user-avatar-load-error-fallback.png', {
    // Glyph anti-aliasing differs slightly between the Windows authoring browser
    // and the Linux CI browser. Keep the visual assertion while allowing that
    // platform-specific rasterization variance.
    maxDiffPixels: 120,
  });

  profileResponse = { displayName: null, avatar: null };
  await page.reload();
  await expect(avatar).toHaveAccessibleName('Аватар пользователя, имя не указано');
  await expect(avatar).toHaveText('?');
});

test('uploads, previews, replaces, validates, and synchronizes the current-user avatar', async ({
  page,
  request,
}) => {
  const session = await register(request, 'profile-avatar-upload');
  const image = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL9HwAAAABJRU5ErkJggg==',
    'base64',
  );
  const firstAvatar = {
    mimeType: 'image/png',
    sizeBytes: image.length,
    updatedAt: '2026-08-15T10:00:00.000Z',
  };
  const replacementAvatar = { ...firstAvatar, updatedAt: '2026-08-15T10:01:00.000Z' };
  let avatar = null as typeof firstAvatar | null;
  let failUpload = false;

  await page.route('**/users/me', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ email: session.email, displayName: 'Алексей', avatar }),
    });
  });
  await page.route('**/users/me/avatar', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'image/png', body: image });
      return;
    }
    if (failUpload) {
      await route.fulfill({
        status: 422,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Сервер отклонил аватар.' }),
      });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    avatar = avatar ? replacementAvatar : firstAvatar;
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify(avatar),
    });
  });
  await authenticate(page, session);
  await page.goto('/profile');

  const avatarInput = page.getByLabel('Выбрать файл аватара');
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(avatarInput).toBeFocused();
  await avatarInput.setInputFiles({ name: 'avatar.png', mimeType: 'image/png', buffer: image });
  await expect(page.getByTestId('avatar-preview')).toHaveAttribute('src', /^blob:/);
  await expect(page.getByTestId('avatar-preview-panel')).toHaveScreenshot(
    'avatar-preview-panel.png',
  );
  await page.getByRole('button', { name: 'Загрузить аватар' }).click();
  await expect(page.getByRole('button', { name: 'Загружаем аватар…' })).toBeDisabled();
  await expect(avatarInput).toBeDisabled();
  await expect(page.getByText('Аватар сохранён.', { exact: true })).toBeVisible();
  await expect(page.getByTestId('current-user-avatar')).toHaveAttribute('src', /^blob:/);
  await expect(page.getByLabel('Email')).toHaveText(session.email);

  await avatarInput.setInputFiles({ name: 'avatar-2.png', mimeType: 'image/png', buffer: image });
  await page.getByRole('button', { name: 'Заменить аватар' }).click();
  await expect(page.getByText('Аватар обновлён.', { exact: true })).toBeVisible();

  await avatarInput.setInputFiles({ name: 'avatar.txt', mimeType: 'text/plain', buffer: image });
  await expect(page.locator('#avatar-upload-error')).toContainText(
    'Выберите изображение в формате JPEG, PNG или WebP.',
  );
  await expect(avatarInput).toBeFocused();
  await expect(page.getByTestId('current-user-avatar')).toHaveAttribute('src', /^blob:/);

  await avatarInput.setInputFiles({
    name: 'large.png',
    mimeType: 'image/png',
    buffer: Buffer.alloc(5 * 1024 * 1024 + 1),
  });
  await expect(page.locator('#avatar-upload-error')).toContainText(
    'Размер файла не должен превышать 5 МБ.',
  );

  failUpload = true;
  await avatarInput.setInputFiles({ name: 'avatar-3.png', mimeType: 'image/png', buffer: image });
  await page.getByRole('button', { name: 'Заменить аватар' }).click();
  await expect(page.locator('#avatar-upload-error')).toContainText('Сервер отклонил аватар.');
  await expect(page.getByTestId('current-user-avatar')).toHaveAttribute('src', /^blob:/);

  await page.getByRole('link', { name: 'К встречам' }).click();
  await expect(
    page.locator('a[href="/profile"]').getByTestId('current-user-avatar'),
  ).toHaveAttribute('src', /^blob:/);
});

test('removes an avatar with recovery on failure and synchronizes the fallback identity', async ({
  page,
  request,
}) => {
  const session = await register(request, 'profile-avatar-removal');
  const image = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL9HwAAAABJRU5ErkJggg==',
    'base64',
  );
  const savedAvatar = {
    mimeType: 'image/png',
    sizeBytes: image.length,
    updatedAt: '2026-08-15T10:00:00.000Z',
  };
  let avatar: typeof savedAvatar | null = savedAvatar;
  let shouldFailRemoval = true;

  await page.route('**/users/me', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ email: session.email, displayName: 'Алексей', avatar }),
    });
  });
  await page.route('**/users/me/avatar', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'image/png', body: image });
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
    if (shouldFailRemoval) {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Не удалось удалить аватар.' }),
      });
      return;
    }

    avatar = null;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ email: session.email, displayName: 'Алексей', avatar }),
    });
  });
  await authenticate(page, session);
  await page.goto('/profile');

  const removeButton = page.getByRole('button', { name: 'Удалить аватар' });
  await expect(removeButton).toBeVisible();
  await expect(page.getByTestId('current-user-avatar')).toHaveAttribute('src', /^blob:/);
  await expect(page.getByTestId('avatar-controls')).toHaveScreenshot(
    'avatar-removal-controls.png',
    {
      // Linux CI renders the native file input differently from the Windows
      // authoring browser; the widest observed difference is 2,816 pixels.
      // This retains the visual guard around the control and button while
      // allowing the platform-owned native control rasterization variance.
      maxDiffPixels: 3000,
    },
  );
  await removeButton.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Удаляем аватар…' })).toBeDisabled();
  await expect(page.getByLabel('Выбрать файл аватара')).toBeDisabled();
  await expect(page.locator('#avatar-upload-error')).toHaveText('Не удалось удалить аватар.');
  await expect(removeButton).toBeFocused();
  await expect(page.getByTestId('current-user-avatar')).toHaveAttribute('src', /^blob:/);

  shouldFailRemoval = false;
  await removeButton.click();
  await expect(page.locator('#avatar-upload-status')).toHaveText('Аватар удалён.');
  await expect(page.locator('#avatar-upload-status')).toBeFocused();
  await expect(page.getByTestId('current-user-avatar')).toHaveText('А');
  await expect(page.getByTestId('current-user-avatar')).not.toHaveAttribute('src');
  await expect(removeButton).toHaveCount(0);
  await expect(page.getByLabel('Email')).toHaveText(session.email);
  await expect(page.getByLabel('Отображаемое имя')).toHaveValue('Алексей');

  await page.getByRole('link', { name: 'К встречам' }).click();
  await expect(page.locator('a[href="/profile"]').getByTestId('current-user-avatar')).toHaveText(
    'А',
  );
  await expect(
    page.locator('a[href="/profile"]').getByTestId('current-user-avatar'),
  ).not.toHaveAttribute('src');
});

test('manages the display name while preserving saved profile details', async ({
  page,
  request,
}) => {
  const session = await register(request, 'profile-overview');
  await prisma.user.update({ where: { id: session.userId }, data: { displayName: 'Алексей' } });
  await authenticate(page, session);

  await page.goto('/');
  await page.getByRole('link', { name: 'Открыть профиль' }).click();

  await expect(page).toHaveURL('/profile');
  await expect(page.getByRole('heading', { name: 'Профиль' })).toBeVisible();
  await expect(page.getByLabel('Отображаемое имя')).toHaveValue('Алексей');
  await expect(page.getByLabel('Email')).toHaveText(session.email);
  await expect(page.getByRole('button', { name: /изменить email/i })).toHaveCount(0);

  const meetingsLink = page.getByRole('link', { name: 'К встречам' });
  await meetingsLink.focus();
  await expect(meetingsLink).toBeFocused();
  const displayNameInput = page.getByLabel('Отображаемое имя');
  await displayNameInput.fill('   ');
  await page.getByRole('button', { name: 'Сохранить имя' }).click();

  await expect(page.locator('#display-name-error')).toHaveText('Введите имя от 1 до 100 символов.');
  await expect(displayNameInput).toBeFocused();
  await expect(page.getByText('Алексей', { exact: true })).toHaveCount(1);

  await displayNameInput.fill('x'.repeat(101));
  await page.getByRole('button', { name: 'Сохранить имя' }).click();
  await expect(page.locator('#display-name-error')).toHaveText('Введите имя от 1 до 100 символов.');
  await expect(page.getByText('Алексей', { exact: true })).toHaveCount(1);

  await page.route('**/users/me', async (route) => {
    if (route.request().method() !== 'PATCH') {
      await route.continue();
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'Имя отклонено сервером.' }),
    });
  });

  await displayNameInput.fill('Отклонённое имя');
  await page.getByRole('button', { name: 'Сохранить имя' }).click();
  await expect(page.getByRole('button', { name: 'Сохраняем имя…' })).toBeDisabled();
  await expect(displayNameInput).toBeDisabled();
  await expect(page.locator('#display-name-error')).toHaveText('Имя отклонено сервером.');
  await expect(displayNameInput).toBeFocused();
  await expect(page.getByText('Алексей', { exact: true })).toHaveCount(1);

  await page.unroute('**/users/me');
  await displayNameInput.fill('  Новое имя  ');
  await page.getByRole('button', { name: 'Сохранить имя' }).click();

  await expect(page.locator('#display-name-status')).toHaveText('Имя «Новое имя» сохранено.');
  await expect(page.locator('#display-name-status')).toBeFocused();
  await expect(displayNameInput).toHaveValue('Новое имя');
  await expect(page.getByText('Новое имя', { exact: true })).toHaveCount(1);
});

test('synchronizes the saved display name with the dashboard identity and keeps the email fallback', async ({
  page,
  request,
}) => {
  const session = await register(request, 'profile-identity-sync');
  await authenticate(page, session);

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Рады видеть вас.' })).toContainText(
    session.email,
  );

  await page.getByRole('link', { name: 'Открыть профиль' }).click();
  const displayNameInput = page.getByLabel('Отображаемое имя');
  await displayNameInput.fill('Мария');
  await page.getByRole('button', { name: 'Сохранить имя' }).click();

  await expect(page.locator('#display-name-status')).toHaveText('Имя «Мария» сохранено.');
  await expect(page.getByText('Мария', { exact: true })).toHaveCount(1);

  await page.getByRole('link', { name: 'К встречам' }).click();
  await expect(page.getByRole('heading', { name: 'Рады видеть вас.' })).toContainText('Мария');
  await expect(page.getByRole('heading', { name: 'Рады видеть вас.' })).not.toContainText(
    session.email,
  );
});

test('falls back to a recoverable sentence when the API error body carries no message', async ({
  page,
  request,
}) => {
  const session = await register(request, 'profile-empty-error-body');
  await authenticate(page, session);
  // The four bodies an API can answer with while still saying nothing usable:
  // an empty validation array element, a message of the wrong shape, a
  // validation element of the wrong shape, and prose that is not JSON at all.
  // None of them may reach the screen as a blank error.
  let rejectionBody = JSON.stringify({ message: [''] });

  await page.route('**/users/me', async (route) => {
    if (route.request().method() !== 'PATCH') {
      await route.continue();
      return;
    }

    await route.fulfill({ status: 400, contentType: 'application/json', body: rejectionBody });
  });

  await page.goto('/profile');
  const displayNameInput = page.getByLabel('Отображаемое имя');
  const fallback = 'Не удалось сохранить имя. Исправьте значение и повторите попытку.';

  await displayNameInput.fill('Пустой ответ');
  await page.getByRole('button', { name: 'Сохранить имя' }).click();
  await expect(page.locator('#display-name-error')).toHaveText(fallback);

  rejectionBody = JSON.stringify({ message: { detail: 'rejected' } });
  await displayNameInput.fill('Ответ не той формы');
  await page.getByRole('button', { name: 'Сохранить имя' }).click();
  await expect(page.locator('#display-name-error')).toHaveText(fallback);

  // An object inside the validation array is the shape a differently configured
  // validation pipe emits. Returned as-is it would reach React as a child and
  // take the screen down instead of leaving the form recoverable.
  rejectionBody = JSON.stringify({ message: [{ detail: 'rejected' }] });
  await displayNameInput.fill('Элемент не той формы');
  await page.getByRole('button', { name: 'Сохранить имя' }).click();
  await expect(page.locator('#display-name-error')).toHaveText(fallback);

  rejectionBody = 'Bad Request';
  await displayNameInput.fill('Ответ не JSON');
  await page.getByRole('button', { name: 'Сохранить имя' }).click();
  await expect(page.locator('#display-name-error')).toHaveText(fallback);
  await expect(displayNameInput).toBeFocused();
});

test('does not let stale dashboard hydration overwrite a newly saved display name', async ({
  page,
  request,
}) => {
  const session = await register(request, 'profile-stale-identity-sync');
  let releaseStaleDashboardResponse: (() => void) | undefined;
  const staleDashboardResponse = new Promise<void>((resolve) => {
    releaseStaleDashboardResponse = resolve;
  });
  let isFirstProfileRequest = true;
  let failNextDashboardHydration = false;

  await page.route('**/users/me', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }

    if (isFirstProfileRequest) {
      isFirstProfileRequest = false;
      await staleDashboardResponse;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ email: session.email, displayName: null }),
      });
      return;
    }

    if (failNextDashboardHydration) {
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
      return;
    }

    await route.continue();
  });
  await authenticate(page, session);

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Рады видеть вас.' })).toContainText(
    session.email,
  );
  await page.getByRole('link', { name: 'Открыть профиль' }).click();

  const displayNameInput = page.getByLabel('Отображаемое имя');
  await displayNameInput.fill('Мария');
  await page.getByRole('button', { name: 'Сохранить имя' }).click();
  await expect(page.locator('#display-name-status')).toHaveText('Имя «Мария» сохранено.');

  releaseStaleDashboardResponse?.();
  await expect(page.evaluate(() => window.sessionStorage.getItem('userDisplayName'))).resolves.toBe(
    'Мария',
  );

  failNextDashboardHydration = true;
  await page.getByRole('link', { name: 'К встречам' }).click();
  await expect(page.getByRole('heading', { name: 'Рады видеть вас.' })).toContainText('Мария');
});

test('hydrates a previously saved display name after a new login', async ({ page, request }) => {
  const session = await register(request, 'profile-login-identity');
  await prisma.user.update({ where: { id: session.userId }, data: { displayName: 'Нина' } });

  await page.goto('/login');
  await page.getByLabel('Email').fill(session.email);
  await page.getByLabel('Пароль').fill(password);
  await page.getByRole('button', { name: 'Войти' }).click();

  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { name: 'Рады видеть вас.' })).toContainText('Нина');
  await expect(page.getByRole('heading', { name: 'Рады видеть вас.' })).not.toContainText(
    session.email,
  );
});

test('redirects to login without loading profile data when authentication is missing', async ({
  page,
}) => {
  await page.goto('/profile');

  await expect(page).toHaveURL('/login');
  await expect(page.getByRole('heading', { name: 'С возвращением' })).toBeVisible();
  await expect(page.getByText('Профиль')).toHaveCount(0);
});

test('validates and recovers from password-change failures without clearing the session', async ({
  page,
  request,
}) => {
  const session = await register(request, 'profile-password-change');
  // Every rejection below is the body the API actually returns, English prose
  // and machine-readable code included: the screen must show Russian text
  // routed by the code, never the server's own wording.
  // A `string` body is sent verbatim: the API answers plain text for some
  // failures, and that has to reach the screen unparsed.
  let passwordChangeFailure: { status: number; body: Record<string, unknown> | string } = {
    status: 400,
    body: { message: 'Current password is incorrect', code: 'CURRENT_PASSWORD_INCORRECT' },
  };
  let submittedPasswordChange: unknown;
  // A dropped request, as opposed to a refused one: the fetch rejects and the
  // screen never sees a status.
  let passwordChangeReachesServer = true;

  await page.route('**/users/me/password', async (route) => {
    if (!passwordChangeReachesServer) {
      await route.abort('failed');
      return;
    }

    submittedPasswordChange = route.request().postDataJSON();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const { status, body } = passwordChangeFailure;
    await route.fulfill({
      status,
      contentType: typeof body === 'string' ? 'text/plain' : 'application/json',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  });
  await authenticate(page, session);
  await page.goto('/profile');

  const currentPassword = page.getByLabel('Текущий пароль', { exact: true });
  const newPassword = page.getByLabel('Новый пароль', { exact: true });
  const confirmation = page.getByLabel('Подтвердите новый пароль', { exact: true });
  await expect(currentPassword).toHaveAttribute('autocomplete', 'current-password');
  await expect(newPassword).toHaveAttribute('autocomplete', 'new-password');
  await expect(confirmation).toHaveAttribute('autocomplete', 'new-password');
  await expect(currentPassword.locator('xpath=ancestor::form')).toHaveScreenshot(
    'password-change-form.png',
  );

  // An untouched form reports every blank field itself and sends nothing.
  await page.getByRole('button', { name: 'Изменить пароль' }).click();
  await expect(page.locator('#current-password-error')).toHaveText('Введите текущий пароль.');
  await expect(page.locator('#password-confirmation-error')).toHaveText(
    'Подтвердите новый пароль.',
  );
  await expect(currentPassword).toBeFocused();
  expect(submittedPasswordChange).toBeUndefined();

  await currentPassword.fill(password);
  await newPassword.fill('short');
  await page.getByRole('button', { name: 'Изменить пароль' }).click();
  await expect(page.locator('#new-password-error')).toHaveText('Используйте не менее 9 символов.');
  await expect(newPassword).toBeFocused();

  await newPassword.fill('😀'.repeat(19));
  await page.getByRole('button', { name: 'Изменить пароль' }).click();
  await expect(page.locator('#new-password-error')).toHaveText(
    'Пароль не должен превышать 72 байта UTF-8.',
  );
  await expect(newPassword).toBeFocused();

  await currentPassword.fill(password);
  await newPassword.fill('new-secure-password-456');
  await confirmation.fill('different-password');
  await page.getByRole('button', { name: 'Изменить пароль' }).click();
  await expect(page.locator('#password-confirmation-error')).toHaveText('Пароли не совпадают.');
  await expect(confirmation).toBeFocused();

  // Recovery means editing one field while another still shows an error, so
  // typing must keep the caret where the user put it. Typed key by key on
  // purpose: `fill()` focuses its own target and writes in a single event,
  // which hides a form that moves focus on every keystroke. The frame wait in
  // the middle is what makes this bite: the form defers its focus move with
  // `requestAnimationFrame`, so an uninterrupted burst of keystrokes can finish
  // inside one frame and let the stolen focus land after the last character,
  // where it corrupts nothing.
  await newPassword.click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('retyped');
  await settleAnimationFrames(page);
  await expect(newPassword).toBeFocused();
  await page.keyboard.type('-secure-password-456');
  await expect(newPassword).toBeFocused();
  await expect(newPassword).toHaveValue('retyped-secure-password-456');
  await expect(confirmation).toHaveValue('different-password');

  // Two errors out of one submit: focus goes to the first of them once, and
  // correcting the other one keeps it there.
  await newPassword.fill('short');
  await page.getByRole('button', { name: 'Изменить пароль' }).click();
  await expect(page.locator('#new-password-error')).toHaveText('Используйте не менее 9 символов.');
  await expect(page.locator('#password-confirmation-error')).toHaveText('Пароли не совпадают.');
  await expect(newPassword).toBeFocused();

  await confirmation.click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('sh');
  await settleAnimationFrames(page);
  await expect(confirmation).toBeFocused();
  await page.keyboard.type('ort');
  await settleAnimationFrames(page);
  await expect(confirmation).toBeFocused();
  await expect(confirmation).toHaveValue('short');
  await expect(page.locator('#new-password-error')).toHaveText('Используйте не менее 9 символов.');

  await newPassword.fill(password);
  await confirmation.fill(password);
  await page.getByRole('button', { name: 'Изменить пароль' }).click();
  await expect(page.locator('#new-password-error')).toHaveText(
    'Новый пароль должен отличаться от текущего.',
  );
  await expect(newPassword).toBeFocused();

  await currentPassword.fill('passe\u0301word');
  await newPassword.fill('passéword');
  await confirmation.fill('passéword');
  await page.getByRole('button', { name: 'Изменить пароль' }).click();
  await expect(page.locator('#new-password-error')).toHaveText(
    'Новый пароль должен отличаться от текущего.',
  );
  await expect(newPassword).toBeFocused();

  // A blank field must never reach the API: the rate-limit guard runs before the
  // DTO is validated, so an empty submit would spend one of five attempts per
  // fifteen minutes and answer with the DTO's own English message.
  await currentPassword.fill('');
  await newPassword.fill('new-secure-password-456');
  await confirmation.fill('new-secure-password-456');
  await page.getByRole('button', { name: 'Изменить пароль' }).click();
  await expect(page.locator('#current-password-error')).toHaveText('Введите текущий пароль.');
  await expect(currentPassword).toBeFocused();
  expect(submittedPasswordChange).toBeUndefined();

  await currentPassword.fill(password);
  await confirmation.fill('');
  await page.getByRole('button', { name: 'Изменить пароль' }).click();
  await expect(page.locator('#password-confirmation-error')).toHaveText(
    'Подтвердите новый пароль.',
  );
  await expect(confirmation).toBeFocused();
  expect(submittedPasswordChange).toBeUndefined();

  // The in-flight window is recorded from inside the page instead of asserted
  // against it: both facts under test happen once, within the 250 ms the stub
  // holds the request, and neither survives into a state a polled assertion
  // could catch. The status region must enter the DOM empty and be filled in a
  // following commit — a live region that mounts already populated is announced
  // unreliably, which is why `SessionNotice` fills itself the same way — and the
  // focus that disabling the submit button drops on `<body>` must land somewhere
  // inside the form.
  await page.evaluate(() => {
    const flight = { statusText: [] as string[], focused: [] as string[] };
    (window as unknown as { passwordChangeFlight: typeof flight }).passwordChangeFlight = flight;
    new MutationObserver(() => {
      const status = document.getElementById('password-change-status');
      if (status) {
        flight.statusText.push(status.textContent ?? '');
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
    document.addEventListener('focusin', (event) => {
      const target = event.target as HTMLElement | null;
      flight.focused.push(target?.id || target?.tagName.toLowerCase() || 'unknown');
    });
  });

  await currentPassword.fill('wrong-password');
  await newPassword.fill('new-secure-password-456');
  await confirmation.fill('new-secure-password-456');
  await page.getByRole('button', { name: 'Изменить пароль' }).click();
  await expect(page.getByRole('button', { name: 'Изменяем пароль…' })).toBeDisabled();
  await expect(currentPassword).toBeDisabled();
  await expect(page.locator('#password-change-status')).toHaveText('Изменяем пароль…');
  await expect(page.locator('#current-password-error')).toHaveText('Неверный текущий пароль.');

  const flight = await page.evaluate(
    () =>
      (window as unknown as { passwordChangeFlight: { statusText: string[]; focused: string[] } })
        .passwordChangeFlight,
  );
  expect(flight.statusText).toContain('');
  expect(flight.statusText.indexOf('')).toBeLessThan(flight.statusText.indexOf('Изменяем пароль…'));
  expect(flight.focused).toContain('password-change-status');
  expect(submittedPasswordChange).toEqual({
    currentPassword: 'wrong-password',
    newPassword: 'new-secure-password-456',
    confirmation: 'new-secure-password-456',
  });
  await expect(currentPassword).toBeFocused();
  await expect(page.locator('#current-password-error')).toHaveAttribute('role', 'alert');
  await expect(page.evaluate(() => window.sessionStorage.getItem('accessToken'))).resolves.toBe(
    session.accessToken,
  );

  passwordChangeFailure = {
    status: 400,
    body: {
      message: 'New password must differ from the current password',
      code: 'NEW_PASSWORD_NOT_DIFFERENT',
    },
  };
  await currentPassword.fill(password);
  await newPassword.fill('another-secure-password-456');
  await confirmation.fill('another-secure-password-456');
  await page.getByRole('button', { name: 'Изменить пароль' }).click();
  await expect(page.locator('#new-password-error')).toHaveText(
    'Новый пароль должен отличаться от текущего.',
  );
  await expect(newPassword).toBeFocused();

  passwordChangeFailure = {
    status: 400,
    body: {
      message: 'Password confirmation does not match',
      code: 'PASSWORD_CONFIRMATION_MISMATCH',
    },
  };
  await page.getByRole('button', { name: 'Изменить пароль' }).click();
  await expect(page.locator('#password-confirmation-error')).toHaveText('Пароли не совпадают.');
  await expect(confirmation).toBeFocused();

  // A DTO rejection routes by the field the API names, not by the property name
  // that happens to appear in the constraint message.
  passwordChangeFailure = {
    status: 400,
    body: {
      statusCode: 400,
      message: ['newPassword must contain at least 9 characters and no more than 72 UTF-8 bytes'],
      error: 'Bad Request',
      code: 'VALIDATION_FAILED',
      fields: ['newPassword'],
    },
  };
  await page.getByRole('button', { name: 'Изменить пароль' }).click();
  await expect(page.locator('#new-password-error')).toHaveText(
    'Используйте не менее 9 символов и не более 72 байт UTF-8.',
  );
  await expect(newPassword).toBeFocused();

  // The API names all three properties, so all three routes are driven here: a
  // typo in one key would otherwise drop that rejection into the generic slot
  // with no field marked, and every assertion would still pass.
  passwordChangeFailure = {
    status: 400,
    body: {
      statusCode: 400,
      message: ['currentPassword must contain no more than 72 UTF-8 bytes'],
      error: 'Bad Request',
      code: 'VALIDATION_FAILED',
      fields: ['currentPassword'],
    },
  };
  await page.getByRole('button', { name: 'Изменить пароль' }).click();
  await expect(page.locator('#current-password-error')).toHaveText(
    'Введите текущий пароль не длиннее 72 байт UTF-8.',
  );
  await expect(currentPassword).toBeFocused();

  passwordChangeFailure = {
    status: 400,
    body: {
      statusCode: 400,
      message: ['confirmation should not be empty'],
      error: 'Bad Request',
      code: 'VALIDATION_FAILED',
      fields: ['confirmation'],
    },
  };
  await page.getByRole('button', { name: 'Изменить пароль' }).click();
  await expect(page.locator('#password-confirmation-error')).toHaveText(
    'Подтвердите новый пароль.',
  );
  await expect(confirmation).toBeFocused();

  // `forbidNonWhitelisted` names a property this screen has no field for. It
  // must still say something in Russian rather than fall silent.
  passwordChangeFailure = {
    status: 400,
    body: {
      statusCode: 400,
      message: ['property unexpectedProperty should not exist'],
      error: 'Bad Request',
      code: 'VALIDATION_FAILED',
      fields: ['unexpectedProperty'],
    },
  };
  await page.getByRole('button', { name: 'Изменить пароль' }).click();
  await expect(page.locator('#password-change-error')).toHaveText(
    'Не удалось изменить пароль: сервер ответил ошибкой. Повторите попытку позже.',
  );
  await expect(page.locator('#password-confirmation-error')).toHaveCount(0);

  passwordChangeFailure = {
    status: 429,
    body: {
      statusCode: 429,
      message: 'Too many password-change attempts. Please try again later.',
      code: 'PASSWORD_CHANGE_RATE_LIMITED',
      retryAfterSeconds: 900,
    },
  };
  await page.getByRole('button', { name: 'Изменить пароль' }).click();
  // The wait is the one the API returns, not "a few minutes": the account window
  // is fifteen minutes long, and a user who retries at minute five is refused
  // again and spends nothing but the wording's credibility.
  await expect(page.locator('#password-change-error')).toHaveText(
    'Слишком много попыток изменить пароль. Повторите через 15 минут.',
  );
  // The refusal belongs to no field, so the caret returns to «Текущий пароль».
  // That field has to describe itself with the refusal: a screen reader reads the
  // description of the control it lands on, and an alert that mounts already
  // filled is announced unreliably. Hearing only the label and the generic help
  // text would present the attempt as if nothing had happened.
  // The assertion is on the computed description rather than on the id list,
  // because the id list stays byte-identical if the referenced node is renamed
  // or removed — the reference dangles and the refusal is silenced, while the
  // attribute still reads as if it were wired up. Hiding that node is not such
  // a regression: a directly referenced node is traversed even when hidden, so
  // both this assertion and a screen reader still get the sentence. The
  // refusal comes first: a description is announced after the label, is
  // interruptible, and the guidance is what the user has already heard.
  await expect(currentPassword).toBeFocused();
  await expect(currentPassword).toHaveAccessibleDescription(
    'Слишком много попыток изменить пароль. Повторите через 15 минут.' +
      ' Не менее 9 символов и не более 72 байт UTF-8.' +
      ' После изменения потребуется войти снова.',
  );
  await expect(page).toHaveURL('/profile');

  // The description is not permanent: typing clears the refusal, and the field
  // goes back to the help text alone.
  await currentPassword.fill('retyped-current-password');
  await expect(currentPassword).toHaveAccessibleDescription(
    'Не менее 9 символов и не более 72 байт UTF-8. После изменения потребуется войти снова.',
  );
  await currentPassword.fill(password);

  // A shorter remaining window is quoted as it stands, and the noun agrees with
  // the number: a message hard-coded to fifteen minutes would keep the user
  // waiting far longer than the API asks.
  passwordChangeFailure = {
    status: 429,
    body: {
      statusCode: 429,
      message: 'Too many password-change attempts. Please try again later.',
      code: 'PASSWORD_CHANGE_RATE_LIMITED',
      retryAfterSeconds: 61,
    },
  };
  await page.getByRole('button', { name: 'Изменить пароль' }).click();
  await expect(page.locator('#password-change-error')).toHaveText(
    'Слишком много попыток изменить пароль. Повторите через 2 минуты.',
  );

  passwordChangeFailure = {
    status: 429,
    body: {
      statusCode: 429,
      message: 'Too many password-change attempts. Please try again later.',
      code: 'PASSWORD_CHANGE_RATE_LIMITED',
      retryAfterSeconds: 30,
    },
  };
  await page.getByRole('button', { name: 'Изменить пароль' }).click();
  await expect(page.locator('#password-change-error')).toHaveText(
    'Слишком много попыток изменить пароль. Повторите через 1 минуту.',
  );

  // A refusal that carries no usable wait falls back to the window the API
  // documents, never to "a few minutes".
  for (const retryAfterSeconds of [undefined, 0, -1, 'soon', Number.NaN]) {
    passwordChangeFailure = {
      status: 429,
      body: {
        statusCode: 429,
        message: 'Too many password-change attempts. Please try again later.',
        code: 'PASSWORD_CHANGE_RATE_LIMITED',
        retryAfterSeconds,
      },
    };
    await page.getByRole('button', { name: 'Изменить пароль' }).click();
    await expect(page.locator('#password-change-error')).toHaveText(
      'Слишком много попыток изменить пароль. Повторите через 15 минут.',
    );
  }

  // A failure the browser does not recognise still says something in Russian
  // and keeps the caret in the form, instead of pasting server prose on screen.
  passwordChangeFailure = {
    status: 400,
    body: { message: 'Current credentials were rejected', code: 'SOMETHING_UNMAPPED' },
  };
  await page.getByRole('button', { name: 'Изменить пароль' }).click();
  await expect(page.locator('#password-change-error')).toHaveText(
    'Не удалось изменить пароль: сервер ответил ошибкой. Повторите попытку позже.',
  );
  await expect(page.getByText('Current credentials were rejected')).toHaveCount(0);
  await expect(currentPassword).toBeFocused();
  await expect(page).toHaveURL('/profile');

  // A body that is not JSON at all has nothing to route on, and gets the same
  // recoverable sentence rather than an unhandled rejection. The server answered
  // and refused, so the sentence must not send the user after their connection:
  // every retry it invites spends one of five account attempts per fifteen
  // minutes.
  await currentPassword.fill(password);
  passwordChangeFailure = { status: 502, body: 'Bad Gateway' };
  await page.getByRole('button', { name: 'Изменить пароль' }).click();
  await expect(page.locator('#password-change-error')).toHaveText(
    'Не удалось изменить пароль: сервер ответил ошибкой. Повторите попытку позже.',
  );
  await expect(currentPassword).toBeFocused();

  // The request that never reached the server is the only one that is a
  // connection problem, and it is the only one worded as such.
  passwordChangeReachesServer = false;
  await page.getByRole('button', { name: 'Изменить пароль' }).click();
  await expect(page.locator('#password-change-error')).toHaveText(
    'Не удалось изменить пароль: нет связи с сервером. Проверьте соединение и повторите попытку.',
  );
  await expect(currentPassword).toBeFocused();
  await expect(page).toHaveURL('/profile');
  passwordChangeReachesServer = true;

  // A `code` or a rejected field named after an `Object.prototype` member is
  // still just an unknown failure. Looking it up in a plain object would find
  // the inherited function, whose `message` is `undefined`, and the screen would
  // re-enable itself having told the user nothing at all.
  for (const inherited of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
    passwordChangeFailure = {
      status: 400,
      body: { message: 'Rejected', code: 'CURRENT_PASSWORD_INCORRECT' },
    };
    await page.getByRole('button', { name: 'Изменить пароль' }).click();
    await expect(page.locator('#current-password-error')).toHaveText('Неверный текущий пароль.');

    passwordChangeFailure = { status: 400, body: { message: 'Rejected', code: inherited } };
    await page.getByRole('button', { name: 'Изменить пароль' }).click();
    await expect(page.locator('#password-change-error')).toHaveText(
      'Не удалось изменить пароль: сервер ответил ошибкой. Повторите попытку позже.',
    );

    passwordChangeFailure = {
      status: 400,
      body: { message: 'Rejected', code: 'CURRENT_PASSWORD_INCORRECT' },
    };
    await page.getByRole('button', { name: 'Изменить пароль' }).click();
    await expect(page.locator('#current-password-error')).toHaveText('Неверный текущий пароль.');

    passwordChangeFailure = {
      status: 400,
      body: { message: 'Rejected', code: 'VALIDATION_FAILED', fields: [inherited] },
    };
    await page.getByRole('button', { name: 'Изменить пароль' }).click();
    await expect(page.locator('#password-change-error')).toHaveText(
      'Не удалось изменить пароль: сервер ответил ошибкой. Повторите попытку позже.',
    );
  }
});

test('explains the sign-out when the password endpoint rejects the session', async ({
  page,
  request,
}) => {
  const session = await register(request, 'profile-password-session');

  // Seeded once instead of through `authenticate`: an init script would restore
  // the token on every later navigation and hide a session that failed to end.
  await page.goto('/login');
  await page.evaluate(({ accessToken, email }) => {
    window.sessionStorage.setItem('accessToken', accessToken);
    window.sessionStorage.setItem('userEmail', email);
  }, session);
  await page.goto('/profile');

  // The documented `401` of a session the endpoint will not act on: a token
  // minted before the session migration carries no `sid`, and the body has no
  // `code` to route on. The current password is correct and stays in force.
  // The first attempt is dropped on the way back instead, which is the sequence
  // the notice must survive: a change can commit and revoke the calling session
  // while its response is lost, so the retry that follows is answered `401` by a
  // token that is already revoked — with the new password in force.
  let passwordChangeResponseArrives = false;

  await page.route('**/users/me/password', async (route) => {
    if (!passwordChangeResponseArrives) {
      passwordChangeResponseArrives = true;
      await route.abort('failed');
      return;
    }

    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({
        statusCode: 401,
        message: 'Sign in again before changing your password',
      }),
    });
  });

  await page.getByLabel('Текущий пароль', { exact: true }).fill(password);
  await page.getByLabel('Новый пароль', { exact: true }).fill('unchanged-secure-password-789');
  await page
    .getByLabel('Подтвердите новый пароль', { exact: true })
    .fill('unchanged-secure-password-789');
  await page.getByRole('button', { name: 'Изменить пароль' }).click();
  await expect(page.locator('#password-change-error')).toHaveText(
    'Не удалось изменить пароль: нет связи с сервером. Проверьте соединение и повторите попытку.',
  );
  await expect(page).toHaveURL('/profile');

  await page.getByRole('button', { name: 'Изменить пароль' }).click();

  // The eject is unavoidable, but it must not look like the successful sign-out
  // with the notice missing: the reason explains the sign-out and names the
  // password to sign in with. It must not claim an outcome the screen never
  // observed — after the sequence above the change may well have gone through.
  await expect(page).toHaveURL('/login?reason=session-rejected');
  await expect(page.getByRole('status')).toHaveText(
    'Сессия завершена. Войдите заново; если смена пароля прошла, используйте новый пароль.',
  );
  await expect(page.getByText('Пароль не изменён')).toHaveCount(0);
  await expect(page.getByRole('status')).toBeFocused();
  await expect(
    page.evaluate(() => window.sessionStorage.getItem('accessToken')),
  ).resolves.toBeNull();
  await expect(page.evaluate(() => window.sessionStorage.getItem('userEmail'))).resolves.toBeNull();

  // The eject leaves a usable sign-in screen: the session really was cleared, so
  // no stale token short-circuits the form, and the focused notice does not trap
  // the keyboard on the way into it. Whether the password survived is not on
  // trial here — the stub answers before the API sees the request; the real `401`
  // for a session-less token is pinned in `apps/api/test/profile.e2e-spec.ts`.
  await page.unroute('**/users/me/password');
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Email')).toBeFocused();
  await page.keyboard.type(session.email);
  await page.keyboard.press('Tab');
  await page.keyboard.type(password);
  await page.keyboard.press('Enter');

  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { name: 'Рады видеть вас.' })).toContainText(
    session.email,
  );
});

test('changes the password by keyboard, signs out, blocks protected routes, and requires the new password', async ({
  page,
  request,
}) => {
  const session = await register(request, 'profile-password-success');
  const newPassword = 'brand-new-secure-password-789';

  // Seeded once instead of through `authenticate`: an init script would restore
  // the token on every later navigation and hide a session that failed to end.
  await page.goto('/login');
  await page.evaluate(({ accessToken, email }) => {
    window.sessionStorage.setItem('accessToken', accessToken);
    window.sessionStorage.setItem('userEmail', email);
  }, session);
  // The dashboard is visited on the way so that Back has an authenticated page
  // to return to once the session is gone. Whichever way the browser serves that
  // Back — a fresh mount or a back/forward-cache hit — the dashboard must not
  // come back; the restored-page half is pinned on its own further below.
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Рады видеть вас.' })).toContainText(
    session.email,
  );
  await page.goto('/profile');

  await page.getByLabel('Текущий пароль', { exact: true }).focus();
  await page.keyboard.type(password);
  await page.keyboard.press('Tab');
  await page.keyboard.type(newPassword);
  await page.keyboard.press('Tab');
  await page.keyboard.type(newPassword);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Изменить пароль' })).toBeFocused();

  // The re-submit window opens after the API answers and closes when the router
  // leaves /profile, so the sign-in payload is held to keep it open: without it
  // the assertion below would race the route change instead of observing it.
  const isSignInPage = (url: URL) => url.pathname === '/login';
  let releaseSignInPage = () => {};
  const heldSignInPage = new Promise<void>((resolve) => {
    releaseSignInPage = resolve;
  });
  await page.route(isSignInPage, async (route) => {
    await heldSignInPage;
    await route.continue();
  });
  const passwordChanged = page.waitForResponse(
    (response) => response.url().endsWith('/users/me/password') && response.ok(),
  );

  await page.keyboard.press('Enter');
  await passwordChanged;
  // The password is already changed and the page is still /profile: the form has
  // to stay submitted, or a repeated Enter would run again without a token and
  // replace the notice URL with a bare /login.
  await expect(page.getByRole('button', { name: 'Изменяем пароль…' })).toBeDisabled();
  releaseSignInPage();

  await expect(page).toHaveURL('/login?reason=password-changed');
  await page.unroute(isSignInPage);
  await expect(page.getByRole('heading', { name: 'С возвращением' })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText(
    'Пароль изменён. Войдите заново с новым паролем.',
  );
  // The notice carries the only explanation of the sign-out, so it takes focus
  // instead of relying on a live region that mounted with its own text.
  await expect(page.getByRole('status')).toBeFocused();
  await expect(
    page.evaluate(() => window.sessionStorage.getItem('accessToken')),
  ).resolves.toBeNull();
  await expect(page.evaluate(() => window.sessionStorage.getItem('userEmail'))).resolves.toBeNull();

  // The notice must not trap the keyboard: Tab leads out of it into the form,
  // where the old password is now rejected without leaving the sign-in screen.
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Email')).toBeFocused();
  await page.keyboard.type(session.email);
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Пароль')).toBeFocused();
  await page.keyboard.type(password);
  await page.keyboard.press('Enter');
  await expect(
    // Filtered because Next keeps its own route announcer under the alert role.
    page.getByRole('alert').filter({ hasText: 'Не удалось войти. Проверьте email и пароль.' }),
  ).toBeVisible();
  await expect(page).toHaveURL('/login?reason=password-changed');
  await expect(
    page.evaluate(() => window.sessionStorage.getItem('accessToken')),
  ).resolves.toBeNull();

  await page.goBack();
  await expect(page).toHaveURL('/login');
  await expect(page.getByText(session.email)).toHaveCount(0);

  await page.goto('/profile');
  await expect(page).toHaveURL('/login');
  await expect(page.getByText(session.email)).toHaveCount(0);

  await page.goto('/');
  await expect(page).toHaveURL('/login');
  await expect(page.getByText(session.email)).toHaveCount(0);

  // The transition ends where the issue expects it: the new password signs the
  // user back in from the sign-in screen the revoked session led to.
  await page.getByLabel('Email').focus();
  await page.keyboard.type(session.email);
  await page.keyboard.press('Tab');
  await page.keyboard.type(newPassword);
  await page.keyboard.press('Enter');

  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { name: 'Рады видеть вас.' })).toContainText(
    session.email,
  );
});

test('sends a meeting page reopened by Back to sign-in after the password change', async ({
  page,
  request,
}) => {
  const session = await register(request, 'profile-password-meeting-back');
  const meeting = await createMeeting(request, session);
  const newPassword = 'meeting-restore-secure-password-789';

  // Seeded once, as in the sign-out test: an init script would hand the token
  // back to the restored page and hide a session that failed to end.
  await page.goto('/login');
  await page.evaluate(({ accessToken, email }) => {
    window.sessionStorage.setItem('accessToken', accessToken);
    window.sessionStorage.setItem('userEmail', email);
  }, session);
  // Both pages are opened as document navigations, so Back leaves the sign-in
  // screen for the meeting page by whichever route the browser picks. The
  // restore route, which the browser will not take against the dev server, is
  // covered by the test that follows.
  await page.goto(`/meetings/${meeting.id}`);
  await expect(page.getByRole('heading', { name: meeting.title })).toBeVisible();
  await page.goto('/profile');

  await page.getByLabel('Текущий пароль', { exact: true }).fill(password);
  await page.getByLabel('Новый пароль', { exact: true }).fill(newPassword);
  await page.getByLabel('Подтвердите новый пароль', { exact: true }).fill(newPassword);
  await page.getByRole('button', { name: 'Изменить пароль' }).click();
  await expect(page).toHaveURL('/login?reason=password-changed');

  await page.goBack();
  await expect(page).toHaveURL('/login');
  await expect(page.getByText(meeting.title)).toHaveCount(0);
  await expect(page.getByText(session.email)).toHaveCount(0);
});

test('sends every authenticated page resumed without the session back to sign-in', async ({
  page,
  request,
}) => {
  const session = await register(request, 'profile-password-restore');
  const meeting = await createMeeting(request, session);
  // Every screen the password change can leave behind in the same tab, so that
  // dropping the guard from one of them is not hidden by the other two.
  const resumablePages = [
    { path: '/', content: page.getByRole('heading', { name: 'Рады видеть вас.' }) },
    {
      path: `/meetings/${meeting.id}`,
      content: page.getByRole('heading', { name: meeting.title }),
    },
    { path: '/profile', content: page.getByLabel('Текущий пароль', { exact: true }) },
  ];

  for (const { path, content } of resumablePages) {
    // Seeded per page instead of through `authenticate`: an init script would
    // hand the token back and leave the guard with nothing to notice.
    await page.goto('/login');
    await page.evaluate(({ accessToken, email }) => {
      window.sessionStorage.setItem('accessToken', accessToken);
      window.sessionStorage.setItem('userEmail', email);
    }, session);
    await page.goto(path);
    await expect(content).toBeVisible();

    // A page served from the back/forward cache is resumed, not mounted, so the
    // mount-time token check never runs again and only `pageshow` can see that
    // the password change ended the session meanwhile. That resume is raised
    // here rather than by pressing Back because the E2E suite runs against
    // `next dev`, which sends `Cache-Control: no-store` over plain HTTP and so
    // keeps Chromium from storing the page in the first place — pressing Back
    // would silently re-mount and exercise the mount-time check instead.
    await page.evaluate(() => {
      window.sessionStorage.clear();
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });

    await expect(page).toHaveURL('/login');
    await expect(content).toHaveCount(0);
    await expect(page.getByText(session.email)).toHaveCount(0);
  }
});

test('clears an expired session and redirects to login without showing profile data', async ({
  page,
  request,
}) => {
  const session = await register(request, 'expired-profile-session');
  const expiredAccessToken = createExpiredAccessToken(session.accessToken);

  await page.addInitScript(
    ({ accessToken }) => {
      window.sessionStorage.setItem('accessToken', accessToken);
      window.sessionStorage.setItem('userEmail', 'private@example.com');
    },
    { accessToken: expiredAccessToken },
  );

  await page.goto('/profile');

  await expect(page).toHaveURL('/login');
  await expect(page.getByRole('heading', { name: 'С возвращением' })).toBeVisible();
  await expect(page.getByText('private@example.com')).toHaveCount(0);
  await expect(
    page.evaluate(() => window.sessionStorage.getItem('accessToken')),
  ).resolves.toBeNull();
});
