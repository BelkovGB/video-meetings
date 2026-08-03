import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import * as bcrypt from 'bcrypt';

import { USERS_SECURITY_PORT, UsersSecurityPort } from '../../users/security/users-security.port';
import { RegisterUserCommand } from '../commands/register-user.command';
import { AuthTokenService } from '../services/auth-token.service';

@CommandHandler(RegisterUserCommand)
@Injectable()
export class RegisterUserHandler implements ICommandHandler<RegisterUserCommand> {
  constructor(
    @Inject(USERS_SECURITY_PORT) private readonly usersSecurity: UsersSecurityPort,
    private readonly authTokenService: AuthTokenService,
  ) {}

  async execute({ email, password }: RegisterUserCommand) {
    const existingUser = await this.usersSecurity.findByEmail(email);

    if (existingUser) {
      throw new ConflictException('A user with this email already exists');
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await this.usersSecurity.create({ email, passwordHash });

    if (!user) {
      throw new ConflictException('A user with this email already exists');
    }

    return this.authTokenService.issue(user.id, user.email);
  }
}
