import { resolve } from 'node:path';

const DEFAULT_FFMPEG_PATH = 'ffmpeg';
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_LEASE_TIMEOUT_MS = 900_000;
const DEFAULT_AUDIO_PREPARATION_TIMEOUT_MS = 3_600_000;
const DEFAULT_RECOGNITION_TIMEOUT_MS = 14_400_000;

function readPositiveInteger(name: string, fallback: number): number {
  const value = process.env[name];

  if (!value) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

/**
 * Reads the recognition command arguments as a JSON array of strings.
 *
 * A single string would have to be split here, and splitting a Windows path
 * with spaces on whitespace produces arguments no quoting convention agrees on.
 * The audio path is appended to this list by the worker, never taken from the
 * uploaded file name.
 */
function readCommandArguments(name: string): string[] {
  const value = process.env[name];

  if (!value) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${name} must be a JSON array of strings`);
  }

  if (!Array.isArray(parsed) || parsed.some((argument) => typeof argument !== 'string')) {
    throw new Error(`${name} must be a JSON array of strings`);
  }

  return parsed as string[];
}

const transcriptionRoot = resolve(process.cwd(), 'var', 'transcription');

export const transcriptionConfig = {
  // Empty until an operator configures it: the API process must boot without a
  // recognizer, and only the worker refuses to start without one.
  command: process.env.TRANSCRIPTION_COMMAND ?? '',
  commandArguments: readCommandArguments('TRANSCRIPTION_COMMAND_ARGS'),
  ffmpegPath: process.env.TRANSCRIPTION_FFMPEG_PATH ?? DEFAULT_FFMPEG_PATH,
  // Placed before the conversion arguments, so a wrapper or an acceleration
  // flag needs no code change.
  ffmpegArguments: readCommandArguments('TRANSCRIPTION_FFMPEG_ARGS'),
  // Separate from UPLOAD_TEMP_DIR: storage reconciliation deletes stale entries
  // there, and it cannot see another process's in-flight files.
  workDirectory: resolve(process.env.TRANSCRIPTION_WORK_DIR ?? transcriptionRoot),
  pollIntervalMs: readPositiveInteger('TRANSCRIPTION_POLL_INTERVAL_MS', DEFAULT_POLL_INTERVAL_MS),
  leaseTimeoutMs: readPositiveInteger('TRANSCRIPTION_LEASE_TIMEOUT_MS', DEFAULT_LEASE_TIMEOUT_MS),
  audioPreparationTimeoutMs: readPositiveInteger(
    'TRANSCRIPTION_AUDIO_TIMEOUT_MS',
    DEFAULT_AUDIO_PREPARATION_TIMEOUT_MS,
  ),
  recognitionTimeoutMs: readPositiveInteger(
    'TRANSCRIPTION_RECOGNITION_TIMEOUT_MS',
    DEFAULT_RECOGNITION_TIMEOUT_MS,
  ),
};
