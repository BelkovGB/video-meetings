import { AuthSessionService } from '../src/auth/services/auth-session.service';

describe('AuthSessionService', () => {
  it('stores the expiry selected for a newly issued token', async () => {
    const expiresAt = new Date('2026-08-15T13:00:01.000Z');
    const prisma = {
      authSession: {
        create: jest.fn().mockResolvedValue({ id: 'new-session' }),
      },
    };
    const service = new AuthSessionService(prisma as never);

    await service.create('user-1', expiresAt);

    expect(prisma.authSession.create).toHaveBeenCalledWith({
      data: { userId: 'user-1', expiresAt },
      select: { id: true },
    });
  });

  it('removes expired and revoked sessions in bounded batches without deleting active sessions', async () => {
    const now = new Date('2026-08-15T12:00:00.000Z');
    const prisma = {
      authSession: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'expired-session' }, { id: 'revoked-session' }]),
        deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    };
    const service = new AuthSessionService(prisma as never);

    await service.pruneExpiredAndRevoked(now);

    expect(prisma.authSession.findMany).toHaveBeenCalledWith({
      where: {
        OR: [{ expiresAt: { lte: now } }, { revokedAt: { not: null } }],
      },
      select: { id: true },
      take: 100,
    });
    expect(prisma.authSession.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['expired-session', 'revoked-session'] } },
    });
  });

  it('only treats an unrevoked, unexpired session as active', async () => {
    const now = new Date('2026-08-15T12:00:00.000Z');
    const prisma = {
      authSession: {
        findFirst: jest.fn().mockResolvedValue({ id: 'active-session' }),
      },
    };
    const service = new AuthSessionService(prisma as never);

    await expect(service.isActive('active-session', 'user-1', now)).resolves.toBe(true);

    expect(prisma.authSession.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'active-session',
        userId: 'user-1',
        revokedAt: null,
        expiresAt: { gt: now },
      },
      select: { id: true },
    });
  });
});
