import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ProfileModule } from '../profile/profile.module';
import { FileDownloadsController, FilesController } from './files.controller';
import { MeetingUploadersController } from './meeting-uploaders.controller';
import { MeetingFileAccessGuard } from './guards/meeting-file-access.guard';
import { UploadCapacityGuard } from './guards/upload-capacity.guard';
import { LocalMeetingFileStorageService } from './services/local-meeting-file-storage.service';
import { MeetingAccessService } from './services/meeting-access.service';
import { MeetingFileDeletionReconciliationService } from './services/meeting-file-deletion-reconciliation.service';
import { MeetingUploaderAvatarService } from './services/meeting-uploader-avatar.service';
import { MeetingFilesService } from './services/meeting-files.service';
import { MeetingFileValidationService } from './services/meeting-file-validation.service';

@Module({
  imports: [AuthModule, PrismaModule, ProfileModule],
  controllers: [FilesController, FileDownloadsController, MeetingUploadersController],
  providers: [
    LocalMeetingFileStorageService,
    MeetingFileDeletionReconciliationService,
    MeetingAccessService,
    MeetingFileAccessGuard,
    MeetingUploaderAvatarService,
    UploadCapacityGuard,
    MeetingFilesService,
    MeetingFileValidationService,
  ],
})
export class FilesModule {}
