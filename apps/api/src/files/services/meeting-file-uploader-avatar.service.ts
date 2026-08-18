import { Injectable, NotFoundException } from '@nestjs/common';
import { MeetingFileStatus } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { AvatarContent, UserAvatarService } from '../../profile/user-avatar.service';
import { MeetingAccessService } from './meeting-access.service';

/**
 * Serves the avatar of the `uploadedBy` identity returned with a meeting file.
 * Access is the meeting's own: the caller reaches an avatar only through a file
 * of a meeting they own or take part in, never through a user identifier, so
 * the rest of the uploader's profile stays private. The user record is read on
 * every request, so a replaced avatar is served and a removed one is gone.
 */
@Injectable()
export class MeetingFileUploaderAvatarService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly meetingAccess: MeetingAccessService,
    private readonly userAvatars: UserAvatarService,
  ) {}

  async open(meetingId: string, fileId: string, userId: string): Promise<AvatarContent> {
    await this.meetingAccess.requireAccess(meetingId, userId);

    const file = await this.prisma.meetingFile.findFirst({
      where: { id: fileId, meetingId, status: MeetingFileStatus.READY },
      select: { uploadedById: true },
    });

    if (!file) {
      throw new NotFoundException('File not found');
    }

    if (!file.uploadedById) {
      throw new NotFoundException('Avatar not found');
    }

    return this.userAvatars.open(file.uploadedById);
  }
}
