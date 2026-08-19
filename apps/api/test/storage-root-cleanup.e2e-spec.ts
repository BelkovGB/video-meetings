import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import globalTeardown from './global-teardown';
import { removeStorageRoots, teardownStorageSuite } from './support/storage-cleanup';
import {
  assertStorageDirectoriesAreEmpty,
  findStorageLeftovers,
} from './support/storage-leftovers';
import { avatarDirectory, storageDirectories } from './support/storage-roots';

// Missing storage cleanup is guarded after every suite (test/setup-after-env.ts)
// and once more after the run (test/global-teardown.ts). These tests pin the
// detector both call, the assertion that acts on its findings, and the
// suite-teardown helper the writing suites use.
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

  // Pinning the tmp folder names would not catch the failure that matters: a
  // watched set that drifts from what the application under test writes to
  // reports "no leftovers" forever without any test failing.
  it('watches exactly the storage directories the application is configured with', () => {
    expect(storageDirectories).toEqual([
      process.env.UPLOAD_DIR,
      process.env.UPLOAD_TEMP_DIR,
      process.env.AVATAR_DIR,
      process.env.AVATAR_TEMP_DIR,
    ]);
    expect(new Set(storageDirectories).size).toBe(4);
  });
});

describe('assertStorageDirectoriesAreEmpty', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'storage-assert-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('resolves when every directory is empty or absent', async () => {
    const present = join(root, 'files');
    await mkdir(present);

    await expect(
      assertStorageDirectoriesAreEmpty([present, join(root, 'missing')], 'a suite'),
    ).resolves.toBeUndefined();
  });

  it('fails naming the leftovers and the source that produced them', async () => {
    const directory = join(root, 'files');
    await mkdir(directory);
    await writeFile(join(directory, 'stored'), 'stored');

    await expect(
      assertStorageDirectoriesAreEmpty([directory], 'files.e2e-spec.ts'),
    ).rejects.toThrow(/files\.e2e-spec\.ts[\s\S]*stored/);
  });

  // A filtered invocation runs neither of the suites that clear a root, so
  // reporting without clearing would make it fail on content it never wrote.
  it('clears the leftovers it reports, so the next invocation does not inherit them', async () => {
    const directory = join(root, 'files');
    await mkdir(join(directory, 'user-1'), { recursive: true });
    await writeFile(join(directory, 'user-1', 'content'), 'avatar');

    await expect(assertStorageDirectoriesAreEmpty([directory], 'a suite')).rejects.toThrow();

    await expect(findStorageLeftovers([directory])).resolves.toEqual([]);
    await expect(assertStorageDirectoriesAreEmpty([directory], 'a suite')).resolves.toBeUndefined();
  });

  it('names stale content from an earlier interrupted run as a possibility', async () => {
    const directory = join(root, 'files');
    await mkdir(directory);
    await writeFile(join(directory, 'stored'), 'stored');

    await expect(assertStorageDirectoriesAreEmpty([directory], 'a suite')).rejects.toThrow(
      /earlier interrupted run/,
    );
  });
});

// The teardown owns both the decision to fail and the directory list it checks.
// Inverting either keeps every other test here green while disabling the guard.
describe('global teardown', () => {
  it('fails on content left in a directory the application is configured with', async () => {
    await mkdir(avatarDirectory, { recursive: true });
    const leftover = join(avatarDirectory, 'global-teardown-leftover');

    try {
      await writeFile(leftover, 'avatar');

      await expect(globalTeardown()).rejects.toThrow(/global-teardown-leftover/);
    } finally {
      await rm(leftover, { force: true });
    }
  });

  it('resolves once the storage directories are empty again', async () => {
    await expect(globalTeardown()).resolves.toBeUndefined();
  });
});

// `rm` rejects a path holding a NUL byte with ERR_INVALID_ARG_VALUE, which
// `force: true` does not swallow: a stand-in for the EBUSY/EPERM a still-open
// handle under the root produces on Windows.
const unremovableRoot = `unremovable${String.fromCharCode(0)}root`;

describe('removeStorageRoots', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'storage-remove-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('removes every root it is given', async () => {
    const first = join(root, 'uploads');
    const second = join(root, 'avatars');
    await mkdir(join(first, 'files'), { recursive: true });
    await mkdir(join(second, 'files'), { recursive: true });

    await removeStorageRoots([first, second]);

    await expect(readdir(root)).resolves.toEqual([]);
  });

  // The avatar root is the one this guard exists to protect, so a rejecting
  // removal of the upload root must not be what keeps it in place. `force: true`
  // swallows only a missing path, so the failing root here is one whose removal
  // rejects the way an EBUSY/EPERM on a still-open handle would.
  it('still removes the other roots when one of them fails', async () => {
    const removable = join(root, 'avatars');
    await mkdir(join(removable, 'files'), { recursive: true });

    await expect(removeStorageRoots([unremovableRoot, removable])).rejects.toThrow();

    await expect(readdir(root)).resolves.toEqual([]);
  });
});

describe('teardownStorageSuite', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'storage-teardown-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('closes, clears and restores in order', async () => {
    const calls: string[] = [];
    await mkdir(join(root, 'files'), { recursive: true });

    await teardownStorageSuite({
      close: async () => {
        calls.push('close');
      },
      storageRoots: [join(root, 'files')],
      restoreEnvironment: () => calls.push('restore'),
    });

    expect(calls).toEqual(['close', 'restore']);
    await expect(readdir(root)).resolves.toEqual([]);
  });

  it('clears the roots and restores the environment when the close fails', async () => {
    await mkdir(join(root, 'files', 'user-1'), { recursive: true });
    const restoreEnvironment = jest.fn();

    await expect(
      teardownStorageSuite({
        close: () => Promise.reject(new Error('close failed')),
        storageRoots: [join(root, 'files')],
        restoreEnvironment,
      }),
    ).rejects.toThrow('close failed');

    expect(restoreEnvironment).toHaveBeenCalledTimes(1);
    await expect(readdir(root)).resolves.toEqual([]);
  });

  // A skipped restore leaks TRUSTED_PROXY_IPS into every later suite of the
  // in-band run, and a rejecting removal is most likely exactly when the close
  // already failed with handles still open under the root.
  it('restores the environment even when clearing a root fails', async () => {
    const restoreEnvironment = jest.fn();

    await expect(
      teardownStorageSuite({
        close: () => Promise.resolve(),
        storageRoots: [unremovableRoot],
        restoreEnvironment,
      }),
    ).rejects.toThrow();

    expect(restoreEnvironment).toHaveBeenCalledTimes(1);
  });
});
