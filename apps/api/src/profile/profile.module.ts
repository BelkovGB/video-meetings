import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ProfileController } from './profile.controller';
import { ProfileService } from './profile.service';
import { AvatarValidationService } from './avatar-validation.service';
import { LocalAvatarStorageService } from './local-avatar-storage.service';

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [ProfileController],
  providers: [ProfileService, AvatarValidationService, LocalAvatarStorageService],
})
export class ProfileModule {}
