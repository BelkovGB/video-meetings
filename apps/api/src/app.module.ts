import { Module, ValidationPipe } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';

import { AuthModule } from './auth/auth.module';
import { FilesModule } from './files/files.module';
import { MeetingsModule } from './meetings/meetings.module';
import { ProfileModule } from './profile/profile.module';
import { validationFailure } from './validation-failure';

@Module({
  imports: [AuthModule, MeetingsModule, FilesModule, ProfileModule],
  providers: [
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        exceptionFactory: validationFailure,
      }),
    },
  ],
})
export class AppModule {}
