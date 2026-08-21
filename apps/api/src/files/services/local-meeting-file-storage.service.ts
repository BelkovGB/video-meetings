import {
  Injectable,
  NotFoundException,
  OnModuleInit,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Dir, ReadStream } from 'node:fs';
import { mkdir, open, opendir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { isInsideDirectory } from '../../storage/storage-path-policy';
import { uploadConfig } from '../upload.config';

type CapacityReservation = (() => void) | 'busy' | undefined;

export type StoredUploadEntry = {
  modifiedAt: Date;
  name: string;
};

const storageReconciliationBatchSize = 100;

@Injectable()
export class LocalMeetingFileStorageService implements OnModuleInit, OnModuleDestroy {
  private static readonly activeTempPaths = new Set<string>();
  private activeReservations = 0;
  private activeUploadCount = 0;
  private readonly activeUploadUsers = new Set<string>();
  private reservationQueue = Promise.resolve();
  private staleTempDirectory: Dir | undefined;
  private storedFilesDirectory: Dir | undefined;

  async onModuleInit() {
    try {
      await mkdir(uploadConfig.directory, { recursive: true, mode: 0o700 });
      await mkdir(uploadConfig.tempDirectory, { recursive: true, mode: 0o700 });
      await this.probeWriteAccess();

      const [storageStats, tempStats] = await Promise.all([
        stat(uploadConfig.directory),
        stat(uploadConfig.tempDirectory),
      ]);

      if (storageStats.dev !== tempStats.dev) {
        throw new Error('Upload directories must be on the same filesystem');
      }
    } catch (error) {
      throw new ServiceUnavailableException({
        message: 'File storage is unavailable',
        code: 'STORAGE_UNAVAILABLE',
        cause: error instanceof Error ? error.message : undefined,
      });
    }
  }

  async onModuleDestroy(): Promise<void> {
    const openDirectories = [this.staleTempDirectory, this.storedFilesDirectory].filter(
      (directory): directory is Dir => directory !== undefined,
    );
    this.staleTempDirectory = undefined;
    this.storedFilesDirectory = undefined;

    await Promise.all(openDirectories.map((directory) => this.closeDirectory(directory)));
  }

  async finalize(tempPath: string, storageKey: string): Promise<void> {
    const resolvedTempPath = resolve(tempPath);

    if (!isInsideDirectory(uploadConfig.tempDirectory, resolvedTempPath)) {
      throw new Error('Temporary upload path is outside the configured directory');
    }

    const destinationDirectory = resolve(uploadConfig.directory, storageKey);
    const destinationPath = resolve(destinationDirectory, 'content');

    if (!isInsideDirectory(uploadConfig.directory, destinationDirectory)) {
      throw new Error('Storage destination is outside the configured directory');
    }

    let destinationCreated = false;
    try {
      await mkdir(destinationDirectory, { mode: 0o700 });
      destinationCreated = true;
      await rename(resolvedTempPath, destinationPath);
    } catch (error) {
      if (destinationCreated) {
        await rm(destinationDirectory, { recursive: true, force: true });
      }
      throw new ServiceUnavailableException({
        message: 'File storage is unavailable',
        code: 'STORAGE_UNAVAILABLE',
        cause: error instanceof Error ? error.message : undefined,
      });
    }
  }

  static trackTemp(tempPath: string): void {
    const resolvedTempPath = resolve(tempPath);
    if (!isInsideDirectory(uploadConfig.tempDirectory, resolvedTempPath)) {
      throw new Error('Temporary upload path is outside the configured directory');
    }

    LocalMeetingFileStorageService.activeTempPaths.add(resolvedTempPath);
  }

  untrackTemp(tempPath: string): void {
    LocalMeetingFileStorageService.activeTempPaths.delete(resolve(tempPath));
  }

  async listStaleTempFiles(
    olderThan: Date,
    limit = storageReconciliationBatchSize,
  ): Promise<StoredUploadEntry[]> {
    const staleEntries: StoredUploadEntry[] = [];
    this.staleTempDirectory ??= await opendir(uploadConfig.tempDirectory);
    const directory = this.staleTempDirectory;

    for (let inspected = 0; inspected < limit; inspected += 1) {
      const entry = await directory.read();
      if (!entry) {
        this.staleTempDirectory = undefined;
        await this.closeDirectory(directory);
        break;
      }

      if (!entry.isFile() || !entry.name.endsWith('.part')) {
        continue;
      }

      const entryPath = resolve(uploadConfig.tempDirectory, entry.name);
      if (
        !isInsideDirectory(uploadConfig.tempDirectory, entryPath) ||
        LocalMeetingFileStorageService.activeTempPaths.has(entryPath)
      ) {
        continue;
      }

      const entryStats = await stat(entryPath);
      if (entryStats.mtime <= olderThan) {
        staleEntries.push({ name: entry.name, modifiedAt: entryStats.mtime });
      }
    }

    return staleEntries;
  }

  async deleteTempFile(name: string): Promise<void> {
    const entryPath = resolve(uploadConfig.tempDirectory, name);
    if (!isInsideDirectory(uploadConfig.tempDirectory, entryPath) || !name.endsWith('.part')) {
      throw new Error('Temporary upload path is outside the configured directory');
    }

    if (!LocalMeetingFileStorageService.activeTempPaths.has(entryPath)) {
      await rm(entryPath, { force: true });
    }
  }

  async listStoredFiles(
    olderThan: Date,
    limit = storageReconciliationBatchSize,
  ): Promise<StoredUploadEntry[]> {
    const storedEntries: StoredUploadEntry[] = [];
    this.storedFilesDirectory ??= await opendir(uploadConfig.directory);
    const directory = this.storedFilesDirectory;

    for (let inspected = 0; inspected < limit; inspected += 1) {
      const entry = await directory.read();
      if (!entry) {
        this.storedFilesDirectory = undefined;
        await this.closeDirectory(directory);
        break;
      }

      if (!entry.isDirectory()) {
        continue;
      }

      const entryPath = resolve(uploadConfig.directory, entry.name);
      const resolvedTempDirectory = resolve(uploadConfig.tempDirectory);
      if (
        !isInsideDirectory(uploadConfig.directory, entryPath) ||
        entryPath === resolvedTempDirectory ||
        isInsideDirectory(entryPath, resolvedTempDirectory)
      ) {
        continue;
      }

      const entryStats = await stat(entryPath);
      if (entryStats.mtime <= olderThan) {
        storedEntries.push({ name: entry.name, modifiedAt: entryStats.mtime });
      }
    }

    return storedEntries;
  }

  async exists(storageKey: string): Promise<boolean> {
    try {
      const contentStats = await stat(this.resolveContentPath(storageKey));
      return contentStats.isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }

      throw error;
    }
  }

  async discardTemp(tempPath: string): Promise<void> {
    const resolvedTempPath = resolve(tempPath);

    if (isInsideDirectory(uploadConfig.tempDirectory, resolvedTempPath)) {
      await rm(resolvedTempPath, { force: true });
    }
  }

  async discardFinal(storageKey: string): Promise<void> {
    const destinationDirectory = resolve(uploadConfig.directory, storageKey);

    if (isInsideDirectory(uploadConfig.directory, destinationDirectory)) {
      await rm(destinationDirectory, { recursive: true, force: true });
    }
  }

  /**
   * Absolute path of stored content, for a reader that needs a real file rather
   * than a stream — ffmpeg seeks in an mp4 container and cannot take it on stdin.
   *
   * Containment is checked here, in the one module that owns it; callers never
   * build a storage path themselves.
   */
  async resolveExistingContentPath(storageKey: string): Promise<string> {
    const contentPath = this.resolveContentPath(storageKey);

    if (!(await this.exists(storageKey))) {
      throw new NotFoundException('File not found');
    }

    return contentPath;
  }

  async open(storageKey: string): Promise<ReadStream> {
    const contentPath = this.resolveContentPath(storageKey);

    try {
      const handle = await open(contentPath, 'r');
      return handle.createReadStream();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new NotFoundException('File not found');
      }

      throw new ServiceUnavailableException({
        message: 'File storage is unavailable',
        code: 'STORAGE_UNAVAILABLE',
      });
    }
  }

  async delete(storageKey: string): Promise<void> {
    const destinationDirectory = resolve(uploadConfig.directory, storageKey);

    if (!isInsideDirectory(uploadConfig.directory, destinationDirectory)) {
      throw new Error('Storage destination is outside the configured directory');
    }

    try {
      await rm(destinationDirectory, { recursive: true, force: true });
    } catch (error) {
      throw new ServiceUnavailableException({
        message: 'File storage is unavailable',
        code: 'STORAGE_UNAVAILABLE',
        cause: error instanceof Error ? error.message : undefined,
      });
    }
  }

  async reserveCapacity(requestBytes: number, userId: string): Promise<CapacityReservation> {
    return this.runExclusively(async () => {
      if (
        this.activeUploadUsers.has(userId) ||
        this.activeUploadCount >= uploadConfig.maxActiveUploads
      ) {
        return 'busy';
      }

      try {
        if (!(await this.hasFreeSpaceFor(requestBytes, this.activeReservations))) {
          return undefined;
        }

        this.activeReservations += requestBytes;
        this.activeUploadCount += 1;
        this.activeUploadUsers.add(userId);
        let released = false;

        return () => {
          if (!released) {
            released = true;
            this.activeReservations -= requestBytes;
            this.activeUploadCount -= 1;
            this.activeUploadUsers.delete(userId);
          }
        };
      } catch {
        return undefined;
      }
    });
  }

  /**
   * Whether the storage filesystem keeps its free-space reserve after writing
   * `bytes`, with `pendingBytes` already promised to writes in flight.
   *
   * Shared with the upload capacity reservation on purpose: a transcript is
   * written past the active-upload limit but not past the reserve, and two
   * copies of this arithmetic would drift apart.
   */
  async hasFreeSpaceFor(bytes: number, pendingBytes = 0): Promise<boolean> {
    const filesystem = await statfs(uploadConfig.directory, { bigint: true });
    const availableBytes = filesystem.bavail * filesystem.bsize;
    const requiredBytes = BigInt(bytes) + BigInt(pendingBytes) + BigInt(uploadConfig.minFreeBytes);

    return availableBytes >= requiredBytes;
  }

  private async probeWriteAccess(): Promise<void> {
    const probePath = resolve(uploadConfig.tempDirectory, `.startup-${randomUUID()}.probe`);

    if (!isInsideDirectory(uploadConfig.tempDirectory, probePath)) {
      throw new Error('Storage probe path is outside the configured directory');
    }

    await writeFile(probePath, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rm(probePath, { force: true });
  }

  private resolveContentPath(storageKey: string): string {
    const destinationDirectory = resolve(uploadConfig.directory, storageKey);
    const contentPath = resolve(destinationDirectory, 'content');

    if (
      !isInsideDirectory(uploadConfig.directory, destinationDirectory) ||
      !isInsideDirectory(destinationDirectory, contentPath)
    ) {
      throw new Error('Storage content path is outside the configured directory');
    }

    return contentPath;
  }

  private async closeDirectory(directory: Dir): Promise<void> {
    try {
      await directory.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ERR_DIR_CLOSED') {
        throw error;
      }
    }
  }

  private async runExclusively<T>(callback: () => Promise<T>): Promise<T> {
    const previous = this.reservationQueue;
    let releaseQueue: () => void;
    this.reservationQueue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });

    await previous;
    try {
      return await callback();
    } finally {
      releaseQueue!();
    }
  }
}
