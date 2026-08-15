import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ReadStream } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { Prisma } from '@prisma/client';

import { avatarConfig } from './avatar.config';
import { PrismaService } from '../prisma/prisma.service';

function isInside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== '' && !path.startsWith('..') && !path.includes('..\\') && !isAbsolute(path);
}

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
    if (!isInside(avatarConfig.tempDirectory, source)) {
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
    if (isInside(avatarConfig.tempDirectory, source)) {
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

  private resolveDirectory(storageKey: string): string {
    const destinationDirectory = resolve(avatarConfig.directory, storageKey);
    if (!isInside(avatarConfig.directory, destinationDirectory)) {
      throw new Error('Avatar storage path is outside the configured directory');
    }
    return destinationDirectory;
  }
}
