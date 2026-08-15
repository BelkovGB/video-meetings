import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  PayloadTooLargeException,
} from '@nestjs/common';
import { Response } from 'express';

@Catch(BadRequestException, PayloadTooLargeException)
export class AvatarUploadExceptionFilter implements ExceptionFilter {
  catch(exception: BadRequestException | PayloadTooLargeException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const statusCode = exception.getStatus();
    const exceptionResponse = exception.getResponse();

    if (typeof exceptionResponse === 'object' && 'code' in exceptionResponse) {
      response.status(statusCode).json({ statusCode, ...exceptionResponse });
      return;
    }

    const tooLarge = statusCode === 413;
    response.status(statusCode).json({
      statusCode,
      message: tooLarge ? 'Avatar is too large' : 'Invalid avatar upload',
      code: tooLarge ? 'AVATAR_TOO_LARGE' : 'INVALID_AVATAR_UPLOAD',
    });
  }
}
