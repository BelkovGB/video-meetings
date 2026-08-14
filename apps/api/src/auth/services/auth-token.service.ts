import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class AuthTokenService {
  constructor(private readonly jwtService: JwtService) {}

  async issue(userId: string, email: string) {
    const accessToken = await this.jwtService.signAsync({ sub: userId, email });

    return { accessToken };
  }
}
