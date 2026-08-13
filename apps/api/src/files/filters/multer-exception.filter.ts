import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  PayloadTooLargeException,
} from '@nestjs/common';
import { Response } from 'express';

@Catch(BadRequestException, PayloadTooLargeException)
export class MulterExceptionFilter implements ExceptionFilter {
  catch(exception: BadRequestException | PayloadTooLargeException, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const statusCode = exception.getStatus();
    const exceptionResponse = exception.getResponse();

    if (typeof exceptionResponse === 'object' && 'code' in exceptionResponse) {
      response.status(statusCode).json({ statusCode, ...exceptionResponse });
      return;
    }

    const isTooLarge = statusCode === 413;

    response.status(statusCode).json({
      statusCode,
      message: isTooLarge ? 'Uploaded file is too large' : 'Invalid multipart upload',
      code: isTooLarge ? 'UPLOAD_TOO_LARGE' : 'INVALID_MULTIPART_UPLOAD',
    });
  }
}
