import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
  StreamableFile,
  UploadedFile,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { diskStorage } from 'multer';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { MulterExceptionFilter } from './filters/multer-exception.filter';
import { MeetingFileAccessGuard } from './guards/meeting-file-access.guard';
import { UploadCapacityGuard } from './guards/upload-capacity.guard';
import { MeetingFileUploaderAvatarService } from './services/meeting-file-uploader-avatar.service';
import { MeetingFilesService } from './services/meeting-files.service';
import { LocalMeetingFileStorageService } from './services/local-meeting-file-storage.service';
import { getDeclaredFile } from './services/meeting-file-validation.service';
import { uploadConfig } from './upload.config';

@Controller('meetings/:meetingId/files')
@UseGuards(JwtAuthGuard, MeetingFileAccessGuard)
export class FilesController {
  constructor(
    private readonly files: MeetingFilesService,
    private readonly uploaderAvatars: MeetingFileUploaderAvatarService,
  ) {}

  @Post()
  @UseGuards(UploadCapacityGuard)
  @UseFilters(MulterExceptionFilter)
  @UseInterceptors(
    FileInterceptor('file', {
      defParamCharset: 'utf8',
      storage: diskStorage({
        destination: uploadConfig.tempDirectory,
        filename: (request, _file, callback) => {
          const name = `${randomUUID()}.part`;
          const tempPath = resolve(uploadConfig.tempDirectory, name);
          LocalMeetingFileStorageService.trackTemp(tempPath);
          (request as AuthenticatedRequest & { uploadTempPath?: string }).uploadTempPath = tempPath;
          callback(null, name);
        },
      }),
      limits: {
        fileSize: uploadConfig.maxBytes + 1,
        files: 1,
        fields: 0,
        parts: 2,
      },
      fileFilter: (_request, file, callback) => {
        try {
          getDeclaredFile(file);
          callback(null, true);
        } catch (error) {
          callback(error as Error, false);
        }
      },
    }),
  )
  upload(
    @Param('meetingId') meetingId: string,
    @Req() request: AuthenticatedRequest,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    return this.files.upload(meetingId, request.user.sub, file);
  }

  @Get()
  list(@Param('meetingId') meetingId: string, @Req() request: AuthenticatedRequest) {
    return this.files.list(meetingId, request.user.sub);
  }

  @Get(':fileId/uploader-avatar')
  async getUploaderAvatar(
    @Param('meetingId') meetingId: string,
    @Param('fileId') fileId: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const avatar = await this.uploaderAvatars.open(meetingId, fileId, request.user.sub);

    response.set({
      'Cache-Control': 'private, no-store',
      'Content-Length': String(avatar.sizeBytes),
      'Content-Type': avatar.mimeType,
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    });

    return new StreamableFile(avatar.stream);
  }

  @Post(':fileId/download-ticket')
  createDownloadTicket(
    @Param('meetingId') meetingId: string,
    @Param('fileId') fileId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.files.createDownloadTicket(meetingId, fileId, request.user.sub);
  }

  @Delete(':fileId')
  @HttpCode(HttpStatus.NO_CONTENT)
  delete(
    @Param('meetingId') meetingId: string,
    @Param('fileId') fileId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.files.delete(meetingId, fileId, request.user.sub);
  }
}

function encodeContentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, '_') || 'download';
  const encoded = encodeURIComponent(name).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

@Controller('file-downloads')
export class FileDownloadsController {
  constructor(private readonly files: MeetingFilesService) {}

  @Get(':ticket')
  async download(
    @Param('ticket') ticket: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const file = await this.files.openDownload(ticket);

    response.set({
      'Cache-Control': 'private, no-store',
      'Content-Disposition': encodeContentDisposition(file.name),
      'Content-Length': String(file.sizeBytes),
      'Content-Type': file.mimeType,
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    });

    return new StreamableFile(file.stream);
  }
}
