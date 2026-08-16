import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { format } from 'node:util';

function waitSync(milliseconds) {
  if (milliseconds <= 0) return;
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, milliseconds);
}

function isTransientFailure(error) {
  const text = [error?.message, error?.stderr, error?.stdout]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
  if (
    error?.code === 'RALPH_COMMAND_TIMEOUT' ||
    ['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ENETUNREACH'].includes(error?.code)
  ) {
    return true;
  }
  return /(?:\b408\b|\b429\b|\b500\b|\b502\b|\b503\b|\b504\b|timed?\s*out|connection reset|could not resolve host|temporary failure|tls handshake|secondary rate limit|\beof\b|remote end hung up)/i.test(
    text,
  );
}

function retryTransientOperation(operation, options = {}) {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 2_000;
  const wait = options.wait ?? waitSync;
  const transient = options.isTransient ?? isTransientFailure;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return operation(attempt);
    } catch (error) {
      lastError = error;
      if (!transient(error) || attempt === attempts) throw error;
      const delay = retryDelayMs(baseDelayMs, attempt);
      options.onRetry?.(error, attempt, delay);
      wait(delay);
    }
  }
  throw lastError;
}

export function retryDelayMs(baseDelayMs, attempt) {
  return Math.min(baseDelayMs * 2 ** (attempt - 1), 30_000);
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function acquireRunLock(lockPath, metadata = {}, dependencies = {}) {
  const alive = dependencies.isProcessAlive ?? isProcessAlive;
  const token = dependencies.token ?? randomUUID();
  const record = {
    ...metadata,
    pid: dependencies.pid ?? process.pid,
    token,
    startedAt: new Date().toISOString(),
  };

  mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor;
    let createdByCurrentProcess = false;
    try {
      descriptor = openSync(lockPath, 'wx');
      createdByCurrentProcess = true;
      writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
      closeSync(descriptor);
      descriptor = undefined;
      break;
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if (createdByCurrentProcess) {
        removeFileIfExists(lockPath);
      }
      if (error.code !== 'EEXIST') throw error;

      let existing;
      try {
        existing = JSON.parse(readFileSync(lockPath, 'utf8'));
      } catch {
        throw new Error(
          `Lock Ralph повреждён или ещё создаётся: ${lockPath}. Проверьте активные процессы и удалите файл вручную только если Ralph не запущен.`,
        );
      }
      if (alive(existing.pid)) {
        throw new Error(
          `Ralph Loop уже запущен (PID ${existing.pid}, с ${existing.startedAt ?? 'неизвестно'}).`,
          { cause: error },
        );
      }
      unlinkSync(lockPath);
    }
  }

  if (!existsSync(lockPath)) {
    throw new Error(`Не удалось создать lock Ralph: ${lockPath}`);
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      const current = JSON.parse(readFileSync(lockPath, 'utf8'));
      if (current.token === token) unlinkSync(lockPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  };
}

function initializePersistentLog(logPath, metadata = {}) {
  mkdirSync(path.dirname(logPath), { recursive: true });
  appendFileSync(
    logPath,
    `${new Date().toISOString()} INFO Ralph process started ${JSON.stringify({ pid: process.pid, ...metadata })}\n`,
    'utf8',
  );
  const original = { log: console.log, error: console.error };
  const append = (level, args) => {
    appendFileSync(
      logPath,
      `${new Date().toISOString()} ${level} ${format(...args).replaceAll('\u0000', '')}\n`,
      'utf8',
    );
  };
  console.log = (...args) => {
    original.log(...args);
    append('INFO', args);
  };
  console.error = (...args) => {
    original.error(...args);
    append('ERROR', args);
  };
  return () => {
    console.log = original.log;
    console.error = original.error;
  };
}

function readJsonFile(filePath, fallback = null) {
  if (!existsSync(filePath)) return fallback;
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function writeJsonAtomic(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    renameSync(temporaryPath, filePath);
  } catch (error) {
    removeFileIfExists(temporaryPath);
    throw error;
  }
}

function removeFileIfExists(filePath) {
  try {
    unlinkSync(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function commandTimeoutError(name, args, timeoutMs, result) {
  const error = new Error(
    `Команда ${name} ${args.join(' ')} превысила wall-clock timeout ${timeoutMs} ms.`,
  );
  error.code = 'RALPH_COMMAND_TIMEOUT';
  error.timeoutMs = timeoutMs;
  error.stdout = result.stdout?.trim() ?? '';
  error.stderr = result.stderr?.trim() ?? '';
  return error;
}

function terminateProcessTreeByPid(pid, force = false) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      timeout: 10_000,
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    try {
      process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
    } catch {
      // Процесс уже завершился.
    }
  }
}

export {
  acquireRunLock,
  commandTimeoutError,
  initializePersistentLog,
  isProcessAlive,
  isTransientFailure,
  readJsonFile,
  removeFileIfExists,
  retryTransientOperation,
  terminateProcessTreeByPid,
  waitSync,
  writeJsonAtomic,
};
