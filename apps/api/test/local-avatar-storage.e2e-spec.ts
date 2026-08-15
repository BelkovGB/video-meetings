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
