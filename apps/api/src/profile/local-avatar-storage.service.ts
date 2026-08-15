import { Injectable, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { ReadStream } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import { avatarConfig } from './avatar.config';

function isInside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== '' && !path.startsWith('..') && !path.includes('..\\') && !isAbsolute(path);
}

@Injectable()
export class LocalAvatarStorageService implements OnModuleInit {
  async onModuleInit(): Promise<void> {
    try {
      await mkdir(avatarConfig.directory, { recursive: true, mode: 0o700 });
      await mkdir(avatarConfig.tempDirectory, { recursive: true, mode: 0o700 });
      const [directory, tempDirectory] = await Promise.all([
        stat(avatarConfig.directory),
        stat(avatarConfig.tempDirectory),
      ]);
      if (directory.dev !== tempDirectory.dev) {
        throw new Error('Avatar directories must be on the same filesystem');
      }
      await this.reconcileTemporaryUploads();
    } catch (error) {
      throw new ServiceUnavailableException({
        message: 'Avatar storage is unavailable',
        code: 'AVATAR_STORAGE_UNAVAILABLE',
        cause: error instanceof Error ? error.message : undefined,
      });
    }
  }

  async finalize(tempPath: string, storageKey: string): Promise<void> {
    const source = resolve(tempPath);
    const destinationDirectory = this.resolveDirectory(storageKey);
    const destination = resolve(destinationDirectory, 'content');
    if (!isInside(avatarConfig.tempDirectory, source)) {
      throw new Error('Avatar temporary path is outside the configured directory');
    }
    try {
      await mkdir(destinationDirectory, { mode: 0o700 });
      await rename(source, destination);
    } catch (error) {
      await rm(destinationDirectory, { recursive: true, force: true });
      throw new ServiceUnavailableException({
        message: 'Avatar storage is unavailable',
        code: 'AVATAR_STORAGE_UNAVAILABLE',
        cause: error instanceof Error ? error.message : undefined,
      });
    }
  }

  async discardTemp(tempPath: string): Promise<void> {
    const source = resolve(tempPath);
    if (isInside(avatarConfig.tempDirectory, source)) {
      await rm(source, { force: true });
    }
  }

  async discard(storageKey: string | null): Promise<void> {
    if (storageKey) {
      await rm(this.resolveDirectory(storageKey), { recursive: true, force: true });
    }
  }

  async open(storageKey: string): Promise<ReadStream> {
    try {
      const handle = await open(resolve(this.resolveDirectory(storageKey), 'content'), 'r');
      return handle.createReadStream();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw error;
      }
      throw new ServiceUnavailableException({
        message: 'Avatar storage is unavailable',
        code: 'AVATAR_STORAGE_UNAVAILABLE',
      });
    }
  }

  private async reconcileTemporaryUploads(): Promise<void> {
    const entries = await readdir(avatarConfig.tempDirectory, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.name.endsWith('.part'))
        .map((entry) =>
          rm(resolve(avatarConfig.tempDirectory, entry.name), {
            recursive: entry.isDirectory(),
            force: true,
          }),
        ),
    );
  }

  private resolveDirectory(storageKey: string): string {
    const destinationDirectory = resolve(avatarConfig.directory, storageKey);
    if (!isInside(avatarConfig.directory, destinationDirectory)) {
      throw new Error('Avatar storage path is outside the configured directory');
    }
    return destinationDirectory;
  }
}
