import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import {
  MeetingFileCategory,
  MeetingFileStatus,
  MeetingSummaryStatus,
  TranscriptionJobStatus,
} from '@prisma/client';

import { LocalMeetingFileStorageService } from '../../files/services/local-meeting-file-storage.service';
import { PrismaService } from '../../prisma/prisma.service';
import { meetingSummaryConfig } from '../meeting-summary.config';
import { computeTranscriptFingerprint } from '../transcript-fingerprint';
import { MeetingSummaryService } from './meeting-summary.service';

const candidateBatchSize = 20;

/**
 * Starts or recomputes a meeting summary automatically — the counterpart to
 * the manual `POST .../summary` route. Each pass finds two kinds of eligible
 * meeting: one with a ready transcript and no summary row yet, and one whose
 * finished summary's `transcriptFingerprint` no longer matches its current
 * ready transcript set. Either way, a meeting is skipped while its transcript
 * set is not final yet: a transcription job still queued or processing means
 * a recording is still becoming a transcript, and an upload still in flight
 * means a file might become one. Starting now would only be replaced by a
 * second, wasted run once the job finishes or the upload lands.
 */
@Injectable()
export class MeetingSummarySchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(MeetingSummarySchedulerService.name);
  private schedulerTimer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly summary: MeetingSummaryService,
    private readonly storage: LocalMeetingFileStorageService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Off during automated tests by default (see test/setup.ts): this starts
    // real, billed model calls against whatever meetings already have a ready
    // transcript, and every e2e spec file boots its own full `AppModule` — an
    // unrelated spec's fixtures would otherwise get auto-summarized the
    // moment any later spec's app instance boots. A spec that wants scheduler
    // behavior drives `run()` itself, as meeting-summary.e2e-spec.ts does.
    if (!meetingSummaryConfig.schedulerAutoStart) {
      return;
    }

    // Errors here must not propagate: unlike the interval below, this call is
    // part of `onApplicationBootstrap`, and a rejection there fails the whole
    // app's startup over a single bad scheduler pass.
    await this.runCatchingErrors();
    this.schedulerTimer = setInterval(() => {
      void this.runCatchingErrors();
    }, meetingSummaryConfig.schedulerIntervalMs);
    this.schedulerTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
    }
  }

  private async runCatchingErrors(): Promise<void> {
    try {
      await this.run();
    } catch (error: unknown) {
      this.logger.error(
        'Failed to run the meeting summary scheduler',
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  async run(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    try {
      const [newMeetingIds, staleMeetingIds] = await Promise.all([
        this.findMeetingsWithoutSummary(),
        this.findMeetingsWithStaleSummary(),
      ]);
      const eligibleMeetingIds = [...newMeetingIds, ...staleMeetingIds];

      if (eligibleMeetingIds.length === 0) {
        return;
      }

      const meetingIdsWithPendingRecognition =
        await this.findMeetingIdsWithPendingRecognition(eligibleMeetingIds);

      for (const meetingId of eligibleMeetingIds) {
        if (
          meetingIdsWithPendingRecognition.has(meetingId) ||
          this.storage.hasActiveUpload(meetingId)
        ) {
          continue;
        }

        await this.summary.startForMeeting(meetingId);
      }
    } finally {
      this.running = false;
    }
  }

  private async findMeetingsWithoutSummary(): Promise<string[]> {
    const candidates = await this.prisma.meetingFile.findMany({
      where: {
        category: MeetingFileCategory.TRANSCRIPT,
        status: MeetingFileStatus.READY,
        meeting: { summary: null },
      },
      distinct: ['meetingId'],
      orderBy: { createdAt: 'asc' },
      select: { meetingId: true },
      take: candidateBatchSize,
    });

    return candidates.map((candidate) => candidate.meetingId);
  }

  /**
   * Meetings whose summary already finished (successfully or not) but whose
   * stored `transcriptFingerprint` no longer matches the meeting's current
   * ready transcript set — a new transcript arrived, or the set otherwise
   * changed, since that run was queued.
   */
  private async findMeetingsWithStaleSummary(): Promise<string[]> {
    // Every finished summary is read, and the batch size is applied to what
    // survives the fingerprint comparison below rather than to this query.
    // Capping here instead would cap the candidates the pass can see, not the
    // work it takes on: whether a summary is stale is only decided in
    // JavaScript, so a page of twenty up-to-date rows hides every stale
    // meeting behind it and the recompute path silently stops working as the
    // table grows. One row per meeting keeps the read cheap enough for that
    // to be the wrong side to save on.
    const finishedSummaries = await this.prisma.meetingSummary.findMany({
      where: {
        status: { in: [MeetingSummaryStatus.COMPLETED, MeetingSummaryStatus.FAILED] },
        meeting: {
          files: {
            some: { category: MeetingFileCategory.TRANSCRIPT, status: MeetingFileStatus.READY },
          },
        },
      },
      select: { meetingId: true, transcriptFingerprint: true },
      orderBy: { updatedAt: 'asc' },
    });

    if (finishedSummaries.length === 0) {
      return [];
    }

    const transcriptFiles = await this.prisma.meetingFile.findMany({
      where: {
        category: MeetingFileCategory.TRANSCRIPT,
        status: MeetingFileStatus.READY,
        meetingId: { in: finishedSummaries.map((summary) => summary.meetingId) },
      },
      select: { meetingId: true, id: true },
    });
    const transcriptIdsByMeeting = new Map<string, string[]>();
    for (const file of transcriptFiles) {
      const ids = transcriptIdsByMeeting.get(file.meetingId) ?? [];
      ids.push(file.id);
      transcriptIdsByMeeting.set(file.meetingId, ids);
    }

    return finishedSummaries
      .filter((summary) => {
        const currentFingerprint = computeTranscriptFingerprint(
          transcriptIdsByMeeting.get(summary.meetingId) ?? [],
        );

        return currentFingerprint !== summary.transcriptFingerprint;
      })
      .map((summary) => summary.meetingId)
      .slice(0, candidateBatchSize);
  }

  private async findMeetingIdsWithPendingRecognition(meetingIds: string[]): Promise<Set<string>> {
    const pendingJobs = await this.prisma.transcriptionJob.findMany({
      where: {
        status: { in: [TranscriptionJobStatus.QUEUED, TranscriptionJobStatus.PROCESSING] },
        sourceFile: { meetingId: { in: meetingIds } },
      },
      select: { sourceFile: { select: { meetingId: true } } },
    });

    return new Set(pendingJobs.map((job) => job.sourceFile.meetingId));
  }
}
