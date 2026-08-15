import { INestApplication } from '@nestjs/common';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
  avatar: { mimeType: string; sizeBytes: number; updatedAt: string } | null;
};

const validPassword = 'secure-password-123';
const avatarUploadRoot = join(tmpdir(), 'video-meetings-api-e2e-avatars');
const validPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC',
  'base64',
);
const validJpeg = Buffer.from(
  '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgj/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABykX//Z',
  'base64',
);
const validWebp = Buffer.from(
  'UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoBAAEAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA=',
  'base64',
);
const fakePng = Buffer.concat([
  Buffer.from('89504e470d0a1a0a0000000049484452', 'hex'),
  Buffer.alloc(5),
  Buffer.from('0000000049454e44ae426082', 'hex'),
]);
const undecodablePng = Buffer.concat([
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'),
  Buffer.alloc(13),
  Buffer.from('0000000149444154000000000000000049454e44ae426082', 'hex'),
]);
const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const fakeWebp = Buffer.from('524946460400000057454250', 'hex');

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
    await rm(avatarUploadRoot, { recursive: true, force: true });
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await rm(avatarUploadRoot, { recursive: true, force: true });
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
      avatar: null,
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

    expectProfile(response, { id: user.id, email: user.email, displayName, avatar: null });

    const readResponse = await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);

    expectProfile(readResponse, { id: user.id, email: user.email, displayName, avatar: null });
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

      expectProfile(response, {
        id: user.id,
        email: user.email,
        displayName: savedDisplayName,
        avatar: null,
      });
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
      avatar: null,
    });

    const response = await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${anotherUser.accessToken}`)
      .expect(200);

    expectProfile(response, {
      id: anotherUser.id,
      email: anotherUser.email,
      displayName: null,
      avatar: null,
    });
  });

  it('uploads a verified avatar, exposes safe metadata, and retrieves only its content', async () => {
    const user = await registerUser('avatar-valid');

    const uploaded = await request(app.getHttpServer())
      .post('/users/me/avatar')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .attach('avatar', validPng, { filename: 'portrait.png', contentType: 'image/png' })
      .expect(201);

    expect(uploaded.body).toEqual({
      mimeType: 'image/png',
      sizeBytes: validPng.length,
      updatedAt: expect.any(String),
    });

    const profile = await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);
    expect(profile.body.avatar).toEqual(uploaded.body);
    expect(profile.body.avatar).not.toHaveProperty('storageKey');

    const retrieved = await request(app.getHttpServer())
      .get('/users/me/avatar')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect('Content-Type', /image\/png/)
      .expect('Cache-Control', 'private, no-store')
      .expect('X-Content-Type-Options', 'nosniff')
      .expect(200);
    expect(Buffer.from(retrieved.body as Buffer)).toEqual(validPng);
  });

  it('replaces an avatar only after the new image is retained', async () => {
    const user = await registerUser('avatar-replacement');
    const storedBefore = await readdir(join(avatarUploadRoot, 'files'));

    await request(app.getHttpServer())
      .post('/users/me/avatar')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .attach('avatar', validPng, { filename: 'portrait.png', contentType: 'image/png' })
      .expect(201);
    expect(await readdir(join(avatarUploadRoot, 'files'))).toHaveLength(storedBefore.length + 1);

    const replacement = await request(app.getHttpServer())
      .post('/users/me/avatar')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .attach('avatar', validJpeg, { filename: 'replacement.jpg', contentType: 'image/jpeg' })
      .expect(201);

    expect(replacement.body).toEqual({
      mimeType: 'image/jpeg',
      sizeBytes: validJpeg.length,
      updatedAt: expect.any(String),
    });
    expect(await readdir(join(avatarUploadRoot, 'files'))).toHaveLength(storedBefore.length + 1);

    const retrieved = await request(app.getHttpServer())
      .get('/users/me/avatar')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect('Content-Type', /image\/jpeg/)
      .expect(200);
    expect(Buffer.from(retrieved.body as Buffer)).toEqual(validJpeg);
  });

  it.each([
    ['invalid', 'portrait.gif', 'image/gif', Buffer.from('GIF89a'), 415],
    ['oversized', 'portrait.png', 'image/png', Buffer.concat([validPng, Buffer.alloc(1024)]), 413],
  ])(
    'keeps the previous avatar retrievable when a %s replacement is rejected',
    async (_case, filename, contentType, content, status) => {
      const user = await registerUser('avatar-replacement-rejected');

      await request(app.getHttpServer())
        .post('/users/me/avatar')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .attach('avatar', validPng, { filename: 'portrait.png', contentType: 'image/png' })
        .expect(201);

      await request(app.getHttpServer())
        .post('/users/me/avatar')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .attach('avatar', content, { filename, contentType })
        .expect(status);

      const retrieved = await request(app.getHttpServer())
        .get('/users/me/avatar')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect('Content-Type', /image\/png/)
        .expect(200);
      expect(Buffer.from(retrieved.body as Buffer)).toEqual(validPng);
      await expect(readdir(join(avatarUploadRoot, 'temp'))).resolves.toEqual([]);
    },
  );

  it.each([
    ['portrait.jpg', 'image/jpeg', validJpeg],
    ['portrait.webp', 'image/webp', validWebp],
  ])('accepts a verified %s avatar', async (filename, contentType, content) => {
    const user = await registerUser('avatar-format');

    const response = await request(app.getHttpServer())
      .post('/users/me/avatar')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .attach('avatar', content, { filename, contentType })
      .expect(201);

    expect(response.body).toMatchObject({ mimeType: contentType, sizeBytes: content.length });
  });

  it.each([
    [
      'malformed content',
      'portrait.png',
      'image/png',
      Buffer.from('not a png'),
      415,
      'UNSUPPORTED_AVATAR_TYPE',
    ],
    [
      'a PNG signature without valid chunks',
      'portrait.png',
      'image/png',
      fakePng,
      415,
      'UNSUPPORTED_AVATAR_TYPE',
    ],
    [
      'a structurally plausible but undecodable PNG',
      'portrait.png',
      'image/png',
      undecodablePng,
      415,
      'UNSUPPORTED_AVATAR_TYPE',
    ],
    [
      'a JPEG signature without image data',
      'portrait.jpg',
      'image/jpeg',
      fakeJpeg,
      415,
      'UNSUPPORTED_AVATAR_TYPE',
    ],
    [
      'a WebP container without an image chunk',
      'portrait.webp',
      'image/webp',
      fakeWebp,
      415,
      'UNSUPPORTED_AVATAR_TYPE',
    ],
    [
      'unsupported content type',
      'portrait.gif',
      'image/gif',
      Buffer.from('GIF89a'),
      415,
      'UNSUPPORTED_AVATAR_TYPE',
    ],
    [
      'oversized content',
      'portrait.png',
      'image/png',
      Buffer.concat([validPng, Buffer.alloc(1024)]),
      413,
      'AVATAR_TOO_LARGE',
    ],
  ])(
    'rejects %s without retaining an avatar',
    async (_case, filename, contentType, content, status, code) => {
      const user = await registerUser('avatar-invalid');

      const response = await request(app.getHttpServer())
        .post('/users/me/avatar')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .attach('avatar', content, { filename, contentType })
        .expect(status);

      expect(response.body).toMatchObject({ code });
      await request(app.getHttpServer())
        .get('/users/me/avatar')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(404);
      await expect(readdir(join(avatarUploadRoot, 'temp'))).resolves.toEqual([]);
    },
  );

  it('keeps avatar operations self-only', async () => {
    const owner = await registerUser('avatar-owner');
    const anotherUser = await registerUser('avatar-another');

    await request(app.getHttpServer())
      .post('/users/me/avatar')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .attach('avatar', validPng, { filename: 'portrait.png', contentType: 'image/png' })
      .expect(201);

    await request(app.getHttpServer())
      .get('/users/me/avatar')
      .set('Authorization', `Bearer ${anotherUser.accessToken}`)
      .expect(404);
    await request(app.getHttpServer())
      .post('/users/me/avatar')
      .set('Authorization', `Bearer ${anotherUser.accessToken}`)
      .field('userId', owner.id)
      .attach('avatar', validPng, { filename: 'portrait.png', contentType: 'image/png' })
      .expect(400);
    await request(app.getHttpServer())
      .get(`/users/${owner.id}/avatar`)
      .set('Authorization', `Bearer ${anotherUser.accessToken}`)
      .expect(404);
  });

  it('rejects requests containing more than one avatar file', async () => {
    const user = await registerUser('avatar-multiple');

    await request(app.getHttpServer())
      .post('/users/me/avatar')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .attach('avatar', validPng, { filename: 'first.png', contentType: 'image/png' })
      .attach('avatar', validPng, { filename: 'second.png', contentType: 'image/png' })
      .expect(400);

    await request(app.getHttpServer())
      .get('/users/me/avatar')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(404);
    await expect(readdir(join(avatarUploadRoot, 'temp'))).resolves.toEqual([]);
  });

  it('rejects unauthenticated avatar uploads and retrieval', async () => {
    await request(app.getHttpServer())
      .post('/users/me/avatar')
      .attach('avatar', validPng, { filename: 'portrait.png', contentType: 'image/png' })
      .expect(401);
    await expect(readdir(join(avatarUploadRoot, 'temp'))).resolves.toEqual([]);
    await request(app.getHttpServer()).get('/users/me/avatar').expect(401);
  });
});
