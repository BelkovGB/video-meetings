import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';

import { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import {
  AuthRateLimiterService,
  RateLimitResult,
} from '../auth/services/auth-rate-limiter.service';

const clientLimit = { maximumRequests: 30, windowMs: 60_000 };
const accountLimit = { maximumRequests: 5, windowMs: 15 * 60_000 };

@Injectable()
export class PasswordChangeRateLimitGuard implements CanActivate {
  constructor(private readonly rateLimiter: AuthRateLimiterService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const response = context
      .switchToHttp()
      .getResponse<{ setHeader(name: string, value: number): void }>();
    const clientIp = request.ip ?? request.socket.remoteAddress ?? 'unknown';
    const scope = 'password-change';

    this.enforce(
      this.rateLimiter.consume(
        `${scope}:ip:${clientIp}`,
        clientLimit.maximumRequests,
        clientLimit.windowMs,
      ),
      response,
    );
    this.enforce(
      this.rateLimiter.consume(
        `${scope}:account:${request.user.sub}`,
        accountLimit.maximumRequests,
        accountLimit.windowMs,
      ),
      response,
    );

    return true;
  }

  private enforce(
    result: RateLimitResult,
    response: { setHeader(name: string, value: number): void },
  ) {
    if (!result.allowed) {
      response.setHeader('Retry-After', result.retryAfterSeconds);
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: 'Too many password-change attempts. Please try again later.',
          code: 'PASSWORD_CHANGE_RATE_LIMITED',
          retryAfterSeconds: result.retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}
