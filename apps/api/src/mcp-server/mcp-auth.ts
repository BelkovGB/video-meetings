import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { AccessTokenPayload } from '../auth/guards/jwt-auth.guard';
import { AuthSessionService } from '../auth/services/auth-session.service';

/**
 * Verifies the access token the MCP client was configured with — the same
 * token `POST /auth/login` returns — the same way `JwtAuthGuard` verifies it
 * for the HTTP API: signature and expiry, then that the session it names is
 * still active. Unlike the HTTP guard, there is no legacy sid-less token to
 * accept: this server is new, so every token it sees was issued with a
 * session. Returns the authenticated user's id.
 */
export async function verifyAccessToken(
  jwtService: JwtService,
  authSessionService: AuthSessionService,
  token: string,
): Promise<string> {
  let payload: AccessTokenPayload;

  try {
    payload = await jwtService.verifyAsync<AccessTokenPayload>(token);
  } catch {
    throw new UnauthorizedException('Invalid or expired access token.');
  }

  if (!payload.sub || !payload.sid) {
    throw new UnauthorizedException('Invalid or expired access token.');
  }

  if (!(await authSessionService.isActive(payload.sid, payload.sub))) {
    throw new UnauthorizedException('Invalid or expired access token.');
  }

  return payload.sub;
}
