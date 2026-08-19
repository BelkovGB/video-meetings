import {
  Controller,
  Get,
  HttpStatus,
  Param,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';

import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { MeetingUploaderAvatarService } from './services/meeting-uploader-avatar.service';

/**
 * Reads a `uploadedBy.handle` from the meeting-file representation, so one
 * uploader has one avatar URL per meeting however many files they uploaded.
 * The route is not under `files` for that reason: its subject is the uploader
 * within the meeting, not a single file.
 */
@Controller('meetings/:meetingId/uploaders')
@UseGuards(JwtAuthGuard)
export class MeetingUploadersController {
  constructor(private readonly uploaderAvatars: MeetingUploaderAvatarService) {}

  @Get(':uploaderHandle/avatar')
  async getAvatar(
    @Param('meetingId') meetingId: string,
    @Param('uploaderHandle') uploaderHandle: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile | undefined> {
    const version = await this.uploaderAvatars.describe(
      meetingId,
      uploaderHandle,
      request.user.sub,
    );

    response.set({
      // The response body depends on the meeting, not on the caller, but the
      // permission to read it does; `Vary` keeps any cache that ignores
      // `private` from handing it to a caller outside the meeting.
      'Cache-Control': 'private, must-revalidate',
      ETag: version.etag,
      'Referrer-Policy': 'no-referrer',
      Vary: 'Authorization',
      'X-Content-Type-Options': 'nosniff',
    });

    if (matchesEntityTag(request.headers['if-none-match'], version.etag)) {
      response.status(HttpStatus.NOT_MODIFIED);

      return undefined;
    }

    const avatar = await this.uploaderAvatars.open(version.uploaderId);

    response.set({
      'Content-Length': String(avatar.sizeBytes),
      'Content-Type': avatar.mimeType,
    });

    return new StreamableFile(avatar.stream);
  }
}

function matchesEntityTag(header: string | undefined, etag: string): boolean {
  if (!header) {
    return false;
  }
  if (header.trim() === '*') {
    return true;
  }

  return header
    .split(',')
    .map((candidate) => candidate.trim().replace(/^W\//, ''))
    .includes(etag);
}
