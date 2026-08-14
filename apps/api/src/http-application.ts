import { INestApplication } from '@nestjs/common';

const trustedProxyIpsEnvironmentVariable = 'TRUSTED_PROXY_IPS';

export function configureHttpApplication(app: INestApplication) {
  const trustedProxyIps = process.env[trustedProxyIpsEnvironmentVariable]
    ?.split(',')
    .map((address) => address.trim())
    .filter(Boolean);

  app
    .getHttpAdapter()
    .getInstance()
    .set('trust proxy', trustedProxyIps?.length ? trustedProxyIps : false);
  app.enableCors({
    origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000',
  });
}
