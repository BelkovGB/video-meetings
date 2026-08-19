import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ProfileController } from './profile.controller';
import { ProfileService } from './profile.service';
import { AvatarListVariantService } from './avatar-list-variant.service';
import { AvatarValidationService } from './avatar-validation.service';
import { LocalAvatarStorageService } from './local-avatar-storage.service';
import { PasswordChangeRateLimitGuard } from './password-change-rate-limit.guard';
import { UserAvatarService } from './user-avatar.service';

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [ProfileController],
  providers: [
    ProfileService,
    AvatarListVariantService,
    AvatarValidationService,
    LocalAvatarStorageService,
    PasswordChangeRateLimitGuard,
    UserAvatarService,
  ],
  exports: [UserAvatarService],
})
export class ProfileModule {}
