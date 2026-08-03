import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';

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

  it.each<[string, AuthCredentials]>([
    ['email is missing', { password: validPassword }],
    ['password is missing', { email: createEmail('missing-password') }],
    ['email has an invalid format', { email: 'invalid-email', password: validPassword }],
  ])('rejects login when %s', async (_description, credentials) => {
    await request(app.getHttpServer()).post('/auth/login').send(credentials).expect(400);
  });
});
