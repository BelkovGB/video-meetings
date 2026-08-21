import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { TranscriptionFailure } from '../models/transcription-failure';
import { transcriptionConfig } from '../transcription.config';
import { runExternalProcess } from './external-process';

/**
 * Converts a recording to the 16 kHz mono wav the recognizer expects and
 * returns the path of the converted copy, which the caller deletes.
 *
 * The copy goes to the worker's own directory: the upload temp directory is
 * swept by storage reconciliation, which cannot see another process's files in
 * flight and would delete a conversion still running.
 */
export async function prepareAudioForRecognition(sourcePath: string): Promise<string> {
  await mkdir(transcriptionConfig.workDirectory, { recursive: true, mode: 0o700 });
  const preparedPath = resolve(transcriptionConfig.workDirectory, `${randomUUID()}.wav`);

  try {
    await runExternalProcess({
      executable: transcriptionConfig.ffmpegPath,
      args: [
        ...transcriptionConfig.ffmpegArguments,
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        sourcePath,
        '-vn',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-c:a',
        'pcm_s16le',
        '-f',
        'wav',
        preparedPath,
      ],
      timeoutMs: transcriptionConfig.audioPreparationTimeoutMs,
    });
  } catch (error) {
    throw new TranscriptionFailure(
      'AUDIO_PREPARATION_FAILED',
      error instanceof Error ? error.message : undefined,
    );
  }

  return preparedPath;
}
