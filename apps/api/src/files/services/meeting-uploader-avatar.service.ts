import { Injectable, NotFoundException } from '@nestjs/common';
import { MeetingFileStatus } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { AvatarContent, UserAvatarService } from '../../profile/user-avatar.service';
import { deriveUserHandle } from '../../users/models/user-identity.response';
import { MeetingAccessService } from './meeting-access.service';

export type UploaderAvatarVersion = { uploaderId: string; etag: string };

/**
 * Serves the avatar of an uploader named by the meeting-scoped handle that the
 * meeting-file representation carries. Access is the meeting's own: the caller
 * reaches an avatar only through a meeting they own or take part in, and only
 * for someone who has a ready file there, so the rest of that uploader's
 * profile stays private and no user identifier ever appears in the URL. The
 * user record is read on every request, so a replaced avatar is served, a
 * removed one is gone, and the entity tag follows the current version.
 */
@Injectable()
export class MeetingUploaderAvatarService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly meetingAccess: MeetingAccessService,
    private readonly userAvatars: UserAvatarService,
  ) {}

  /**
   * Resolves the handle and the avatar's current version without opening the
   * object, so a revalidated request costs no file access.
   */
  async describe(
    meetingId: string,
    uploaderHandle: string,
    userId: string,
  ): Promise<UploaderAvatarVersion> {
    await this.meetingAccess.requireAccess(meetingId, userId);

    const uploaders = await this.prisma.meetingFile.findMany({
      where: { meetingId, status: MeetingFileStatus.READY, uploadedById: { not: null } },
      distinct: ['uploadedById'],
      select: {
        uploadedById: true,
        uploadedBy: {
          select: { id: true, avatarMimeType: true, avatarSizeBytes: true, avatarUpdatedAt: true },
        },
      },
    });

    const uploader = uploaders
      .map((file) => file.uploadedBy)
      .find(
        (candidate) => candidate && deriveUserHandle(meetingId, candidate.id) === uploaderHandle,
      );

    // An unknown handle and an uploader without an avatar answer alike: the
    // caller may already list every uploader of the meeting, and neither
    // distinction tells them anything they could act on.
    if (
      !uploader ||
      !uploader.avatarMimeType ||
      uploader.avatarSizeBytes === null ||
      !uploader.avatarUpdatedAt
    ) {
      throw new NotFoundException('Avatar not found');
    }

    return {
      uploaderId: uploader.id,
      etag: `"${uploader.avatarUpdatedAt.getTime().toString(36)}"`,
    };
  }

  open(uploaderId: string): Promise<AvatarContent> {
    return this.userAvatars.open(uploaderId);
  }
}
