import {
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Patch,
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

import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { avatarConfig } from './avatar.config';
import { AvatarUploadExceptionFilter } from './avatar-upload-exception.filter';
import { ProfileService } from './profile.service';

@Controller('users/me')
@UseGuards(JwtAuthGuard)
export class ProfileController {
  constructor(private readonly profileService: ProfileService) {}

  @Post('avatar')
  @UseFilters(AvatarUploadExceptionFilter)
  @UseInterceptors(
    FileInterceptor('avatar', {
      storage: diskStorage({
        destination: avatarConfig.tempDirectory,
        filename: (_request, _file, callback) => callback(null, `${randomUUID()}.part`),
      }),
      limits: { fileSize: avatarConfig.maxBytes + 1, files: 1, fields: 0, parts: 2 },
    }),
  )
  uploadAvatar(
    @Req() request: AuthenticatedRequest,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    return this.profileService.uploadAvatar(request.user.sub, file);
  }

  @Delete('avatar')
  removeCurrentAvatar(@Req() request: AuthenticatedRequest) {
    return this.profileService.removeCurrentAvatar(request.user.sub);
  }

  @Get('avatar')
  async getCurrentAvatar(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const avatar = await this.profileService.openCurrentAvatar(request.user.sub);
    response.status(HttpStatus.OK).set({
      'Cache-Control': 'private, no-store',
      'Content-Length': String(avatar.sizeBytes),
      'Content-Type': avatar.mimeType,
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    });
    return new StreamableFile(avatar.stream);
  }

  @Get()
  getCurrentProfile(@Req() request: AuthenticatedRequest) {
    return this.profileService.getCurrentProfile(request.user.sub);
  }

  @Patch()
  updateCurrentProfile(
    @Body() updateProfileDto: UpdateProfileDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.profileService.updateCurrentProfile(request.user.sub, updateProfileDto.displayName);
  }
}
