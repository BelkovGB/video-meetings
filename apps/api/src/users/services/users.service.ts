import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateSecurityUserInput,
  SecurityUser,
  UsersSecurityPort,
} from '../security/users-security.port';

@Injectable()
export class UsersService implements UsersSecurityPort {
  constructor(private readonly prisma: PrismaService) {}

  findByEmail(email: string): Promise<SecurityUser | null> {
    return this.prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        passwordHash: true,
      },
    });
  }

  async withLockedCredentialsByEmail<T>(
    email: string,
    callback: (user: SecurityUser, transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T | null> {
    const user = await this.findByEmail(email);
    if (!user) {
      return null;
    }

    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${user.id}, 0))`,
      );
      const lockedUser = await transaction.user.findUnique({
        where: { id: user.id },
        select: {
          id: true,
          email: true,
          passwordHash: true,
        },
      });
      if (!lockedUser) {
        return null;
      }

      return callback(lockedUser, transaction);
    });
  }

  async create({ email, passwordHash }: CreateSecurityUserInput): Promise<SecurityUser | null> {
    try {
      return await this.prisma.user.create({
        data: { email, passwordHash },
        select: {
          id: true,
          email: true,
          passwordHash: true,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return null;
      }

      throw error;
    }
  }

  async createWithTransaction<T>(
    { email, passwordHash }: CreateSecurityUserInput,
    callback: (user: SecurityUser, transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T | null> {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const user = await transaction.user.create({
          data: { email, passwordHash },
          select: {
            id: true,
            email: true,
            passwordHash: true,
          },
        });

        return callback(user, transaction);
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return null;
      }

      throw error;
    }
  }
}
