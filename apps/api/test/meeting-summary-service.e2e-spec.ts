import { Logger } from '@nestjs/common';
import { MeetingSummaryStatus, Prisma } from '@prisma/client';

import { MeetingSummaryService } from '../src/meeting-summary/services/meeting-summary.service';
import { computeTranscriptFingerprint } from '../src/meeting-summary/transcript-fingerprint';

function uniqueConstraintViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    'Unique constraint failed on the fields: (meetingId)',
    {
      code: 'P2002',
      clientVersion: '6.19.3',
    },
  );
}

/** A `$transaction` mock that hands the same `prisma` mock to the callback,
 * matching how `resetForRecompute` uses `tx` interchangeably with `prisma`. */
function withTransaction(prisma: Record<string, unknown>) {
  return jest.fn(async (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma));
}

describe('MeetingSummaryService.startForMeeting', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('creates a queued row stamped with the current transcript fingerprint', async () => {
    const prisma = {
      meetingFile: { findMany: jest.fn().mockResolvedValue([{ id: 'transcript-1' }]) },
      meetingSummary: { create: jest.fn().mockResolvedValue({ id: 'summary-1' }) },
    };
    const runner = { process: jest.fn().mockResolvedValue(undefined) };
    const service = new MeetingSummaryService(prisma as never, {} as never, runner as never);

    await service.startForMeeting('meeting-1');

    expect(prisma.meetingSummary.create).toHaveBeenCalledWith({
      data: {
        meetingId: 'meeting-1',
        transcriptFingerprint: computeTranscriptFingerprint(['transcript-1']),
      },
      select: { id: true },
    });
    expect(runner.process).toHaveBeenCalledWith('summary-1');
  });

  it('resets a finished summary in place when the transcript set changed', async () => {
    const prisma = {
      meetingFile: { findMany: jest.fn().mockResolvedValue([{ id: 'transcript-2' }]) },
      meetingSummary: {
        create: jest.fn().mockRejectedValue(uniqueConstraintViolation()),
        findUnique: jest.fn().mockResolvedValue({
          id: 'summary-1',
          status: MeetingSummaryStatus.COMPLETED,
          transcriptFingerprint: 'stale-fingerprint',
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      meetingSummaryTask: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      meetingSummaryDecision: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      $transaction: undefined as unknown,
    };
    prisma.$transaction = withTransaction(prisma);
    const runner = { process: jest.fn().mockResolvedValue(undefined) };
    const service = new MeetingSummaryService(prisma as never, {} as never, runner as never);

    await service.startForMeeting('meeting-1');

    const freshFingerprint = computeTranscriptFingerprint(['transcript-2']);
    expect(prisma.meetingSummary.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'summary-1',
        status: { in: [MeetingSummaryStatus.COMPLETED, MeetingSummaryStatus.FAILED] },
      },
      data: {
        status: MeetingSummaryStatus.QUEUED,
        transcriptFingerprint: freshFingerprint,
        summaryText: null,
        failureCode: null,
        startedAt: null,
        finishedAt: null,
      },
    });
    expect(prisma.meetingSummaryTask.deleteMany).toHaveBeenCalledWith({
      where: { summaryId: 'summary-1' },
    });
    expect(runner.process).toHaveBeenCalledWith('summary-1');
  });

  it('leaves a summary alone when the transcript set did not actually change', async () => {
    const fingerprint = computeTranscriptFingerprint(['transcript-2']);
    const prisma = {
      meetingFile: { findMany: jest.fn().mockResolvedValue([{ id: 'transcript-2' }]) },
      meetingSummary: {
        create: jest.fn().mockRejectedValue(uniqueConstraintViolation()),
        findUnique: jest.fn().mockResolvedValue({
          id: 'summary-1',
          status: MeetingSummaryStatus.COMPLETED,
          transcriptFingerprint: fingerprint,
        }),
        updateMany: jest.fn(),
      },
      $transaction: undefined as unknown,
    };
    prisma.$transaction = withTransaction(prisma);
    const runner = { process: jest.fn() };
    const service = new MeetingSummaryService(prisma as never, {} as never, runner as never);

    await service.startForMeeting('meeting-1');

    expect(prisma.meetingSummary.updateMany).not.toHaveBeenCalled();
    expect(runner.process).not.toHaveBeenCalled();
  });

  it('leaves a running summary alone instead of resetting it out from under itself', async () => {
    const prisma = {
      meetingFile: { findMany: jest.fn().mockResolvedValue([{ id: 'transcript-2' }]) },
      meetingSummary: {
        create: jest.fn().mockRejectedValue(uniqueConstraintViolation()),
        findUnique: jest.fn().mockResolvedValue({
          id: 'summary-1',
          status: MeetingSummaryStatus.PROCESSING,
          transcriptFingerprint: 'stale-fingerprint',
        }),
        updateMany: jest.fn(),
      },
      $transaction: undefined as unknown,
    };
    prisma.$transaction = withTransaction(prisma);
    const runner = { process: jest.fn() };
    const service = new MeetingSummaryService(prisma as never, {} as never, runner as never);

    await service.startForMeeting('meeting-1');

    expect(prisma.meetingSummary.updateMany).not.toHaveBeenCalled();
    expect(runner.process).not.toHaveBeenCalled();
  });

  it('leaves the row alone when another actor claims it between the reset attempt and the update', async () => {
    const prisma = {
      meetingFile: { findMany: jest.fn().mockResolvedValue([{ id: 'transcript-2' }]) },
      meetingSummary: {
        create: jest.fn().mockRejectedValue(uniqueConstraintViolation()),
        findUnique: jest.fn().mockResolvedValue({
          id: 'summary-1',
          status: MeetingSummaryStatus.COMPLETED,
          transcriptFingerprint: 'stale-fingerprint',
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      $transaction: undefined as unknown,
    };
    prisma.$transaction = withTransaction(prisma);
    const runner = { process: jest.fn() };
    const service = new MeetingSummaryService(prisma as never, {} as never, runner as never);

    await service.startForMeeting('meeting-1');

    expect(runner.process).not.toHaveBeenCalled();
  });

  it('does not swallow an unrelated database failure', async () => {
    const databaseFailure = new Error('database unavailable');
    const prisma = {
      meetingFile: { findMany: jest.fn().mockResolvedValue([]) },
      meetingSummary: { create: jest.fn().mockRejectedValue(databaseFailure) },
    };
    const runner = { process: jest.fn() };
    const service = new MeetingSummaryService(prisma as never, {} as never, runner as never);

    await expect(service.startForMeeting('meeting-1')).rejects.toBe(databaseFailure);
    expect(runner.process).not.toHaveBeenCalled();
  });

  it('logs instead of throwing when the runner rejects unexpectedly', async () => {
    const prisma = {
      meetingFile: { findMany: jest.fn().mockResolvedValue([]) },
      meetingSummary: { create: jest.fn().mockResolvedValue({ id: 'summary-1' }) },
    };
    const runnerFailure = new Error('runner exploded');
    const runner = { process: jest.fn().mockRejectedValue(runnerFailure) };
    const loggerError = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const service = new MeetingSummaryService(prisma as never, {} as never, runner as never);

    // Unlike the manual route's `launch`, `startForMeeting` awaits the runner
    // itself, so the rejection above has already reached its own try/catch by
    // the time this resolves — no microtask flush needed.
    await service.startForMeeting('meeting-1');

    expect(loggerError).toHaveBeenCalledWith(
      'Meeting summary runner rejected unexpectedly for job summary-1',
      runnerFailure.stack,
    );
  });
});
