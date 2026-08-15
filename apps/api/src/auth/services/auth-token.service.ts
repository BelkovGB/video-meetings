import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';

import { AuthSessionService } from './auth-session.service';

export const accessTokenLifetimeSeconds = 60 * 60;
export const accessTokenLifetimeMs = accessTokenLifetimeSeconds * 1000;

@Injectable()
export class AuthTokenService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly authSessionService: AuthSessionService,
  ) {}

  async issue(userId: string, email: string, transaction?: Prisma.TransactionClient) {
    const expiresAt = new Date(Date.now() + accessTokenLifetimeMs + 1_000);
    const session = await this.authSessionService.create(userId, expiresAt, transaction);
    const accessToken = await this.jwtService.signAsync({ sub: userId, email, sid: session.id });

    return { accessToken };
  }
}
