import { join } from 'node:path';
import { config } from 'dotenv';

import { avatarUploadRoot, uploadRoot } from './support/storage-roots';

config({ path: join(__dirname, '../../../.env') });

process.env.UPLOAD_DIR = join(uploadRoot, 'files');
process.env.UPLOAD_TEMP_DIR = join(uploadRoot, 'temp');
process.env.UPLOAD_MAX_BYTES = '64';
process.env.UPLOAD_MIN_FREE_BYTES = '0';
process.env.UPLOAD_MAX_ACTIVE_UPLOADS = '4';
process.env.UPLOAD_RECONCILIATION_GRACE_MS = '86400000';
process.env.AVATAR_DIR = join(avatarUploadRoot, 'files');
process.env.AVATAR_TEMP_DIR = join(avatarUploadRoot, 'temp');
process.env.AVATAR_MAX_BYTES = '1024';
