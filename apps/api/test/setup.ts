import { join } from 'node:path';
import { tmpdir } from 'node:os';

const uploadRoot = join(tmpdir(), 'video-meetings-api-e2e-uploads');

process.env.UPLOAD_DIR = join(uploadRoot, 'files');
process.env.UPLOAD_TEMP_DIR = join(uploadRoot, 'temp');
process.env.UPLOAD_MAX_BYTES = '64';
process.env.UPLOAD_MIN_FREE_BYTES = '0';
process.env.UPLOAD_MAX_ACTIVE_UPLOADS = '4';
process.env.UPLOAD_RECONCILIATION_GRACE_MS = '86400000';
