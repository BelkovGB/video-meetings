import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  acquireRunLock,
  initializePersistentLog,
  rotatePersistentLog,
  isTransientFailure,
  readJsonFile,
  retryTransientOperation,
  writeJsonAtomic,
} from './ralph-runtime.mjs';

function withTemporaryDirectory(run) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ralph-runtime-test-'));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('retryTransientOperation повторяет временные ошибки и возвращает результат', () => {
  const attempts = [];
  const delays = [];
  const retries = [];

  const result = retryTransientOperation(
    (attempt) => {
      attempts.push(attempt);
      if (attempt === 1) {
        const error = new Error('connection reset by peer');
        error.code = 'ECONNRESET';
        throw error;
      }
      if (attempt === 2) throw new Error('GitHub returned HTTP 503');
      return 'ready';
    },
    {
      attempts: 4,
      baseDelayMs: 10,
      wait: (delay) => delays.push(delay),
      onRetry: (_error, attempt, delay) => retries.push({ attempt, delay }),
    },
  );

  assert.equal(result, 'ready');
  assert.deepEqual(attempts, [1, 2, 3]);
  assert.deepEqual(delays, [10, 20]);
  assert.deepEqual(retries, [
    { attempt: 1, delay: 10 },
    { attempt: 2, delay: 20 },
  ]);
  assert.equal(isTransientFailure({ code: 'RALPH_COMMAND_TIMEOUT' }), true);
  assert.equal(
    isTransientFailure({ stderr: 'Patch "https://api.github.com/issues/65": EOF' }),
    true,
  );
});

test('retryTransientOperation останавливается после исчерпания попыток', () => {
  const expected = new Error('secondary rate limit (429)');
  let operationCalls = 0;
  const delays = [];

  assert.throws(
    () =>
      retryTransientOperation(
        () => {
          operationCalls += 1;
          throw expected;
        },
        {
          attempts: 3,
          baseDelayMs: 5,
          wait: (delay) => delays.push(delay),
        },
      ),
    (error) => error === expected,
  );

  assert.equal(operationCalls, 3);
  assert.deepEqual(delays, [5, 10]);
});

test('retryTransientOperation не повторяет постоянную ошибку', () => {
  const expected = new Error('validation failed');
  let operationCalls = 0;
  let waitCalls = 0;

  assert.throws(
    () =>
      retryTransientOperation(
        () => {
          operationCalls += 1;
          throw expected;
        },
        {
          attempts: 5,
          wait: () => {
            waitCalls += 1;
          },
        },
      ),
    (error) => error === expected,
  );

  assert.equal(operationCalls, 1);
  assert.equal(waitCalls, 0);
  assert.equal(isTransientFailure(expected), false);
});

