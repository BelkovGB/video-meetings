import { Logger } from '@nestjs/common';
import {
  MeetingFileCategory,
  MeetingFileStatus,
  MeetingSummaryStatus,
  TranscriptionJobStatus,
} from '@prisma/client';

import { meetingSummaryConfig } from '../src/meeting-summary/meeting-summary.config';
import { MeetingSummarySchedulerService } from '../src/meeting-summary/services/meeting-summary-scheduler.service';
import { computeTranscriptFingerprint } from '../src/meeting-summary/transcript-fingerprint';

type MeetingFileFindManyArgs = { where: { meeting?: unknown; meetingId?: unknown } };

/**
 * `meetingFile.findMany` is called for two different reasons within one
 * pass — new candidates (filtered by `meeting: { summary: null }`) and the
 * current transcript ids of an already-finished summary (filtered by
 * `meetingId: { in: [...] }`) — so the mock has to branch on which query it
 * is answering rather than rely on call order.
 */
function mockMeetingFileFindMany(
  noSummaryCandidates: { meetingId: string }[],
  transcriptIdsByMeeting: { meetingId: string; id: string }[] = [],
) {
  return jest.fn().mockImplementation((args: MeetingFileFindManyArgs) => {
    if (args.where.meeting) {
      return Promise.resolve(noSummaryCandidates);
    }

    return Promise.resolve(transcriptIdsByMeeting);
  });
}

/** No meeting has an upload in flight, unless the test says otherwise. */
function noActiveUploads() {
  return { hasActiveUpload: jest.fn().mockReturnValue(false) };
}

