import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { commandTimeoutError, retryTransientOperation } from './ralph-runtime.mjs';

/**
 * Запуск внешних команд: Git, GitHub CLI, npm и Codex CLI.
 *
 * Пути выводятся здесь заново, а не импортируются из оркестратора. Это не
 * дублирование ради удобства: `loadConfig` вызывает `applyRuntimeSettings`, а
 * `run` нуждается в путях, поэтому импорт путей из модуля конфигурации создал бы
 * настоящий цикл с temporal dead zone — оба значения вычисляются на этапе
 * загрузки модуля. Файлы лежат в одном каталоге, поэтому значения совпадают.
 */

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..', '..');
const commandRunnerPath = path.join(scriptDirectory, 'ralph-command-runner.mjs');

// Значения по умолчанию действуют, пока конфигурация не загружена: часть тестов
// и ранние проверки запускают команды до `loadConfig`.
export const defaultRuntimeSettings = Object.freeze({
  commandTimeoutMs: 300_000,
  validationTimeoutMs: 1_800_000,
  validationRunTimeoutMs: 3_600_000,
  codexTimeoutMs: 5_400_000,
  networkRetryAttempts: 3,
  networkRetryBaseDelayMs: 2_000,
  maxPages: 20,
  reviewRetryAttempts: 3,
});

let settings = { ...defaultRuntimeSettings };

export function applyRuntimeSettings(runtime) {
  settings = { ...runtime };
}

export function runtimeSettings() {
  return settings;
}

export function executable(name) {
  if (process.platform !== 'win32') {
    return name;
  }

  return `${name}.exe`;
}

export function commandSpec(name, args) {
  const useWindowsCommandShim =
    process.platform === 'win32' && ['codex', 'npm', 'npx'].includes(name);
  const command = useWindowsCommandShim ? (process.env.ComSpec ?? 'cmd.exe') : executable(name);
  const commandArgs = useWindowsCommandShim ? ['/d', '/s', '/c', `${name}.cmd`, ...args] : args;

  return { command, commandArgs };
}

export function outputTail(value, maxLength = 20_000) {
  const text = String(value ?? '').trim();
  return text.length > maxLength ? `…${text.slice(-maxLength)}` : text;
}

// Полный allowlist переменных, которые дочерний процесс может унаследовать.
// Сам по себе он не является политикой: home/config-переменные указывают на
// каталоги с учётными данными, поэтому единственная применяемая политика ниже
// вычитает их. Список остаётся отдельно, чтобы вычитание было видимым.
export const inheritableEnvironmentVariables = [
  'PATH',
  'Path',
  'PATHEXT',
  'ComSpec',
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'CODEX_HOME',
];

export const credentialFreeEnvironmentVariables = inheritableEnvironmentVariables.filter(
  (name) =>
    ![
      'HOME',
      'USERPROFILE',
      'APPDATA',
      'LOCALAPPDATA',
      'XDG_CONFIG_HOME',
      'XDG_CACHE_HOME',
      'CODEX_HOME',
    ].includes(name),
);

function createEnvironment(variableNames, source = process.env) {
  return Object.fromEntries(
    variableNames.flatMap((name) => (source[name] === undefined ? [] : [[name, source[name]]])),
  );
}

export function credentialFreeEnvironment(source = process.env) {
  return createEnvironment(credentialFreeEnvironmentVariables, source);
}

export function run(name, args, options = {}) {
  const commandTarget = commandSpec(name, args);
  const useCommandRunner = process.platform === 'win32';
  const command = useCommandRunner ? process.execPath : commandTarget.command;
  const commandArgs = useCommandRunner ? [commandRunnerPath] : commandTarget.commandArgs;
  const stdio = options.inherit ? ['pipe', 'inherit', 'inherit'] : 'pipe';
  const timeoutMs = options.timeoutMs ?? settings.commandTimeoutMs;
  const startedAt = Date.now();
  console.log(`Команда: ${name} ${args[0] ?? ''}`.trim());
  const result = spawnSync(command, commandArgs, {
    cwd: projectRoot,
    encoding: 'utf8',
    input: useCommandRunner
      ? JSON.stringify({
          command: commandTarget.command,
          args: commandTarget.commandArgs,
          cwd: projectRoot,
          input: options.input,
          timeoutMs,
          env: options.env,
        })
      : options.input,
    stdio,
    timeout: useCommandRunner ? timeoutMs + 25_000 : timeoutMs,
    killSignal: 'SIGTERM',
    maxBuffer: 50 * 1024 * 1024,
    windowsHide: true,
    ...(options.env === undefined ? {} : { env: options.env }),
  });

  const commandRunnerTimedOut =
    useCommandRunner &&
    result.status === 124 &&
    String(result.stderr ?? '').includes('RALPH_COMMAND_TIMEOUT:');
  if (result.error?.code === 'ETIMEDOUT' || commandRunnerTimedOut) {
    throw commandTimeoutError(name, args, timeoutMs, result);
  }
  if (result.error) {
    const error = new Error(`Не удалось запустить ${name}: ${result.error.message}`);
    error.code = result.error.code;
    error.stdout = result.stdout?.trim() ?? '';
    error.stderr = result.stderr?.trim() ?? '';
    throw error;
  }
  if (result.status === null) {
    const error = new Error(
      `Команда ${name} ${args[0] ?? ''} завершилась без exit code` +
        `${result.signal ? ` (сигнал ${result.signal})` : ''}.`,
    );
    error.code = 'RALPH_COMMAND_TERMINATED';
    error.stdout = outputTail(result.stdout);
    error.stderr = outputTail(result.stderr);
    throw error;
  }

  const allowedExitCodes = new Set(options.allowedExitCodes ?? []);
  if (result.status !== 0 && !options.allowFailure && !allowedExitCodes.has(result.status)) {
    const details = [result.stderr, result.stdout]
      .filter(Boolean)
      .map((value) => value.trim())
      .filter(Boolean)
      .join('\n');
    const error = new Error(
      `Команда ${name} ${args[0] ?? ''} завершилась с кодом ${result.status}.` +
        `${details ? `\n${outputTail(details)}` : ''}`,
    );
    error.code = 'RALPH_COMMAND_FAILED';
    error.status = result.status;
    error.stdout = result.stdout?.trim() ?? '';
    error.stderr = result.stderr?.trim() ?? '';
    throw error;
  }

  if (options.echoOutput) {
    if (result.stdout?.trim()) console.log(outputTail(result.stdout, 100_000));
    if (result.stderr?.trim()) console.error(outputTail(result.stderr, 100_000));
  }
  console.log(`Команда ${name} завершена за ${Date.now() - startedAt} ms.`);

  return {
    status: result.status,
    stdout: result.stdout?.trim() ?? '',
    stderr: result.stderr?.trim() ?? '',
  };
}

export function runNetwork(name, args, options = {}) {
  return retryTransientOperation(() => run(name, args, options), {
    attempts: settings.networkRetryAttempts,
    baseDelayMs: settings.networkRetryBaseDelayMs,
    onRetry: (error, attempt, delay) =>
      console.error(
        `Временная ошибка ${name} (попытка ${attempt}): ${error.message}. Повтор через ${delay} ms.`,
      ),
  });
}
