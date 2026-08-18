import { ExecutionContext, UnauthorizedException } from '@nestjs/common';

import { JwtAuthGuard } from '../src/auth/guards/jwt-auth.guard';

function contextWithToken(token: string): ExecutionContext {
  const request = { headers: { authorization: `Bearer ${token}` } };

  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('JwtAuthGuard', () => {
  it('rejects a token whose session was revoked', async () => {
    const jwtService = {
      verifyAsync: jest
        .fn()
        .mockResolvedValue({ sub: 'user-1', email: 'a@example.com', sid: 's-1' }),
    };
    const authSessionService = { isActive: jest.fn().mockResolvedValue(false) };
    const guard = new JwtAuthGuard(jwtService as never, authSessionService as never);

    await expect(guard.canActivate(contextWithToken('revoked'))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('surfaces a session lookup failure instead of signing the caller out', async () => {
    const jwtService = {
      verifyAsync: jest
        .fn()
        .mockResolvedValue({ sub: 'user-1', email: 'a@example.com', sid: 's-1' }),
    };
    const lookupFailure = new Error('Timed out fetching a new connection from the pool');
    const authSessionService = { isActive: jest.fn().mockRejectedValue(lookupFailure) };
    const guard = new JwtAuthGuard(jwtService as never, authSessionService as never);

    await expect(guard.canActivate(contextWithToken('valid'))).rejects.toBe(lookupFailure);
  });

  it('rejects a token that fails verification', async () => {
    const jwtService = { verifyAsync: jest.fn().mockRejectedValue(new Error('invalid signature')) };
    const authSessionService = { isActive: jest.fn() };
    const guard = new JwtAuthGuard(jwtService as never, authSessionService as never);

    await expect(guard.canActivate(contextWithToken('forged'))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(authSessionService.isActive).not.toHaveBeenCalled();
  });
});
