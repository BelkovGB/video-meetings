import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureHttpApplication } from '../src/http-application';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuthSessionService } from '../src/auth/services/auth-session.service';

type AuthCredentials = {
  email?: string;
  password?: string;
};

const validPassword = 'secure-password-123';

function createEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

function expectAccessToken(response: request.Response) {
  expect(response.body).toHaveProperty('accessToken');
  expect(typeof response.body.accessToken).toBe('string');
  expect(response.body.accessToken.length).toBeGreaterThan(0);
}

function getSessionId(accessToken: string): string | undefined {
  const payload = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString()) as {
    sid?: string;
  };

  return payload.sid;
}

describe('Authentication (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('registers a user and returns a non-empty access token', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: createEmail('new-user'), password: validPassword })
      .expect(201);

    expectAccessToken(response);
  });

  it('does not allow registration with an already registered email', async () => {
    const email = createEmail('duplicate-user');
    const credentials = { email, password: validPassword };

    await request(app.getHttpServer()).post('/auth/register').send(credentials).expect(201);

    await request(app.getHttpServer()).post('/auth/register').send(credentials).expect(409);
  });

  it('rolls back registration when initial session creation fails', async () => {
    const email = createEmail('session-creation-failure');
    const credentials = { email, password: validPassword };
    const authSessionService = app.get(AuthSessionService);

    jest
      .spyOn(authSessionService, 'create')
      .mockRejectedValueOnce(new Error('Session storage failed'));

    await request(app.getHttpServer()).post('/auth/register').send(credentials).expect(500);

    await expect(app.get(PrismaService).user.findUnique({ where: { email } })).resolves.toBeNull();

    const retry = await request(app.getHttpServer())
      .post('/auth/register')
      .send(credentials)
      .expect(201);

    expectAccessToken(retry);
  });

  it.each<[string, AuthCredentials]>([
    ['email is missing', { password: validPassword }],
    ['password is missing', { email: createEmail('missing-password') }],
    ['email has an invalid format', { email: 'invalid-email', password: validPassword }],
    [
      'password is shorter than 9 characters',
      { email: createEmail('short-password'), password: 'password' },
    ],
  ])('rejects registration when %s', async (_description, credentials) => {
    await request(app.getHttpServer()).post('/auth/register').send(credentials).expect(400);
  });

  it('does not create a user when logging in with an unknown email', async () => {
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: createEmail('unknown-user'), password: validPassword })
      .expect(401);
  });

  it('logs in a registered user and returns a non-empty access token', async () => {
    const credentials = {
      email: createEmail('existing-user'),
      password: validPassword,
    };

    await request(app.getHttpServer()).post('/auth/register').send(credentials).expect(201);

    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send(credentials)
      .expect(200);

    expectAccessToken(response);
  });

  it('revokes only the selected session for a user', async () => {
    const credentials = {
      email: createEmail('distinct-sessions'),
      password: validPassword,
    };
    const firstSession = await request(app.getHttpServer())
      .post('/auth/register')
      .send(credentials)
      .expect(201);
    const secondSession = await request(app.getHttpServer())
      .post('/auth/login')
      .send(credentials)
      .expect(200);
    const firstSessionId = getSessionId(firstSession.body.accessToken as string);
    const secondSessionId = getSessionId(secondSession.body.accessToken as string);

    expect(firstSessionId).toEqual(expect.any(String));
    expect(secondSessionId).toEqual(expect.any(String));
    expect(firstSessionId).not.toBe(secondSessionId);

    await app.get(PrismaService).authSession.update({
      where: { id: firstSessionId },
      data: { revokedAt: new Date() },
    });

    await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${firstSession.body.accessToken}`)
      .expect(401);

    await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${secondSession.body.accessToken}`)
      .expect(200);
  });

  it('temporarily accepts a legacy token without a session identity', async () => {
    const registration = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: createEmail('legacy-session'), password: validPassword })
      .expect(201);
    const payload = JSON.parse(
      Buffer.from((registration.body.accessToken as string).split('.')[1], 'base64url').toString(),
    ) as { sub: string; email: string };
    const accessToken = await app
      .get(JwtService)
      .signAsync({ sub: payload.sub, email: payload.email });

    await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
  });

  it('rejects a token with a malformed session identity', async () => {
    const accessToken = await app
      .get(JwtService)
      .signAsync({ sub: 'user-with-invalid-session', email: 'user@example.com', sid: 42 });

    await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(401);
  });

  it.each<[string, AuthCredentials]>([
    ['email is missing', { password: validPassword }],
    ['password is missing', { email: createEmail('missing-password') }],
    ['email has an invalid format', { email: 'invalid-email', password: validPassword }],
  ])('rejects login when %s', async (_description, credentials) => {
    await request(app.getHttpServer()).post('/auth/login').send(credentials).expect(400);
  });
});

