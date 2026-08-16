import { spawn } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { retryDelayMs, terminateProcessTreeByPid, waitSync } from './ralph-runtime.mjs';
import {
  commandSpec,
  credentialFreeEnvironment,
  run,
  runtimeSettings,
} from './ralph-process-runner.mjs';

/**
 * Сессия Codex CLI: изолированный CODEX_HOME, разбор JSONL-потока и лимит шагов.
 */

// Пути выводятся здесь заново по той же причине, что и в
// `ralph-process-runner.mjs`: импорт из модуля конфигурации создал бы цикл.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function codexAuthenticationFile(source = process.env) {
  const codexHome = source.CODEX_HOME?.trim();
  if (codexHome) return path.join(codexHome, 'auth.json');

  const userHome = source.USERPROFILE?.trim() || source.HOME?.trim();
  return userHome ? path.join(userHome, '.codex', 'auth.json') : null;
}

export function createSandboxedCodexEnvironment(source = process.env, options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'ralph-codex-'));
  const home = path.join(root, 'home');
  const temp = path.join(root, 'tmp');
  const config = path.join(root, 'config');
  const cache = path.join(root, 'cache');
  const codexHome = path.join(root, 'codex');
  mkdirSync(home, { recursive: true });
  mkdirSync(temp, { recursive: true });
  mkdirSync(config, { recursive: true });
  mkdirSync(cache, { recursive: true });
  mkdirSync(codexHome, { recursive: true });

  const authenticationFile =
    options.authenticationFile === undefined
      ? codexAuthenticationFile(source)
      : options.authenticationFile;
  if (authenticationFile !== null) {
    try {
      if (!authenticationFile || !existsSync(authenticationFile)) {
        const error = new Error(
          'Codex auth.json не найден. Выполните `codex login`, затем повторите запуск Ralph.',
        );
        error.code = 'RALPH_CODEX_AUTH';
        throw error;
      }
      const sandboxedAuthenticationFile = path.join(codexHome, 'auth.json');
      copyFileSync(authenticationFile, sandboxedAuthenticationFile);
      chmodSync(sandboxedAuthenticationFile, 0o600);
      writeFileSync(path.join(codexHome, 'config.toml'), 'cli_auth_credentials_store = "file"\n', {
        encoding: 'utf8',
        mode: 0o600,
      });
    } catch (error) {
      rmSync(root, { recursive: true, force: true });
      throw error;
    }
  }

  return {
    root,
    env: {
      ...credentialFreeEnvironment(source),
      HOME: home,
      USERPROFILE: home,
      APPDATA: config,
      LOCALAPPDATA: config,
      XDG_CONFIG_HOME: config,
      XDG_CACHE_HOME: cache,
      CODEX_HOME: codexHome,
      TEMP: temp,
      TMP: temp,
      TMPDIR: temp,
    },
  };
}

function terminateProcessTree(child, force = false) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  terminateProcessTreeByPid(child.pid, force);
}

