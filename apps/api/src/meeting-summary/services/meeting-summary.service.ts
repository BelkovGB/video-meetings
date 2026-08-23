import {
  ConflictException,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  MeetingFileCategory,
  MeetingFileStatus,
  MeetingSummaryStatus,
  Prisma,
} from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { MeetingAccessService } from '../../files/services/meeting-access.service';
import {
  MeetingSummaryResponse,
  toMeetingSummaryResponse,
} from '../models/meeting-summary.response';
import { computeTranscriptFingerprint } from '../transcript-fingerprint';
import { MeetingSummaryRunnerService } from './meeting-summary-runner.service';

const runningStatuses: readonly MeetingSummaryStatus[] = [
  MeetingSummaryStatus.QUEUED,
  MeetingSummaryStatus.PROCESSING,
];

@Injectable()
export class MeetingSummaryService {
  private readonly logger = new Logger(MeetingSummaryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly meetingAccess: MeetingAccessService,
    private readonly runner: MeetingSummaryRunnerService,
  ) {}

  async start(meetingId: string, userId: string): Promise<MeetingSummaryResponse> {
    await this.meetingAccess.requireAccess(meetingId, userId);

    const transcriptFileIds = await this.readyTranscriptFileIds(meetingId);

    if (transcriptFileIds.length === 0) {
      throw new UnprocessableEntityException({
        message: 'Meeting has no transcript files',
        code: 'NO_TRANSCRIPT_FILES',
      });
    }

    const existing = await this.prisma.meetingSummary.findUnique({ where: { meetingId } });

    if (existing && runningStatuses.includes(existing.status)) {
      throw new ConflictException({
        message: 'A summary is already running for this meeting',
        code: 'SUMMARY_ALREADY_RUNNING',
      });
    }

    const fingerprint = computeTranscriptFingerprint(transcriptFileIds);

    // A rerun replaces the previous result in place: same row, cleared fields,
    // and its previous tasks/decisions deleted eagerly here (not deferred to
    // completion) so the three blocks never show a torn mix of an old list
    // against a freshly-queued status.
    const summary = await this.prisma.$transaction(async (tx) => {
      const row = await tx.meetingSummary.upsert({
        where: { meetingId },
        create: { meetingId, transcriptFingerprint: fingerprint },
        update: {
          status: MeetingSummaryStatus.QUEUED,
          transcriptFingerprint: fingerprint,
          summaryText: null,
          failureCode: null,
          startedAt: null,
          finishedAt: null,
        },
      });

      await tx.meetingSummaryTask.deleteMany({ where: { summaryId: row.id } });
      await tx.meetingSummaryDecision.deleteMany({ where: { summaryId: row.id } });

      return row;
    });

    this.launch(summary.id);

    // tasks/decisions were just deleted above and nothing new exists yet, so
    // building the response in place is correct without an extra read.
    return toMeetingSummaryResponse({ ...summary, tasks: [], decisions: [] });
  }

  /**
   * The scheduler's launch path, for a meeting the scheduler judged eligible
   * either because it has no summary row yet or because its finished run's
   * `transcriptFingerprint` no longer matches the meeting's current ready
   * transcript set. No access check and no unconditional reset: `create`
   * always runs first, and only a `P2002` unique-constraint failure — a row
   * already existing — falls through to `resetForRecompute`, which re-reads
   * the row and re-checks both its status and the fingerprint itself before
   * touching it. That keeps this method safe to call from a stale candidate
   * list without trusting the caller's read.
   *
   * Awaits the run to completion rather than firing it like `launch` does for
   * the manual route: there is no HTTP response here to keep unblocked, and
   * awaiting is what keeps the scheduler's own loop (see
   * `MeetingSummarySchedulerService.run`) from starting a second real model
   * call before the first has finished — several such calls in flight at once
   * was never a case the manual, one-click-at-a-time route had to consider.
   */
  async startForMeeting(meetingId: string): Promise<void> {
    const fingerprint = computeTranscriptFingerprint(await this.readyTranscriptFileIds(meetingId));

    let summary: { id: string } | null;

    try {
      summary = await this.prisma.meetingSummary.create({
        data: { meetingId, transcriptFingerprint: fingerprint },
        select: { id: true },
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) {
        throw error;
      }

      summary = await this.resetForRecompute(meetingId, fingerprint);
    }

    if (summary) {
      await this.runAndLogFailures(summary.id);
    }
  }

  /**
   * Resets a COMPLETED or FAILED row for a recompute, the same in-place reset
   * `start` does for a manual rerun, guarded so a row another actor already
   * moved to QUEUED/PROCESSING (a manual start, or another scheduler pass)
   * since it was read is left alone instead of reset out from under that run.
   * Also declines a fingerprint that turns out to already match — the
   * scheduler's own candidate read can be a moment stale by the time this
   * runs, and starting a run whose input has not actually changed is exactly
   * the wasted run this column exists to prevent.
   */
  private async resetForRecompute(
    meetingId: string,
    fingerprint: string,
  ): Promise<{ id: string } | null> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.meetingSummary.findUnique({
        where: { meetingId },
        select: { id: true, status: true, transcriptFingerprint: true },
      });

      if (
        !existing ||
        runningStatuses.includes(existing.status) ||
        existing.transcriptFingerprint === fingerprint
      ) {
        return null;
      }

      const claimed = await tx.meetingSummary.updateMany({
        where: {
          id: existing.id,
          status: { in: [MeetingSummaryStatus.COMPLETED, MeetingSummaryStatus.FAILED] },
        },
        data: {
          status: MeetingSummaryStatus.QUEUED,
          transcriptFingerprint: fingerprint,
          summaryText: null,
          failureCode: null,
          startedAt: null,
          finishedAt: null,
        },
      });

      if (claimed.count !== 1) {
        return null;
      }

      await tx.meetingSummaryTask.deleteMany({ where: { summaryId: existing.id } });
      await tx.meetingSummaryDecision.deleteMany({ where: { summaryId: existing.id } });

      return { id: existing.id };
    });
  }

  private async readyTranscriptFileIds(meetingId: string): Promise<string[]> {
    const files = await this.prisma.meetingFile.findMany({
      where: {
        meetingId,
        category: MeetingFileCategory.TRANSCRIPT,
        status: MeetingFileStatus.READY,
      },
      select: { id: true },
    });

    return files.map((file) => file.id);
  }

  async get(meetingId: string, userId: string): Promise<MeetingSummaryResponse> {
    await this.meetingAccess.requireAccess(meetingId, userId);

    const row = await this.prisma.meetingSummary.findUnique({
      where: { meetingId },
      include: {
        tasks: { orderBy: { position: 'asc' } },
        decisions: { orderBy: { position: 'asc' } },
      },
    });

    return toMeetingSummaryResponse(row);
  }

  // Fire-and-forget: the manual route's HTTP response must not wait for the
  // model. `startForMeeting` above awaits `runAndLogFailures` directly
  // instead of going through this — see the comment on that method.
  private launch(summaryId: string): void {
    void this.runAndLogFailures(summaryId);
  }

  // The runner writes FAILED status internally on any error and never
  // rejects, so this catch only guards against a bug in that guarantee —
  // for either caller, an exception here must not propagate into an
  // unhandled rejection.
  private async runAndLogFailures(summaryId: string): Promise<void> {
    try {
      await this.runner.process(summaryId);
    } catch (error: unknown) {
      this.logger.error(
        `Meeting summary runner rejected unexpectedly for job ${summaryId}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}
