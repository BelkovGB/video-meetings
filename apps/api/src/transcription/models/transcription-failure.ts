/**
 * Machine-readable reasons a transcription job stops.
 *
 * The code is what the job row stores and what phase 3 will show to the client,
 * so it carries no paths, storage keys or command output.
 */
export const transcriptionFailureCodes = [
  'AUDIO_PREPARATION_FAILED',
  'RECOGNITION_FAILED',
  'RECOGNITION_OUTPUT_INVALID',
  'NO_SPEECH_DETECTED',
  'INSUFFICIENT_STORAGE',
  'TRANSCRIPT_STORAGE_FAILED',
  'SOURCE_FILE_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;

export type TranscriptionFailureCode = (typeof transcriptionFailureCodes)[number];

export class TranscriptionFailure extends Error {
  constructor(
    readonly code: TranscriptionFailureCode,
    message: string = code,
  ) {
    super(message);
    this.name = 'TranscriptionFailure';
  }
}

export function transcriptionFailureCode(error: unknown): TranscriptionFailureCode {
  return error instanceof TranscriptionFailure ? error.code : 'INTERNAL_ERROR';
}
