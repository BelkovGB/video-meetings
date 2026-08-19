import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import globalSetup from './global-setup';
import globalTeardown from './global-teardown';
import * as cleanup from './support/storage-cleanup';
import { removeStorageRoots, teardownStorageSuite } from './support/storage-cleanup';
import {
  assertStorageDirectoriesAreEmpty,
  findStorageLeftovers,
} from './support/storage-leftovers';
import {
  avatarDirectory,
  avatarUploadRoot,
  storageDirectories,
  uploadDirectory,
  uploadRoot,
} from './support/storage-roots';

// Missing storage cleanup is cleared before the run (test/global-setup.ts),
// guarded after every suite (test/setup-after-env.ts) and once more after the
// run (test/global-teardown.ts). These tests pin the detector all of them call,
// the assertion that acts on its findings, the suite-teardown helper the
// writing suites use, and the jest wiring that makes each of those files run at
// all — none of which any product spec would notice the absence of.
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

  // The swallow is right — the leftovers matter more than the removal — but a
  // message claiming a clearing that did not happen reads as an already handled
  // interrupted run while the identical failure repeats on every invocation.
  it('still fails, and says the content was not cleared, when the removal fails', async () => {
    const directory = join(root, 'files');
    await mkdir(directory);
    await writeFile(join(directory, 'stored'), 'stored');
    const removal = jest
      .spyOn(cleanup, 'removeStorageRoots')
      .mockRejectedValue(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }));

    try {
      const failure = assertStorageDirectoriesAreEmpty([directory], 'a suite');

      await expect(failure).rejects.toThrow(/could NOT be cleared/);
      await expect(failure).rejects.not.toThrow(/has been cleared/);
    } finally {
      removal.mockRestore();
    }

    await expect(findStorageLeftovers([directory])).resolves.toEqual([`${directory}: stored`]);
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

  // The removal fails *because* the close did: handles are still open under the
  // root. Reporting only the `rm` failure shows the symptom and hides the cause.
  it('reports the close failure alongside the removal failure when both fail', async () => {
    const restoreEnvironment = jest.fn();

    const failure = teardownStorageSuite({
      close: () => Promise.reject(new Error('close failed')),
      storageRoots: [unremovableRoot],
      restoreEnvironment,
    });

    await expect(failure).rejects.toBeInstanceOf(AggregateError);
    await expect(failure).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: 'close failed' }), expect.anything()],
    });
    expect(restoreEnvironment).toHaveBeenCalledTimes(1);
  });
});

// The guard only runs because jest is told to run it, and only stays safe
// because jest is told to serialize. Both live in a config file no spec would
// otherwise touch: deleting a line there silently disables the fix.
describe('e2e jest configuration', () => {
  async function readConfiguration(): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(join(__dirname, 'jest-e2e.json'), 'utf8')) as Record<
      string,
      unknown
    >;
  }

  it('registers the per-suite guard, the run-start clearing and the run-wide backstop', async () => {
    const configuration = await readConfiguration();

    expect(configuration.setupFilesAfterEnv).toEqual(['<rootDir>/test/setup-after-env.ts']);
    expect(configuration.globalSetup).toBe('<rootDir>/test/global-setup.ts');
    expect(configuration.globalTeardown).toBe('<rootDir>/test/global-teardown.ts');
  });

  // Without this the per-suite hook is destructive under jest's default worker
  // pool: a filtered run such as `jest --config ./test/jest-e2e.json profile`
  // matches two files, and one worker's afterAll would delete the avatar root
  // out from under the other worker's uploads. `--runInBand` in the npm script
  // does not reach an ad hoc invocation, so the config has to carry it.
  it('serializes suites, which the shared storage directories require', async () => {
    expect((await readConfiguration()).maxWorkers).toBe(1);
  });
});

describe('setup-after-env', () => {
  // Loaded in isolation with `afterAll` captured: nothing else in the run would
  // notice this hook being deleted or inverted, because a passing run is
  // exactly what a disabled guard produces.
  function loadRegisteredHooks(): Array<() => Promise<void>> {
    const hooks: Array<() => Promise<void>> = [];
    const register = jest
      .spyOn(global, 'afterAll')
      .mockImplementation((hook) => hooks.push(hook as () => Promise<void>) as unknown as void);

    try {
      jest.isolateModules(() => {
        require('./setup-after-env');
      });
    } finally {
      register.mockRestore();
    }

    return hooks;
  }

  it('registers exactly one root-level hook', () => {
    expect(loadRegisteredHooks()).toHaveLength(1);
  });

  it('rejects, naming the suite, on content left in a configured directory', async () => {
    const [hook] = loadRegisteredHooks();
    await mkdir(uploadDirectory, { recursive: true });
    await writeFile(join(uploadDirectory, 'setup-after-env-leftover'), 'stored');

    await expect(hook()).rejects.toThrow(
      /setup-after-env-leftover[\s\S]*storage-root-cleanup\.e2e-spec\.ts|storage-root-cleanup\.e2e-spec\.ts[\s\S]*setup-after-env-leftover/,
    );
  });

  it('resolves once the storage directories are empty again', async () => {
    const [hook] = loadRegisteredHooks();

    await expect(hook()).resolves.toBeUndefined();
  });
});

// Clearing only at the end of a suite leaves whatever an interrupted run left
// behind in place for every suite scheduled before the ones that own a root,
// and each of those starts pays a locked reconciliation transaction per stale
// directory. This runs once, before any suite boots.
describe('global setup', () => {
  it('clears content left in the storage roots by an earlier run', async () => {
    await mkdir(avatarDirectory, { recursive: true });
    await mkdir(uploadDirectory, { recursive: true });
    await writeFile(join(avatarDirectory, 'global-setup-leftover'), 'avatar');
    await writeFile(join(uploadDirectory, 'global-setup-leftover'), 'stored');

    await expect(globalSetup()).resolves.toBeUndefined();

    await expect(findStorageLeftovers(storageDirectories)).resolves.toEqual([]);
    await expect(readdir(avatarUploadRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('resolves when there is nothing to clear', async () => {
    await expect(globalSetup()).resolves.toBeUndefined();
  });

  // The clearing is an optimisation for a cost the per-suite guard already
  // self-heals: a root that survives costs one locked reconciliation
  // transaction per application start, and the guard clears it after the first
  // suite that observes it. Aborting the whole run before a single suite is
  // scheduled is strictly worse than that, and on Windows a handle held by an
  // indexer, an antivirus scan or a crashed earlier run is enough to reject a
  // removal that `maxRetries: 0` never retries.
  it('warns and lets the run proceed when a root cannot be removed', async () => {
    const removal = jest.spyOn(cleanup, 'removeStorageRoots').mockRejectedValue(
      Object.assign(new Error('EBUSY: resource busy or locked'), {
        code: 'EBUSY',
      }),
    );
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await expect(globalSetup()).resolves.toBeUndefined();

      expect(removal).toHaveBeenCalledWith([uploadRoot, avatarUploadRoot]);
      expect(warn).toHaveBeenCalledTimes(1);
      const [message] = warn.mock.calls[0] as [string];
      expect(message).toContain(uploadRoot);
      expect(message).toContain(avatarUploadRoot);
      expect(message).toContain('EBUSY');
    } finally {
      warn.mockRestore();
      removal.mockRestore();
    }
  });
});
