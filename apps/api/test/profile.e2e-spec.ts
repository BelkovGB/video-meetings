import { INestApplication } from '@nestjs/common';
import { readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureHttpApplication } from '../src/http-application';
import { LocalAvatarStorageService } from '../src/profile/local-avatar-storage.service';
import { avatarConfig } from '../src/profile/avatar.config';
import { AvatarValidationService } from '../src/profile/avatar-validation.service';
import { ProfileService } from '../src/profile/profile.service';
import { PrismaService } from '../src/prisma/prisma.service';

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
  let authenticationRequestCount = 0;
  const originalTrustedProxyIps = process.env.TRUSTED_PROXY_IPS;

  beforeAll(async () => {
    await rm(avatarUploadRoot, { recursive: true, force: true });
    process.env.TRUSTED_PROXY_IPS = 'loopback';
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureHttpApplication(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await rm(avatarUploadRoot, { recursive: true, force: true });

    if (originalTrustedProxyIps === undefined) {
      delete process.env.TRUSTED_PROXY_IPS;
    } else {
      process.env.TRUSTED_PROXY_IPS = originalTrustedProxyIps;
    }
  });

  function authenticationRequest(path: '/auth/register' | '/auth/login') {
    authenticationRequestCount += 1;

    return request(app.getHttpServer())
      .post(path)
      .set('X-Forwarded-For', `198.51.100.${authenticationRequestCount}`);
  }

  async function registerUser(prefix: string): Promise<UserSession> {
    const email = createEmail(prefix);
    const response = await authenticationRequest('/auth/register')
      .send({ email, password: validPassword })
      .expect(201);

    return {
      accessToken: response.body.accessToken as string,
      id: getUserId(response.body.accessToken as string),
      email,
    };
  }

  async function loginUser(email: string, password: string): Promise<string> {
    const response = await authenticationRequest('/auth/login')
      .send({ email, password })
      .expect(200);

    return response.body.accessToken as string;
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
    await request(app.getHttpServer())
      .post('/users/me/password')
      .send({
        currentPassword: validPassword,
        newPassword: 'new-password-123',
        confirmation: 'new-password-123',
      })
      .expect(401);
  });

  it('rejects invalid password changes without changing the password or session', async () => {
    const user = await registerUser('password-change-invalid');
    const invalidRequests = [
      {
        currentPassword: 'not-the-current-password',
        newPassword: 'new-password-123',
        confirmation: 'new-password-123',
      },
      { currentPassword: validPassword, newPassword: validPassword, confirmation: validPassword },
      { currentPassword: validPassword, newPassword: 'password', confirmation: 'password' },
      {
        currentPassword: validPassword,
        newPassword: '😀'.repeat(19),
        confirmation: '😀'.repeat(19),
      },
      {
        currentPassword: validPassword,
        newPassword: 'new-password-123',
        confirmation: 'different-password-123',
      },
    ];

    for (const body of invalidRequests) {
      await request(app.getHttpServer())
        .post('/users/me/password')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send(body)
        .expect(400);

      await request(app.getHttpServer())
        .get('/users/me')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .expect(200);
    }

    await loginUser(user.email, validPassword);
  });

  it('limits repeated password-change attempts without changing the password or session', async () => {
    const user = await registerUser('password-change-rate-limit');
    const invalidChange = {
      currentPassword: 'not-the-current-password',
      newPassword: 'new-password-123',
      confirmation: 'new-password-123',
    };

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request(app.getHttpServer())
        .post('/users/me/password')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send(invalidChange)
        .expect(400);
    }

    await request(app.getHttpServer())
      .post('/users/me/password')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send(invalidChange)
      .expect('Retry-After', /\d+/)
      .expect(429);

    await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);
    await loginUser(user.email, validPassword);
  });

  it('changes the password, revokes only the caller session, and permits login with the new password', async () => {
    const user = await registerUser('password-change-success');
    const secondSessionToken = await loginUser(user.email, validPassword);
    const newPassword = '😀'.repeat(18);

    await request(app.getHttpServer())
      .post('/users/me/password')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ currentPassword: validPassword, newPassword, confirmation: newPassword })
      .expect(204);

    await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(401);
    await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${secondSessionToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: user.email, password: validPassword })
      .expect(401);
    await loginUser(user.email, newPassword);
  });

  it('permits login after changing to a decomposed Unicode password', async () => {
    const user = await registerUser('password-change-unicode');
    const newPassword = 'e\u0301'.repeat(9);

    await request(app.getHttpServer())
      .post('/users/me/password')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ currentPassword: validPassword, newPassword, confirmation: newPassword })
      .expect(204);

    await loginUser(user.email, newPassword);
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
    const displayName = 'Avatar owner';

    await request(app.getHttpServer())
      .patch('/users/me')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ displayName })
      .expect(200);

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

    const storage = app.get(LocalAvatarStorageService);
    const discard = jest
      .spyOn(storage, 'discard')
      .mockRejectedValueOnce(new Error('storage temporarily unavailable'));
    const removed = await request(app.getHttpServer())
      .delete('/users/me/avatar')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);

    expectProfile(removed, { id: user.id, email: user.email, displayName, avatar: null });
    expect(removed.body).not.toHaveProperty('storageKey');
    expect(removed.body).not.toHaveProperty('path');
    discard.mockRestore();
    await storage.reconcile();
    expect(await readdir(join(avatarUploadRoot, 'files'))).toHaveLength(storedBefore.length);
    await request(app.getHttpServer())
      .get('/users/me/avatar')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(404);
    const repeatedRemoval = await request(app.getHttpServer())
      .delete('/users/me/avatar')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);
    expectProfile(repeatedRemoval, removed.body as Profile);
    await expect(
      app.get(PrismaService).user.findUnique({ where: { id: user.id }, select: { id: true } }),
    ).resolves.toEqual({ id: user.id });
  });

  it('keeps the prior avatar retrievable when storage rejects a replacement', async () => {
    const user = await registerUser('avatar-replacement-storage-failure');
    const storedBefore = await readdir(join(avatarUploadRoot, 'files'));
    await request(app.getHttpServer())
      .post('/users/me/avatar')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .attach('avatar', validPng, { filename: 'portrait.png', contentType: 'image/png' })
      .expect(201);
    const storage = app.get(LocalAvatarStorageService);
    const finalize = jest
      .spyOn(storage, 'finalize')
      .mockRejectedValueOnce(new Error('storage unavailable'));

    await request(app.getHttpServer())
      .post('/users/me/avatar')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .attach('avatar', validJpeg, { filename: 'replacement.jpg', contentType: 'image/jpeg' })
      .expect(500);

    finalize.mockRestore();
    const retrieved = await request(app.getHttpServer())
      .get('/users/me/avatar')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect('Content-Type', /image\/png/)
      .expect(200);
    expect(Buffer.from(retrieved.body as Buffer)).toEqual(validPng);
    expect(await readdir(join(avatarUploadRoot, 'files'))).toHaveLength(storedBefore.length + 1);
    await expect(readdir(join(avatarUploadRoot, 'temp'))).resolves.toEqual([]);
  });

  it('removes a retained replacement when persistence fails and preserves the prior avatar', async () => {
    const user = await registerUser('avatar-replacement-persistence-failure');
    const storedBefore = await readdir(join(avatarUploadRoot, 'files'));
    await request(app.getHttpServer())
      .post('/users/me/avatar')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .attach('avatar', validPng, { filename: 'portrait.png', contentType: 'image/png' })
      .expect(201);
    const prisma = app.get(PrismaService);
    const update = jest
      .spyOn(prisma.user, 'update')
      .mockRejectedValueOnce(new Error('database unavailable'));
    const transaction = jest
      .spyOn(prisma, '$transaction')
      .mockImplementation(async (operation) => operation(prisma as never));

    await request(app.getHttpServer())
      .post('/users/me/avatar')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .attach('avatar', validJpeg, { filename: 'replacement.jpg', contentType: 'image/jpeg' })
      .expect(500);

    update.mockRestore();
    transaction.mockRestore();
    const retrieved = await request(app.getHttpServer())
      .get('/users/me/avatar')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect('Content-Type', /image\/png/)
      .expect(200);
    expect(Buffer.from(retrieved.body as Buffer)).toEqual(validPng);
    expect(await readdir(join(avatarUploadRoot, 'files'))).toHaveLength(storedBefore.length + 1);
    await expect(readdir(join(avatarUploadRoot, 'temp'))).resolves.toEqual([]);
  });

  it('serializes concurrent replacements from separate API instances', async () => {
    const user = await registerUser('avatar-multi-instance-replacement');
    await request(app.getHttpServer())
      .post('/users/me/avatar')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .attach('avatar', validPng, { filename: 'portrait.png', contentType: 'image/png' })
      .expect(201);

    const storage = app.get(LocalAvatarStorageService);
    const firstTempPath = join(avatarUploadRoot, 'temp', `${user.id}-first.part`);
    const secondTempPath = join(avatarUploadRoot, 'temp', `${user.id}-second.part`);
    const firstContent = Buffer.from('first concurrent replacement');
    const secondContent = Buffer.from('second concurrent replacement');
    await writeFile(firstTempPath, firstContent);
    await writeFile(secondTempPath, secondContent);

    const firstPrisma = new PrismaService();
    const secondPrisma = new PrismaService();
    await Promise.all([firstPrisma.onModuleInit(), secondPrisma.onModuleInit()]);
    let releaseFirstFinalize: (() => void) | undefined;
    const firstFinalizeStarted = new Promise<void>((resolve) => {
      releaseFirstFinalize = resolve;
    });
    const originalFinalize = storage.finalize.bind(storage);
    const finalize = jest.spyOn(storage, 'finalize').mockImplementation(async (path, key) => {
      if (finalize.mock.calls.length === 1) {
        releaseFirstFinalize?.();
        await new Promise<void>((resolve) => {
          releaseFirstFinalize = resolve;
        });
      }
      await originalFinalize(path, key);
    });
    const validation = {
      validate: jest
        .fn()
        .mockResolvedValue({ mimeType: 'image/png', sizeBytes: firstContent.length }),
    } as unknown as AvatarValidationService;
    const firstService = new ProfileService(firstPrisma, storage, validation);
    const secondService = new ProfileService(secondPrisma, storage, validation);

    try {
      const first = firstService.uploadAvatar(user.id, {
        path: firstTempPath,
      } as Express.Multer.File);
      await firstFinalizeStarted;
      const second = secondService.uploadAvatar(user.id, {
        path: secondTempPath,
      } as Express.Multer.File);
      await new Promise((resolve) => setImmediate(resolve));
      expect(finalize).toHaveBeenCalledTimes(1);

      releaseFirstFinalize?.();
      await Promise.all([first, second]);

      const activeAvatar = await app.get(PrismaService).user.findUniqueOrThrow({
        where: { id: user.id },
        select: { avatarStorageKey: true },
      });
      const stream = await storage.open(activeAvatar.avatarStorageKey!);
      const received: Buffer[] = [];
      for await (const chunk of stream) {
        received.push(Buffer.from(chunk));
      }
      expect(Buffer.concat(received)).toEqual(secondContent);
    } finally {
      finalize.mockRestore();
      await Promise.all([firstPrisma.onModuleDestroy(), secondPrisma.onModuleDestroy()]);
    }
  });

  it('does not let another storage instance remove a finalized replacement before its reference commits', async () => {
    const user = await registerUser('avatar-reconciliation-race');
    await request(app.getHttpServer())
      .post('/users/me/avatar')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .attach('avatar', validPng, { filename: 'portrait.png', contentType: 'image/png' })
      .expect(201);

    const storage = app.get(LocalAvatarStorageService);
    const replacementTempPath = join(avatarUploadRoot, 'temp', `${user.id}-reconciliation.part`);
    await writeFile(replacementTempPath, validJpeg);
    const reconciliationPrisma = new PrismaService();
    await reconciliationPrisma.onModuleInit();
    const reconciliationStorage = new LocalAvatarStorageService(reconciliationPrisma);
    await reconciliationStorage.onModuleInit();
    const originalFinalize = storage.finalize.bind(storage);
    let releaseFinalize: (() => void) | undefined;
    const replacementFinalized = new Promise<void>((resolve) => {
      releaseFinalize = resolve;
    });
    let allowCommit: (() => void) | undefined;
    const commitAllowed = new Promise<void>((resolve) => {
      allowCommit = resolve;
    });
    const finalize = jest.spyOn(storage, 'finalize').mockImplementation(async (path, key) => {
      await originalFinalize(path, key);
      const staleAt = new Date(Date.now() - avatarConfig.temporaryUploadGraceMs - 1_000);
      await utimes(join(avatarUploadRoot, 'files', key), staleAt, staleAt);
      releaseFinalize?.();
      await commitAllowed;
    });
    const replacementPrisma = new PrismaService();
    const service = new ProfileService(replacementPrisma, storage, {
      validate: jest
        .fn()
        .mockResolvedValue({ mimeType: 'image/jpeg', sizeBytes: validJpeg.length }),
    } as unknown as AvatarValidationService);

    try {
      await replacementPrisma.onModuleInit();
      const replacement = service.uploadAvatar(user.id, {
        path: replacementTempPath,
      } as Express.Multer.File);
      await replacementFinalized;

      await reconciliationStorage.reconcile();
      allowCommit?.();
      await replacement;

      const activeAvatar = await app.get(PrismaService).user.findUniqueOrThrow({
        where: { id: user.id },
        select: { avatarStorageKey: true },
      });
      await expect(storage.open(activeAvatar.avatarStorageKey!)).resolves.toBeDefined();
    } finally {
      finalize.mockRestore();
      await replacementPrisma.onModuleDestroy();
      await reconciliationStorage.onModuleDestroy();
      await reconciliationPrisma.onModuleDestroy();
    }
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
    await request(app.getHttpServer())
      .delete(`/users/${owner.id}/avatar`)
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
    await request(app.getHttpServer()).delete('/users/me/avatar').expect(401);
  });
});
