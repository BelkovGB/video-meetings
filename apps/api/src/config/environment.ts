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
  /**
   * Admits a signed token that carries no `sid`, from before session-aware
   * JWTs existed. Off unless a deployment asks for it: such a token has no
   * session row, so nothing revokes it — not a logout, not a password change
   * — and it keeps working until it expires. On by default that turned every
   * password change into a revocation the user only thought they had made,
   * and a forgotten variable on a fresh deployment reproduced it silently.
   * Turn it on deliberately, for at most one maximum JWT lifetime after the
   * rollout that started issuing `sid`.
   */
  acceptLegacyJwtWithoutSession: getBooleanEnvironmentVariable(
    'ACCEPT_LEGACY_JWT_WITHOUT_SESSION',
    false,
  ),
};
