import { ClaudeAgentTimeoutError } from '../../claude-agent/claude-agent.service';

/**
 * Machine-readable reasons a meeting summary job stops.
 *
 * The code is what the job row stores and what the client sees, so it carries
 * no paths, storage keys or database ids.
 */
export const meetingSummaryFailureCodes = [
  'INPUT_TOO_LARGE',
  'MODEL_OUTPUT_INVALID',
  'TIME_LIMIT_EXCEEDED',
  'INTERRUPTED',
  'INTERNAL_ERROR',
] as const;

export type MeetingSummaryFailureCode = (typeof meetingSummaryFailureCodes)[number];

export class MeetingSummaryFailure extends Error {
  constructor(
    readonly code: MeetingSummaryFailureCode,
    message: string = code,
  ) {
    super(message);
    this.name = 'MeetingSummaryFailure';
  }
}

export function meetingSummaryFailureCode(error: unknown): MeetingSummaryFailureCode {
  if (error instanceof MeetingSummaryFailure) {
    return error.code;
  }

  if (error instanceof ClaudeAgentTimeoutError) {
    return 'TIME_LIMIT_EXCEEDED';
  }

  return 'INTERNAL_ERROR';
}
