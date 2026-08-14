import * as filesystem from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { LocalMeetingFileStorageService } from '../src/files/services/local-meeting-file-storage.service';
import { uploadConfig } from '../src/files/upload.config';

describe('LocalMeetingFileStorageService', () => {
  it('accounts for active upload reservations before accepting another upload', async () => {
    const statfs = jest.spyOn(filesystem, 'statfs').mockResolvedValue({
      bavail: 10n,
      bsize: 10n,
    } as never);
    const storage = new LocalMeetingFileStorageService();

    const firstReservation = await storage.reserveCapacity(40, 'user-1');
    const secondReservation = await storage.reserveCapacity(70, 'user-2');

    expect(firstReservation).toEqual(expect.any(Function));
    expect(secondReservation).toBeUndefined();

    if (typeof firstReservation !== 'function') {
      throw new Error('Expected the first capacity reservation to succeed');
    }
    firstReservation();

    await expect(storage.reserveCapacity(70, 'user-2')).resolves.toEqual(expect.any(Function));
    statfs.mockRestore();
  });

  it('allows only one active upload per user and four uploads per process', async () => {
    const statfs = jest.spyOn(filesystem, 'statfs').mockResolvedValue({
      bavail: 1_000n,
      bsize: 1_000n,
    } as never);
    const storage = new LocalMeetingFileStorageService();

    const reservations = await Promise.all(
      ['user-1', 'user-2', 'user-3', 'user-4'].map((userId) => storage.reserveCapacity(10, userId)),
    );

    await expect(storage.reserveCapacity(10, 'user-1')).resolves.toBe('busy');
    await expect(storage.reserveCapacity(10, 'user-5')).resolves.toBe('busy');

    if (typeof reservations[0] !== 'function') {
      throw new Error('Expected the first upload slot to be reserved');
    }
    reservations[0]();
    await expect(storage.reserveCapacity(10, 'user-5')).resolves.toEqual(expect.any(Function));
    reservations.slice(1).forEach((release) => {
      if (typeof release === 'function') {
        release();
      }
    });
    statfs.mockRestore();
  });

  it('does not treat a nested temporary directory as orphan final storage', async () => {
    const tempDirectoryName = 'nested-temp';
    const originalTempDirectory = uploadConfig.tempDirectory;
    uploadConfig.tempDirectory = join(uploadConfig.directory, tempDirectoryName);
    const read = jest
      .fn()
      .mockResolvedValueOnce({ isDirectory: () => true, name: tempDirectoryName })
      .mockResolvedValueOnce({ isDirectory: () => true, name: 'orphan-storage' })
      .mockResolvedValue(null);
    const close = jest.fn().mockResolvedValue(undefined);
    const opendir = jest.spyOn(filesystem, 'opendir').mockResolvedValue({ read, close } as never);
    const stat = jest.spyOn(filesystem, 'stat').mockResolvedValue({
      mtime: new Date('2026-08-10T00:00:00.000Z'),
    } as never);
    const storage = new LocalMeetingFileStorageService();

    try {
      const entries = await storage.listStoredFiles(new Date('2026-08-11T00:00:00.000Z'));

      expect(entries.map((entry) => entry.name)).toEqual(['orphan-storage']);
      expect(stat).toHaveBeenCalledWith(resolve(uploadConfig.directory, 'orphan-storage'));
    } finally {
      uploadConfig.tempDirectory = originalTempDirectory;
      opendir.mockRestore();
      stat.mockRestore();
    }
  });

  it('inspects no more than the requested number of storage entries', async () => {
    const read = jest
      .fn()
      .mockResolvedValueOnce({ isDirectory: () => true, name: 'first-storage' })
      .mockResolvedValueOnce({ isDirectory: () => true, name: 'second-storage' })
      .mockResolvedValue(null);
    const close = jest.fn().mockResolvedValue(undefined);
    const opendir = jest.spyOn(filesystem, 'opendir').mockResolvedValue({ read, close } as never);
    const stat = jest.spyOn(filesystem, 'stat').mockResolvedValue({
      mtime: new Date('2026-08-10T00:00:00.000Z'),
    } as never);
    const storage = new LocalMeetingFileStorageService();

    try {
      const entries = await storage.listStoredFiles(new Date('2026-08-11T00:00:00.000Z'), 1);

      expect(entries.map((entry) => entry.name)).toEqual(['first-storage']);
      expect(read).toHaveBeenCalledTimes(1);
      expect(close).not.toHaveBeenCalled();

      const nextEntries = await storage.listStoredFiles(new Date('2026-08-11T00:00:00.000Z'), 1);

      expect(nextEntries.map((entry) => entry.name)).toEqual(['second-storage']);
      expect(opendir).toHaveBeenCalledTimes(1);

      await storage.listStoredFiles(new Date('2026-08-11T00:00:00.000Z'), 1);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      opendir.mockRestore();
      stat.mockRestore();
    }
  });

  it('closes a retained directory cursor during module shutdown', async () => {
    const read = jest
      .fn()
      .mockResolvedValueOnce({ isDirectory: () => true, name: 'first-storage' });
    const close = jest.fn().mockResolvedValue(undefined);
    const opendir = jest.spyOn(filesystem, 'opendir').mockResolvedValue({ read, close } as never);
    const stat = jest.spyOn(filesystem, 'stat').mockResolvedValue({
      mtime: new Date('2026-08-10T00:00:00.000Z'),
    } as never);
    const storage = new LocalMeetingFileStorageService();

    try {
      await storage.listStoredFiles(new Date('2026-08-11T00:00:00.000Z'), 1);
      expect(close).not.toHaveBeenCalled();

      await storage.onModuleDestroy();

      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      opendir.mockRestore();
      stat.mockRestore();
    }
  });
});
