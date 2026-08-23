import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AuthSessionService } from '../auth/services/auth-session.service';
import { accessTokenLifetimeSeconds } from '../auth/services/auth-token.service';
import { environment } from '../config/environment';
import { MeetingAccessService } from '../files/services/meeting-access.service';
import { PrismaModule } from '../prisma/prisma.module';

// PrismaModule for data access, JwtModule to verify the caller's access
// token. Provides AuthSessionService and MeetingAccessService directly
// instead of importing AuthModule/FilesModule: both only depend on
// PrismaService, and pulling in the full modules would also start their
// HTTP-only pieces (login/register handlers, the files controller) that this
// stdio subprocess never uses.
@Module({
  imports: [
    PrismaModule,
    JwtModule.register({
      secret: environment.jwtSecret,
      signOptions: { expiresIn: accessTokenLifetimeSeconds },
    }),
  ],
  providers: [AuthSessionService, MeetingAccessService],
})
export class McpServerModule {}
