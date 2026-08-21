import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { TranscriptionJobsService } from './services/transcription-jobs.service';

/**
 * The API-side half of transcription: enqueueing a job with an upload and
 * removing it with the recording. Running jobs is the worker process, assembled
 * separately in `worker/transcription-worker.module.ts`.
 */
@Module({
  imports: [PrismaModule],
  providers: [TranscriptionJobsService],
  exports: [TranscriptionJobsService],
})
export class TranscriptionModule {}