describe('Authentication rate limiting (e2e)', () => {
  let app: INestApplication;
  const originalTrustedProxyIps = process.env.TRUSTED_PROXY_IPS;

  beforeEach(async () => {
    process.env.TRUSTED_PROXY_IPS = 'loopback';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureHttpApplication(app);
    await app.init();
  });

  afterEach(async () => {
    await app.close();

    if (originalTrustedProxyIps === undefined) {
      delete process.env.TRUSTED_PROXY_IPS;
    } else {
      process.env.TRUSTED_PROXY_IPS = originalTrustedProxyIps;
    }
  });

  it.each(['/auth/register', '/auth/login'])(
    'returns 429 after too many requests to %s from one IP address',
    async (path) => {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await request(app.getHttpServer())
          .post(path)
          .send({ email: createEmail(`rate-limit-${attempt}`), password: 'short' })
          .expect(path === '/auth/register' ? 400 : 401);
      }

      const response = await request(app.getHttpServer())
        .post(path)
        .send({ email: createEmail('rate-limit-blocked'), password: 'short' })
        .expect('Retry-After', /\d+/)
        .expect(429);

      expect(response.body).toMatchObject({
        statusCode: 429,
        message: 'Too many authentication attempts. Please try again later.',
      });
      expect(response.body.retryAfterSeconds).toEqual(expect.any(Number));
    },
  );

  it('limits repeated login attempts for the same account', async () => {
    const credentials = {
      email: createEmail('account-rate-limit'),
      password: validPassword,
    };

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request(app.getHttpServer()).post('/auth/login').send(credentials).expect(401);
    }

    await request(app.getHttpServer()).post('/auth/login').send(credentials).expect(429);
  });

  it('keeps rate-limit quotas separate for forwarded clients through a trusted proxy', async () => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await request(app.getHttpServer())
        .post('/auth/login')
        .set('X-Forwarded-For', '198.51.100.10')
        .send({ email: createEmail(`forwarded-client-${attempt}`), password: 'short' })
        .expect(401);
    }

    await request(app.getHttpServer())
      .post('/auth/login')
      .set('X-Forwarded-For', '198.51.100.11')
      .send({ email: createEmail('forwarded-client-independent'), password: 'short' })
      .expect(401);
  });

  it('does not trust forwarded client addresses without a configured ingress', async () => {
    await app.close();
    delete process.env.TRUSTED_PROXY_IPS;

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureHttpApplication(app);
    await app.init();

    for (let attempt = 0; attempt < 30; attempt += 1) {
      await request(app.getHttpServer())
        .post('/auth/login')
        .set('X-Forwarded-For', '198.51.100.10')
        .send({ email: createEmail(`untrusted-forwarded-client-${attempt}`), password: 'short' })
        .expect(401);
    }

    await request(app.getHttpServer())
      .post('/auth/login')
      .set('X-Forwarded-For', '198.51.100.11')
      .send({ email: createEmail('untrusted-forwarded-client-blocked'), password: 'short' })
      .expect(429);
  });
});
