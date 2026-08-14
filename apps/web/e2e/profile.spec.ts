import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';

type Session = {
  accessToken: string;
  email: string;
  userId: string;
};

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const password = 'secure-password-123';
const prisma = new PrismaClient();
const createdUserIds = new Set<string>();

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

test('opens the profile from the account and shows the current safe details', async ({
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
  await expect(page.getByLabel('Ваши данные').getByText('Алексей', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Email')).toHaveText(session.email);
  await expect(page.getByRole('button', { name: /изменить email/i })).toHaveCount(0);

  const meetingsLink = page.getByRole('link', { name: 'К встречам' });
  await meetingsLink.focus();
  await expect(meetingsLink).toBeFocused();
});

test('redirects to login without loading profile data when authentication is missing', async ({
  page,
}) => {
  await page.goto('/profile');

  await expect(page).toHaveURL('/login');
  await expect(page.getByRole('heading', { name: 'С возвращением' })).toBeVisible();
  await expect(page.getByText('Профиль')).toHaveCount(0);
});

test('clears an expired session and redirects to login without showing profile data', async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.sessionStorage.setItem('accessToken', 'expired.access.token');
    window.sessionStorage.setItem('userEmail', 'private@example.com');
  });

  await page.goto('/profile');

  await expect(page).toHaveURL('/login');
  await expect(page.getByRole('heading', { name: 'С возвращением' })).toBeVisible();
  await expect(page.getByText('private@example.com')).toHaveCount(0);
  await expect(
    page.evaluate(() => window.sessionStorage.getItem('accessToken')),
  ).resolves.toBeNull();
});
