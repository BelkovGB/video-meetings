import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class AuthSessionService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string) {
    return this.prisma.authSession.create({
      data: { userId },
      select: { id: true },
    });
  }

  async isActive(sessionId: string, userId: string): Promise<boolean> {
    const session = await this.prisma.authSession.findFirst({
      where: { id: sessionId, userId, revokedAt: null },
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
}
