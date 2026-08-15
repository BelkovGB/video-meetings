import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { AuthSessionService } from './auth-session.service';

@Injectable()
export class AuthTokenService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly authSessionService: AuthSessionService,
  ) {}

  async issue(userId: string, email: string) {
    const session = await this.authSessionService.create(userId);
    const accessToken = await this.jwtService.signAsync({ sub: userId, email, sid: session.id });

    return { accessToken };
  }
}
