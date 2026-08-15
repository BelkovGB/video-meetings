import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ProfileController } from './profile.controller';
import { ProfileService } from './profile.service';
import { AvatarValidationService } from './avatar-validation.service';
import { LocalAvatarStorageService } from './local-avatar-storage.service';
import { PasswordChangeRateLimitGuard } from './password-change-rate-limit.guard';

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [ProfileController],
  providers: [
    ProfileService,
    AvatarValidationService,
    LocalAvatarStorageService,
    PasswordChangeRateLimitGuard,
  ],
})
export class ProfileModule {}
