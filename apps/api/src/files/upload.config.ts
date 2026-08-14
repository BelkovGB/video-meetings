import { resolve } from 'node:path';

const DEFAULT_MAX_BYTES = 1_073_741_824;
const DEFAULT_MIN_FREE_BYTES = 2_147_483_648;
const DEFAULT_MAX_ACTIVE_UPLOADS = 4;
const DEFAULT_RECONCILIATION_GRACE_MS = 86_400_000;

function readPositiveInteger(name: string, fallback: number): number {
  const value = process.env[name];

  if (!value) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }

  return parsed;
}

const uploadRoot = resolve(process.cwd(), 'var', 'uploads');

export const uploadConfig = {
  directory: resolve(process.env.UPLOAD_DIR ?? uploadRoot),
  tempDirectory: resolve(process.env.UPLOAD_TEMP_DIR ?? resolve(uploadRoot, 'temp')),
  maxBytes: readPositiveInteger('UPLOAD_MAX_BYTES', DEFAULT_MAX_BYTES),
  minFreeBytes: readPositiveInteger('UPLOAD_MIN_FREE_BYTES', DEFAULT_MIN_FREE_BYTES),
  maxRequestBytes: readPositiveInteger('UPLOAD_MAX_REQUEST_BYTES', DEFAULT_MAX_BYTES + 1_048_576),
  maxActiveUploads: readPositiveInteger('UPLOAD_MAX_ACTIVE_UPLOADS', DEFAULT_MAX_ACTIVE_UPLOADS),
  reconciliationGraceMs: readPositiveInteger(
    'UPLOAD_RECONCILIATION_GRACE_MS',
    DEFAULT_RECONCILIATION_GRACE_MS,
  ),
};
