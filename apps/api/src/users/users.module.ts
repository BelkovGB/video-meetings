import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { USERS_SECURITY_PORT } from './security/users-security.port';
import { UsersService } from './services/users.service';

@Module({
  imports: [PrismaModule],
  providers: [
    UsersService,
    {
      provide: USERS_SECURITY_PORT,
      useExisting: UsersService,
    },
  ],
  exports: [USERS_SECURITY_PORT],
})
export class UsersModule {}
