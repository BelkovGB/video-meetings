import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ReadStream } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Prisma } from '@prisma/client';

import { isInsideDirectory } from '../storage/storage-path-policy';
import { avatarConfig } from './avatar.config';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class LocalAvatarStorageService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LocalAvatarStorageService.name);
  private readonly pendingDiscards = new Set<string>();
  private reconciliationTimer: NodeJS.Timeout | undefined;
  private reconciliationRunning = false;

  constructor(private readonly prisma?: PrismaService) {}

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
      await this.reconcileUnreferencedAvatars();
      if (this.prisma) {
        this.reconciliationTimer = setInterval(() => {
          void this.reconcile().catch((error: unknown) => {
            this.logger.error(
              'Failed to reconcile avatar storage',
              error instanceof Error ? error.stack : undefined,
            );
          });
        }, avatarConfig.reconciliationIntervalMs);
        this.reconciliationTimer.unref();
      }
    } catch (error) {
      throw new ServiceUnavailableException({
        message: 'Avatar storage is unavailable',
        code: 'AVATAR_STORAGE_UNAVAILABLE',
        cause: error instanceof Error ? error.message : undefined,
      });
    }
  }

  onModuleDestroy(): void {
    if (this.reconciliationTimer) {
      clearInterval(this.reconciliationTimer);
    }
  }

  async finalize(tempPath: string, storageKey: string): Promise<void> {
    const source = resolve(tempPath);
    const destinationDirectory = this.resolveDirectory(storageKey);
    const destination = resolve(destinationDirectory, 'content');
    if (!isInsideDirectory(avatarConfig.tempDirectory, source)) {
      throw new Error('Avatar temporary path is outside the configured directory');
    }
    let destinationDirectoryCreated = false;
    try {
      await mkdir(destinationDirectory, { mode: 0o700 });
      destinationDirectoryCreated = true;
      await rename(source, destination);
    } catch (error) {
      if (destinationDirectoryCreated) {
        await rm(destinationDirectory, { recursive: true, force: true });
      }
      throw new ServiceUnavailableException({
        message: 'Avatar storage is unavailable',
        code: 'AVATAR_STORAGE_UNAVAILABLE',
        cause: error instanceof Error ? error.message : undefined,
      });
    }
  }

  async discardTemp(tempPath: string): Promise<void> {
    const source = resolve(tempPath);
    if (isInsideDirectory(avatarConfig.tempDirectory, source)) {
      await rm(source, { force: true });
    }
  }

  async discard(storageKey: string | null): Promise<void> {
    if (storageKey) {
      await rm(this.resolveDirectory(storageKey), { recursive: true, force: true });
    }
  }

  async discardEventually(storageKey: string | null): Promise<void> {
    if (!storageKey) {
      return;
    }

    try {
      await this.discard(storageKey);
      this.pendingDiscards.delete(storageKey);
    } catch {
      this.pendingDiscards.add(storageKey);
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

  async readContent(storageKey: string): Promise<Buffer> {
    try {
      return await readFile(resolve(this.resolveDirectory(storageKey), 'content'));
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

  /**
   * Opens a picture derived from the stored avatar, or reports `null` when it
   * has not been derived yet. Derived files live under the avatar's own storage
   * key, so `discard` and reconciliation remove them with the avatar itself.
   */
  async openVariant(
    storageKey: string,
    variant: string,
  ): Promise<{ stream: ReadStream; sizeBytes: number } | null> {
    let handle;
    try {
      handle = await open(this.resolveVariant(storageKey, variant), 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw new ServiceUnavailableException({
        message: 'Avatar storage is unavailable',
        code: 'AVATAR_STORAGE_UNAVAILABLE',
      });
    }

    try {
      const { size } = await handle.stat();
      return { stream: handle.createReadStream(), sizeBytes: size };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  /**
   * Publishes a derived picture through a rename, so a concurrent reader sees
   * either no variant or a complete one. Storing it is an optimisation: a
   * failure leaves the caller with the bytes it derived and the next request
   * derives them again.
   */
  async saveVariant(storageKey: string, variant: string, content: Buffer): Promise<void> {
    const tempPath = resolve(avatarConfig.tempDirectory, `${randomUUID()}.part`);
    try {
      await writeFile(tempPath, content, { mode: 0o600 });
      await rename(tempPath, this.resolveVariant(storageKey, variant));
    } catch {
      await rm(tempPath, { force: true });
    }
  }

  async reconcile(): Promise<void> {
    if (this.reconciliationRunning) {
      return;
    }

    this.reconciliationRunning = true;
    try {
      await Promise.all(
        [...this.pendingDiscards].map(async (storageKey) => this.discardEventually(storageKey)),
      );
      await this.reconcileTemporaryUploads();
      await this.reconcileUnreferencedAvatars();
    } finally {
      this.reconciliationRunning = false;
    }
  }

  private async reconcileTemporaryUploads(): Promise<void> {
    const entries = await readdir(avatarConfig.tempDirectory, { withFileTypes: true });
    const staleBefore = Date.now() - avatarConfig.temporaryUploadGraceMs;
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.name.endsWith('.part')) {
          return;
        }

        const path = resolve(avatarConfig.tempDirectory, entry.name);
        let metadata;
        try {
          metadata = await stat(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return;
          }
          throw error;
        }
        if (metadata.mtimeMs >= staleBefore) {
          return;
        }

        await rm(path, {
          recursive: entry.isDirectory(),
          force: true,
        });
      }),
    );
  }

  private async reconcileUnreferencedAvatars(): Promise<void> {
    if (!this.prisma) {
      return;
    }

    const entries = await readdir(avatarConfig.directory, { withFileTypes: true });
    const staleBefore = Date.now() - avatarConfig.temporaryUploadGraceMs;
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isDirectory()) {
          return;
        }

        await this.prisma!.$transaction(async (transaction) => {
          const locks = await transaction.$queryRaw<{ locked: boolean }[]>(
            Prisma.sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${entry.name}, 0)) AS locked`,
          );
          if (!locks[0]?.locked) {
            return;
          }

          const [reservation, user] = await Promise.all([
            transaction.avatarStorageReservation.findUnique({
              where: { storageKey: entry.name },
              select: { createdAt: true },
            }),
            transaction.user.findFirst({
              where: { avatarStorageKey: entry.name },
              select: { id: true },
            }),
          ]);
          if (user) {
            if (reservation && reservation.createdAt.getTime() < staleBefore) {
              await transaction.avatarStorageReservation.delete({
                where: { storageKey: entry.name },
              });
            }
            return;
          }
          if (reservation && reservation.createdAt.getTime() >= staleBefore) {
            return;
          }

          const path = resolve(avatarConfig.directory, entry.name);
          let metadata;
          try {
            metadata = await stat(path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              return;
            }
            throw error;
          }
          if (metadata.mtimeMs >= staleBefore) {
            return;
          }

          await rm(path, { recursive: true, force: true });
          if (reservation) {
            await transaction.avatarStorageReservation.delete({
              where: { storageKey: entry.name },
            });
          }
        });
      }),
    );
  }

  private resolveVariant(storageKey: string, variant: string): string {
    const path = resolve(this.resolveDirectory(storageKey), variant);
    if (!isInsideDirectory(avatarConfig.directory, path)) {
      throw new Error('Avatar storage path is outside the configured directory');
    }
    return path;
  }

  private resolveDirectory(storageKey: string): string {
    const destinationDirectory = resolve(avatarConfig.directory, storageKey);
    if (!isInsideDirectory(avatarConfig.directory, destinationDirectory)) {
      throw new Error('Avatar storage path is outside the configured directory');
    }
    return destinationDirectory;
  }
}
