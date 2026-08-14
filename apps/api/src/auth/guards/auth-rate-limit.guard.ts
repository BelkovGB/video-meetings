import { createHash } from 'node:crypto';

import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';

import { AuthRateLimiterService, RateLimitResult } from '../services/auth-rate-limiter.service';

const ipLimit = { maximumRequests: 30, windowMs: 60_000 };
const accountLimit = { maximumRequests: 5, windowMs: 15 * 60_000 };

@Injectable()
export class AuthRateLimitGuard implements CanActivate {
  constructor(private readonly rateLimiter: AuthRateLimiterService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context
      .switchToHttp()
      .getResponse<{ setHeader(name: string, value: number): void }>();
    const scope = 'auth';
    const clientIp = request.ip ?? request.socket.remoteAddress ?? 'unknown';

    this.enforce(
      this.rateLimiter.consume(
        `${scope}:ip:${clientIp}`,
        ipLimit.maximumRequests,
        ipLimit.windowMs,
      ),
      response,
    );

    const email = request.body?.email;

    if (typeof email === 'string' && email.trim()) {
      const accountKey = createHash('sha256').update(email.trim().toLowerCase()).digest('hex');

      this.enforce(
        this.rateLimiter.consume(
          `${scope}:account:${accountKey}`,
          accountLimit.maximumRequests,
          accountLimit.windowMs,
        ),
        response,
      );
    }

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
          message: 'Too many authentication attempts. Please try again later.',
          retryAfterSeconds: result.retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}
