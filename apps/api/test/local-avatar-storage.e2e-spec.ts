import { readFile, utimes, writeFile } from 'node:fs/promises';
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
});
