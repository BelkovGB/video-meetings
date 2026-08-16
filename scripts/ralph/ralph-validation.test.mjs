import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createTrustedValidationDependencySnapshot,
  ensureValidationImage,
  failedValidationScript,
  hasValidationAttestation,
  loadConfig,
  readValidationAttestations,
  recordValidationAttestation,
  run,
  runConfiguredScripts,
  summarizeCommandFailure,
  validationAttestationKey,
  validationImageForSnapshot,
} from './ralph-loop.mjs';
import {
  ralphConfigPath,
  trustedControlFileHashes,
  withPatchedRalphConfig,
} from './ralph-test-support.mjs';

test('validation image provisions the configured database from a pinned Dockerfile', () => {
  const dockerfile = readFileSync(new URL('./Dockerfile.validation', import.meta.url), 'utf8');
  const entrypoint = readFileSync(
    new URL('./ralph-validation-entrypoint.sh', import.meta.url),
    'utf8',
  );

  assert.match(dockerfile, /COPY apps\/api\/prisma apps\/api\/prisma/);
  assert.match(dockerfile, /apt-get install --yes --no-install-recommends git postgresql/);
  assert.match(dockerfile, /--mount=type=cache,target=\/root\/\.npm,sharing=locked/);
  assert.match(dockerfile, /fetch-retries 5/);
  assert.match(dockerfile, /until npm ci; do/);
  assert.match(dockerfile, /npm run prisma:generate --workspace @video-meetings\/api/);
  assert.match(
    dockerfile,
    /RUN --network=none cp \.env\.example \.env[\s\S]+npm run prisma:generate --workspace @video-meetings\/api[\s\S]+\/usr\/local\/bin\/ralph-validation db:migrate/,
  );
  assert.match(entrypoint, /cp -R \/opt\/ralph-dependencies\/node_modules \/workspace\//);
  assert.match(entrypoint, /git init --quiet/);
  assert.match(entrypoint, /git commit --quiet --message "validation snapshot"/);
  assert.match(entrypoint, /CI=1 npm run "\$script"/);
  assert.doesNotMatch(entrypoint, /npm ci/);
  assert.match(entrypoint, /unix_socket_directories=\/tmp/);
  assert.match(entrypoint, /cat "\$PGLOG" >&2/);
  assert.match(entrypoint, /CREATE ROLE video_meetings LOGIN/);
  assert.match(entrypoint, /CREATE DATABASE video_meetings OWNER video_meetings/);
});

test('validation dependency image is built from committed inputs, not the mutable workspace', () => {
  const lockfilePath = new URL('../../package-lock.json', import.meta.url);
  const originalLockfile = readFileSync(lockfilePath, 'utf8');
  let snapshot;

  try {
    writeFileSync(lockfilePath, '{"name":"attacker-controlled-lockfile"}\n', 'utf8');
    snapshot = createTrustedValidationDependencySnapshot();
    const committedLockfile = run('git', ['show', 'HEAD:package-lock.json']).stdout;
    assert.equal(readFileSync(path.join(snapshot, 'package-lock.json'), 'utf8'), committedLockfile);
    assert.equal(existsSync(path.join(snapshot, 'apps', 'api', 'prisma', 'schema.prisma')), true);
  } finally {
    if (snapshot) rmSync(snapshot, { recursive: true, force: true });
    writeFileSync(lockfilePath, originalLockfile, 'utf8');
  }
});

test('validation image cache is invalidated when trusted dependency inputs change', () => {
  const firstSnapshot = mkdtempSync(path.join(tmpdir(), 'ralph-validation-lock-first-'));
  const secondSnapshot = mkdtempSync(path.join(tmpdir(), 'ralph-validation-lock-second-'));
  const config = { validationContainer: { image: 'ralph-validation:test' } };

  try {
    writeFileSync(path.join(firstSnapshot, 'package-lock.json'), '{"lockfileVersion":3}\n');
    writeFileSync(path.join(secondSnapshot, 'package-lock.json'), '{"lockfileVersion":3}\n');
    writeFileSync(path.join(firstSnapshot, 'schema.prisma'), 'model First {}\n');
    writeFileSync(path.join(secondSnapshot, 'schema.prisma'), 'model Second {}\n');

    const firstImage = validationImageForSnapshot(config, firstSnapshot);
    const secondImage = validationImageForSnapshot(config, secondSnapshot);

    assert.match(firstImage, /^ralph-validation:test-inputs-[a-f0-9]{16}$/);
    assert.notEqual(firstImage, secondImage);
  } finally {
    rmSync(firstSnapshot, { recursive: true, force: true });
    rmSync(secondSnapshot, { recursive: true, force: true });
  }
});

test('validation image cache hit returns the existing image without rebuilding it', () => {
  const snapshot = mkdtempSync(path.join(tmpdir(), 'ralph-validation-cache-hit-'));
  const config = { validationContainer: { image: 'ralph-validation:test' } };
  const calls = [];

  try {
    writeFileSync(snapshot + path.sep + 'package-lock.json', '{"lockfileVersion":3}\n');
    const expectedImage = validationImageForSnapshot(config, snapshot);
    const image = ensureValidationImage(config, snapshot, {
      run: (command, args) => {
        calls.push([command, args]);
        assert.deepEqual(args, ['image', 'inspect', expectedImage]);
        return { status: 0, stdout: '' };
      },
    });

    assert.equal(image, expectedImage);
    assert.deepEqual(calls, [['docker', ['image', 'inspect', expectedImage]]]);
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
});

test('validation image build takes package.json from HEAD and ignores injected lifecycle hooks', () => {
  const packagePath = new URL('../../package.json', import.meta.url);
  const dockerfilePath = new URL('./Dockerfile.validation', import.meta.url);
  const originalPackage = readFileSync(packagePath, 'utf8');
  const directory = mkdtempSync(path.join(tmpdir(), 'ralph-validation-frozen-inputs-'));
  const lifecycleMarkerPath = path.join(directory, 'lifecycle-ran');
  let snapshot;

  try {
    const packageJson = JSON.parse(originalPackage);
    packageJson.scripts = {
      ...packageJson.scripts,
      postinstall: `write ${lifecycleMarkerPath}`,
    };
    writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
    snapshot = createTrustedValidationDependencySnapshot();

    const image = ensureValidationImage(
      {
        runtime: { validationTimeoutMs: 5_000 },
        validationContainer: {
          image: `ralph-validation:frozen-${Date.now()}`,
          dockerfilePath: fileURLToPath(dockerfilePath),
        },
      },
      snapshot,
      {
        run: (command, args) => {
          assert.equal(command, 'docker');
          if (args[0] === 'image') return { status: 1, stdout: '' };

          assert.equal(args[0], 'build');
          assert.equal(args[args.indexOf('--file') + 1], fileURLToPath(dockerfilePath));
          const buildPackage = JSON.parse(
            readFileSync(path.join(snapshot, 'package.json'), 'utf8'),
          );
          if (buildPackage.scripts?.postinstall?.includes(lifecycleMarkerPath)) {
            writeFileSync(lifecycleMarkerPath, 'ran', 'utf8');
          }
          return { status: 0, stdout: '' };
        },
      },
    );

    assert.match(image, /^ralph-validation:frozen-[0-9]+-inputs-[a-f0-9]{16}$/);
    assert.equal(existsSync(lifecycleMarkerPath), false);
  } finally {
    if (snapshot) rmSync(snapshot, { recursive: true, force: true });
    writeFileSync(packagePath, originalPackage, 'utf8');
    rmSync(directory, { recursive: true, force: true });
  }
});

test('validation orchestration builds from trusted inputs and never runs injected lifecycle hooks', () => {
  const trustedControlFileHashes = loadConfig().trustedControlFileHashes;
  const packagePath = new URL('../../package.json', import.meta.url);
  const originalPackage = readFileSync(packagePath, 'utf8');
  const directory = mkdtempSync(path.join(tmpdir(), 'ralph-validation-orchestration-'));
  const lifecycleMarkerPath = path.join(directory, 'lifecycle-ran');
  const calls = [];

  try {
    const packageJson = JSON.parse(originalPackage);
    packageJson.scripts = {
      ...packageJson.scripts,
      postinstall: `write ${lifecycleMarkerPath}`,
    };
    writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');

    runConfiguredScripts(
      {
        preflightScripts: [],
        runtime: { validationTimeoutMs: 5_000 },
        trustedControlFileHashes,
        validationContainer: {
          image: `ralph-validation:orchestration-${Date.now()}`,
          dockerfilePath: fileURLToPath(new URL('./Dockerfile.validation', import.meta.url)),
        },
      },
      ['test:ralph'],
      'Validation',
      {
        run: (command, args) => {
          calls.push([command, args]);
          if (args[0] === 'image') return { status: 1, stdout: '' };
          if (args[0] === 'build') {
            const buildPackage = JSON.parse(
              readFileSync(path.join(args.at(-1), 'package.json'), 'utf8'),
            );
            if (buildPackage.scripts?.postinstall?.includes(lifecycleMarkerPath)) {
              writeFileSync(lifecycleMarkerPath, 'ran', 'utf8');
            }
          }
          return { status: 0, stdout: '' };
        },
      },
    );

    assert.equal(existsSync(lifecycleMarkerPath), false);
    assert.equal(calls.filter(([, args]) => args[0] === 'build').length, 1);
    assert.equal(calls.filter(([, args]) => args[0] === 'run').length, 1);
  } finally {
    writeFileSync(packagePath, originalPackage, 'utf8');
    rmSync(directory, { recursive: true, force: true });
  }
});

// `npm run test:ralph` does not pay for a full repository copy per case.
function withStubbedValidationSnapshots(body) {
  const directory = mkdtempSync(path.join(tmpdir(), 'ralph-validation-stub-'));
  let created = 0;
  const factory = (kind) => () => {
    created += 1;
    const snapshotPath = path.join(directory, `${kind}-${created}`);
    mkdirSync(snapshotPath, { recursive: true });
    writeFileSync(path.join(snapshotPath, 'content'), kind, 'utf8');
    return snapshotPath;
  };
  try {
    return body({
      createWorkspaceSnapshot: factory('workspace'),
      createDependencySnapshot: factory('dependencies'),
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function validationConfig(overrides = {}) {
  return {
    preflightScripts: ['db:ready', 'db:migrate'],
    validationScripts: ['format:check', 'lint', 'build', 'test:ralph'],
    runtime: { validationTimeoutMs: 5_000, validationRunTimeoutMs: 9_000 },
    trustedControlFileHashes: trustedControlFileHashes(),
    validationContainer: {
      image: 'ralph-validation:single',
      dockerfilePath: fileURLToPath(new URL('./Dockerfile.validation', import.meta.url)),
    },
    ...overrides,
  };
}

test('a validation set runs in one container instead of one per script', () => {
  const calls = [];
  withStubbedValidationSnapshots((snapshots) =>
    runConfiguredScripts(
      validationConfig(),
      ['format:check', 'lint', 'build', 'test:ralph'],
      'Validation',
      {
        ...snapshots,
        run: (command, args, options) => {
          calls.push({ command, args, options });
          return { status: 0, stdout: '' };
        },
      },
    ),
  );

  const runs = calls.filter((call) => call.args[0] === 'run');
  assert.equal(runs.length, 1, 'exactly one docker run for the whole set');
  assert.deepEqual(
    runs[0].args.slice(-6),
    ['db:ready', 'db:migrate', 'format:check', 'lint', 'build', 'test:ralph'],
    'preflight precedes the validation scripts inside the same container',
  );
  assert.equal(runs[0].options.timeoutMs, 9_000, 'the run budget, not the per-command budget');
  assert.equal(
    calls.filter((call) => call.args[0] === 'build').length,
    0,
    'an existing image is not rebuilt',
  );
  // Image resolution and the digest probe happen once per run, not once per
  // script: four scripts must not produce four image inspections.
  assert.equal(calls.filter((call) => call.args[0] === 'image').length, 2);
});

test('preflight also collapses into a single container without the validation scripts', () => {
  const calls = [];
  withStubbedValidationSnapshots((snapshots) =>
    runConfiguredScripts(validationConfig(), ['db:ready', 'db:migrate'], 'Preflight', {
      ...snapshots,
      includePreflight: false,
      run: (command, args) => {
        calls.push(args);
        return { status: 0, stdout: '' };
      },
    }),
  );

  const runs = calls.filter((args) => args[0] === 'run');
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].slice(-2), ['db:ready', 'db:migrate']);
});

test('an empty script list still starts no container', () => {
  let started = false;
  runConfiguredScripts(validationConfig(), [], 'Validation', {
    run: () => {
      started = true;
      return { status: 0, stdout: '' };
    },
  });
  assert.equal(started, false);
});

test('the failing script is recovered from the entrypoint marker', () => {
  const output = [
    'RALPH_VALIDATION_SCRIPT=db:ready',
    'RALPH_VALIDATION_SCRIPT=db:migrate',
    'RALPH_VALIDATION_SCRIPT=format:check',
    'RALPH_VALIDATION_SCRIPT=lint',
    '',
    '/workspace/apps/web/app/page.tsx',
    "  12:3  error  'x' is not defined  no-undef",
  ].join(String.fromCharCode(10));

  assert.equal(failedValidationScript({ stdout: output, stderr: '' }), 'lint');
  assert.equal(failedValidationScript({ stdout: '', stderr: '' }), null);
});

test('a failed validation set reports the failing script, not the whole list', () => {
  const output = [
    'RALPH_VALIDATION_SCRIPT=db:ready',
    'RALPH_VALIDATION_SCRIPT=format:check',
    'RALPH_VALIDATION_SCRIPT=test:e2e:web',
    '  1) [chromium] > e2e/profile.spec.ts:42:5 > shows avatar',
  ].join(String.fromCharCode(10));

  assert.throws(
    () =>
      withStubbedValidationSnapshots((snapshots) =>
        runConfiguredScripts(validationConfig(), ['format:check', 'test:e2e:web'], 'Validation', {
          ...snapshots,
          run: (command, args) => {
            if (args[0] !== 'run') return { status: 0, stdout: '' };
            throw Object.assign(new Error('Команда docker run завершилась с кодом 1.'), {
              code: 'RALPH_COMMAND_FAILED',
              status: 1,
              stdout: output,
              stderr: '',
            });
          },
        }),
      ),
    (error) => {
      assert.equal(error.code, 'RALPH_VALIDATION_FAILED');
      assert.equal(error.script, 'test:e2e:web');
      assert.equal(summarizeCommandFailure(error).command, 'npm run test:e2e:web');
      return true;
    },
  );
});

test('a validation timeout keeps its own error code and names the whole set', () => {
  assert.throws(
    () =>
      withStubbedValidationSnapshots((snapshots) =>
        runConfiguredScripts(validationConfig(), ['format:check', 'lint'], 'Validation', {
          ...snapshots,
          run: (command, args) => {
            if (args[0] !== 'run') return { status: 0, stdout: '' };
            throw Object.assign(new Error('timeout'), { code: 'RALPH_COMMAND_TIMEOUT' });
          },
        }),
      ),
    (error) => {
      assert.equal(error.code, 'RALPH_COMMAND_TIMEOUT');
      assert.equal(error.script, 'db:ready, db:migrate, format:check, lint');
      return true;
    },
  );
});

test('the validation entrypoint prints a script marker and prepares the database once', () => {
  const entrypoint = readFileSync(
    fileURLToPath(new URL('./ralph-validation-entrypoint.sh', import.meta.url)),
    'utf8',
  );
  assert.match(entrypoint, /set -eu/);
  assert.match(entrypoint, /echo "RALPH_VALIDATION_SCRIPT=\$script"/);
  assert.ok(entrypoint.indexOf('initdb') < entrypoint.indexOf('for script in'));
  assert.equal((entrypoint.match(/initdb/g) ?? []).length, 1);
});

test('the per-run validation budget is validated and defaults when omitted', () => {
  const original = JSON.parse(readFileSync(ralphConfigPath, 'utf8'));
  assert.equal(original.runtime.validationRunTimeoutMs, 3_600_000);

  const { validationRunTimeoutMs, ...runtimeWithoutBudget } = original.runtime;
  withPatchedRalphConfig({ runtime: runtimeWithoutBudget }, (config) => {
    assert.equal(config.runtime.validationRunTimeoutMs, 3_600_000);
  });

  assert.throws(
    () =>
      withPatchedRalphConfig(
        { runtime: { ...original.runtime, validationRunTimeoutMs: 0 } },
        () => {
          throw new Error('loadConfig should have failed');
        },
      ),
    /Поле "runtime\.validationRunTimeoutMs" должно быть целым числом больше 0\./,
  );
});

// snapshots whose bytes they control directly.
function withAttestationHarness(body) {
  const directory = mkdtempSync(path.join(tmpdir(), 'ralph-attestations-'));
  const attestationsPath = path.join(directory, 'validation-attestations.json');
  const sources = { workspace: 'source v1', dependencies: 'lockfile v1' };
  let created = 0;

  const snapshotFactory = (kind) => () => {
    created += 1;
    const snapshotPath = path.join(directory, `${kind}-${created}`);
    mkdirSync(snapshotPath, { recursive: true });
    writeFileSync(path.join(snapshotPath, 'content'), sources[kind], 'utf8');
    return snapshotPath;
  };

  const dockerCalls = [];
  const validate = (scripts, overrides = {}) =>
    runConfiguredScripts(
      validationConfig(overrides.config),
      scripts,
      overrides.label ?? 'Validation',
      {
        attestationsPath,
        createWorkspaceSnapshot: snapshotFactory('workspace'),
        createDependencySnapshot: snapshotFactory('dependencies'),
        run:
          overrides.run ??
          ((command, args, options) => {
            dockerCalls.push({ command, args, options });
            if (args[0] === 'image') {
              return { status: 0, stdout: overrides.digest ?? `sha256:${'a'.repeat(64)}` };
            }
            return { status: 0, stdout: '' };
          }),
        ...(overrides.includePreflight === undefined
          ? {}
          : { includePreflight: overrides.includePreflight }),
      },
    );

  const containerRuns = () => dockerCalls.filter((call) => call.args[0] === 'run').length;

  try {
    return body({ attestationsPath, sources, validate, containerRuns, dockerCalls });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('an identical source, script list, and image reuse the recorded PASS', () => {
  withAttestationHarness(({ attestationsPath, validate, containerRuns }) => {
    validate(['format:check', 'lint']);
    assert.equal(containerRuns(), 1);
    assert.equal(readValidationAttestations(attestationsPath).length, 1);

    validate(['format:check', 'lint']);
    assert.equal(
      containerRuns(),
      1,
      'the second validation of an unchanged tree must not start a container',
    );
  });
});

test('a changed source byte invalidates the attestation', () => {
  withAttestationHarness(({ sources, validate, containerRuns }) => {
    validate(['format:check']);
    assert.equal(containerRuns(), 1);

    sources.workspace = 'source v2';
    validate(['format:check']);
    assert.equal(containerRuns(), 2, 'one changed byte must force a new run');
  });
});

test('changed dependencies, scripts, or image digest invalidate the attestation', () => {
  withAttestationHarness(({ sources, validate, containerRuns }) => {
    validate(['lint']);
    assert.equal(containerRuns(), 1);

    sources.dependencies = 'lockfile v2';
    validate(['lint']);
    assert.equal(containerRuns(), 2, 'a dependency change must force a new run');

    validate(['lint', 'build']);
    assert.equal(containerRuns(), 3, 'a longer script list must force a new run');

    validate(['lint'], { digest: `sha256:${'b'.repeat(64)}` });
    assert.equal(containerRuns(), 4, 'a rebuilt image under the same tag must force a new run');
  });
});

test('the preflight set and the validation set hold separate attestations', () => {
  withAttestationHarness(({ validate, containerRuns }) => {
    validate(['db:ready', 'db:migrate'], { includePreflight: false, label: 'Preflight' });
    assert.equal(containerRuns(), 1);

    validate(['lint']);
    assert.equal(containerRuns(), 2, 'preflight PASS must not satisfy the validation set');

    validate(['db:ready', 'db:migrate'], { includePreflight: false, label: 'Preflight' });
    assert.equal(containerRuns(), 2, 'the preflight set itself is still reused');
  });
});

test('a failed validation records no attestation', () => {
  withAttestationHarness(({ attestationsPath, validate }) => {
    assert.throws(() =>
      validate(['lint'], {
        run: (command, args) => {
          if (args[0] === 'image') return { status: 0, stdout: `sha256:${'c'.repeat(64)}` };
          throw Object.assign(new Error('failed'), { code: 'RALPH_COMMAND_FAILED', status: 1 });
        },
      }),
    );
    assert.deepEqual(readValidationAttestations(attestationsPath), []);
  });
});

test('an unresolvable image digest disables attestation instead of trusting a mutable tag', () => {
  withAttestationHarness(({ attestationsPath, validate, containerRuns }) => {
    validate(['lint'], { digest: '' });
    validate(['lint'], { digest: '' });

    assert.deepEqual(readValidationAttestations(attestationsPath), []);
    assert.equal(containerRuns(), 2, 'without a digest every validation must execute');
  });
});

test('a tampered trusted control file stops validation before it runs', () => {
  withAttestationHarness(({ validate }) => {
    const orchestratorPath = fileURLToPath(new URL('./ralph-loop.mjs', import.meta.url));
    const tamperedHashes = new Map(validationConfig().trustedControlFileHashes);
    assert.equal(tamperedHashes.has(orchestratorPath), true);
    tamperedHashes.set(orchestratorPath, 'not-the-real-hash');

    assert.throws(
      () => validate(['lint'], { config: { trustedControlFileHashes: tamperedHashes } }),
      /изменила доверенный файл/,
    );
  });
});

test('a changed AGENTS.md set also stops validation before it runs', () => {
  withAttestationHarness(({ validate }) => {
    assert.throws(
      () => validate(['lint'], { config: { trustedControlFileHashes: new Map() } }),
      /изменила набор доверенных файлов AGENTS\.md/,
    );
  });
});

test('the attestation store is bounded and keeps the newest entries', () => {
  withAttestationHarness(({ attestationsPath }) => {
    for (let index = 0; index < 40; index += 1) {
      recordValidationAttestation(`key-${index}`, { label: 'Validation' }, attestationsPath);
    }
    const entries = readValidationAttestations(attestationsPath);
    assert.equal(entries.length, 32);
    assert.equal(entries[0].key, 'key-39');
    assert.equal(hasValidationAttestation('key-0', attestationsPath), false);
    assert.equal(hasValidationAttestation('key-39', attestationsPath), true);
  });
});

test('the attestation key covers every declared input', () => {
  const inputs = {
    workspaceHash: 'w',
    dependencyHash: 'd',
    imageDigest: 'i',
    scripts: ['lint', 'build'],
  };
  const base = validationAttestationKey(inputs);

  for (const changed of [
    { ...inputs, workspaceHash: 'w2' },
    { ...inputs, dependencyHash: 'd2' },
    { ...inputs, imageDigest: 'i2' },
    { ...inputs, scripts: ['build', 'lint'] },
    { ...inputs, scripts: ['lint'] },
  ]) {
    assert.notEqual(validationAttestationKey(changed), base);
  }
  assert.equal(validationAttestationKey({ ...inputs }), base);
});
