import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';

type UserSession = {
  accessToken: string;
  id: string;
  email: string;
};

type Profile = {
  id: string;
  email: string;
  displayName: string | null;
};

const validPassword = 'secure-password-123';

function createEmail(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

function getUserId(accessToken: string): string {
  const payload = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString()) as {
    sub: string;
  };

  return payload.sub;
}

describe('Current user profile (e2e)', () => {
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

  async function registerUser(prefix: string): Promise<UserSession> {
    const email = createEmail(prefix);
    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: validPassword })
      .expect(201);

    return {
      accessToken: response.body.accessToken as string,
      id: getUserId(response.body.accessToken as string),
      email,
    };
  }

  function expectProfile(response: request.Response, expected: Profile) {
    expect(response.body).toEqual(expected);
    expect(response.body).not.toHaveProperty('passwordHash');
    expect(response.body).not.toHaveProperty('createdAt');
    expect(response.body).not.toHaveProperty('updatedAt');
  }

  it('returns only the authenticated user safe profile', async () => {
    const currentUser = await registerUser('profile-current');
    const anotherUser = await registerUser('profile-another');

    const response = await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${currentUser.accessToken}`)
      .expect(200);

    expectProfile(response, {
      id: currentUser.id,
      email: currentUser.email,
      displayName: null,
    });
    expect(response.body).not.toHaveProperty('email', anotherUser.email);
  });

  it('trims and saves a valid Unicode display name', async () => {
    const user = await registerUser('profile-update');
    const displayName = `${'😀'.repeat(99)}И`;

    const response = await request(app.getHttpServer())
      .patch('/users/me')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ displayName: `  ${displayName}  ` })
      .expect(200);

    expectProfile(response, { id: user.id, email: user.email, displayName });

    const readResponse = await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);

    expectProfile(readResponse, { id: user.id, email: user.email, displayName });
  });

  it.each<[string, unknown]>([
    ['is absent', undefined],
    ['is null', null],
    ['is not a string', 42],
    ['is empty after trimming', ' \t\n '],
    ['exceeds 100 Unicode characters', '😀'.repeat(101)],
  ])(
    'rejects a display name when it %s without overwriting the saved value',
    async (_case, displayName) => {
      const user = await registerUser('profile-invalid');
      const savedDisplayName = 'Saved name';

      await request(app.getHttpServer())
        .patch('/users/me')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ displayName: savedDisplayName })
        .expect(200);

      await request(app.getHttpServer())
        .patch('/users/me')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send(displayName === undefined ? {} : { displayName })
        .expect(400);

      const response = await request(app.getHttpServer())
        .get('/users/me')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);

      expectProfile(response, { id: user.id, email: user.email, displayName: savedDisplayName });
    },
  );

  it('rejects unauthenticated profile reads and updates', async () => {
    await request(app.getHttpServer()).get('/users/me').expect(401);
    await request(app.getHttpServer())
      .patch('/users/me')
      .send({ displayName: 'Unauthenticated' })
      .expect(401);
  });

  it('does not allow a client to target another user or change email', async () => {
    const currentUser = await registerUser('profile-owner');
    const anotherUser = await registerUser('profile-target');

    await request(app.getHttpServer())
      .patch('/users/me')
      .set('Authorization', `Bearer ${currentUser.accessToken}`)
      .send({ displayName: 'Attempted takeover', userId: anotherUser.id })
      .expect(400);

    await request(app.getHttpServer())
      .patch('/users/me')
      .set('Authorization', `Bearer ${currentUser.accessToken}`)
      .send({ displayName: 'Attempted email change', email: anotherUser.email })
      .expect(400);

    await request(app.getHttpServer())
      .get(`/users/${anotherUser.id}`)
      .set('Authorization', `Bearer ${currentUser.accessToken}`)
      .expect(404);

    const currentUserResponse = await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${currentUser.accessToken}`)
      .expect(200);

    expectProfile(currentUserResponse, {
      id: currentUser.id,
      email: currentUser.email,
      displayName: null,
    });

    const response = await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${anotherUser.accessToken}`)
      .expect(200);

    expectProfile(response, { id: anotherUser.id, email: anotherUser.email, displayName: null });
  });
});
