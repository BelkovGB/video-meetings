import { Injectable, NotFoundException } from '@nestjs/common';
import { ReadStream } from 'node:fs';

import { PrismaService } from '../prisma/prisma.service';
import { LocalAvatarStorageService } from './local-avatar-storage.service';

export type AvatarContent = {
  mimeType: string;
  sizeBytes: number;
  stream: ReadStream;
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
  ) {}

  async open(userId: string): Promise<AvatarContent> {
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

    try {
      return {
        mimeType: user.avatarMimeType,
        sizeBytes: user.avatarSizeBytes,
        stream: await this.avatars.open(user.avatarStorageKey),
        updatedAt: user.avatarUpdatedAt,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new NotFoundException('Avatar not found');
      }
      throw error;
    }
  }
}
