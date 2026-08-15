import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';
import { ReadStream } from 'node:fs';

import { PrismaService } from '../prisma/prisma.service';
import { ChangePasswordDto } from './dto/change-password.dto';
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

  async changePassword(
    userId: string,
    sessionId: string,
    { currentPassword, newPassword, confirmation }: ChangePasswordDto,
  ): Promise<void> {
    if (newPassword !== confirmation) {
      throw new BadRequestException('Password confirmation does not match');
    }

    await this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`,
      );
      const user = await transaction.user.findUnique({
        where: { id: userId },
        select: { passwordHash: true },
      });
      if (!user) {
        throw new NotFoundException('User not found');
      }
      if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
        throw new BadRequestException('Current password is incorrect');
      }
      if (await bcrypt.compare(newPassword, user.passwordHash)) {
        throw new BadRequestException('New password must differ from the current password');
      }

      const passwordHash = await bcrypt.hash(newPassword, 12);
      await transaction.user.update({ where: { id: userId }, data: { passwordHash } });
      const revokedSession = await transaction.authSession.updateMany({
        where: { id: sessionId, userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (revokedSession.count !== 1) {
        throw new UnauthorizedException();
      }
    });
  }

  async uploadAvatar(userId: string, file: Express.Multer.File | undefined) {
    try {
      const avatar = await this.avatarValidation.validate(file);

      return await this.retainAvatar(userId, file, avatar);
    } finally {
      if (file) {
        await this.avatars.discardTemp(file.path);
      }
    }
  }

  async removeCurrentAvatar(userId: string): Promise<Profile> {
    const { profile, storageKey } = await this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`,
      );
      const user = await transaction.user.findUnique({
        where: { id: userId },
        select: { avatarStorageKey: true },
      });
      if (!user) {
        throw new NotFoundException('User not found');
      }

      const profile = await transaction.user.update({
        where: { id: userId },
        data: {
          avatarStorageKey: null,
          avatarMimeType: null,
          avatarSizeBytes: null,
          avatarUpdatedAt: null,
        },
        select: profileSelect,
      });
      return { profile: this.toProfile(profile), storageKey: user.avatarStorageKey };
    });

    await this.discardSafely(storageKey);
    return profile;
  }

  private async retainAvatar(
    userId: string,
    file: Express.Multer.File | undefined,
    avatar: AvatarMetadata,
  ) {
    const storageKey = randomUUID();
    const updatedAt = new Date();
    let switched = false;
    let previousStorageKey: string | null = null;
    try {
      const existingStorageKey = await this.prisma.$transaction(async (transaction) => {
        await transaction.$executeRaw(
          Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`,
        );
        await transaction.$executeRaw(
          Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${storageKey}, 0))`,
        );
        const existing = await transaction.user.findUnique({
          where: { id: userId },
          select: { avatarStorageKey: true },
        });
        if (!existing) {
          throw new NotFoundException('User not found');
        }
        previousStorageKey = existing.avatarStorageKey;

        await transaction.avatarStorageReservation.create({ data: { storageKey } });
        await this.avatars.finalize(file!.path, storageKey);
        await transaction.user.update({
          where: { id: userId },
          data: {
            avatarStorageKey: storageKey,
            avatarMimeType: avatar.mimeType,
            avatarSizeBytes: avatar.sizeBytes,
            avatarUpdatedAt: updatedAt,
          },
        });
        await transaction.avatarStorageReservation.delete({ where: { storageKey } });
        return existing.avatarStorageKey;
      });
      switched = true;
      await this.discardSafely(existingStorageKey);
    } catch (error) {
      if (!switched) {
        const replacementIsActive = await this.isActiveAvatarStorageKey(userId, storageKey);
        if (replacementIsActive === true) {
          await this.discardSafely(previousStorageKey);
          return { ...avatar, updatedAt };
        }
        if (replacementIsActive === false) {
          await this.discardSafely(storageKey);
        }
      }
      throw error;
    }
    return { ...avatar, updatedAt };
  }

  private async discardSafely(storageKey: string | null): Promise<void> {
    await this.avatars.discardEventually(storageKey);
  }

  private async isActiveAvatarStorageKey(
    userId: string,
    storageKey: string,
  ): Promise<boolean | undefined> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { avatarStorageKey: true },
      });
      return user?.avatarStorageKey === storageKey;
    } catch {
      return undefined;
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
