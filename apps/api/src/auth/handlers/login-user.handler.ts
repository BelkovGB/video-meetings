import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';

import { PrismaService } from '../../prisma/prisma.service';
import { USERS_SECURITY_PORT, UsersSecurityPort } from '../../users/security/users-security.port';
import { LoginUserCommand } from '../commands/login-user.command';
import { AuthTokenService } from '../services/auth-token.service';

@CommandHandler(LoginUserCommand)
@Injectable()
export class LoginUserHandler implements ICommandHandler<LoginUserCommand> {
  constructor(
    @Inject(USERS_SECURITY_PORT) private readonly usersSecurity: UsersSecurityPort,
    private readonly authTokenService: AuthTokenService,
    private readonly prisma: PrismaService,
  ) {}

  async execute({ email, password }: LoginUserCommand) {
    const user = await this.usersSecurity.findByEmail(email);

    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }

    return this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${user.id}, 0))`,
      );
      const lockedUser = await transaction.user.findUnique({
        where: { id: user.id },
        select: { id: true, email: true, passwordHash: true },
      });

      if (!lockedUser || !(await bcrypt.compare(password, lockedUser.passwordHash))) {
        throw new UnauthorizedException('Invalid email or password');
      }

      return this.authTokenService.issue(lockedUser.id, lockedUser.email, transaction);
    });
  }
}