test('acquireRunLock не перехватывает lock живого процесса', () => {
  withTemporaryDirectory((directory) => {
    const lockPath = path.join(directory, 'run.lock');
    const existing = {
      pid: 1234,
      token: 'live-owner',
      startedAt: '2026-08-14T00:00:00.000Z',
    };
    writeFileSync(lockPath, `${JSON.stringify(existing)}\n`, 'utf8');

    assert.throws(
      () =>
        acquireRunLock(lockPath, {}, { isProcessAlive: () => true, pid: 5678, token: 'new-owner' }),
      /Ralph Loop уже запущен \(PID 1234/,
    );
    assert.deepEqual(JSON.parse(readFileSync(lockPath, 'utf8')), existing);
  });
});

test('acquireRunLock заменяет lock завершившегося процесса', () => {
  withTemporaryDirectory((directory) => {
    const lockPath = path.join(directory, 'run.lock');
    writeFileSync(lockPath, `${JSON.stringify({ pid: 1234, token: 'stale-owner' })}\n`, 'utf8');

    const release = acquireRunLock(
      lockPath,
      { mode: '--run' },
      { isProcessAlive: () => false, pid: 5678, token: 'new-owner' },
    );
    const current = JSON.parse(readFileSync(lockPath, 'utf8'));

    assert.equal(current.pid, 5678);
    assert.equal(current.token, 'new-owner');
    assert.equal(current.mode, '--run');
    assert.match(current.startedAt, /^\d{4}-\d{2}-\d{2}T/);

    release();
    assert.equal(existsSync(lockPath), false);
    release();
  });
});

test('release lock не удаляет lock с токеном нового владельца', () => {
  withTemporaryDirectory((directory) => {
    const lockPath = path.join(directory, 'run.lock');
    const release = acquireRunLock(
      lockPath,
      {},
      { isProcessAlive: () => false, pid: 1234, token: 'original-owner' },
    );
    const replacement = { pid: 5678, token: 'replacement-owner' };
    writeFileSync(lockPath, `${JSON.stringify(replacement)}\n`, 'utf8');

    release();

    assert.equal(existsSync(lockPath), true);
    assert.deepEqual(JSON.parse(readFileSync(lockPath, 'utf8')), replacement);
  });
});

test('acquireRunLock отклоняет повреждённый lock', () => {
  withTemporaryDirectory((directory) => {
    const lockPath = path.join(directory, 'run.lock');
    writeFileSync(lockPath, 'not-json\n', 'utf8');

    assert.throws(
      () => acquireRunLock(lockPath, {}, { isProcessAlive: () => false, token: 'new-owner' }),
      /Lock Ralph повреждён или ещё создаётся/,
    );
    assert.equal(readFileSync(lockPath, 'utf8'), 'not-json\n');
  });
});

test('writeJsonAtomic создаёт и атомарно обновляет JSON', () => {
  withTemporaryDirectory((directory) => {
    const filePath = path.join(directory, 'state', 'state.json');
    const fallback = { missing: true };

    assert.equal(readJsonFile(filePath, fallback), fallback);

    writeJsonAtomic(filePath, { count: 1, phase: 'started' });
    assert.deepEqual(readJsonFile(filePath), { count: 1, phase: 'started' });
    assert.match(readFileSync(filePath, 'utf8'), /\n$/);

    writeJsonAtomic(filePath, { count: 2, phase: 'complete' });
    assert.deepEqual(readJsonFile(filePath), { count: 2, phase: 'complete' });
    assert.deepEqual(readdirSync(path.dirname(filePath)), ['state.json']);
  });
});

test('initializePersistentLog отделяет журнал прогона и восстанавливает console', () => {
  withTemporaryDirectory((directory) => {
    const logPath = path.join(directory, 'run.log');
    const originalLog = console.log;
    const originalError = console.error;
    writeFileSync(logPath, 'previous run\n', 'utf8');

    let restore;
    try {
      restore = initializePersistentLog(logPath, { mode: '--run' });
      assert.notEqual(console.log, originalLog);
      assert.notEqual(console.error, originalError);
      console.log('iteration %d', 2);
      console.error('failure: %s', 'temporary');
    } finally {
      restore?.();
    }

    assert.equal(console.log, originalLog);
    assert.equal(console.error, originalError);

    const log = readFileSync(logPath, 'utf8');
    // Журнал прошлого прогона уезжает в архив, а не дописывается: иначе файл
    // растёт неограниченно и после падения его нечем открыть.
    assert.doesNotMatch(log, /previous run/);
    assert.match(log, /^\S+ INFO Ralph process started .*"mode":"--run"/);
    assert.match(log, /INFO iteration 2/);
    assert.match(log, /ERROR failure: temporary/);

    const archived = readdirSync(directory).filter((name) => /^run-.*\.log$/.test(name));
    assert.equal(archived.length, 1);
    assert.equal(readFileSync(path.join(directory, archived[0]), 'utf8'), 'previous run\n');
  });
});

test('every run starts a fresh run.log and keeps a bounded history', () => {
  withTemporaryDirectory((directory) => {
    const logPath = path.join(directory, 'run.log');

    // Восемь прогонов подряд: run.log должен содержать только последний, а
    // прошлые — лежать рядом в ограниченном количестве.
    for (let run = 1; run <= 8; run += 1) {
      const restore = initializePersistentLog(logPath, { mode: '--run', run });
      console.log(`marker for run ${run}`);
      restore();
    }

    const current = readFileSync(logPath, 'utf8');
    assert.match(current, /marker for run 8/);
    assert.doesNotMatch(current, /marker for run 7/);

    const archived = readdirSync(directory)
      .filter((name) => name.startsWith('run-') && name.endsWith('.log'))
      .sort();
    assert.equal(archived.length, 5);
    // Сохраняются именно последние: прогон 2 уже вытеснен, прогон 7 ещё здесь.
    const kept = archived.map((name) => readFileSync(path.join(directory, name), 'utf8')).join('');
    assert.match(kept, /marker for run 7/);
    assert.doesNotMatch(kept, /marker for run 2/);
  });
});

test('two rotations within the same millisecond keep both archives', () => {
  withTemporaryDirectory((directory) => {
    const logPath = path.join(directory, 'run.log');
    // Метка времени одна и та же для обеих ротаций: именно так вело себя
    // окружение контейнера, где восемь ротаций уложились в одну миллисекунду.
    // Раньше вторая ротация переименовывала поверх первой и уничтожала её.
    const stamp = '2026-08-16T13:45:51.316Z';

    writeFileSync(logPath, 'first run\n', 'utf8');
    rotatePersistentLog(logPath, stamp);
    writeFileSync(logPath, 'second run\n', 'utf8');
    rotatePersistentLog(logPath, stamp);

    const archived = readdirSync(directory)
      .filter((name) => /^run-.*\.log$/.test(name))
      .sort();
    assert.equal(archived.length, 2);
    assert.deepEqual(
      archived.map((name) => readFileSync(path.join(directory, name), 'utf8')).sort(),
      ['first run\n', 'second run\n'],
    );
  });
});
