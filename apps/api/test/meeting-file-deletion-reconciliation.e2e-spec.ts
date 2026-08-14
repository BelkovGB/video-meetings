import { Logger } from '@nestjs/common';

import { PrismaService } from '../src/prisma/prisma.service';
import { LocalMeetingFileStorageService } from '../src/files/services/local-meeting-file-storage.service';
import { MeetingFileDeletionReconciliationService } from '../src/files/services/meeting-file-deletion-reconciliation.service';

describe('MeetingFileDeletionReconciliationService', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('logs a rejected background reconciliation pass', async () => {
    jest.useFakeTimers();
    const service = new MeetingFileDeletionReconciliationService(
      {} as PrismaService,
      {} as LocalMeetingFileStorageService,
    );
    const error = new Error('database unavailable');
    const loggerError = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const reconcile = jest
      .spyOn(service, 'reconcile')
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(undefined);

    await service.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(60_000);

    expect(loggerError).toHaveBeenCalledWith(
      'Failed to reconcile meeting file deletions',
      error.stack,
    );

    await jest.advanceTimersByTimeAsync(60_000);

    expect(reconcile).toHaveBeenCalledTimes(3);

    service.onModuleDestroy();
  });
});
