import {
  ConflictException,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { MeetingFileCategory, MeetingFileStatus, MeetingSummaryStatus } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { MeetingAccessService } from '../../files/services/meeting-access.service';
import {
  MeetingSummaryResponse,
  toMeetingSummaryResponse,
} from '../models/meeting-summary.response';
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

    const transcriptFileCount = await this.prisma.meetingFile.count({
      where: {
        meetingId,
        category: MeetingFileCategory.TRANSCRIPT,
        status: MeetingFileStatus.READY,
      },
    });

    if (transcriptFileCount === 0) {
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

    // A rerun replaces the previous result in place: same row, cleared fields,
    // and its previous tasks/decisions deleted eagerly here (not deferred to
    // completion) so the three blocks never show a torn mix of an old list
    // against a freshly-queued status.
    const summary = await this.prisma.$transaction(async (tx) => {
      const row = await tx.meetingSummary.upsert({
        where: { meetingId },
        create: { meetingId },
        update: {
          status: MeetingSummaryStatus.QUEUED,
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

    // Fire-and-forget: the HTTP response must not wait for the model. The
    // runner writes FAILED status internally on any error and never rejects,
    // so this catch only guards against a bug in that guarantee.
    void this.runner.process(summary.id).catch((error: unknown) => {
      this.logger.error(
        `Meeting summary runner rejected unexpectedly for job ${summary.id}`,
        error instanceof Error ? error.stack : undefined,
      );
    });

    // tasks/decisions were just deleted above and nothing new exists yet, so
    // building the response in place is correct without an extra read.
    return toMeetingSummaryResponse({ ...summary, tasks: [], decisions: [] });
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
}
