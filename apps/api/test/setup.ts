import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config } from 'dotenv';

config({ path: join(__dirname, '../../../.env') });

const uploadRoot = join(tmpdir(), 'video-meetings-api-e2e-uploads');
const avatarRoot = join(tmpdir(), 'video-meetings-api-e2e-avatars');

process.env.UPLOAD_DIR = join(uploadRoot, 'files');
process.env.UPLOAD_TEMP_DIR = join(uploadRoot, 'temp');
process.env.UPLOAD_MAX_BYTES = '64';
process.env.UPLOAD_MIN_FREE_BYTES = '0';
process.env.UPLOAD_MAX_ACTIVE_UPLOADS = '4';
process.env.UPLOAD_RECONCILIATION_GRACE_MS = '86400000';
process.env.AVATAR_DIR = join(avatarRoot, 'files');
process.env.AVATAR_TEMP_DIR = join(avatarRoot, 'temp');
process.env.AVATAR_MAX_BYTES = '1024';
