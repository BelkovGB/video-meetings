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

loadEnvFile(resolve(__dirname, '../../../.env'));

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const password = 'secure-password-123';
const prisma = new PrismaClient();
const createdUserIds = new Set<string>();
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

async function authenticate(page: Page, session: Session): Promise<void> {
  await page.addInitScript(({ accessToken, email }) => {
    window.sessionStorage.setItem('accessToken', accessToken);
    window.sessionStorage.setItem('userEmail', email);
  }, session);
}

test.afterAll(async () => {
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
  let responseMessage = 'Current password is incorrect';
  let submittedPasswordChange: unknown;

  await page.route('**/users/me/password', async (route) => {
    submittedPasswordChange = route.request().postDataJSON();
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.fulfill({
      status: responseMessage === 'Слишком много попыток.' ? 429 : 400,
      contentType: 'application/json',
      body: JSON.stringify({ message: responseMessage }),
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

  await newPassword.fill('short');
  await page.getByRole('button', { name: 'Изменить пароль' }).click();
  await expect(page.locator('#new-password-error')).toHaveText('Используйте не менее 9 символов.');
  await expect(newPassword).toBeFocused();

  await newPassword.fill('😀'.repeat(19));
  await page.getByRole('button', { name: 'Изменить пароль' }).click();
  await expect(page.locator('#new-password-error')).toHaveText(
    'Пароль не должен превышать 72 байта UTF-8.',
  );

  await currentPassword.fill(password);
  await newPassword.fill('new-secure-password-456');
  await confirmation.fill('different-password');
  await page.getByRole('button', { name: 'Изменить пароль' }).click();
  await expect(page.locator('#password-confirmation-error')).toHaveText('Пароли не совпадают.');

  await newPassword.fill(password);
  await confirmation.fill(password);
  await page.getByRole('button', { name: 'Изменить пароль' }).click();
  await expect(page.locator('#new-password-error')).toHaveText(
    'Новый пароль должен отличаться от текущего.',
  );

  await currentPassword.fill('passe\u0301word');
  await newPassword.fill('passéword');
  await confirmation.fill('passéword');
  await page.getByRole('button', { name: 'Изменить пароль' }).click();
  await expect(page.locator('#new-password-error')).toHaveText(
    'Новый пароль должен отличаться от текущего.',
  );

  await currentPassword.fill('wrong-password');
  await newPassword.fill('new-secure-password-456');
  await confirmation.fill('new-secure-password-456');
  await page.getByRole('button', { name: 'Изменить пароль' }).click();
  await expect(page.getByRole('button', { name: 'Изменяем пароль…' })).toBeDisabled();
  await expect(currentPassword).toBeDisabled();
  await expect(page.locator('#password-change-status')).toHaveText('Изменяем пароль…');
  await expect(page.locator('#current-password-error')).toHaveText('Current password is incorrect');
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

  responseMessage = 'New password must differ from the current password';
  await currentPassword.fill(password);
  await newPassword.fill('another-secure-password-456');
  await confirmation.fill('another-secure-password-456');
  await page.getByRole('button', { name: 'Изменить пароль' }).click();
  await expect(page.locator('#new-password-error')).toHaveText(
    'New password must differ from the current password',
  );
  await expect(newPassword).toBeFocused();

  responseMessage = 'Password confirmation does not match';
  await page.getByRole('button', { name: 'Изменить пароль' }).click();
  await expect(page.locator('#password-confirmation-error')).toHaveText(
    'Password confirmation does not match',
  );
  await expect(confirmation).toBeFocused();

  responseMessage = 'Слишком много попыток.';
  await page.getByRole('button', { name: 'Изменить пароль' }).click();
  await expect(page.locator('#password-change-error')).toHaveText('Слишком много попыток.');
  await expect(page).toHaveURL('/profile');
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
  await page.goto('/profile');

  await page.getByLabel('Текущий пароль', { exact: true }).focus();
  await page.keyboard.type(password);
  await page.keyboard.press('Tab');
  await page.keyboard.type(newPassword);
  await page.keyboard.press('Tab');
  await page.keyboard.type(newPassword);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Изменить пароль' })).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(page).toHaveURL('/login?reason=password-changed');
  await expect(page.getByRole('heading', { name: 'С возвращением' })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText(
    'Пароль изменён. Войдите заново с новым паролем.',
  );
  await expect(
    page.evaluate(() => window.sessionStorage.getItem('accessToken')),
  ).resolves.toBeNull();
  await expect(page.evaluate(() => window.sessionStorage.getItem('userEmail'))).resolves.toBeNull();

  await page.goto('/profile');
  await expect(page).toHaveURL('/login');
  await expect(page.getByText(session.email)).toHaveCount(0);

  await page.goto('/');
  await expect(page).toHaveURL('/login');
  await expect(page.getByText(session.email)).toHaveCount(0);

  const oldPasswordLogin = await request.post(`${apiUrl}/auth/login`, {
    data: { email: session.email, password },
  });
  expect(oldPasswordLogin.status()).toBe(401);

  const newPasswordLogin = await request.post(`${apiUrl}/auth/login`, {
    data: { email: session.email, password: newPassword },
  });
  expect(newPasswordLogin.ok()).toBeTruthy();
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
