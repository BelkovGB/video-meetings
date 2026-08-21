import { Module } from '@nestjs/common';

import { LocalMeetingFileStorageService } from '../../files/services/local-meeting-file-storage.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { TranscriptFileService } from '../services/transcript-file.service';
import { TranscriptionJobsService } from '../services/transcription-jobs.service';
import { TranscriptionWorker } from './transcription-worker';

/**
 * The worker process assembly. `AppModule` must not import it: the HTTP process
 * would then hold the GPU and block on a recording hours long, which is the one
 * thing a separate worker exists to prevent.
 *
 * `LocalMeetingFileStorageService` is a provider here rather than a whole
 * `FilesModule` import, so the worker gets the storage checks its start needs
 * without also starting deletion reconciliation a second time.
 */
@Module({
  imports: [PrismaModule],
  providers: [
    LocalMeetingFileStorageService,
    TranscriptFileService,
    TranscriptionJobsService,
    TranscriptionWorker,
  ],
})
export class TranscriptionWorkerModule {}
