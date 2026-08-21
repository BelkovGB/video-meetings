import { Injectable } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { LocalMeetingFileStorageService } from '../../files/services/local-meeting-file-storage.service';
import { uploadConfig } from '../../files/upload.config';
import { TranscriptionFailure } from '../models/transcription-failure';
import { StoredTranscript } from './transcription-jobs.service';

const transcriptExtension = '.txt';
const maxOriginalNameLength = 255;

/**
 * Names the transcript after its recording.
 *
 * The name is user-supplied and never reaches the filesystem — the path is
 * built from the storage key — so this only has to keep it displayable and
 * within the column: control characters and path separators go, the recording's
 * extension is replaced.
 */
export function transcriptNameFor(sourceName: string): string {
  const displayable = Array.from(sourceName)
    .filter(
      (character) =>
        character.charCodeAt(0) >= 32 &&
        character.charCodeAt(0) !== 127 &&
        character !== '/' &&
        character !== '\\',
    )
    .join('');
  const lastDot = displayable.lastIndexOf('.');
  const stem = (lastDot > 0 ? displayable.slice(0, lastDot) : displayable).trim();
  const base = stem.length > 0 ? stem : 'transcript';

  return `${base.slice(0, maxOriginalNameLength - transcriptExtension.length)}${transcriptExtension}`;
}

@Injectable()
export class TranscriptFileService {
  constructor(private readonly storage: LocalMeetingFileStorageService) {}

  /**
   * Writes the transcript into meeting-file storage and returns the row it
   * needs, leaving the row itself to the caller's transaction.
   *
   * Written past the active-upload limit — that limit counts HTTP uploads, and
   * its counters are per-process, so a worker calling it would only pretend to
   * account for anything — but not past the free-space reserve.
   */
  async write(sourceName: string, text: string): Promise<StoredTranscript> {
    const content = Buffer.from(text, 'utf8');

    if (!(await this.storage.hasFreeSpaceFor(content.byteLength))) {
      throw new TranscriptionFailure('INSUFFICIENT_STORAGE');
    }

    // `finalize` accepts only a path inside the upload temp directory, and the
    // stale-temp sweeper only considers `.part` files it is not tracking.
    const tempPath = resolve(uploadConfig.tempDirectory, `${randomUUID()}.part`);
    LocalMeetingFileStorageService.trackTemp(tempPath);

    try {
      await writeFile(tempPath, content, { mode: 0o600, flag: 'wx' });

      const storageKey = randomBytes(32).toString('hex');
      await this.storage.finalize(tempPath, storageKey);

      return {
        originalName: transcriptNameFor(sourceName),
        storageKey,
        sizeBytes: content.byteLength,
      };
    } catch (error) {
      await this.storage.discardTemp(tempPath);
      throw new TranscriptionFailure(
        'TRANSCRIPT_STORAGE_FAILED',
        error instanceof Error ? error.message : undefined,
      );
    } finally {
      this.storage.untrackTemp(tempPath);
    }
  }

  async discard(storageKey: string): Promise<void> {
    await this.storage.discardFinal(storageKey);
  }
}
