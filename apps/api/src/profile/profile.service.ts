import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';

import { PrismaService } from '../prisma/prisma.service';
import { ChangePasswordDto } from './dto/change-password.dto';
import { AvatarListVariantService } from './avatar-list-variant.service';
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
    private readonly listVariants: AvatarListVariantService,
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
      throw new BadRequestException({
        message: 'Password confirmation does not match',
        code: 'PASSWORD_CONFIRMATION_MISMATCH',
      });
    }

    const normalizedCurrentPassword = currentPassword.normalize('NFC');
    const normalizedNewPassword = newPassword.normalize('NFC');

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
      if (!(await bcrypt.compare(normalizedCurrentPassword, user.passwordHash))) {
        throw new BadRequestException({
          message: 'Current password is incorrect',
          code: 'CURRENT_PASSWORD_INCORRECT',
        });
      }
      if (await bcrypt.compare(normalizedNewPassword, user.passwordHash)) {
        throw new BadRequestException({
          message: 'New password must differ from the current password',
          code: 'NEW_PASSWORD_NOT_DIFFERENT',
        });
      }

      const passwordHash = await bcrypt.hash(normalizedNewPassword, 12);
      await transaction.user.update({ where: { id: userId }, data: { passwordHash } });
      // The caller session is checked before the sweep below, which cannot tell
      // it apart from the others it revokes: a request carrying an unknown or
      // already revoked session must be answered `401` with nothing changed,
      // not treated as a licence to sign the account out everywhere.
      const callerSession = await transaction.authSession.findFirst({
        where: { id: sessionId, userId, revokedAt: null },
        select: { id: true },
      });
      if (!callerSession) {
        throw new UnauthorizedException();
      }

      // Every session dies, not just the caller's. A password is normally
      // changed because the old one or a token minted with it is suspected
      // stolen, and this app has no reset flow and no "sign out everywhere",
      // so leaving the other sessions alive would leave the user no way to
      // evict a thief.
      await transaction.authSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
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
      // The list variant is derived here, where the picture is decoded once per
      // upload anyway, so that reading it stays a plain file open instead of a
      // buffer-and-decode inside every first request.
      await this.listVariants.prepare(storageKey, avatar.mimeType);
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
