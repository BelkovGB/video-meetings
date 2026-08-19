import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { AvatarContent } from './avatar-content';
import { AvatarListVariantService } from './avatar-list-variant.service';
import { LocalAvatarStorageService } from './local-avatar-storage.service';

type StoredAvatar = { storageKey: string; mimeType: string; sizeBytes: number };

/**
 * Opens the avatar a user has right now, without deciding who may read it: the
 * owner's own route and the shared meeting routes reach it after their own
 * authorization check, and only the bytes and their verified media type leave
 * here — never a storage key or any other profile field.
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

    return this.readOrReportMissing(async () => ({
      mimeType: stored.mimeType,
      sizeBytes: stored.sizeBytes,
      stream: await this.avatars.open(stored.storageKey),
    }));
  }

  /**
   * Opens the small variant a list of rows needs. The original stays untouched
   * on disk: only what the wire carries is reduced.
   */
  async openListVariant(userId: string): Promise<AvatarContent> {
    const stored = await this.requireStoredAvatar(userId);

    return this.readOrReportMissing(async () => this.listVariants.open(stored));
  }

  private async requireStoredAvatar(userId: string): Promise<StoredAvatar> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { avatarStorageKey: true, avatarMimeType: true, avatarSizeBytes: true },
    });
    if (!user?.avatarStorageKey || !user.avatarMimeType || user.avatarSizeBytes === null) {
      throw new NotFoundException('Avatar not found');
    }

    return {
      storageKey: user.avatarStorageKey,
      mimeType: user.avatarMimeType,
      sizeBytes: user.avatarSizeBytes,
    };
  }

  private async readOrReportMissing(read: () => Promise<AvatarContent>): Promise<AvatarContent> {
    try {
      return await read();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new NotFoundException('Avatar not found');
      }
      throw error;
    }
  }
}
