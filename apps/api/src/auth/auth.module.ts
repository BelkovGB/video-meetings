import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { JwtModule } from '@nestjs/jwt';

import { environment } from '../config/environment';
import { PrismaModule } from '../prisma/prisma.module';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthRateLimitGuard } from './guards/auth-rate-limit.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { LoginUserHandler } from './handlers/login-user.handler';
import { RegisterUserHandler } from './handlers/register-user.handler';
import { AuthTokenService } from './services/auth-token.service';
import { AuthRateLimiterService } from './services/auth-rate-limiter.service';
import { AuthSessionService } from './services/auth-session.service';

const commandHandlers = [RegisterUserHandler, LoginUserHandler];

@Module({
  imports: [
    UsersModule,
    PrismaModule,
    CqrsModule,
    JwtModule.register({
      secret: environment.jwtSecret,
      signOptions: { expiresIn: '1h' },
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthTokenService,
    AuthSessionService,
    AuthRateLimiterService,
    AuthRateLimitGuard,
    JwtAuthGuard,
    ...commandHandlers,
  ],
  exports: [JwtModule, JwtAuthGuard, AuthSessionService],
})
export class AuthModule {}
