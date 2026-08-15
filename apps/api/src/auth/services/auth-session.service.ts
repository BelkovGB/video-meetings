import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';

const cleanupIntervalMs = 60_000;
const cleanupBatchSize = 100;

@Injectable()
export class AuthSessionService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AuthSessionService.name);
  private cleanupTimer: NodeJS.Timeout | undefined;
  private cleanupRunning = false;

  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.pruneExpiredAndRevoked();
    this.cleanupTimer = setInterval(() => {
      void this.pruneExpiredAndRevoked().catch((error: unknown) => {
        this.logger.error(
          'Failed to prune expired authentication sessions',
          error instanceof Error ? error.stack : undefined,
        );
      });
    }, cleanupIntervalMs);
    this.cleanupTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
  }

  async create(userId: string, expiresAt: Date, transaction?: Prisma.TransactionClient) {
    return (transaction ?? this.prisma).authSession.create({
      data: { userId, expiresAt },
      select: { id: true },
    });
  }

  async isActive(sessionId: string, userId: string, now = new Date()): Promise<boolean> {
    const session = await this.prisma.authSession.findFirst({
      where: { id: sessionId, userId, revokedAt: null, expiresAt: { gt: now } },
      select: { id: true },
    });

    return session !== null;
  }

  async revoke(sessionId: string, userId: string) {
    return this.prisma.authSession.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async pruneExpiredAndRevoked(now = new Date()): Promise<void> {
    if (this.cleanupRunning) {
      return;
    }

    this.cleanupRunning = true;
    try {
      while (true) {
        const sessions = await this.prisma.authSession.findMany({
          where: {
            OR: [{ expiresAt: { lte: now } }, { revokedAt: { not: null } }],
          },
          select: { id: true },
          take: cleanupBatchSize,
        });

        if (sessions.length === 0) {
          break;
        }

        await this.prisma.authSession.deleteMany({
          where: { id: { in: sessions.map((session) => session.id) } },
        });
      }
    } finally {
      this.cleanupRunning = false;
    }
  }
}
