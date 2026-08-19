import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { AvatarBytes, AvatarContent } from './avatar-content';
import { AvatarListVariantService } from './avatar-list-variant.service';
import { LocalAvatarStorageService } from './local-avatar-storage.service';

type StoredAvatar = {
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  updatedAt: Date;
};

/**
 * Opens the avatar a user has right now, without deciding who may read it: the
 * owner's own route and the shared meeting routes reach it after their own
 * authorization check, and only the bytes, their verified media type, and the
 * version they belong to leave here — never a storage key or any other profile
 * field. The version comes from the same row read as the storage key, so a
 * caller that labels the body with it names the bytes it actually streamed even
 * when the avatar is replaced around this call.
 */
@Injectable()
export class UserAvatarService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly avatars: LocalAvatarStorageService,
    private readonly listVariants: AvatarListVariantService,
  ) {}

  async open(userId: string): Promise<AvatarContent> {
    const stored = await this.requireStoredAvatar(userId);

    return this.readOrReportMissing(stored, async () => ({
      mimeType: stored.mimeType,
      sizeBytes: stored.sizeBytes,
      stream: await this.avatars.open(stored.storageKey),
    }));
  }

  /**
   * Opens the small variant a list of rows needs. The original stays untouched
   * on disk: only what the wire carries is reduced. The version is the stored
   * avatar's own, because that is what the variant was derived from — a client
   * revalidating it is asking about the picture, not about the size it was
   * served in.
   */
  async openListVariant(userId: string): Promise<AvatarContent> {
    const stored = await this.requireStoredAvatar(userId);

    return this.readOrReportMissing(stored, async () => this.listVariants.open(stored));
  }

  private async requireStoredAvatar(userId: string): Promise<StoredAvatar> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        avatarStorageKey: true,
        avatarMimeType: true,
        avatarSizeBytes: true,
        avatarUpdatedAt: true,
      },
    });
    if (
      !user?.avatarStorageKey ||
      !user.avatarMimeType ||
      user.avatarSizeBytes === null ||
      !user.avatarUpdatedAt
    ) {
      throw new NotFoundException('Avatar not found');
    }

    return {
      storageKey: user.avatarStorageKey,
      mimeType: user.avatarMimeType,
      sizeBytes: user.avatarSizeBytes,
      updatedAt: user.avatarUpdatedAt,
    };
  }

  private async readOrReportMissing(
    stored: StoredAvatar,
    read: () => Promise<AvatarBytes>,
  ): Promise<AvatarContent> {
    try {
      return { ...(await read()), updatedAt: stored.updatedAt };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new NotFoundException('Avatar not found');
      }
      throw error;
    }
  }
}
