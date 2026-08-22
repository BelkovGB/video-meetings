import { TranscriptSegment } from '../models/transcript-segment';
import { TranscriptionFailure } from '../models/transcription-failure';
import { transcriptionConfig } from '../transcription.config';
import { runExternalProcess } from './external-process';

type RawSegment = {
  start: unknown;
  end: unknown;
  text: unknown;
};

function readSegmentList(stdout: string): RawSegment[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new TranscriptionFailure('RECOGNITION_OUTPUT_INVALID', 'stdout is not JSON');
  }

  const segments = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed !== null
      ? (parsed as { segments?: unknown }).segments
      : undefined;

  if (!Array.isArray(segments)) {
    throw new TranscriptionFailure('RECOGNITION_OUTPUT_INVALID', 'no segment list in stdout');
  }

  return segments as RawSegment[];
}

function toSegment(raw: RawSegment): TranscriptSegment {
  const startSeconds = Number(raw.start);
  const endSeconds = Number(raw.end);

  if (
    !Number.isFinite(startSeconds) ||
    !Number.isFinite(endSeconds) ||
    startSeconds < 0 ||
    endSeconds < startSeconds ||
    typeof raw.text !== 'string'
  ) {
    throw new TranscriptionFailure('RECOGNITION_OUTPUT_INVALID', 'malformed segment');
  }

  return { startSeconds, endSeconds, text: raw.text.replace(/\s+/g, ' ').trim() };
}

/**
 * Runs the configured recognizer over the prepared audio and returns its
 * segments.
 *
 * The contract is the audio path as the last argument and JSON on stdout: a
 * segment array, or an object carrying one under `segments`, each segment
 * `start`, `end` in seconds from the beginning of the recording and `text`.
 * The stream must be UTF-8; a recognizer that writes its console encoding
 * instead fails the job rather than storing replacement characters.
 */
export async function recognizeAudio(audioPath: string): Promise<TranscriptSegment[]> {
  let stdout: string;

  try {
    stdout = await runExternalProcess({
      executable: transcriptionConfig.command,
      args: [...transcriptionConfig.commandArguments, audioPath],
      timeoutMs: transcriptionConfig.recognitionTimeoutMs,
    });
  } catch (error) {
    throw new TranscriptionFailure(
      'RECOGNITION_FAILED',
      error instanceof Error ? error.message : undefined,
    );
  }

  // The stream is decoded as UTF-8. A recognizer that wrote its text in the
  // console encoding instead still produces parseable JSON, because the
  // structure is ASCII, and the damage shows only as a replacement character
  // where a word was. Failing the job beats storing a transcript of them.
  if (stdout.includes('�')) {
    throw new TranscriptionFailure('RECOGNITION_OUTPUT_INVALID', 'stdout is not UTF-8');
  }

  return readSegmentList(stdout)
    .map(toSegment)
    .filter((segment) => segment.text.length > 0);
}
