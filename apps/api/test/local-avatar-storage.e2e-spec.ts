import { Logger } from '@nestjs/common';
import * as fsPromises from 'node:fs/promises';
import { readdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { avatarConfig } from '../src/profile/avatar.config';
import { LocalAvatarStorageService } from '../src/profile/local-avatar-storage.service';

describe('LocalAvatarStorageService', () => {
  const storage = new LocalAvatarStorageService();
  const storageKey = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tempPath = join(avatarConfig.tempDirectory, `${storageKey}.part`);
  const content = Buffer.from('private avatar content');

  beforeAll(async () => {
    await storage.onModuleInit();
  });

  afterAll(async () => {
    await storage.discardTemp(tempPath);
    await storage.discard(storageKey);
  });

  it('moves a temporary avatar into private storage, reads it, and deletes it', async () => {
    await writeFile(tempPath, content);
    await storage.finalize(tempPath, storageKey);

    await expect(readFile(tempPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const stream = await storage.open(storageKey);
    const received: Buffer[] = [];
    for await (const chunk of stream) {
      received.push(Buffer.from(chunk));
    }
    expect(Buffer.concat(received)).toEqual(content);

    await storage.discard(storageKey);
    await expect(storage.open(storageKey)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps existing private content when finalizing a replacement to an occupied key fails', async () => {
    const occupiedKey = `${storageKey}-occupied`;
    const originalTempPath = join(avatarConfig.tempDirectory, `${occupiedKey}-original.part`);
    const replacementTempPath = join(avatarConfig.tempDirectory, `${occupiedKey}-replacement.part`);
    const originalContent = Buffer.from('original private avatar content');

    try {
      await writeFile(originalTempPath, originalContent);
      await storage.finalize(originalTempPath, occupiedKey);
      await writeFile(replacementTempPath, Buffer.from('replacement private avatar content'));

      await expect(storage.finalize(replacementTempPath, occupiedKey)).rejects.toMatchObject({
        response: { code: 'AVATAR_STORAGE_UNAVAILABLE' },
      });

      const stream = await storage.open(occupiedKey);
      const received: Buffer[] = [];
      for await (const chunk of stream) {
        received.push(Buffer.from(chunk));
      }
      expect(Buffer.concat(received)).toEqual(originalContent);
    } finally {
      await storage.discardTemp(originalTempPath);
      await storage.discardTemp(replacementTempPath);
      await storage.discard(occupiedKey);
    }
  });

  it('retries a failed finalized-avatar deletion during periodic reconciliation', async () => {
    const retryKey = `${storageKey}-retry`;
    const retryTempPath = join(avatarConfig.tempDirectory, `${retryKey}.part`);

    try {
      await writeFile(retryTempPath, content);
      await storage.finalize(retryTempPath, retryKey);
      const discard = jest
        .spyOn(storage, 'discard')
        .mockRejectedValueOnce(new Error('storage temporarily unavailable'));

      await storage.discardEventually(retryKey);
      await storage.reconcile();

      expect(discard).toHaveBeenCalledTimes(2);
      await expect(storage.open(retryKey)).rejects.toMatchObject({ code: 'ENOENT' });
      discard.mockRestore();
    } finally {
      await storage.discardTemp(retryTempPath);
      await storage.discard(retryKey);
    }
  });

  it('removes private avatar content through the non-blocking cleanup path', async () => {
    const removalKey = `${storageKey}-removal`;
    const removalTempPath = join(avatarConfig.tempDirectory, `${removalKey}.part`);

    try {
      await writeFile(removalTempPath, content);
      await storage.finalize(removalTempPath, removalKey);

      await storage.discardEventually(removalKey);

      await expect(storage.open(removalKey)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await storage.discardTemp(removalTempPath);
      await storage.discard(removalKey);
    }
  });

  it('removes interrupted temporary avatar uploads when storage starts', async () => {
    await writeFile(tempPath, content);
    const staleAt = new Date(Date.now() - avatarConfig.temporaryUploadGraceMs - 1_000);
    await utimes(tempPath, staleAt, staleAt);

    await new LocalAvatarStorageService().onModuleInit();

    await expect(readFile(tempPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps an active temporary upload when another storage instance starts', async () => {
    await writeFile(tempPath, content);

    await new LocalAvatarStorageService().onModuleInit();

    await expect(readFile(tempPath)).resolves.toEqual(content);
  });

  it('keeps a finalized replacement reserved while another storage instance reconciles', async () => {
    const reservedKey = `${storageKey}-reserved`;
    const reservedTempPath = join(avatarConfig.tempDirectory, `${reservedKey}.part`);
    const prisma: any = {};
    Object.assign(prisma, {
      $transaction: jest.fn(async (operation: (client: any) => unknown) => operation(prisma)),
      $queryRaw: jest.fn().mockResolvedValue([{ locked: true }]),
      avatarStorageReservation: {
        findUnique: jest.fn().mockResolvedValue({ createdAt: new Date() }),
      },
      user: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    });

    try {
      await writeFile(reservedTempPath, content);
      await storage.finalize(reservedTempPath, reservedKey);
      const staleAt = new Date(Date.now() - avatarConfig.temporaryUploadGraceMs - 1_000);
      await utimes(join(avatarConfig.directory, reservedKey), staleAt, staleAt);

      await new LocalAvatarStorageService(prisma as never).onModuleInit();

      await expect(storage.open(reservedKey)).resolves.toBeDefined();
    } finally {
      await storage.discardTemp(reservedTempPath);
      await storage.discard(reservedKey);
    }
  });

  it('removes a stale finalized replacement left after an interrupted switch', async () => {
    const staleKey = `${storageKey}-stale-reservation`;
    const staleTempPath = join(avatarConfig.tempDirectory, `${staleKey}.part`);
    const createdAt = new Date(Date.now() - avatarConfig.temporaryUploadGraceMs - 1_000);
    const prisma: any = {};
    Object.assign(prisma, {
      $transaction: jest.fn(async (operation: (client: any) => unknown) => operation(prisma)),
      $queryRaw: jest.fn().mockResolvedValue([{ locked: true }]),
      avatarStorageReservation: {
        findUnique: jest.fn().mockResolvedValue({ createdAt }),
        delete: jest.fn().mockResolvedValue(undefined),
      },
      user: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    });

    try {
      await writeFile(staleTempPath, content);
      await storage.finalize(staleTempPath, staleKey);
      await utimes(join(avatarConfig.directory, staleKey), createdAt, createdAt);

      await new LocalAvatarStorageService(prisma as never).onModuleInit();

      await expect(storage.open(staleKey)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(prisma.avatarStorageReservation.delete).toHaveBeenCalledWith({
        where: { storageKey: staleKey },
      });
    } finally {
      await storage.discardTemp(staleTempPath);
      await storage.discard(staleKey);
    }
  });

  it('removes finalized avatars that are no longer referenced by a user', async () => {
    const retainedKey = `${storageKey}-retained`;
    const orphanedKey = `${storageKey}-orphaned`;
    const retainedTempPath = join(avatarConfig.tempDirectory, `${retainedKey}.part`);
    const orphanedTempPath = join(avatarConfig.tempDirectory, `${orphanedKey}.part`);
    const prisma: any = {};
    Object.assign(prisma, {
      $transaction: jest.fn(async (operation: (client: any) => unknown) => operation(prisma)),
      $queryRaw: jest.fn().mockResolvedValue([{ locked: true }]),
      avatarStorageReservation: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      user: {
        findFirst: jest.fn(({ where }: { where: { avatarStorageKey: string } }) =>
          Promise.resolve(where.avatarStorageKey === retainedKey ? { id: 'retained-user' } : null),
        ),
      },
    });

    try {
      await writeFile(retainedTempPath, content);
      await storage.finalize(retainedTempPath, retainedKey);
      await writeFile(orphanedTempPath, content);
      await storage.finalize(orphanedTempPath, orphanedKey);
      const staleAt = new Date(Date.now() - avatarConfig.temporaryUploadGraceMs - 1_000);
      await utimes(join(avatarConfig.directory, orphanedKey), staleAt, staleAt);

      await new LocalAvatarStorageService(prisma as never).onModuleInit();

      await expect(storage.open(retainedKey)).resolves.toBeDefined();
      await expect(storage.open(orphanedKey)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await storage.discardTemp(retainedTempPath);
      await storage.discardTemp(orphanedTempPath);
      await storage.discard(retainedKey);
      await storage.discard(orphanedKey);
    }
  });

  describe('derived variants', () => {
    const variant = 'list-96';
    const derived = Buffer.from('derived list-sized avatar');

    async function storeAvatar(suffix: string): Promise<string> {
      const key = `${storageKey}-${suffix}`;
      const path = join(avatarConfig.tempDirectory, `${key}.part`);
      await writeFile(path, content);
      await storage.finalize(path, key);
      return key;
    }

    /** Other tests in this suite keep their own `.part` fixtures alive. */
    async function tempParts(): Promise<string[]> {
      const entries = await readdir(avatarConfig.tempDirectory);
      return entries.filter((entry) => entry.endsWith('.part')).sort();
    }

    it('reports an underived variant as absent, publishes it whole, and drops it with the avatar', async () => {
      const key = await storeAvatar('variant');
      const partsBefore = await tempParts();

      try {
        await expect(storage.openVariant(key, variant)).resolves.toBeNull();

        await storage.saveVariant(key, variant, derived);

        const opened = await storage.openVariant(key, variant);
        expect(opened?.sizeBytes).toBe(derived.length);
        const received: Buffer[] = [];
        for await (const chunk of opened!.stream) {
          received.push(Buffer.from(chunk));
        }
        expect(Buffer.concat(received)).toEqual(derived);
        // Published through a rename, so nothing is left behind in the
        // temporary directory for reconciliation to sweep.
        expect(await tempParts()).toEqual(partsBefore);

        // The derived file lives under the avatar's own storage key, so removal
        // takes it along and no request can read a variant of a replaced
        // picture.
        await storage.discard(key);
        await expect(storage.openVariant(key, variant)).resolves.toBeNull();
      } finally {
        await storage.discard(key);
      }
    });

    it('reports a variant it cannot open for a reason other than absence as unavailable', async () => {
      const key = await storeAvatar('variant-unreadable');
      const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
      const open = jest.spyOn(fsPromises, 'open').mockRejectedValueOnce(denied as never);

      try {
        // Absence is the ordinary "not derived yet" answer; anything else is a
        // broken store and must not be mistaken for it.
        await expect(storage.openVariant(key, variant)).rejects.toMatchObject({
          response: { code: 'AVATAR_STORAGE_UNAVAILABLE' },
        });
      } finally {
        open.mockRestore();
        await storage.discard(key);
      }
    });

    it('leaves the avatar readable and logs when a variant cannot be stored', async () => {
      const key = await storeAvatar('variant-unwritable');
      const partsBefore = await tempParts();
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      try {
        // A destination inside the store that does not exist: the same shape as
        // a full disk or a read-only volume, which must degrade the route to a
        // slower answer rather than fail it.
        await expect(
          storage.saveVariant(key, `missing/${variant}`, derived),
        ).resolves.toBeUndefined();

        expect(warn).toHaveBeenCalledWith(expect.stringContaining('avatar variant'));
        expect(await tempParts()).toEqual(partsBefore);
        const avatar = await storage.open(key);
        avatar.destroy();
      } finally {
        warn.mockRestore();
        await storage.discard(key);
      }
    });

    it('refuses to store a variant outside the configured directory', async () => {
      const key = await storeAvatar('variant-escape');

      try {
        // A path-policy failure is a misconfiguration, not a transient write
        // failure, so it must surface instead of degrading the route silently.
        await expect(storage.saveVariant(key, '../../escaped', derived)).rejects.toThrow(
          'outside the configured directory',
        );
      } finally {
        await storage.discard(key);
      }
    });
  });
});
