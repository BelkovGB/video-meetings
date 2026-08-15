import { config } from 'dotenv';
import { resolve } from 'node:path';

config({ path: resolve(__dirname, '../../../../.env') });

function getRequiredEnvironmentVariable(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function getBooleanEnvironmentVariable(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];

  if (value === undefined) {
    return defaultValue;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new Error(`${name} must be either true or false`);
}

export const environment = {
  jwtSecret: getRequiredEnvironmentVariable('JWT_SECRET'),
  acceptLegacyJwtWithoutSession: getBooleanEnvironmentVariable(
    'ACCEPT_LEGACY_JWT_WITHOUT_SESSION',
    true,
  ),
};