describe('MeetingSummarySchedulerService', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('queues every new candidate meeting whose recognition is not still in flight', async () => {
    const prisma = {
      meetingFile: {
        findMany: mockMeetingFileFindMany([
          { meetingId: 'meeting-done' },
          { meetingId: 'meeting-recognizing' },
        ]),
      },
      meetingSummary: { findMany: jest.fn().mockResolvedValue([]) },
      transcriptionJob: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ sourceFile: { meetingId: 'meeting-recognizing' } }]),
      },
    };
    const summary = { startForMeeting: jest.fn().mockResolvedValue(undefined) };
    const service = new MeetingSummarySchedulerService(
      prisma as never,
      summary as never,
      noActiveUploads() as never,
    );

    await service.run();

    expect(prisma.meetingFile.findMany).toHaveBeenCalledWith({
      where: {
        category: MeetingFileCategory.TRANSCRIPT,
        status: MeetingFileStatus.READY,
        meeting: { summary: null },
      },
      distinct: ['meetingId'],
      orderBy: { createdAt: 'asc' },
      select: { meetingId: true },
      take: 20,
    });
    expect(prisma.transcriptionJob.findMany).toHaveBeenCalledWith({
      where: {
        status: { in: [TranscriptionJobStatus.QUEUED, TranscriptionJobStatus.PROCESSING] },
        sourceFile: { meetingId: { in: ['meeting-done', 'meeting-recognizing'] } },
      },
      select: { sourceFile: { select: { meetingId: true } } },
    });
    expect(summary.startForMeeting).toHaveBeenCalledTimes(1);
    expect(summary.startForMeeting).toHaveBeenCalledWith('meeting-done');
  });

  it('queues a finished summary whose transcript set no longer matches its stored fingerprint', async () => {
    const staleFingerprint = computeTranscriptFingerprint(['old-transcript-file']);
    const prisma = {
      meetingFile: {
        findMany: mockMeetingFileFindMany(
          [],
          [
            { meetingId: 'meeting-stale', id: 'old-transcript-file' },
            { meetingId: 'meeting-stale', id: 'new-transcript-file' },
            { meetingId: 'meeting-unchanged', id: 'same-transcript-file' },
          ],
        ),
      },
      meetingSummary: {
        findMany: jest.fn().mockResolvedValue([
          { meetingId: 'meeting-stale', transcriptFingerprint: staleFingerprint },
          {
            meetingId: 'meeting-unchanged',
            transcriptFingerprint: computeTranscriptFingerprint(['same-transcript-file']),
          },
        ]),
      },
      transcriptionJob: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const summary = { startForMeeting: jest.fn().mockResolvedValue(undefined) };
    const service = new MeetingSummarySchedulerService(
      prisma as never,
      summary as never,
      noActiveUploads() as never,
    );

    await service.run();

    expect(prisma.meetingSummary.findMany).toHaveBeenCalledWith({
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
    // meeting-stale's stored fingerprint only covers the old file, so the
    // current two-file set counts as changed; meeting-unchanged's fingerprint
    // still matches its (single, same) file and is left alone.
    expect(summary.startForMeeting).toHaveBeenCalledTimes(1);
    expect(summary.startForMeeting).toHaveBeenCalledWith('meeting-stale');
  });

  it('finds a stale summary sitting behind a full page of up-to-date ones', async () => {
    // One more up-to-date summary than the pass may queue in a batch: a query
    // that asked the database for a page of that size would come back holding
    // nothing but these, and the stale meeting behind them would never be
    // recomputed.
    const pageSize = 20;
    const upToDate = Array.from({ length: pageSize }, (unused, index) => ({
      meetingId: `meeting-fresh-${index}`,
      transcriptFingerprint: computeTranscriptFingerprint([`fresh-transcript-${index}`]),
    }));
    const finishedSummaries = [
      ...upToDate,
      {
        meetingId: 'meeting-stale',
        transcriptFingerprint: computeTranscriptFingerprint(['old-transcript-file']),
      },
    ];
    const prisma = {
      meetingFile: {
        findMany: mockMeetingFileFindMany(
          [],
          [
            ...upToDate.map((summary, index) => ({
              meetingId: summary.meetingId,
              id: `fresh-transcript-${index}`,
            })),
            { meetingId: 'meeting-stale', id: 'old-transcript-file' },
            { meetingId: 'meeting-stale', id: 'new-transcript-file' },
          ],
        ),
      },
      meetingSummary: {
        // Honours `take` the way the database would, so this test fails if
        // the batch size ever moves back ahead of the fingerprint comparison
        // instead of being applied to its result.
        findMany: jest
          .fn()
          .mockImplementation((args: { take?: number }) =>
            Promise.resolve(
              args.take === undefined ? finishedSummaries : finishedSummaries.slice(0, args.take),
            ),
          ),
      },
      transcriptionJob: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const summary = { startForMeeting: jest.fn().mockResolvedValue(undefined) };
    const service = new MeetingSummarySchedulerService(
      prisma as never,
      summary as never,
      noActiveUploads() as never,
    );

    await service.run();

    expect(summary.startForMeeting).toHaveBeenCalledTimes(1);
    expect(summary.startForMeeting).toHaveBeenCalledWith('meeting-stale');
  });

  it('skips a stale summary while its meeting still has a recognition job in flight', async () => {
    const prisma = {
      meetingFile: {
        findMany: mockMeetingFileFindMany([], [{ meetingId: 'meeting-stale', id: 'new-file' }]),
      },
      meetingSummary: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { meetingId: 'meeting-stale', transcriptFingerprint: 'old-fingerprint' },
          ]),
      },
      transcriptionJob: {
        findMany: jest.fn().mockResolvedValue([{ sourceFile: { meetingId: 'meeting-stale' } }]),
      },
    };
    const summary = { startForMeeting: jest.fn() };
    const service = new MeetingSummarySchedulerService(
      prisma as never,
      summary as never,
      noActiveUploads() as never,
    );

    await service.run();

    expect(summary.startForMeeting).not.toHaveBeenCalled();
  });

  it('skips a meeting that currently has a file upload in flight', async () => {
    const prisma = {
      meetingFile: {
        findMany: mockMeetingFileFindMany([
          { meetingId: 'meeting-uploading' },
          { meetingId: 'meeting-idle' },
        ]),
      },
      meetingSummary: { findMany: jest.fn().mockResolvedValue([]) },
      transcriptionJob: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const summary = { startForMeeting: jest.fn().mockResolvedValue(undefined) };
    const storage = {
      hasActiveUpload: jest.fn((meetingId: string) => meetingId === 'meeting-uploading'),
    };
    const service = new MeetingSummarySchedulerService(
      prisma as never,
      summary as never,
      storage as never,
    );

    await service.run();

    expect(summary.startForMeeting).toHaveBeenCalledTimes(1);
    expect(summary.startForMeeting).toHaveBeenCalledWith('meeting-idle');
  });

  it('does nothing when no meeting is a new or a stale candidate', async () => {
    const prisma = {
      meetingFile: { findMany: mockMeetingFileFindMany([]) },
      meetingSummary: { findMany: jest.fn().mockResolvedValue([]) },
      transcriptionJob: { findMany: jest.fn() },
    };
    const summary = { startForMeeting: jest.fn() };
    const service = new MeetingSummarySchedulerService(
      prisma as never,
      summary as never,
      noActiveUploads() as never,
    );

    await service.run();

    expect(prisma.transcriptionJob.findMany).not.toHaveBeenCalled();
    expect(summary.startForMeeting).not.toHaveBeenCalled();
  });

  it('does not let a slow pass overlap with the next tick', async () => {
    let resolveFindMany: ((candidates: never[]) => void) | undefined;
    const prisma = {
      meetingFile: {
        findMany: jest.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              resolveFindMany = resolve;
            }),
        ),
      },
      meetingSummary: { findMany: jest.fn().mockResolvedValue([]) },
      transcriptionJob: { findMany: jest.fn() },
    };
    const summary = { startForMeeting: jest.fn() };
    const service = new MeetingSummarySchedulerService(
      prisma as never,
      summary as never,
      noActiveUploads() as never,
    );

    const firstPass = service.run();
    const secondPass = service.run();
    resolveFindMany?.([]);
    await Promise.all([firstPass, secondPass]);

    expect(prisma.meetingFile.findMany).toHaveBeenCalledTimes(1);
  });

  it('logs a rejected scheduler pass and keeps retrying on the next tick', async () => {
    // test/setup.ts turns this off for the whole suite; this one test needs
    // it on to exercise onApplicationBootstrap's own auto-start behavior.
    meetingSummaryConfig.schedulerAutoStart = true;
    jest.useFakeTimers();
    const service = new MeetingSummarySchedulerService(
      {} as never,
      {} as never,
      noActiveUploads() as never,
    );
    const error = new Error('database unavailable');
    const loggerError = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const run = jest
      .spyOn(service, 'run')
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(undefined);

    await service.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(meetingSummaryConfig.schedulerIntervalMs);

    expect(loggerError).toHaveBeenCalledWith(
      'Failed to run the meeting summary scheduler',
      error.stack,
    );

    await jest.advanceTimersByTimeAsync(meetingSummaryConfig.schedulerIntervalMs);

    expect(run).toHaveBeenCalledTimes(3);

    service.onModuleDestroy();
    meetingSummaryConfig.schedulerAutoStart = false;
  });

  it('does not auto-start when SUMMARY_SCHEDULER_AUTOSTART is off, as it is for this whole suite', async () => {
    const service = new MeetingSummarySchedulerService(
      {} as never,
      {} as never,
      noActiveUploads() as never,
    );
    const run = jest.spyOn(service, 'run');

    await service.onApplicationBootstrap();

    expect(run).not.toHaveBeenCalled();

    service.onModuleDestroy();
  });

  it('an exception during the initial bootstrap pass does not fail app startup', async () => {
    meetingSummaryConfig.schedulerAutoStart = true;
    const service = new MeetingSummarySchedulerService(
      {} as never,
      {} as never,
      noActiveUploads() as never,
    );
    const error = new Error('database unavailable');
    const loggerError = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.spyOn(service, 'run').mockRejectedValueOnce(error);

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();

    expect(loggerError).toHaveBeenCalledWith(
      'Failed to run the meeting summary scheduler',
      error.stack,
    );

    service.onModuleDestroy();
    meetingSummaryConfig.schedulerAutoStart = false;
  });
});
