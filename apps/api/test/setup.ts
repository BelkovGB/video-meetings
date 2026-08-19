import { join } from 'node:path';
import { config } from 'dotenv';

import {
  avatarDirectory,
  avatarTempDirectory,
  uploadDirectory,
  uploadTempDirectory,
} from './support/storage-roots';

config({ path: join(__dirname, '../../../.env') });

process.env.UPLOAD_DIR = uploadDirectory;
process.env.UPLOAD_TEMP_DIR = uploadTempDirectory;
process.env.UPLOAD_MAX_BYTES = '64';
process.env.UPLOAD_MIN_FREE_BYTES = '0';
process.env.UPLOAD_MAX_ACTIVE_UPLOADS = '4';
process.env.UPLOAD_RECONCILIATION_GRACE_MS = '86400000';
process.env.AVATAR_DIR = avatarDirectory;
process.env.AVATAR_TEMP_DIR = avatarTempDirectory;
process.env.AVATAR_MAX_BYTES = '1024';
