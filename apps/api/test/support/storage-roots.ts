import { join } from 'node:path';
import { tmpdir } from 'node:os';

// The e2e environment points meeting-file and avatar storage at these roots
// (see test/setup.ts). Suites that write to either one must remove it, so the
// paths live here instead of being re-derived in every spec.
export const uploadRoot = join(tmpdir(), 'video-meetings-api-e2e-uploads');
export const avatarUploadRoot = join(tmpdir(), 'video-meetings-api-e2e-avatars');
