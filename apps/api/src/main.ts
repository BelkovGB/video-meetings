import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { configureHttpApplication } from './http-application';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  configureHttpApplication(app);
  await app.listen(process.env.PORT ?? 3001);
}

void bootstrap();
