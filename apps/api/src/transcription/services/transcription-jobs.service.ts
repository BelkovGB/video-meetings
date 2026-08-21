import { Injectable } from '@nestjs/common';
import {
  MeetingFileCategory,
  MeetingFileStatus,
  Prisma,
  TranscriptionJobStatus,
} from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { TranscriptionFailureCode } from '../models/transcription-failure';
import { transcriptionConfig } from '../transcription.config';

/** Categories a recording can be recognized from; a document or an already
 * uploaded transcript never gets a job. */
const transcribedCategories: readonly MeetingFileCategory[] = [
  MeetingFileCategory.AUDIO,
  MeetingFileCategory.VIDEO,
];

export type ClaimedTranscriptionJob = {
  id: string;
  sourceFile: {
    id: string;
    meetingId: string;
    originalName: string;
    storageKey: string;
  };
};

export type StoredTranscript = {
  originalName: string;
  storageKey: string;
  sizeBytes: number;
};

const claimedJobSelect = {
  id: true,
  sourceFile: {
    select: { id: true, meetingId: true, originalName: true, storageKey: true },
  },
} satisfies Prisma.TranscriptionJobSelect;

@Injectable()
export class TranscriptionJobsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Nested create that enqueues the job together with the file row, or
   * `undefined` for a category that is not transcribed.
   *
   * Nested rather than a second call: a failure between two calls would leave a
   * recording that never gets transcribed and nothing to notice it.
   */
  jobCreateForCategory(
    category: MeetingFileCategory,
  ): Prisma.TranscriptionJobCreateNestedOneWithoutSourceFileInput | undefined {
    return transcribedCategories.includes(category) ? { create: {} } : undefined;
  }

  /**
   * Removes the job of a file being deleted, inside the caller's transaction.
   *
   * The foreign key already cascades, but the row is deleted a moment later,
   * outside that transaction. Removing the job while the file is claimed for
   * deletion is what makes a worker holding it fail its own completion check
   * instead of writing a transcript for a recording that is going away.
   */
  async removeForSourceFile(
    transaction: Prisma.TransactionClient,
    sourceFileId: string,
  ): Promise<void> {
    await transaction.transcriptionJob.deleteMany({ where: { sourceFileId } });
  }

  /**
   * Takes the oldest queued job whose recording is still readable.
   *
   * The `updateMany` guarded by the previous status is the claim: two workers
   * reading the same candidate produce one update with `count === 1` and one
   * with `count === 0`.
   */
  async claimNextJob(
    leaseOwner: string,
    now = new Date(),
  ): Promise<ClaimedTranscriptionJob | null> {
    const candidate = await this.prisma.transcriptionJob.findFirst({
      where: {
        status: TranscriptionJobStatus.QUEUED,
        sourceFile: { status: MeetingFileStatus.READY },
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });

    if (!candidate) {
      return null;
    }

    const claimed = await this.prisma.transcriptionJob.updateMany({
      where: { id: candidate.id, status: TranscriptionJobStatus.QUEUED },
      data: {
        status: TranscriptionJobStatus.PROCESSING,
        leaseOwner,
        leaseExpiresAt: new Date(now.getTime() + transcriptionConfig.leaseTimeoutMs),
        startedAt: now,
        finishedAt: null,
        failureCode: null,
        attemptCount: { increment: 1 },
      },
    });

    if (claimed.count !== 1) {
      return null;
    }

    return this.prisma.transcriptionJob.findUnique({
      where: { id: candidate.id },
      select: claimedJobSelect,
    });
  }

  /**
   * Records the transcript and closes the job in one transaction.
   *
   * Returns false when the job is no longer this worker's — the owner deleted
   * the recording, or the lease was taken over — and the caller must then throw
   * the stored bytes away rather than leave a transcript of a deleted recording.
   */
  async completeJob(
    jobId: string,
    leaseOwner: string,
    transcript: StoredTranscript,
    now = new Date(),
  ): Promise<boolean> {
    return this.prisma.$transaction(async (transaction) => {
      const job = await transaction.transcriptionJob.findUnique({
        where: { id: jobId },
        select: { sourceFile: { select: { id: true, meetingId: true, status: true } } },
      });

      if (!job || job.sourceFile.status !== MeetingFileStatus.READY) {
        return false;
      }

      const closed = await transaction.transcriptionJob.updateMany({
        where: { id: jobId, status: TranscriptionJobStatus.PROCESSING, leaseOwner },
        data: {
          status: TranscriptionJobStatus.COMPLETED,
          finishedAt: now,
          failureCode: null,
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      });

      if (closed.count !== 1) {
        return false;
      }

      await transaction.meetingFile.create({
        data: {
          meetingId: job.sourceFile.meetingId,
          sourceFileId: job.sourceFile.id,
          // The system wrote this file, so no uploader identity is attached.
          uploadedById: null,
          originalName: transcript.originalName,
          storageKey: transcript.storageKey,
          category: MeetingFileCategory.TRANSCRIPT,
          mimeType: 'text/plain',
          sizeBytes: transcript.sizeBytes,
        },
        select: { id: true },
      });

      return true;
    });
  }

  /** Records why the job stopped. A job already gone with its recording leaves
   * nothing to update, which is the intended outcome. */
  async failJob(
    jobId: string,
    leaseOwner: string,
    failureCode: TranscriptionFailureCode,
    now = new Date(),
  ): Promise<void> {
    await this.prisma.transcriptionJob.updateMany({
      where: { id: jobId, status: TranscriptionJobStatus.PROCESSING, leaseOwner },
      data: {
        status: TranscriptionJobStatus.FAILED,
        failureCode,
        finishedAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
  }
}
