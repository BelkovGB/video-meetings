import { resolve } from 'node:path';

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

function readPositiveInteger(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

const avatarRoot = resolve(process.cwd(), 'var', 'avatars');

export const avatarConfig = {
  directory: resolve(process.env.AVATAR_DIR ?? resolve(avatarRoot, 'files')),
  tempDirectory: resolve(process.env.AVATAR_TEMP_DIR ?? resolve(avatarRoot, 'temp')),
  maxBytes: readPositiveInteger('AVATAR_MAX_BYTES', DEFAULT_MAX_BYTES),
};
