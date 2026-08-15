import { AuthSessionService } from '../src/auth/services/auth-session.service';
import { PrismaService } from '../src/prisma/prisma.service';

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

  it('removes every expired and revoked session while retaining active sessions', async () => {
    const now = new Date('2026-08-15T12:00:00.000Z');
    const prisma = new PrismaService();
    await prisma.$connect();
    const user = await prisma.user.create({
      data: {
        email: `session-cleanup-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
        passwordHash: 'not-used-by-this-test',
      },
    });
    const activeSessionId = 'active-session';
    const expiredSessionCount = 125;
    const revokedSessionCount = 125;

    try {
      await prisma.authSession.createMany({
        data: [
          ...Array.from({ length: expiredSessionCount }, (_, index) => ({
            id: `expired-session-${index}`,
            userId: user.id,
            expiresAt: new Date(now.getTime() - 1),
          })),
          ...Array.from({ length: revokedSessionCount }, (_, index) => ({
            id: `revoked-session-${index}`,
            userId: user.id,
            expiresAt: new Date(now.getTime() + 60_000),
            revokedAt: new Date(now.getTime() - 1),
          })),
          {
            id: activeSessionId,
            userId: user.id,
            expiresAt: new Date(now.getTime() + 60_000),
          },
        ],
      });

      const service = new AuthSessionService(prisma);
      await service.pruneExpiredAndRevoked(now);

      await expect(
        prisma.authSession.findMany({
          where: { userId: user.id },
          select: { id: true },
        }),
      ).resolves.toEqual([{ id: activeSessionId }]);
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
      await prisma.$disconnect();
    }
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
