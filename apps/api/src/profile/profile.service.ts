import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ReadStream } from 'node:fs';

import { PrismaService } from '../prisma/prisma.service';
import { AvatarMetadata, AvatarValidationService } from './avatar-validation.service';
import { LocalAvatarStorageService } from './local-avatar-storage.service';

const profileSelect = {
  id: true,
  email: true,
  displayName: true,
  avatarMimeType: true,
  avatarSizeBytes: true,
  avatarUpdatedAt: true,
} as const;

export type Profile = {
  id: string;
  email: string;
  displayName: string | null;
  avatar: (AvatarMetadata & { updatedAt: Date }) | null;
};

@Injectable()
export class ProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly avatars: LocalAvatarStorageService,
    private readonly avatarValidation: AvatarValidationService,
  ) {}

  async getCurrentProfile(userId: string): Promise<Profile> {
    const profile = await this.prisma.user.findUnique({
      where: { id: userId },
      select: profileSelect,
    });

    if (!profile) {
      throw new NotFoundException('User not found');
    }

    return this.toProfile(profile);
  }

  async updateCurrentProfile(userId: string, displayName: string): Promise<Profile> {
    await this.getCurrentProfile(userId);

    const profile = await this.prisma.user.update({
      where: { id: userId },
      data: { displayName },
      select: profileSelect,
    });
    return this.toProfile(profile);
  }

  async uploadAvatar(userId: string, file: Express.Multer.File | undefined) {
    try {
      const avatar = await this.avatarValidation.validate(file);
      const existing = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { avatarStorageKey: true },
      });
      if (!existing) {
        throw new NotFoundException('User not found');
      }

      const storageKey = randomUUID();
      await this.avatars.finalize(file!.path, storageKey);
      const updatedAt = new Date();
      try {
        await this.prisma.user.update({
          where: { id: userId },
          data: {
            avatarStorageKey: storageKey,
            avatarMimeType: avatar.mimeType,
            avatarSizeBytes: avatar.sizeBytes,
            avatarUpdatedAt: updatedAt,
          },
        });
      } catch (error) {
        await this.avatars.discard(storageKey);
        throw error;
      }
      await this.avatars.discard(existing.avatarStorageKey);
      return { ...avatar, updatedAt };
    } finally {
      if (file) {
        await this.avatars.discardTemp(file.path);
      }
    }
  }

  async openCurrentAvatar(
    userId: string,
  ): Promise<{ mimeType: string; sizeBytes: number; stream: ReadStream }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { avatarStorageKey: true, avatarMimeType: true, avatarSizeBytes: true },
    });
    if (!user?.avatarStorageKey || !user.avatarMimeType || user.avatarSizeBytes === null) {
      throw new NotFoundException('Avatar not found');
    }
    try {
      return {
        mimeType: user.avatarMimeType,
        sizeBytes: user.avatarSizeBytes,
        stream: await this.avatars.open(user.avatarStorageKey),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new NotFoundException('Avatar not found');
      }
      throw error;
    }
  }

  private toProfile(profile: {
    id: string;
    email: string;
    displayName: string | null;
    avatarMimeType: string | null;
    avatarSizeBytes: number | null;
    avatarUpdatedAt: Date | null;
  }): Profile {
    const avatar =
      profile.avatarMimeType && profile.avatarSizeBytes !== null && profile.avatarUpdatedAt
        ? {
            mimeType: profile.avatarMimeType,
            sizeBytes: profile.avatarSizeBytes,
            updatedAt: profile.avatarUpdatedAt,
          }
        : null;
    return { id: profile.id, email: profile.email, displayName: profile.displayName, avatar };
  }
}
