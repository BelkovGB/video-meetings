import { BadRequestException, HttpStatus, Module, ValidationPipe } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { ValidationError } from 'class-validator';

import { AuthModule } from './auth/auth.module';
import { FilesModule } from './files/files.module';
import { MeetingsModule } from './meetings/meetings.module';
import { ProfileModule } from './profile/profile.module';

/**
 * Names the rejected properties next to a stable `code`, so a client can route
 * a validation failure to its field without matching the English `message`.
 * Rewording a constraint message must not silently stop that routing.
 *
 * Every DTO here is flat; a nested one would need its child constraints
 * flattened the way Nest's own factory does.
 */
function validationFailure(errors: ValidationError[]): BadRequestException {
  return new BadRequestException({
    statusCode: HttpStatus.BAD_REQUEST,
    message: errors.flatMap((error) => Object.values(error.constraints ?? {})),
    error: 'Bad Request',
    code: 'VALIDATION_FAILED',
    fields: errors.map((error) => error.property),
  });
}

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
