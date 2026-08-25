import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { environment } from './config/environment';
import { configureHttpApplication } from './http-application';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  configureHttpApplication(app);

  // Said out loud at every boot, because the cost of the flag is invisible
  // otherwise: it is the one setting under which a password change stops
  // ending the sessions the user believes it ends.
  if (environment.acceptLegacyJwtWithoutSession) {
    new Logger('Bootstrap').warn(
      'ACCEPT_LEGACY_JWT_WITHOUT_SESSION is on: tokens without a session are accepted ' +
        'and cannot be revoked by a logout or a password change. Turn it off once the ' +
        'last pre-session token has expired.',
    );
  }

  await app.listen(process.env.PORT ?? 3001);
}

void bootstrap();
