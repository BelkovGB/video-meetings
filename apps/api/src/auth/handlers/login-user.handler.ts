import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import * as bcrypt from 'bcrypt';

import { USERS_SECURITY_PORT, UsersSecurityPort } from '../../users/security/users-security.port';
import { LoginUserCommand } from '../commands/login-user.command';
import { AuthTokenService } from '../services/auth-token.service';

@CommandHandler(LoginUserCommand)
@Injectable()
export class LoginUserHandler implements ICommandHandler<LoginUserCommand> {
  constructor(
    @Inject(USERS_SECURITY_PORT) private readonly usersSecurity: UsersSecurityPort,
    private readonly authTokenService: AuthTokenService,
  ) {}

  async execute({ email, password }: LoginUserCommand) {
    const user = await this.usersSecurity.findByEmail(email);

    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid email or password');
    }

    return this.authTokenService.issue(user.id, user.email);
  }
}
