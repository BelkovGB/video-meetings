import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { hostname } from 'node:os';

import { LocalMeetingFileStorageService } from '../../files/services/local-meeting-file-storage.service';
import { TranscriptionFailure, transcriptionFailureCode } from '../models/transcription-failure';
import { TranscriptFileService } from '../services/transcript-file.service';
import {
  ClaimedTranscriptionJob,
  TranscriptionJobsService,
} from '../services/transcription-jobs.service';
import { transcriptionConfig } from '../transcription.config';
import { prepareAudioForRecognition } from './audio-preparation';
import { recognizeAudio } from './recognition-command';
import { formatTranscript } from './transcript-format';

const maxLeaseOwnerLength = 128;

/**
 * Runs transcription jobs, one at a time, in the worker process.
 *
 * The loop is started by the process entry point rather than by a lifecycle
 * hook: a hook would also start it wherever the module is instantiated, and a
 * test that drives `processNextJob` directly needs no timers at all.
 */
@Injectable()
export class TranscriptionWorker {
  private readonly logger = new Logger(TranscriptionWorker.name);
  private readonly leaseOwner = `${hostname()}:${process.pid}:${randomUUID()}`.slice(
    0,
    maxLeaseOwnerLength,
  );
  private pollTimer: NodeJS.Timeout | undefined;
  private activeDrain: Promise<void> | undefined;
  private stopping = false;

  constructor(
    private readonly jobs: TranscriptionJobsService,
    private readonly transcriptFile: TranscriptFileService,
    private readonly storage: LocalMeetingFileStorageService,
  ) {}

  run(): void {
    if (this.pollTimer) {
      return;
    }

    this.stopping = false;
    // Referenced on purpose: this timer is the only handle the worker process
    // owns — it serves no port and holds no socket — so unreferencing it lets
    // the process exit as soon as the first drain finds an empty queue.
    this.pollTimer = setInterval(() => {
      void this.drainQueue();
    }, transcriptionConfig.pollIntervalMs);
    void this.drainQueue();
  }

  async stop(): Promise<void> {
    this.stopping = true;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }

    await this.activeDrain;
  }

  /** Takes one job and sees it through. Returns false when the queue held
   * nothing this worker could take. */
  async processNextJob(): Promise<boolean> {
    const job = await this.jobs.claimNextJob(this.leaseOwner);

    if (!job) {
      return false;
    }

    try {
      await this.transcribe(job);
    } catch (error) {
      const failureCode = transcriptionFailureCode(error);
      this.logger.error(
        `Transcription job ${job.id} failed: ${failureCode}`,
        error instanceof Error ? error.stack : undefined,
      );
      await this.jobs.failJob(job.id, this.leaseOwner, failureCode);
    }

    return true;
  }

  private async drainQueue(): Promise<void> {
    if (this.activeDrain) {
      return;
    }

    this.activeDrain = this.takeJobsUntilEmpty().finally(() => {
      this.activeDrain = undefined;
    });

    await this.activeDrain;
  }

  private async takeJobsUntilEmpty(): Promise<void> {
    try {
      while (!this.stopping && (await this.processNextJob())) {
        // One job at a time: the queue is drained sequentially because the GPU
        // fits one recognition run.
      }
    } catch (error) {
      this.logger.error(
        'Failed to poll the transcription queue',
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  private async transcribe(job: ClaimedTranscriptionJob): Promise<void> {
    let sourcePath: string;
    try {
      sourcePath = await this.storage.resolveExistingContentPath(job.sourceFile.storageKey);
    } catch {
      throw new TranscriptionFailure('SOURCE_FILE_UNAVAILABLE');
    }

    const preparedPath = await prepareAudioForRecognition(sourcePath);
    let segments;
    try {
      segments = await recognizeAudio(preparedPath);
    } finally {
      await rm(preparedPath, { force: true });
    }

    if (segments.length === 0) {
      throw new TranscriptionFailure('NO_SPEECH_DETECTED');
    }

    const transcript = await this.transcriptFile.write(
      job.sourceFile.originalName,
      formatTranscript(segments),
    );

    let stored: boolean;
    try {
      stored = await this.jobs.completeJob(job.id, this.leaseOwner, transcript);
    } catch (error) {
      await this.transcriptFile.discard(transcript.storageKey);
      throw new TranscriptionFailure(
        'TRANSCRIPT_STORAGE_FAILED',
        error instanceof Error ? error.message : undefined,
      );
    }

    if (!stored) {
      // The recording was deleted, or the lease moved on, while this ran: the
      // bytes go away instead of surfacing as a transcript with no recording.
      await this.transcriptFile.discard(transcript.storageKey);
      throw new TranscriptionFailure('SOURCE_FILE_UNAVAILABLE');
    }
  }
}