async function waitForChildTermination(child, childResult, graceMs) {
  let timer;
  const completed = await Promise.race([
    childResult.then(
      () => true,
      () => true,
    ),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), graceMs);
    }),
  ]).finally(() => clearTimeout(timer));
  if (completed) return;

  terminateProcessTree(child, true);
  await Promise.race([
    childResult.catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
}

function printCodexEvent(event, turn, maxTurns) {
  const item = event.item;
  if (!item) {
    return;
  }

  if (item.type === 'error') {
    console.error(`[Codex] ${item.message}`);
    return;
  }

  if (turn !== null) {
    console.log(`[Codex step ${turn}/${maxTurns}] ${item.type}`);
  }

  if (event.type !== 'item.completed') {
    return;
  }

  if (item.type === 'agent_message' && item.text) {
    console.log(item.text);
  } else if (item.type === 'command_execution' && item.aggregated_output) {
    console.log(item.aggregated_output.replace(/\r?\n$/, ''));
  }
}

// Изолированный CODEX_HOME не содержит пользовательский config.toml, поэтому без
// явного override каждая роль получает текущий default CLI/модели. Передаём
// эффективное значение сами, чтобы поведение не менялось вместе с default.
export const reasoningEfforts = ['minimal', 'low', 'medium', 'high'];

export function reasoningEffortArguments(effort) {
  return ['-c', `model_reasoning_effort="${effort}"`];
}

export function developmentCodexArguments(config) {
  return [
    'exec',
    '--json',
    '--sandbox',
    'danger-full-access',
    '--model',
    config.developmentModel,
    ...reasoningEffortArguments(config.developmentEffort),
    '-C',
    projectRoot,
    '-',
  ];
}

export function agentReportedWriteAccessFailure(message) {
  return /(?:file system|filesystem|файловая система).{0,80}(?:read[- ]only|только для чтения)|(?:access|доступ).{0,40}(?:denied|запрещ[её]н)|(?:EPERM|EACCES).{0,80}(?:write|запис)/is.test(
    String(message ?? ''),
  );
}

// -----------------------------------------------------------------------------
// Circuit breaker: ограничиваем количество шагов Codex через maxTurns
// -----------------------------------------------------------------------------

export async function runCodexWithTurnLimit(args, options) {
  const { command, commandArgs } = commandSpec('codex', args);
  const childEnvironment = createSandboxedCodexEnvironment(options.env ?? process.env, {
    authenticationFile: options.authenticationFile,
  });
  let child;
  try {
    child = spawn(command, commandArgs, {
      cwd: projectRoot,
      env: childEnvironment.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
  } catch (error) {
    rmSync(childEnvironment.root, { recursive: true, force: true });
    throw error;
  }
  const cleanupChildEnvironment = () =>
    rmSync(childEnvironment.root, { recursive: true, force: true });
  child.once('error', cleanupChildEnvironment);
  child.once('close', cleanupChildEnvironment);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  let stderr = '';
  let stdoutBuffer = '';
  let lastAgentMessage = '';
  // Счётчик шагов текущей сессии Codex.
  let turns = 0;
  let limitReached = false;
  let wallTimeoutReached = false;
  let resolveTurnLimit;
  const seenItemIds = new Set();

  const handleLine = (line) => {
    if (line.trim() === '') {
      return;
    }

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      console.log(line);
      return;
    }

    const item = event.item;
    if (event.type === 'item.completed' && item?.type === 'agent_message' && item.text) {
      lastAgentMessage = item.text;
    }
    let currentTurn = null;
    if (
      (event.type === 'item.started' || event.type === 'item.completed') &&
      item?.id &&
      item.type !== 'error' &&
      !seenItemIds.has(item.id)
    ) {
      // Проверяем лимит до запуска следующего уникального шага.
      if (turns >= options.maxTurns) {
        if (limitReached) return;
        limitReached = true;
        console.error(
          `\nCircuit breaker: ${options.label} попытался превысить лимит ${options.maxTurns} шагов.`,
        );
        terminateProcessTree(child);
        resolveTurnLimit({ code: null, signal: 'RALPH_MAX_TURNS' });
        return;
      }

      seenItemIds.add(item.id);
      turns += 1;
      currentTurn = turns;
    }

    printCodexEvent(event, currentTurn, options.maxTurns);
  };

  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      handleLine(line);
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    console.error(chunk.replace(/\r?\n$/, ''));
  });

  const childResult = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const turnLimitResult = new Promise((resolve) => {
    resolveTurnLimit = resolve;
  });
  child.stdin.on('error', (error) => {
    if (error.code !== 'EPIPE') {
      console.error(`Ошибка stdin Codex: ${error.message}`);
    }
  });

  child.stdin.end(options.input);
  const timeoutMs = options.timeoutMs ?? runtimeSettings().codexTimeoutMs;
  let wallTimer;
  const wallTimeout = new Promise((resolve) => {
    wallTimer = setTimeout(() => {
      wallTimeoutReached = true;
      console.error(`\nCircuit breaker: ${options.label} превысил ${timeoutMs} ms.`);
      terminateProcessTree(child);
      resolve({ code: null, signal: 'RALPH_WALL_TIMEOUT' });
    }, timeoutMs);
  });
  let result;
  try {
    result = await Promise.race([childResult, wallTimeout, turnLimitResult]);
  } finally {
    clearTimeout(wallTimer);
  }
  if (limitReached || wallTimeoutReached) {
    await waitForChildTermination(child, childResult, 10_000);
  }
  if (stdoutBuffer.trim() !== '') {
    handleLine(stdoutBuffer);
  }

  if (limitReached) {
    const error = new Error(`${options.label} достиг лимита maxTurns=${options.maxTurns}.`);
    error.code = 'RALPH_MAX_TURNS';
    error.turns = turns;
    throw error;
  }

  if (wallTimeoutReached) {
    const error = new Error(`${options.label} достиг wall-clock timeout ${timeoutMs} ms.`);
    error.code = 'RALPH_CODEX_TIMEOUT';
    error.turns = turns;
    error.timeoutMs = timeoutMs;
    throw error;
  }

  if (result.code !== 0) {
    const error = new Error(
      `${options.label} завершился с кодом ${result.code ?? 'null'}` +
        `${result.signal ? ` (сигнал ${result.signal})` : ''}.` +
        `${stderr.trim() ? `\n${stderr.trim()}` : ''}`,
    );
    if (/401 Unauthorized|Missing bearer or basic authentication/i.test(stderr)) {
      error.code = 'RALPH_CODEX_AUTH';
    }
    throw error;
  }

  console.log(`${options.label}: использовано шагов ${turns}/${options.maxTurns}.`);
  return { turns, lastAgentMessage };
}

export function verifyCodexAuthentication(dependencies = {}) {
  const execute = dependencies.run ?? run;
  const childEnvironment = createSandboxedCodexEnvironment(dependencies.env ?? process.env, {
    authenticationFile: dependencies.authenticationFile,
  });
  try {
    execute('codex', ['login', 'status'], {
      env: childEnvironment.env,
      timeoutMs: runtimeSettings().commandTimeoutMs,
    });
  } catch (cause) {
    const error = new Error(
      'Изолированный Codex не авторизован. Выполните `codex login` и повторите запуск Ralph.',
      { cause },
    );
    error.code = 'RALPH_CODEX_AUTH';
    throw error;
  } finally {
    rmSync(childEnvironment.root, { recursive: true, force: true });
  }
}

// Повтор review-сессии при технической ошибке. Ошибка с nonRetryable - это
// вердикт ревьюера, а не сбой запуска, и повторять её нельзя.
export async function runReviewWithRetries(config, operation, label) {
  let lastError;
  for (let attempt = 1; attempt <= config.runtime.reviewRetryAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (error.nonRetryable || attempt === config.runtime.reviewRetryAttempts) throw error;
      const delay = retryDelayMs(config.runtime.networkRetryBaseDelayMs, attempt);
      console.error(
        `${label} технически не завершился (попытка ${attempt}): ${error.message}. ` +
          `Повтор через ${delay} ms.`,
      );
      waitSync(delay);
    }
  }
  throw lastError;
}
