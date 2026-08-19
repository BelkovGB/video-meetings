import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findStorageLeftovers } from './support/storage-leftovers';
import { storageDirectories } from './support/storage-roots';

// The run-wide guard is test/global-teardown.ts, which fails the run when a
// suite leaves content in a shared storage directory. These tests pin the
// detector it calls; the teardown itself only formats the failure.
describe('findStorageLeftovers', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'storage-leftovers-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reports nothing for a directory a suite removed entirely', async () => {
    await expect(findStorageLeftovers([join(root, 'missing')])).resolves.toEqual([]);
  });

  it('reports nothing for a directory the application recreated but left empty', async () => {
    const directory = join(root, 'files');
    await mkdir(directory);

    await expect(findStorageLeftovers([directory])).resolves.toEqual([]);
  });

  it('reports a stored file and the per-user directory holding it', async () => {
    const directory = join(root, 'files');
    await mkdir(join(directory, 'user-1'), { recursive: true });
    await writeFile(join(directory, 'user-1', 'content'), 'avatar');

    await expect(findStorageLeftovers([directory])).resolves.toEqual([
      `${directory}: user-1`,
      `${directory}: ${join('user-1', 'content')}`,
    ]);
  });

  it('reports an empty directory left behind, because reconciliation still visits it', async () => {
    const directory = join(root, 'files');
    await mkdir(join(directory, 'user-1'), { recursive: true });

    await expect(findStorageLeftovers([directory])).resolves.toEqual([`${directory}: user-1`]);
  });

  it('reports leftovers from every directory it is given', async () => {
    const first = join(root, 'files');
    const second = join(root, 'temp');
    await mkdir(first);
    await mkdir(second);
    await writeFile(join(first, 'stored'), 'stored');
    await writeFile(join(second, 'partial.part'), 'partial');

    await expect(findStorageLeftovers([first, second])).resolves.toEqual([
      `${first}: stored`,
      `${second}: partial.part`,
    ]);
  });

  it('propagates a failure that is not a missing directory', async () => {
    const file = join(root, 'not-a-directory');
    await writeFile(file, 'content');

    await expect(findStorageLeftovers([file])).rejects.toMatchObject({
      code: expect.stringMatching(/ENOTDIR|EINVAL/),
    });
  });

  it('watches both the meeting-file and the avatar storage directories', () => {
    expect(storageDirectories).toEqual([
      expect.stringContaining('video-meetings-api-e2e-uploads'),
      expect.stringContaining('video-meetings-api-e2e-uploads'),
      expect.stringContaining('video-meetings-api-e2e-avatars'),
      expect.stringContaining('video-meetings-api-e2e-avatars'),
    ]);
    expect(new Set(storageDirectories).size).toBe(4);
  });
});
