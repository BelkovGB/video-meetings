import { join } from 'node:path';
import { config } from 'dotenv';

import {
  avatarDirectory,
  avatarTempDirectory,
  transcriptionWorkRoot,
  uploadDirectory,
  uploadTempDirectory,
} from './support/storage-roots';
import { fixtureControlPath } from './support/transcription-fixtures';

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
// Both external programs are fixtures: the e2e recordings are a few bytes of
// header that no real ffmpeg decodes, and no run of this suite may need a GPU,
// a model or a download. Set here rather than in a hook because
// transcription.config.ts reads the environment when the module is imported.
//
// The control file follows the fixture path in both argument lists: a spec
// shapes a run by writing that file, which is the only channel it has to a
// spawned child (see support/transcription-fixtures.ts).
process.env.TRANSCRIPTION_COMMAND = process.execPath;
process.env.TRANSCRIPTION_COMMAND_ARGS = JSON.stringify([
  join(__dirname, 'support', 'fake-recognizer.cjs'),
  fixtureControlPath,
]);
process.env.TRANSCRIPTION_FFMPEG_PATH = process.execPath;
process.env.TRANSCRIPTION_FFMPEG_ARGS = JSON.stringify([
  join(__dirname, 'support', 'fake-ffmpeg.cjs'),
  fixtureControlPath,
]);
process.env.TRANSCRIPTION_WORK_DIR = transcriptionWorkRoot;
process.env.TRANSCRIPTION_POLL_INTERVAL_MS = '50';
