import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

import { AuthSessionService } from '../services/auth-session.service';

type AccessTokenPayload = {
  sub: string;
  email: string;
  sid: string;
};

export type AuthenticatedRequest = Request & {
  user: AccessTokenPayload;
};

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly authSessionService: AuthSessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.extractBearerToken(request);

    if (!token) {
      throw new UnauthorizedException();
    }

    try {
      const payload = await this.jwtService.verifyAsync<AccessTokenPayload>(token);

      if (!payload.sub || typeof payload.sid !== 'string' || !payload.sid) {
        throw new UnauthorizedException();
      }

      if (!(await this.authSessionService.isActive(payload.sid, payload.sub))) {
        throw new UnauthorizedException();
      }

      request.user = payload;
      return true;
    } catch {
      throw new UnauthorizedException();
    }
  }

  private extractBearerToken(request: Request): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];

    return type === 'Bearer' ? token : undefined;
  }
}
