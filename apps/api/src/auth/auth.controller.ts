import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';

import { LoginUserCommand } from './commands/login-user.command';
import { RegisterUserCommand } from './commands/register-user.command';
import { AuthCredentialsDto } from './dto/auth-credentials.dto';
import { RegisterCredentialsDto } from './dto/register-credentials.dto';
import { AuthRateLimitGuard } from './guards/auth-rate-limit.guard';

@Controller('auth')
@UseGuards(AuthRateLimitGuard)
export class AuthController {
  constructor(private readonly commandBus: CommandBus) {}

  @Post('register')
  register(@Body() credentials: RegisterCredentialsDto) {
    return this.commandBus.execute(
      new RegisterUserCommand(credentials.email, credentials.password),
    );
  }

  @Post('login')
  @HttpCode(200)
  login(@Body() credentials: AuthCredentialsDto) {
    return this.commandBus.execute(new LoginUserCommand(credentials.email, credentials.password));
  }
}
