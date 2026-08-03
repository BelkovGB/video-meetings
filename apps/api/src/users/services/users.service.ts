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
}
