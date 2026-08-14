import { Logger, NotFoundException } from '@nestjs/common';
import { MeetingFileStatus } from '@prisma/client';

import { MeetingFileDeletionReconciliationService } from '../src/files/services/meeting-file-deletion-reconciliation.service';
import { MeetingFilesService } from '../src/files/services/meeting-files.service';

describe('MeetingFilesService failure handling', () => {
  it('rejects a delete when another request already claimed the READY file', async () => {
    const transaction = {
      meetingFile: {
        findFirst: jest.fn().mockResolvedValue({ id: 'file-1', storageKey: 'storage-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (callback: (client: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
      ),
    };
    const meetingAccess = { requireOwner: jest.fn().mockResolvedValue(undefined) };
    const storage = { delete: jest.fn() };
    const service = new MeetingFilesService(
      prisma as never,
      meetingAccess as never,
      {} as never,
      storage as never,
    );

    await expect(service.delete('meeting-1', 'file-1', 'owner-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('does not turn a database access failure into a missing download ticket', async () => {
    const transaction = {
      meetingFileDownloadTicket: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue({
          issuedToUserId: 'user-1',
          file: {
            id: 'file-1',
            meetingId: 'meeting-1',
            originalName: 'notes.pdf',
            storageKey: 'storage-1',
            mimeType: 'application/pdf',
            sizeBytes: 10,
            status: MeetingFileStatus.READY,
          },
        }),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (callback: (client: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
      ),
    };
    const databaseFailure = new Error('database unavailable');
    const meetingAccess = { requireAccess: jest.fn().mockRejectedValue(databaseFailure) };
    const service = new MeetingFilesService(
      prisma as never,
      meetingAccess as never,
      {} as never,
      {} as never,
    );

    await expect(service.openDownload('ticket')).rejects.toBe(databaseFailure);
  });

  it('deletes expired and consumed download tickets in bounded batches', async () => {
    const now = new Date('2026-08-14T12:00:00.000Z');
    const prisma = {
      meetingFileDownloadTicket: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ tokenHash: 'expired-ticket' }, { tokenHash: 'consumed-ticket' }]),
        deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    };
    const service = new MeetingFileDeletionReconciliationService(prisma as never, {} as never);

    await service.reconcileDownloadTickets(now);

    expect(prisma.meetingFileDownloadTicket.findMany).toHaveBeenCalledWith({
      where: {
        OR: [{ expiresAt: { lte: now } }, { usedAt: { not: null } }],
      },
      select: { tokenHash: true },
      take: 100,
    });
    expect(prisma.meetingFileDownloadTicket.deleteMany).toHaveBeenCalledWith({
      where: { tokenHash: { in: ['expired-ticket', 'consumed-ticket'] } },
    });
  });

  it('retries a stale DELETING file after a transient storage failure', async () => {
    const file = { id: 'file-1', storageKey: 'storage-1' };
    const prisma = {
      meetingFile: {
        findMany: jest.fn().mockResolvedValue([file]),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const storageFailure = new Error('storage unavailable');
    const storage = {
      delete: jest.fn().mockRejectedValueOnce(storageFailure).mockResolvedValueOnce(undefined),
    };
    const logger = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const service = new MeetingFileDeletionReconciliationService(prisma as never, storage as never);
    const now = new Date('2026-08-11T12:00:00.000Z');

    await service.reconcileDeletions(now);
    await service.reconcileDeletions(now);

    expect(storage.delete).toHaveBeenCalledTimes(2);
    expect(prisma.meetingFile.deleteMany).toHaveBeenCalledTimes(1);
    expect(prisma.meetingFile.findMany).toHaveBeenCalledWith({
      where: {
        status: MeetingFileStatus.DELETING,
        updatedAt: { lte: new Date('2026-08-11T11:59:00.000Z') },
      },
      select: { id: true, storageKey: true },
    });
    logger.mockRestore();
  });

  it('cleans stale temporary and orphan files without deleting linked storage', async () => {
    const prisma = {
      meetingFile: {
        findMany: jest
          .fn()
          .mockImplementation(({ where }: { where: unknown }) =>
            'storageKey' in (where as object) ? [{ storageKey: 'linked-storage' }] : [],
          ),
        updateMany: jest.fn(),
      },
    };
    const storage = {
      listStaleTempFiles: jest
        .fn()
        .mockResolvedValue([
          { name: 'stale.part', modifiedAt: new Date('2026-08-10T00:00:00.000Z') },
        ]),
      listStoredFiles: jest.fn().mockResolvedValue([
        { name: 'orphan-storage', modifiedAt: new Date('2026-08-10T00:00:00.000Z') },
        { name: 'linked-storage', modifiedAt: new Date('2026-08-10T00:00:00.000Z') },
      ]),
      deleteTempFile: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
      exists: jest.fn(),
    };
    const service = new MeetingFileDeletionReconciliationService(prisma as never, storage as never);

    await service.reconcileStorage(new Date('2026-08-12T12:00:00.000Z'));

    expect(storage.deleteTempFile).toHaveBeenCalledWith('stale.part');
    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(storage.delete).toHaveBeenCalledWith('orphan-storage');
  });

  it('reconciles storage in bounded batches', async () => {
    const readyFiles = Array.from({ length: 100 }, (_, index) => ({
      id: `file-${index}`,
      storageKey: `storage-${index}`,
      createdAt: new Date('2026-08-10T00:00:00.000Z'),
    }));
    const finalReadyFile = {
      id: 'file-final',
      storageKey: 'storage-final',
      createdAt: new Date('2026-08-10T00:00:01.000Z'),
    };
    let readyFilePage = 0;
    const prisma = {
      meetingFile: {
        findMany: jest.fn().mockImplementation(({ where }: { where: object }) => {
          if (!('status' in where)) {
            return Promise.resolve([]);
          }

          readyFilePage += 1;
          return Promise.resolve(readyFilePage === 1 ? readyFiles : [finalReadyFile]);
        }),
      },
    };
    const storage = {
      listStaleTempFiles: jest.fn().mockResolvedValue([]),
      listStoredFiles: jest.fn().mockResolvedValue([]),
      exists: jest.fn().mockResolvedValue(true),
    };
    const service = new MeetingFileDeletionReconciliationService(prisma as never, storage as never);
    const now = new Date('2026-08-12T12:00:00.000Z');
    const staleBefore = new Date('2026-08-11T12:00:00.000Z');

    await service.reconcileStorage(now);
    await service.reconcileStorage(now);
    await service.reconcileStorage(now);

    expect(storage.listStaleTempFiles).toHaveBeenCalledWith(staleBefore, 100);
    expect(storage.listStoredFiles).toHaveBeenCalledWith(staleBefore, 100);
    expect(prisma.meetingFile.findMany).toHaveBeenNthCalledWith(2, {
      where: { status: MeetingFileStatus.READY, createdAt: { lte: staleBefore } },
      select: { id: true, storageKey: true, createdAt: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 100,
    });
    expect(prisma.meetingFile.findMany).toHaveBeenNthCalledWith(4, {
      where: {
        status: MeetingFileStatus.READY,
        createdAt: { lte: staleBefore },
        OR: [
          { createdAt: { gt: readyFiles.at(-1)!.createdAt } },
          { createdAt: readyFiles.at(-1)!.createdAt, id: { gt: readyFiles.at(-1)!.id } },
        ],
      },
      select: { id: true, storageKey: true, createdAt: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 100,
    });
    expect(prisma.meetingFile.findMany).toHaveBeenNthCalledWith(6, {
      where: { status: MeetingFileStatus.READY, createdAt: { lte: staleBefore } },
      select: { id: true, storageKey: true, createdAt: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 100,
    });
  });

  it('marks a READY database record as MISSING when its stored file disappears', async () => {
    const prisma = {
      meetingFile: {
        findMany: jest
          .fn()
          .mockImplementation(({ where }: { where: unknown }) =>
            'status' in (where as object) ? [{ id: 'file-1', storageKey: 'missing-storage' }] : [],
          ),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const storage = {
      listStaleTempFiles: jest.fn().mockResolvedValue([]),
      listStoredFiles: jest.fn().mockResolvedValue([]),
      deleteTempFile: jest.fn(),
      delete: jest.fn(),
      exists: jest.fn().mockResolvedValue(false),
    };
    const logger = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const service = new MeetingFileDeletionReconciliationService(prisma as never, storage as never);

    await service.reconcileStorage(new Date('2026-08-12T12:00:00.000Z'));

    expect(prisma.meetingFile.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'file-1',
        status: MeetingFileStatus.READY,
        createdAt: { lte: new Date('2026-08-11T12:00:00.000Z') },
      },
      data: { status: MeetingFileStatus.MISSING },
    });
    expect(logger).toHaveBeenCalledWith('Meeting file file-1 is missing from storage');
    logger.mockRestore();
  });
});
