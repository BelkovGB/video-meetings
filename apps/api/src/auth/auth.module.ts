import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { JwtModule } from '@nestjs/jwt';

import { environment } from '../config/environment';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthRateLimitGuard } from './guards/auth-rate-limit.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { LoginUserHandler } from './handlers/login-user.handler';
import { RegisterUserHandler } from './handlers/register-user.handler';
import { AuthTokenService } from './services/auth-token.service';
import { AuthRateLimiterService } from './services/auth-rate-limiter.service';

const commandHandlers = [RegisterUserHandler, LoginUserHandler];

@Module({
  imports: [
    UsersModule,
    CqrsModule,
    JwtModule.register({
      secret: environment.jwtSecret,
      signOptions: { expiresIn: '1h' },
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthTokenService,
    AuthRateLimiterService,
    AuthRateLimitGuard,
    JwtAuthGuard,
    ...commandHandlers,
  ],
  exports: [JwtModule, JwtAuthGuard],
})
export class AuthModule {}
