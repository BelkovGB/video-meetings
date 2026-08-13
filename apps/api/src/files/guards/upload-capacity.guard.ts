import {
  BadRequestException,
  CanActivate,
  ConflictException,
  ExecutionContext,
  Injectable,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Response } from 'express';

import { AuthenticatedRequest } from '../../auth/guards/jwt-auth.guard';
import { LocalMeetingFileStorageService } from '../services/local-meeting-file-storage.service';
import { uploadConfig } from '../upload.config';

type UploadRequest = AuthenticatedRequest & { uploadTempPath?: string };

@Injectable()
export class UploadCapacityGuard implements CanActivate {
  constructor(private readonly storage: LocalMeetingFileStorageService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<UploadRequest>();
    const contentLength = request.headers['content-length'];
    const requestBytes = this.parseContentLength(contentLength);

    if (requestBytes > uploadConfig.maxRequestBytes) {
      throw new PayloadTooLargeException({
        message: 'Upload request is too large',
        code: 'UPLOAD_TOO_LARGE',
      });
    }

    const reservation = await this.storage.reserveCapacity(requestBytes, request.user.sub);
    if (reservation === 'busy') {
      throw new ConflictException({
        message: 'Another upload is already in progress',
        code: 'UPLOAD_BUSY',
      });
    }

    if (!reservation) {
      throw new ServiceUnavailableException({
        message: 'File storage is unavailable',
        code: 'STORAGE_UNAVAILABLE',
      });
    }

    this.releaseWhenRequestCompletes(request, reservation);

    return true;
  }

  private releaseWhenRequestCompletes(request: UploadRequest, releaseCapacity: () => void) {
    const response = request.res as Response;
    const release = () => {
      releaseCapacity();
      if (request.uploadTempPath) {
        this.storage.untrackTemp(request.uploadTempPath);
        delete request.uploadTempPath;
      }
      request.off('aborted', release);
      request.off('error', release);
      response.off('finish', release);
      response.off('close', release);
    };

    request.once('aborted', release);
    request.once('error', release);
    response.once('finish', release);
    response.once('close', release);
  }

  private parseContentLength(contentLength: string | undefined): number {
    if (!contentLength) {
      throw new BadRequestException({
        message: 'Content-Length is required for uploads',
        code: 'CONTENT_LENGTH_REQUIRED',
      });
    }

    const value = Number(contentLength);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new BadRequestException({
        message: 'Invalid Content-Length for upload',
        code: 'INVALID_CONTENT_LENGTH',
      });
    }

    return value;
  }
}
