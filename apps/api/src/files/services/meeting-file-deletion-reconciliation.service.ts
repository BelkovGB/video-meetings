import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { MeetingFileStatus } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { uploadConfig } from '../upload.config';
import { LocalMeetingFileStorageService } from './local-meeting-file-storage.service';

const reconciliationIntervalMs = 60_000;
const downloadTicketCleanupBatchSize = 100;

@Injectable()
export class MeetingFileDeletionReconciliationService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(MeetingFileDeletionReconciliationService.name);
  private reconciliationTimer: NodeJS.Timeout | undefined;
  private reconciliationRunning = false;
  private storageReconciliationRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: LocalMeetingFileStorageService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.reconcile();
    this.reconciliationTimer = setInterval(() => {
      void this.reconcile().catch((error: unknown) => {
        this.logger.error(
          'Failed to reconcile meeting file deletions',
          error instanceof Error ? error.stack : undefined,
        );
      });
    }, reconciliationIntervalMs);
    this.reconciliationTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.reconciliationTimer) {
      clearInterval(this.reconciliationTimer);
    }
  }

  async reconcile(now = new Date()): Promise<void> {
    if (this.reconciliationRunning) {
      return;
    }

    this.reconciliationRunning = true;
    try {
      await this.reconcileDownloadTickets(now);
      await this.reconcileDeletions(now);
      await this.reconcileStorage(now);
    } finally {
      this.reconciliationRunning = false;
    }
  }

  async reconcileDownloadTickets(now: Date): Promise<void> {
    const tickets = await this.prisma.meetingFileDownloadTicket.findMany({
      where: {
        OR: [{ expiresAt: { lte: now } }, { usedAt: { not: null } }],
      },
      select: { tokenHash: true },
      take: downloadTicketCleanupBatchSize,
    });

    if (tickets.length === 0) {
      return;
    }

    await this.prisma.meetingFileDownloadTicket.deleteMany({
      where: { tokenHash: { in: tickets.map((ticket) => ticket.tokenHash) } },
    });
  }

  async reconcileDeletions(now = new Date()): Promise<void> {
    const retryBefore = new Date(now.getTime() - reconciliationIntervalMs);
    const files = await this.prisma.meetingFile.findMany({
      where: {
        status: MeetingFileStatus.DELETING,
        updatedAt: { lte: retryBefore },
      },
      select: { id: true, storageKey: true },
    });

    for (const file of files) {
      try {
        await this.storage.delete(file.storageKey);
        await this.prisma.meetingFile.deleteMany({
          where: { id: file.id, status: MeetingFileStatus.DELETING },
        });
      } catch (error) {
        this.logger.error(
          `Failed to reconcile meeting file deletion ${file.id}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }
  }

  async reconcileStorage(now: Date): Promise<void> {
    if (this.storageReconciliationRunning) {
      return;
    }

    this.storageReconciliationRunning = true;
    try {
      const staleBefore = new Date(now.getTime() - uploadConfig.reconciliationGraceMs);
      const staleTempFiles = await this.storage.listStaleTempFiles(staleBefore);
      const storedFiles = await this.storage.listStoredFiles(staleBefore);
      const storedKeys = storedFiles.map((file) => file.name);
      const linkedFiles = await this.prisma.meetingFile.findMany({
        where: storedKeys.length > 0 ? { storageKey: { in: storedKeys } } : { id: { in: [] } },
        select: { storageKey: true },
      });
      const linkedKeys = new Set(linkedFiles.map((file) => file.storageKey));

      for (const tempFile of staleTempFiles) {
        await this.storage.deleteTempFile(tempFile.name);
      }

      for (const storedFile of storedFiles) {
        if (!linkedKeys.has(storedFile.name)) {
          await this.storage.delete(storedFile.name);
        }
      }

      const readyFiles = await this.prisma.meetingFile.findMany({
        where: { status: MeetingFileStatus.READY, createdAt: { lte: staleBefore } },
        select: { id: true, storageKey: true },
      });

      for (const file of readyFiles) {
        if (!(await this.storage.exists(file.storageKey))) {
          await this.prisma.meetingFile.updateMany({
            where: {
              id: file.id,
              status: MeetingFileStatus.READY,
              createdAt: { lte: staleBefore },
            },
            data: { status: MeetingFileStatus.MISSING },
          });
          this.logger.error(`Meeting file ${file.id} is missing from storage`);
        }
      }
    } finally {
      this.storageReconciliationRunning = false;
    }
  }
}
