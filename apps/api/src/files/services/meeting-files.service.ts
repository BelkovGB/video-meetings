import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { MeetingFileStatus } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { ReadStream } from 'node:fs';

import { PrismaService } from '../../prisma/prisma.service';
import { TranscriptionJobsService } from '../../transcription/services/transcription-jobs.service';
import { meetingFileSelect, toMeetingFileResponse } from '../models/meeting-file.response';
import { LocalMeetingFileStorageService } from './local-meeting-file-storage.service';
import { MeetingAccessService } from './meeting-access.service';
import { MeetingFileValidationService } from './meeting-file-validation.service';

@Injectable()
export class MeetingFilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly meetingAccess: MeetingAccessService,
    private readonly validation: MeetingFileValidationService,
    private readonly storage: LocalMeetingFileStorageService,
    private readonly transcriptionJobs: TranscriptionJobsService,
  ) {}

  async upload(meetingId: string, userId: string, file: Express.Multer.File | undefined) {
    if (!file) {
      throw new BadRequestException({ message: 'Missing file upload', code: 'MISSING_UPLOAD' });
    }

    try {
      const allowedFile = await this.validation.validate(file);
      await this.meetingAccess.requireAccess(meetingId, userId);

      const storageKey = randomBytes(32).toString('hex');
      await this.storage.finalize(file.path, storageKey);

      try {
        const storedFile = await this.prisma.meetingFile.create({
          data: {
            meetingId,
            uploadedById: userId,
            originalName: file.originalname,
            storageKey,
            category: allowedFile.category,
            mimeType: file.mimetype,
            sizeBytes: file.size,
            // Nested, so a recording never exists without the job that
            // transcribes it: a failure between two writes would leave one
            // waiting forever with nothing to notice it.
            transcriptionJob: this.transcriptionJobs.jobCreateForCategory(allowedFile.category),
          },
          select: meetingFileSelect,
        });

        return toMeetingFileResponse(storedFile);
      } catch (error) {
        await this.storage.discardFinal(storageKey);
        throw error;
      }
    } catch (error) {
      await this.storage.discardTemp(file.path);
      throw error;
    }
  }

  async list(meetingId: string, userId: string) {
    await this.meetingAccess.requireAccess(meetingId, userId);

    const files = await this.prisma.meetingFile.findMany({
      where: { meetingId, status: MeetingFileStatus.READY },
      select: meetingFileSelect,
      orderBy: { createdAt: 'desc' },
    });

    return files.map(toMeetingFileResponse);
  }

  async createDownloadTicket(meetingId: string, fileId: string, userId: string) {
    await this.meetingAccess.requireAccess(meetingId, userId);

    const file = await this.prisma.meetingFile.findFirst({
      where: { id: fileId, meetingId, status: MeetingFileStatus.READY },
      select: { id: true },
    });

    if (!file) {
      throw new NotFoundException('File not found');
    }

    const ticket = randomBytes(32).toString('base64url');
    const tokenHash = this.hashTicket(ticket);
    const expiresAt = new Date(Date.now() + 60_000);

    await this.prisma.meetingFileDownloadTicket.create({
      data: {
        tokenHash,
        fileId: file.id,
        issuedToUserId: userId,
        expiresAt,
      },
    });

    return { ticket, expiresAt };
  }

  async openDownload(ticket: string): Promise<{
    stream: ReadStream;
    name: string;
    mimeType: string;
    sizeBytes: number;
  }> {
    const tokenHash = this.hashTicket(ticket);
    const now = new Date();
    const downloadTicket = await this.prisma.$transaction(async (transaction) => {
      const redeemed = await transaction.meetingFileDownloadTicket.updateMany({
        where: { tokenHash, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });

      if (redeemed.count !== 1) {
        return null;
      }

      return transaction.meetingFileDownloadTicket.findUnique({
        where: { tokenHash },
        select: {
          issuedToUserId: true,
          file: {
            select: {
              id: true,
              meetingId: true,
              originalName: true,
              storageKey: true,
              mimeType: true,
              sizeBytes: true,
              status: true,
            },
          },
        },
      });
    });

    if (!downloadTicket || downloadTicket.file.status !== MeetingFileStatus.READY) {
      throw new NotFoundException('Download ticket not found');
    }

    try {
      await this.meetingAccess.requireAccess(
        downloadTicket.file.meetingId,
        downloadTicket.issuedToUserId,
      );
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw new NotFoundException('Download ticket not found');
      }

      throw error;
    }

    let stream: ReadStream;
    try {
      stream = await this.storage.open(downloadTicket.file.storageKey);
    } catch (error) {
      if (error instanceof NotFoundException) {
        await this.prisma.meetingFile.updateMany({
          where: { id: downloadTicket.file.id, status: MeetingFileStatus.READY },
          data: { status: MeetingFileStatus.MISSING },
        });
      }

      throw error;
    }

    return {
      stream,
      name: downloadTicket.file.originalName,
      mimeType: downloadTicket.file.mimeType,
      sizeBytes: downloadTicket.file.sizeBytes,
    };
  }

  async delete(meetingId: string, fileId: string, userId: string): Promise<void> {
    await this.meetingAccess.requireOwner(meetingId, userId);

    const claimed = await this.prisma.$transaction(async (transaction) => {
      const storedFile = await transaction.meetingFile.findFirst({
        where: { id: fileId, meetingId, status: MeetingFileStatus.READY },
        select: {
          id: true,
          storageKey: true,
          transcript: { select: { id: true, storageKey: true } },
        },
      });

      if (!storedFile) {
        throw new NotFoundException('File not found');
      }

      const claimed = await transaction.meetingFile.updateMany({
        where: {
          id: storedFile.id,
          meetingId,
          status: MeetingFileStatus.READY,
        },
        data: { status: MeetingFileStatus.DELETING },
      });

      if (claimed.count !== 1) {
        throw new NotFoundException('File not found');
      }

      if (storedFile.transcript) {
        // Whatever status the transcript is in, it goes with its recording: a
        // transcript left behind would outlive the only thing it describes.
        await transaction.meetingFile.updateMany({
          where: { id: storedFile.transcript.id },
          data: { status: MeetingFileStatus.DELETING },
        });
      }

      // Removing the job here, rather than leaving it to the cascade a moment
      // later, is what stops a worker holding it from completing: its own
      // completion is guarded by this row still being its own.
      await this.transcriptionJobs.removeForSourceFile(transaction, storedFile.id);

      return storedFile;
    });

    // The transcript first, in both storage and the database: its row
    // references the recording, and the reference is restricted on purpose.
    for (const file of claimed.transcript ? [claimed.transcript, claimed] : [claimed]) {
      await this.storage.delete(file.storageKey);
      await this.prisma.meetingFile.deleteMany({
        where: { id: file.id, status: MeetingFileStatus.DELETING },
      });
    }
  }

  private hashTicket(ticket: string): string {
    return createHash('sha256').update(ticket).digest('hex');
  }
}
