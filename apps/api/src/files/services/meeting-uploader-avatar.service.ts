import { Injectable, NotFoundException } from '@nestjs/common';
import { MeetingFileStatus } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { AvatarContent, UserAvatarService } from '../../profile/user-avatar.service';
import { deriveUserHandle } from '../../users/models/user-identity.response';
import { MeetingAccessService } from './meeting-access.service';

export type UploaderAvatarVersion = { uploaderId: string; etag: string };
export type UploaderAvatarContent = AvatarContent & { etag: string };

/**
 * The recorded version is the only thing that changes when an avatar is
 * replaced, so the entity tag is derived from it — and from the same read that
 * produced the rest of the answer, never from a second lookup that could see a
 * different version.
 */
function deriveAvatarEntityTag(updatedAt: Date): string {
  return `"${updatedAt.getTime().toString(36)}"`;
}

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

    // A keyed hash cannot be inverted into an `uploadedById` predicate, so the
    // handle is matched against the meeting's uploaders instead. `groupBy` keeps
    // that to one row per uploader, and the `(meetingId, status, uploadedById)`
    // index covers every column the query touches, so the scan stays inside the
    // index rather than reading each ready file row.
    const uploaders = await this.prisma.meetingFile.groupBy({
      by: ['uploadedById'],
      where: { meetingId, status: MeetingFileStatus.READY, uploadedById: { not: null } },
    });

    const uploaderId = uploaders
      .map((group) => group.uploadedById)
      .find(
        (candidate) =>
          candidate !== null && deriveUserHandle(meetingId, candidate) === uploaderHandle,
      );

    const uploader = uploaderId
      ? await this.prisma.user.findUnique({
          where: { id: uploaderId },
          select: { id: true, avatarMimeType: true, avatarSizeBytes: true, avatarUpdatedAt: true },
        })
      : null;

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
      etag: deriveAvatarEntityTag(uploader.avatarUpdatedAt),
    };
  }

  /**
   * Carries its own entity tag rather than reusing `describe`'s: the uploader
   * may replace their avatar between the two calls, and a body published under
   * the version read before it would be a validator that does not describe it —
   * a client would revalidate the stored entry and keep serving the replaced
   * image as the current one.
   */
  async open(uploaderId: string): Promise<UploaderAvatarContent> {
    const avatar = await this.userAvatars.open(uploaderId);

    return { ...avatar, etag: deriveAvatarEntityTag(avatar.updatedAt) };
  }
}
