import { join } from 'node:path';
import { tmpdir } from 'node:os';

// The e2e environment points meeting-file and avatar storage at these roots
// (see test/setup.ts). Suites that write to either one must remove it, so the
// paths live here instead of being re-derived in every spec.
export const uploadRoot = join(tmpdir(), 'video-meetings-api-e2e-uploads');
export const avatarUploadRoot = join(tmpdir(), 'video-meetings-api-e2e-avatars');
// The worker converts audio here. Deliberately outside uploadRoot: storage
// reconciliation deletes stale entries under the upload roots and cannot see a
// conversion another process still has open.
export const transcriptionWorkRoot = join(tmpdir(), 'video-meetings-api-e2e-transcription');

export const uploadDirectory = join(uploadRoot, 'files');
export const uploadTempDirectory = join(uploadRoot, 'temp');
export const avatarDirectory = join(avatarUploadRoot, 'files');
export const avatarTempDirectory = join(avatarUploadRoot, 'temp');

// Every application start recreates the four directories themselves, so only
// their contents may not survive a run: a stored file or a per-user directory
// left behind is what makes the next start pay a reconciliation transaction.
export const storageDirectories = [
  uploadDirectory,
  uploadTempDirectory,
  avatarDirectory,
  avatarTempDirectory,
];
