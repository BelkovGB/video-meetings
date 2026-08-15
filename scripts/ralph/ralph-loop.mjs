#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  acquireRunLock,
  commandTimeoutError,
  initializePersistentLog,
  readJsonFile,
  removeFileIfExists,
  retryTransientOperation,
  terminateProcessTreeByPid,
  waitSync,
  writeJsonAtomic,
} from './ralph-runtime.mjs';

// -----------------------------------------------------------------------------
// Пути проекта и режим запуска
// -----------------------------------------------------------------------------

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..', '..');
const configPath = path.join(projectRoot, '.agents', 'ralph.config.json');
const approvedIssueSnapshotsHash =
  'c0e278f489ab9e9b20c7d21232b9bb50e1e268eed0ba338966091da84777701e';
const mode = process.argv[2] ?? '--check';
const supportedModes = new Set(['--check', '--once', '--run']);
const runtimeDirectory = path.join(projectRoot, '.git', 'ralph-loop');
const runtimeStatePath = path.join(runtimeDirectory, 'state.json');
const runtimeLockPath = path.join(runtimeDirectory, 'run.lock');
const runtimeLogPath = path.join(runtimeDirectory, 'run.log');
const commandRunnerPath = path.join(scriptDirectory, 'ralph-command-runner.mjs');
const ralphInfrastructureLabel = 'ralph-infrastructure';
let runtimeSettings = {
  commandTimeoutMs: 300_000,
  validationTimeoutMs: 1_800_000,
  codexTimeoutMs: 5_400_000,
  networkRetryAttempts: 3,
  networkRetryBaseDelayMs: 2_000,
  maxPages: 20,
  reviewRetryAttempts: 3,
};
let activeStateStore = null;
const preparedValidationImages = new Set();

// -----------------------------------------------------------------------------
// Запуск внешних команд: Git, GitHub CLI, npm и Codex CLI
// -----------------------------------------------------------------------------

function fail(message) {
  throw new Error(message);
}

// Ralph is the control plane for product work. Its own implementation and
// instructions are maintained manually in this chat and are never product work.
function isRalphInfrastructurePath(file) {
  const normalized = String(file ?? '')
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/:\d+(?::\d+)?$/, '');

  return (
    normalized === 'AGENTS.md' ||
    normalized.endsWith('/AGENTS.md') ||
    normalized === '.agents' ||
    normalized.startsWith('.agents/') ||
    normalized === 'scripts/ralph' ||
    normalized.startsWith('scripts/ralph/')
  );
}

function issueLabels(issue) {
  return (issue?.labels ?? []).map((label) =>
    typeof label === 'string' ? label : String(label?.name ?? ''),
  );
}

function milestoneFindingPath(issue) {
  if (!String(issue?.body ?? '').includes('<!-- ralph-milestone-finding ')) return null;
  return String(issue.body).match(/^\*\*Location:\*\*\s+`([^`]+)`\s*$/m)?.[1] ?? null;
}

function isRalphInfrastructureIssue(issue) {
  return (
    issueLabels(issue).some((label) => label.toLowerCase() === ralphInfrastructureLabel) ||
    isRalphInfrastructurePath(milestoneFindingPath(issue))
  );
}

function scopeMilestoneReviewToProduct(review) {
  const productFindings = review.findings.filter(
    (finding) => !isRalphInfrastructurePath(finding.file),
  );
  const ignoredCount = review.findings.length - productFindings.length;
  if (ignoredCount === 0) return review;

  console.log(
    `Milestone review: ${ignoredCount} замечаний к Ralph-инфраструктуре исключены из продуктовой очереди.`,
  );
  return {
    ...review,
    verdict: productFindings.length > 0 ? 'fail' : 'pass',
    summary:
      `${review.summary} ${ignoredCount} Ralph infrastructure finding(s) were excluded ` +
      'from the product milestone and must be handled manually in the configuration chat.',
    findings: productFindings,
  };
}

function executable(name) {
  if (process.platform !== 'win32') {
    return name;
  }

  return `${name}.exe`;
}

function commandSpec(name, args) {
  const useWindowsCommandShim =
    process.platform === 'win32' && ['codex', 'npm', 'npx'].includes(name);
  const command = useWindowsCommandShim ? (process.env.ComSpec ?? 'cmd.exe') : executable(name);
  const commandArgs = useWindowsCommandShim ? ['/d', '/s', '/c', `${name}.cmd`, ...args] : args;

  return { command, commandArgs };
}

function outputTail(value, maxLength = 20_000) {
  const text = String(value ?? '').trim();
  return text.length > maxLength ? `…${text.slice(-maxLength)}` : text;
}

const sanitizedChildEnvironmentVariables = [
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

const credentialFreeEnvironmentVariables = sanitizedChildEnvironmentVariables.filter(
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

function sanitizedChildEnvironment(source = process.env) {
  return createEnvironment(credentialFreeEnvironmentVariables, source);
}

function credentialFreeEnvironment(source = process.env) {
  return createEnvironment(credentialFreeEnvironmentVariables, source);
}

function codexAuthenticationFile(source = process.env) {
  const codexHome = source.CODEX_HOME?.trim();
  if (codexHome) return path.join(codexHome, 'auth.json');

  const userHome = source.USERPROFILE?.trim() || source.HOME?.trim();
  return userHome ? path.join(userHome, '.codex', 'auth.json') : null;
}

function createSandboxedCodexEnvironment(source = process.env, options = {}) {
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
      const authenticationFileStat = lstatSync(authenticationFile);
      if (!authenticationFileStat.isFile() || authenticationFileStat.isSymbolicLink()) {
        const error = new Error('Codex auth.json должен быть обычным файлом, а не ссылкой.');
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

function run(name, args, options = {}) {
  const commandTarget = commandSpec(name, args);
  const useCommandRunner = process.platform === 'win32';
  const command = useCommandRunner ? process.execPath : commandTarget.command;
  const commandArgs = useCommandRunner ? [commandRunnerPath] : commandTarget.commandArgs;
  const stdio = options.inherit ? ['pipe', 'inherit', 'inherit'] : 'pipe';
  const timeoutMs = options.timeoutMs ?? runtimeSettings.commandTimeoutMs;
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

function runNetwork(name, args, options = {}) {
  return retryTransientOperation(() => run(name, args, options), {
    attempts: runtimeSettings.networkRetryAttempts,
    baseDelayMs: runtimeSettings.networkRetryBaseDelayMs,
    onRetry: (error, attempt, delay) =>
      console.error(
        `Временная ошибка ${name} (попытка ${attempt}): ${error.message}. Повтор через ${delay} ms.`,
      ),
  });
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

function developmentCodexArguments(config) {
  return [
    'exec',
    '--json',
    '--sandbox',
    'danger-full-access',
    '--model',
    config.developmentModel,
    '-C',
    projectRoot,
    '-',
  ];
}

function agentReportedWriteAccessFailure(message) {
  return /(?:file system|filesystem|файловая система).{0,80}(?:read[- ]only|только для чтения)|(?:access|доступ).{0,40}(?:denied|запрещ[её]н)|(?:EPERM|EACCES).{0,80}(?:write|запис)/is.test(
    String(message ?? ''),
  );
}

// -----------------------------------------------------------------------------
// Circuit breaker: ограничиваем количество шагов Codex через maxTurns
// -----------------------------------------------------------------------------

async function runCodexWithTurnLimit(args, options) {
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
  const timeoutMs = options.timeoutMs ?? runtimeSettings.codexTimeoutMs;
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

// -----------------------------------------------------------------------------
// Чтение и проверка ralph.config.json
// -----------------------------------------------------------------------------

function parseJson(value, source) {
  try {
    return JSON.parse(value);
  } catch (error) {
    fail(`Некорректный JSON от ${source}: ${error.message}`);
  }
}

function resolveProjectFile(file, field) {
  if (typeof file !== 'string' || file.trim() === '') {
    fail(`Поле "${field}" должно быть непустой строкой.`);
  }

  const resolved = path.resolve(projectRoot, file);
  const relative = path.relative(projectRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    fail(`Поле "${field}" должно указывать файл внутри проекта.`);
  }

  return resolved;
}

function trustedFileHash(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

const ignoredAgentInstructionDirectories = new Set([
  '.git',
  '.next',
  'coverage',
  'dist',
  'node_modules',
]);

function agentInstructionFiles(directory = projectRoot) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredAgentInstructionDirectories.has(entry.name)) {
        files.push(...agentInstructionFiles(path.join(directory, entry.name)));
      }
      continue;
    }
    if (entry.name === 'AGENTS.md') {
      files.push(path.join(directory, entry.name));
    }
  }
  return files.sort();
}

const skillsDirectory = path.join(projectRoot, '.agents', 'skills');

// Codex загружает project-local skills по YAML frontmatter. Невалидный
// frontmatter не останавливает сессию: агент просто теряет skill и пишет
// `failed to load skill`, поэтому проблему нужно ловить до запуска.
function parseSkillFrontmatter(content) {
  const errors = [];
  const fields = new Map();
  const lines = String(content ?? '')
    .replace(/^﻿/, '')
    .split(/\r?\n/);

  if (lines[0]?.trim() !== '---') {
    return { fields, errors: ['файл должен начинаться со строки `---`'] };
  }

  const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (closingIndex === -1) {
    return { fields, errors: ['frontmatter не закрыт строкой `---`'] };
  }

  let lastKey = null;
  for (let index = 1; index < closingIndex; index += 1) {
    const line = lines[index];
    if (line.trim() === '') continue;
    // Продолжение многострочного значения YAML.
    if (lastKey && /^\s/.test(line)) continue;

    const tabSeparated = /^([A-Za-z0-9_-]+)\t/.exec(line);
    if (tabSeparated) {
      errors.push(
        `строка ${index + 1}: поле "${tabSeparated[1]}" отделено табуляцией; ` +
          'YAML требует `' +
          tabSeparated[1] +
          ': значение`',
      );
      lastKey = tabSeparated[1];
      continue;
    }

    const pair = /^([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(line);
    if (!pair) {
      errors.push(`строка ${index + 1}: ожидалась пара \`ключ: значение\``);
      continue;
    }
    lastKey = pair[1];
    fields.set(pair[1], (pair[2] ?? '').trim());
  }

  for (const required of ['name', 'description']) {
    if (!fields.has(required)) {
      if (!errors.some((message) => message.includes(`"${required}"`))) {
        errors.push(`отсутствует обязательное поле "${required}"`);
      }
    } else if (fields.get(required) === '') {
      errors.push(`поле "${required}" пустое`);
    }
  }

  return { fields, errors };
}

function agentSkillFiles(directory = skillsDirectory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(directory, entry.name, 'SKILL.md'))
    .filter((file) => existsSync(file))
    .sort();
}

function verifyAgentSkills(dependencies = {}) {
  const files = dependencies.files ?? agentSkillFiles(dependencies.directory);
  const readFile = dependencies.readFile ?? ((file) => readFileSync(file, 'utf8'));
  const problems = [];
  for (const file of files) {
    const { errors } = parseSkillFrontmatter(readFile(file));
    if (errors.length > 0) {
      problems.push(`${path.relative(projectRoot, file)}: ${errors.join('; ')}`);
    }
  }
  if (problems.length > 0) {
    fail(
      'Невалидный frontmatter project-local skills; Codex не загрузит их:\n  ' +
        problems.join('\n  '),
    );
  }
  return files;
}

function freezeValidationDockerfile(dockerfilePath) {
  const snapshotDirectory = mkdtempSync(path.join(tmpdir(), 'ralph-validation-dockerfile-'));
  const snapshotPath = path.join(snapshotDirectory, 'Dockerfile.validation');
  try {
    copyFileSync(dockerfilePath, snapshotPath);
    return { snapshotDirectory, snapshotPath };
  } catch (error) {
    rmSync(snapshotDirectory, { recursive: true, force: true });
    throw error;
  }
}

function assertTrustedControlFilesUnchanged(config) {
  const trustedAgentInstructionFiles = new Set(
    [...(config.trustedControlFileHashes?.keys() ?? [])].filter(
      (file) => path.basename(file) === 'AGENTS.md',
    ),
  );
  const currentAgentInstructionFiles = new Set(agentInstructionFiles());
  if (
    trustedAgentInstructionFiles.size !== currentAgentInstructionFiles.size ||
    [...currentAgentInstructionFiles].some((file) => !trustedAgentInstructionFiles.has(file))
  ) {
    fail(
      'AFK-сессия изменила набор доверенных файлов AGENTS.md. ' +
        'Изменение отклонено до валидации, commit и push.',
    );
  }
  for (const [file, expectedHash] of config.trustedControlFileHashes ?? []) {
    if (!existsSync(file) || trustedFileHash(file) !== expectedHash) {
      fail(
        `AFK-сессия изменила доверенный файл ${file}. ` +
          'Изменение отклонено до валидации, commit и push.',
      );
    }
  }
}

function phasePlanId(phases) {
  return createHash('sha256')
    .update(
      JSON.stringify(
        phases.map(({ milestone, branch, baseBranch }) => ({ milestone, branch, baseBranch })),
      ),
    )
    .digest('hex');
}

function normalizePhases(config) {
  const hasPhaseArray = Object.hasOwn(config, 'phases');
  const hasAnyLegacyPhaseField =
    Object.hasOwn(config, 'milestone') || Object.hasOwn(config, 'branch');
  if (hasPhaseArray && hasAnyLegacyPhaseField) {
    fail('Не используйте одновременно "phases" и верхнеуровневые "milestone"/"branch".');
  }
  const hasLegacyPhase =
    typeof config.milestone === 'string' &&
    config.milestone.trim() !== '' &&
    typeof config.branch === 'string' &&
    config.branch.trim() !== '';
  const source =
    config.phases ??
    (hasLegacyPhase ? [{ milestone: config.milestone, branch: config.branch }] : null);

  if (!Array.isArray(source) || source.length === 0) {
    fail(
      `Добавьте непустой массив "phases" в ${configPath} ` +
        'или заполните совместимые поля "milestone" и "branch".',
    );
  }

  const phases = source.map((phase, index) => {
    if (typeof phase !== 'object' || phase === null || Array.isArray(phase)) {
      fail(`Поле "phases[${index}]" должно быть объектом.`);
    }
    for (const field of ['milestone', 'branch']) {
      if (typeof phase[field] !== 'string' || phase[field].trim() === '') {
        fail(`Поле "phases[${index}].${field}" должно быть непустой строкой.`);
      }
    }
    const baseBranch = phase.baseBranch ?? config.baseBranch;
    if (typeof baseBranch !== 'string' || baseBranch.trim() === '') {
      fail(`Поле "phases[${index}].baseBranch" должно быть непустой строкой.`);
    }
    if (phase.branch === baseBranch) {
      fail(`В phases[${index}] рабочая ветка не должна совпадать с baseBranch.`);
    }
    return {
      milestone: phase.milestone.trim(),
      branch: phase.branch.trim(),
      baseBranch: baseBranch.trim(),
    };
  });

  for (const field of ['milestone', 'branch']) {
    const values = phases.map((phase) =>
      field === 'branch' ? phase[field].toLowerCase() : phase[field],
    );
    if (new Set(values).size !== values.length) {
      fail(`Поле "phases" не должно содержать повторяющиеся значения "${field}".`);
    }
  }

  return phases;
}

function configForPhase(config, phaseIndex) {
  if (!Number.isInteger(phaseIndex) || phaseIndex < 0 || phaseIndex >= config.phases.length) {
    fail(`Некорректный индекс фазы ${phaseIndex}. Всего фаз: ${config.phases.length}.`);
  }
  return {
    ...config,
    ...config.phases[phaseIndex],
    phaseIndex,
    phaseCount: config.phases.length,
    phasePlanId: config.phasePlanId,
  };
}

function loadConfig() {
  const config = parseJson(readFileSync(configPath, 'utf8'), configPath);

  for (const field of ['prompt']) {
    if (typeof config[field] !== 'string' || config[field].trim() === '') {
      fail(`Заполните строковое поле \"${field}\" в ${configPath}.`);
    }
  }

  config.baseBranch ??= 'main';
  config.phases = normalizePhases(config);
  config.phasePlanId = phasePlanId(config.phases);
  ({
    milestone: config.milestone,
    branch: config.branch,
    baseBranch: config.baseBranch,
  } = config.phases[0]);
  config.draftPullRequest ??= true;
  config.maxIterations ??= 20;
  config.maxTurns ??= 50;
  config.maxTestFixAttempts ??= 5;
  config.runtime ??= {};
  config.runtime.commandTimeoutMs ??= 300_000;
  config.runtime.validationTimeoutMs ??= 1_800_000;
  config.runtime.codexTimeoutMs ??= 5_400_000;
  config.runtime.networkRetryAttempts ??= 3;
  config.runtime.networkRetryBaseDelayMs ??= 2_000;
  config.runtime.maxPages ??= 20;
  config.runtime.reviewRetryAttempts ??= 3;
  config.developmentModel ??= 'gpt-5.6-terra';
  config.rulesFile ??= '.agents/ralph-rules.md';
  config.autoApproveConfiguredIssues ??= true;
  config.trustedIssueAuthors ??= [];
  config.approvedIssueSnapshotsFile ??= 'scripts/ralph/approved-issues.json';
  if (
    typeof config.approvedIssueSnapshotsFile !== 'string' ||
    config.approvedIssueSnapshotsFile.trim() === ''
  ) {
    fail('Поле "approvedIssueSnapshotsFile" должно быть непустым путём к snapshots issue.');
  }
  const approvedIssueSnapshotsPath = resolveProjectFile(
    config.approvedIssueSnapshotsFile,
    'approvedIssueSnapshotsFile',
  );
  if (!existsSync(approvedIssueSnapshotsPath)) {
    fail(`Файл одобренных snapshots issue не найден: ${approvedIssueSnapshotsPath}`);
  }
  if (lstatSync(approvedIssueSnapshotsPath).isSymbolicLink()) {
    fail('Файл одобренных snapshots issue не должен быть symbolic link.');
  }
  if (trustedFileHash(approvedIssueSnapshotsPath) !== approvedIssueSnapshotsHash) {
    fail(
      'Файл одобренных snapshots issue не совпадает с защищённым контрольным SHA-256. ' +
        'Проверьте изменение и обновите контрольную сумму вместе с одобрением snapshots.',
    );
  }
  config.approvedIssueSnapshots = parseJson(
    readFileSync(approvedIssueSnapshotsPath, 'utf8'),
    approvedIssueSnapshotsPath,
  );
  config.approvedIssueSnapshotsPath = approvedIssueSnapshotsPath;
  config.validationContainer ??= {
    image: 'video-meetings-ralph-validation:latest',
    dockerfile: 'scripts/ralph/Dockerfile.validation',
    network: 'none',
  };
  config.preflightScripts ??= [];
  config.validationScripts ??= ['format:check', 'lint', 'build'];
  config.review ??= {
    enabled: true,
    model: 'gpt-5.6-terra',
    schemaFile: '.agents/review.schema.json',
    outputFile: '.agents/last-review.json',
  };
  config.review.model ??= 'gpt-5.6-terra';
  config.milestoneReview ??= {
    enabled: true,
    model: 'gpt-5.6-sol',
    maxTurns: config.maxTurns,
    schemaFile: '.agents/review.schema.json',
    outputFile: '.agents/last-milestone-review.json',
  };
  config.milestoneReview.maxTurns ??= config.maxTurns;
  config.milestoneReview.maxFindings ??= 10;

  if (typeof config.active !== 'boolean') {
    fail('Поле "active" должно быть true или false.');
  }
  if (typeof config.baseBranch !== 'string' || config.baseBranch.trim() === '') {
    fail('Поле "baseBranch" должно быть непустой строкой.');
  }
  if (typeof config.draftPullRequest !== 'boolean') {
    fail('Поле "draftPullRequest" должно быть true или false.');
  }
  if (typeof config.autoApproveConfiguredIssues !== 'boolean') {
    fail('Поле "autoApproveConfiguredIssues" должно быть true или false.');
  }
  if (!Number.isInteger(config.maxIterations) || config.maxIterations < 1) {
    fail('Поле "maxIterations" должно быть целым числом больше 0.');
  }
  if (!Number.isInteger(config.maxTurns) || config.maxTurns < 1) {
    fail('Поле "maxTurns" должно быть целым числом больше 0.');
  }
  if (!Number.isInteger(config.maxTestFixAttempts) || config.maxTestFixAttempts < 1) {
    fail('Поле "maxTestFixAttempts" должно быть целым числом больше 0.');
  }
  if (
    !Array.isArray(config.trustedIssueAuthors) ||
    config.trustedIssueAuthors.some(
      (author) => typeof author !== 'string' || !/^[a-zA-Z0-9-]+$/.test(author),
    )
  ) {
    fail('Поле "trustedIssueAuthors" должно содержать GitHub логины доверенных авторов.');
  }
  const normalizedTrustedAuthors = config.trustedIssueAuthors.map((author) => author.toLowerCase());
  if (new Set(normalizedTrustedAuthors).size !== normalizedTrustedAuthors.length) {
    fail('Поле "trustedIssueAuthors" не должно содержать одинаковые логины с разным регистром.');
  }
  config.trustedIssueAuthors = normalizedTrustedAuthors;
  if (
    typeof config.approvedIssueSnapshots !== 'object' ||
    config.approvedIssueSnapshots === null ||
    Array.isArray(config.approvedIssueSnapshots)
  ) {
    fail('Поле "approvedIssueSnapshots" должно быть объектом с неизменяемыми snapshots issue.');
  }
  for (const [number, snapshot] of Object.entries(config.approvedIssueSnapshots)) {
    if (!/^[1-9][0-9]*$/.test(number)) {
      fail('Ключи "approvedIssueSnapshots" должны быть положительными номерами GitHub issue.');
    }
    if (
      typeof snapshot !== 'object' ||
      snapshot === null ||
      Array.isArray(snapshot) ||
      typeof snapshot.title !== 'string' ||
      typeof snapshot.body !== 'string'
    ) {
      fail(`Snapshot issue #${number} должен содержать строковые поля "title" и "body".`);
    }
  }
  if (typeof config.validationContainer !== 'object' || config.validationContainer === null) {
    fail('Поле "validationContainer" должно быть объектом.');
  }
  for (const field of ['image', 'dockerfile']) {
    if (
      typeof config.validationContainer[field] !== 'string' ||
      config.validationContainer[field].trim() === '' ||
      !/^[a-zA-Z0-9._/:@-]+$/.test(config.validationContainer[field])
    ) {
      fail(`Поле "validationContainer.${field}" должно содержать безопасное значение.`);
    }
  }
  if (config.validationContainer.network !== 'none') {
    fail('Поле "validationContainer.network" должно быть равно "none" для изолированной проверки.');
  }
  config.validationContainer.dockerfilePath = resolveProjectFile(
    config.validationContainer.dockerfile,
    'validationContainer.dockerfile',
  );
  if (!existsSync(config.validationContainer.dockerfilePath)) {
    fail(`Dockerfile изоляции валидации не найден: ${config.validationContainer.dockerfilePath}`);
  }
  if (lstatSync(config.validationContainer.dockerfilePath).isSymbolicLink()) {
    fail('Dockerfile изоляции валидации не должен быть symbolic link.');
  }
  const frozenDockerfile = freezeValidationDockerfile(config.validationContainer.dockerfilePath);
  config.validationContainer.frozenDockerfilePath = frozenDockerfile.snapshotPath;
  config.validationContainer.frozenDockerfileDirectory = frozenDockerfile.snapshotDirectory;
  if (
    !Array.isArray(config.preflightScripts) ||
    !Array.isArray(config.validationScripts) ||
    [...config.preflightScripts, ...config.validationScripts].some(
      (script) =>
        typeof script !== 'string' || script.trim() === '' || !/^[a-zA-Z0-9:_-]+$/.test(script),
    )
  ) {
    fail(
      'Поля "preflightScripts" и "validationScripts" должны быть массивами безопасных имён npm scripts.',
    );
  }
  if (typeof config.runtime !== 'object' || config.runtime === null) {
    fail('Поле "runtime" должно быть объектом.');
  }
  for (const field of [
    'commandTimeoutMs',
    'validationTimeoutMs',
    'codexTimeoutMs',
    'networkRetryBaseDelayMs',
  ]) {
    if (!Number.isInteger(config.runtime[field]) || config.runtime[field] < 1) {
      fail(`Поле "runtime.${field}" должно быть целым числом больше 0.`);
    }
  }
  for (const field of ['networkRetryAttempts', 'reviewRetryAttempts']) {
    if (
      !Number.isInteger(config.runtime[field]) ||
      config.runtime[field] < 1 ||
      config.runtime[field] > 5
    ) {
      fail(`Поле "runtime.${field}" должно быть целым числом от 1 до 5.`);
    }
  }
  if (
    !Number.isInteger(config.runtime.maxPages) ||
    config.runtime.maxPages < 1 ||
    config.runtime.maxPages > 100
  ) {
    fail('Поле "runtime.maxPages" должно быть целым числом от 1 до 100.');
  }
  if (typeof config.review !== 'object' || config.review === null) {
    fail('Поле "review" должно быть объектом.');
  }
  if (typeof config.review.enabled !== 'boolean') {
    fail('Поле "review.enabled" должно быть true или false.');
  }
  for (const [field, value] of [
    ['developmentModel', config.developmentModel],
    ['review.model', config.review.model],
  ]) {
    if (typeof value !== 'string' || value.trim() === '' || !/^[a-zA-Z0-9._-]+$/.test(value)) {
      fail(`Поле "${field}" должно содержать безопасное имя модели.`);
    }
  }
  if (typeof config.milestoneReview !== 'object' || config.milestoneReview === null) {
    fail('Поле "milestoneReview" должно быть объектом.');
  }
  if (typeof config.milestoneReview.enabled !== 'boolean') {
    fail('Поле "milestoneReview.enabled" должно быть true или false.');
  }
  if (
    typeof config.milestoneReview.model !== 'string' ||
    config.milestoneReview.model.trim() === '' ||
    !/^[a-zA-Z0-9._-]+$/.test(config.milestoneReview.model)
  ) {
    fail('Поле "milestoneReview.model" должно содержать безопасное имя модели.');
  }
  if (!Number.isInteger(config.milestoneReview.maxTurns) || config.milestoneReview.maxTurns < 1) {
    fail('Поле "milestoneReview.maxTurns" должно быть целым числом больше 0.');
  }
  if (
    !Number.isInteger(config.milestoneReview.maxFindings) ||
    config.milestoneReview.maxFindings < 1 ||
    config.milestoneReview.maxFindings > 50
  ) {
    fail('Поле "milestoneReview.maxFindings" должно быть целым числом от 1 до 50.');
  }

  config.rulesPath = resolveProjectFile(config.rulesFile, 'rulesFile');
  if (!existsSync(config.rulesPath)) {
    fail(`Файл правил не найден: ${config.rulesPath}`);
  }

  if (config.review.enabled) {
    config.review.schemaPath = resolveProjectFile(config.review.schemaFile, 'review.schemaFile');
    config.review.outputPath = resolveProjectFile(config.review.outputFile, 'review.outputFile');
    if (!existsSync(config.review.schemaPath)) {
      fail(`Схема review не найдена: ${config.review.schemaPath}`);
    }
    parseJson(readFileSync(config.review.schemaPath, 'utf8'), config.review.schemaPath);
  }

  if (config.milestoneReview.enabled) {
    config.milestoneReview.schemaPath = resolveProjectFile(
      config.milestoneReview.schemaFile,
      'milestoneReview.schemaFile',
    );
    config.milestoneReview.outputPath = resolveProjectFile(
      config.milestoneReview.outputFile,
      'milestoneReview.outputFile',
    );
    if (!existsSync(config.milestoneReview.schemaPath)) {
      fail(`Схема milestone review не найдена: ${config.milestoneReview.schemaPath}`);
    }
    parseJson(
      readFileSync(config.milestoneReview.schemaPath, 'utf8'),
      config.milestoneReview.schemaPath,
    );
  }

  const trustedControlFiles = [
    configPath,
    config.rulesPath,
    config.approvedIssueSnapshotsPath,
    config.validationContainer.dockerfilePath,
    commandRunnerPath,
    path.join(scriptDirectory, 'ralph-runtime.mjs'),
    path.join(scriptDirectory, 'ralph-validation-docker-shim.sh'),
    path.join(scriptDirectory, 'ralph-validation-entrypoint.sh'),
    fileURLToPath(import.meta.url),
    path.join(projectRoot, '.agents', 'RALPH.md'),
    ...agentInstructionFiles(),
  ];
  if (config.review.enabled) trustedControlFiles.push(config.review.schemaPath);
  if (config.milestoneReview.enabled) trustedControlFiles.push(config.milestoneReview.schemaPath);
  config.trustedControlFileHashes = new Map(
    [...new Set(trustedControlFiles)].map((file) => {
      if (!existsSync(file) || lstatSync(file).isSymbolicLink()) {
        fail(`Доверенный control-plane файл недоступен или является symbolic link: ${file}`);
      }
      return [file, trustedFileHash(file)];
    }),
  );

  runtimeSettings = { ...config.runtime };
  return config;
}

function loadRalphRules(config) {
  const rules = readFileSync(config.rulesPath, 'utf8').trim();
  if (rules === '') {
    fail(`Файл правил пуст: ${config.rulesPath}`);
  }

  return rules;
}

// -----------------------------------------------------------------------------
// Состояние AFK-запуска: переживает перезапуск Node и не попадает в Git
// -----------------------------------------------------------------------------

function createStateStore(config, selectedMode, statePath = runtimeStatePath) {
  let state = readJsonFile(statePath, null);
  const configuredPhaseIndex = config.phaseIndex ?? 0;
  const configuredPhaseCount = config.phaseCount ?? 1;
  const configuredPlanId =
    config.phasePlanId ??
    phasePlanId([
      { milestone: config.milestone, branch: config.branch, baseBranch: config.baseBranch },
    ]);
  if (state) {
    // Состояние version=1 создано однофазным Ralph. Если его идентичность
    // совпадает с текущей фазой, безопасно дополняем его индексом плана.
    if (
      state.version === 1 &&
      state.branch === config.branch &&
      state.baseBranch === config.baseBranch &&
      state.milestone === config.milestone
    ) {
      state.version = 2;
      state.phaseIndex = configuredPhaseIndex;
      state.phaseCount = configuredPhaseCount;
      state.phasePlanId = configuredPlanId;
      if (selectedMode !== '--check') writeJsonAtomic(statePath, state);
    }
    const identityMismatch =
      state.version !== 2 ||
      state.phaseIndex !== configuredPhaseIndex ||
      state.phaseCount !== configuredPhaseCount ||
      state.phasePlanId !== configuredPlanId ||
      state.branch !== config.branch ||
      state.baseBranch !== config.baseBranch ||
      state.milestone !== config.milestone;
    if (identityMismatch) {
      if (state.issue === null && state.iterationsUsed === 0) {
        removeFileIfExists(statePath);
        state = null;
      } else {
        fail(
          `Сохранённое состояние ${statePath} относится к другой ветке, базе или milestone. ` +
            'Завершите предыдущий AFK-запуск или удалите state вручную после проверки.',
        );
      }
    }
  }
  if (!state && selectedMode !== '--check') {
    state = {
      version: 2,
      runId: randomUUID(),
      status: 'active',
      phaseIndex: configuredPhaseIndex,
      phaseCount: configuredPhaseCount,
      phasePlanId: configuredPlanId,
      branch: config.branch,
      baseBranch: config.baseBranch,
      milestone: config.milestone,
      iterationsUsed: 0,
      approvedIssueSnapshots: {},
      issue: null,
      updatedAt: new Date().toISOString(),
    };
    writeJsonAtomic(statePath, state);
  }

  const persist = () => {
    if (!state) return;
    state.updatedAt = new Date().toISOString();
    writeJsonAtomic(statePath, state);
  };

  return {
    get state() {
      return state;
    },
    get issue() {
      return state?.issue ?? null;
    },
    get phaseIndex() {
      return state?.phaseIndex ?? configuredPhaseIndex;
    },
    get phaseCount() {
      return state?.phaseCount ?? configuredPhaseCount;
    },
    get approvedIssueSnapshots() {
      return state?.approvedIssueSnapshots ?? {};
    },
    approveIssueSnapshot(issueNumber, snapshot, replace = false) {
      if (!state) return snapshot;
      state.approvedIssueSnapshots ??= {};
      const key = String(issueNumber);
      const existing = state.approvedIssueSnapshots[key];
      if (existing && !replace) return existing;
      state.approvedIssueSnapshots[key] = snapshot;
      persist();
      return snapshot;
    },
    beginIssue(issue, startingCommit, continuation = false) {
      if (!state) return;
      if (state.issue && state.issue.number !== issue.number) {
        fail(`State ожидает issue #${state.issue.number}, но очередь выбрала #${issue.number}.`);
      }
      state.issue ??= {
        number: issue.number,
        title: issue.title,
        url: issue.url,
        body: issue.body ?? '',
        authorLogin: issue.authorLogin ?? null,
        authorAssociation: issue.authorAssociation ?? null,
        startingCommit,
        phase: 'agent-running',
        validationFixAttempts: 0,
        agentAttempts: 0,
        lastFailure: null,
        commit: null,
        pushedHead: null,
        expectedTree: null,
        commitMessage: null,
      };
      state.issue.phase = 'agent-running';
      state.issue.agentAttempts += 1;
      state.issue.continuation = continuation;
      persist();
      return state.issue;
    },
    updateIssue(values) {
      if (!state?.issue) return;
      Object.assign(state.issue, values);
      persist();
    },
    clearIssue() {
      if (!state) return;
      state.issue = null;
      persist();
    },
    get iterationsUsed() {
      return state?.iterationsUsed ?? 0;
    },
    reserveIteration() {
      if (!state) return null;
      state.iterationsUsed += 1;
      persist();
      return state.iterationsUsed;
    },
    releaseIteration() {
      if (!state) return null;
      state.iterationsUsed = Math.max(0, state.iterationsUsed - 1);
      persist();
      return state.iterationsUsed;
    },
    allowsDirtyRecovery(currentBranch, currentHead) {
      return Boolean(
        state?.issue &&
        currentBranch === state.branch &&
        currentHead === state.issue.startingCommit &&
        ['agent-running', 'working-tree', 'validating', 'staging'].includes(state.issue.phase),
      );
    },
    advancePhase(nextConfig) {
      if (!state) return false;
      if (state.issue !== null) {
        fail(`Нельзя перейти к следующей фазе: состояние issue #${state.issue.number} не очищено.`);
      }
      const expectedIndex = state.phaseIndex + 1;
      if (nextConfig.phaseIndex !== expectedIndex || nextConfig.phasePlanId !== state.phasePlanId) {
        fail('Следующая фаза не соответствует сохранённому плану Ralph Loop.');
      }
      state.phaseIndex = nextConfig.phaseIndex;
      state.branch = nextConfig.branch;
      state.baseBranch = nextConfig.baseBranch;
      state.milestone = nextConfig.milestone;
      state.iterationsUsed = 0;
      persist();
      return true;
    },
    finish() {
      state = null;
      removeFileIfExists(statePath);
    },
  };
}

function commitTrailerForIssue(issue) {
  return `Ralph-Issue: #${issue.number}`;
}

function commitStagedChanges(commitMessage, issue, timeoutMs, dependencies = {}) {
  const execute = dependencies.run ?? run;
  const emptyHooksDirectory = mkdtempSync(path.join(tmpdir(), 'ralph-empty-hooks-'));
  try {
    return execute(
      'git',
      [
        '-c',
        `core.hooksPath=${emptyHooksDirectory}`,
        'commit',
        '-m',
        commitMessage,
        '-m',
        commitTrailerForIssue(issue),
      ],
      { echoOutput: true, timeoutMs },
    );
  } finally {
    rmSync(emptyHooksDirectory, { recursive: true, force: true });
  }
}

function validateRecoveredCommit(issue, storedIssue, currentHead) {
  const commitCount = Number(
    run('git', ['rev-list', '--count', `${storedIssue.startingCommit}..${currentHead}`]).stdout,
  );
  const parent = run('git', ['show', '-s', '--format=%P', currentHead]).stdout;
  const tree = run('git', ['rev-parse', `${currentHead}^{tree}`]).stdout;
  const trailer = run('git', [
    'show',
    '-s',
    '--format=%(trailers:key=Ralph-Issue,valueonly)',
    currentHead,
  ]).stdout;
  if (
    commitCount !== 1 ||
    parent !== storedIssue.startingCommit ||
    !storedIssue.expectedTree ||
    tree !== storedIssue.expectedTree ||
    trailer !== `#${issue.number}`
  ) {
    fail(
      `Issue #${issue.number}: HEAD изменился во время staging, но новый commit не совпал ` +
        'с сохранёнными parent/tree/trailer. Автоматический reset запрещён.',
    );
  }
  return currentHead;
}

function reconcileStateAfterCrash(config, stateStore = activeStateStore) {
  const storedIssue = stateStore?.issue;
  if (!storedIssue || storedIssue.phase !== 'staging') return;

  const currentHead = run('git', ['rev-parse', 'HEAD']).stdout;
  const changes = run('git', ['status', '--porcelain']).stdout;
  if (currentHead !== storedIssue.startingCommit) {
    if (changes !== '') {
      fail(
        `Issue #${storedIssue.number}: после crash найден новый commit и дополнительные изменения. ` +
          'Ralph не будет автоматически смешивать или сбрасывать их.',
      );
    }
    const commit = validateRecoveredCommit(storedIssue, storedIssue, currentHead);
    stateStore.updateIssue({ phase: 'committed', commit, lastFailure: null });
    console.log(`Issue #${storedIssue.number}: распознан commit ${commit} после crash.`);
    return;
  }

  if (!storedIssue.expectedTree || !storedIssue.commitMessage) return;
  const indexTree = run('git', ['write-tree']).stdout;
  const unstaged = run('git', ['diff', '--quiet'], { allowFailure: true });
  const untracked = run('git', ['ls-files', '--others', '--exclude-standard']).stdout;
  if (indexTree !== storedIssue.expectedTree || unstaged.status !== 0 || untracked !== '') {
    return;
  }

  commitStagedChanges(storedIssue.commitMessage, storedIssue, config.runtime.validationTimeoutMs);
  const commit = validateRecoveredCommit(
    storedIssue,
    storedIssue,
    run('git', ['rev-parse', 'HEAD']).stdout,
  );
  stateStore.updateIssue({ phase: 'committed', commit, lastFailure: null });
  console.log(`Issue #${storedIssue.number}: staging завершён commit ${commit} после crash.`);
}

// -----------------------------------------------------------------------------
// Проверка инструментов, Git-репозитория и рабочей ветки
// -----------------------------------------------------------------------------

function verifyTools() {
  run('git', ['--version']);
  run('gh', ['--version']);
  run('codex', ['--version']);
  run('docker', ['version']);
  runNetwork('gh', ['auth', 'status']);
}

function verifyCodexAuthentication(dependencies = {}) {
  const execute = dependencies.run ?? run;
  const childEnvironment = createSandboxedCodexEnvironment(dependencies.env ?? process.env, {
    authenticationFile: dependencies.authenticationFile,
  });
  try {
    execute('codex', ['login', 'status'], {
      env: childEnvironment.env,
      timeoutMs: runtimeSettings.commandTimeoutMs,
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

function verifyRepository(config, requireClean) {
  const repositoryRoot = path.resolve(run('git', ['rev-parse', '--show-toplevel']).stdout);
  if (repositoryRoot.toLowerCase() !== path.resolve(projectRoot).toLowerCase()) {
    fail(`Скрипт ожидает Git-репозиторий ${projectRoot}, но нашёл ${repositoryRoot}.`);
  }

  run('git', ['check-ref-format', '--branch', config.branch]);
  let currentBranch = run('git', ['branch', '--show-current']).stdout;
  const changes = run('git', ['status', '--porcelain']).stdout;
  const currentHead = run('git', ['rev-parse', 'HEAD']).stdout;
  const recoveryAllowed = activeStateStore?.allowsDirtyRecovery(currentBranch, currentHead);
  if (requireClean && changes !== '' && !recoveryAllowed) {
    fail(
      'Рабочее дерево не чистое. Закоммитьте или уберите текущие изменения перед запуском Ralph Loop.',
    );
  }
  if (changes !== '' && recoveryAllowed) {
    console.log(
      `Найдена незавершённая работа Ralph для issue #${activeStateStore.issue.number}; ` +
        'AFK продолжит существующий diff без сброса.',
    );
  }

  if (currentBranch !== config.branch) {
    if (!requireClean) {
      fail(
        `Текущая ветка \"${currentBranch}\", а в конфиге указана \"${config.branch}\". ` +
          'Режим --check не переключает ветки.',
      );
    }

    const localBranchExists =
      run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${config.branch}`], {
        allowFailure: true,
      }).status === 0;

    if (localBranchExists) {
      run('git', ['switch', config.branch], { inherit: true });
    } else {
      const remoteBranchExists =
        runNetwork('git', ['ls-remote', '--exit-code', '--heads', 'origin', config.branch], {
          allowedExitCodes: [2],
        }).status === 0;

      if (remoteBranchExists) {
        runNetwork('git', ['fetch', 'origin', config.branch], { echoOutput: true });
        run('git', ['switch', '--track', '-c', config.branch, `origin/${config.branch}`], {
          inherit: true,
        });
      } else {
        runNetwork('git', ['fetch', 'origin', config.baseBranch], {
          echoOutput: true,
        });
        run('git', ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${config.baseBranch}`]);
        run('git', ['switch', '-c', config.branch, `origin/${config.baseBranch}`], {
          inherit: true,
        });
      }
    }

    currentBranch = run('git', ['branch', '--show-current']).stdout;
    if (currentBranch !== config.branch) {
      fail(`Не удалось перейти на ветку \"${config.branch}\".`);
    }
  }

  return { currentBranch, clean: changes === '' };
}

function verifyBaseHistory(config) {
  runNetwork('git', ['fetch', 'origin', config.baseBranch], { echoOutput: true });
  const baseRef = `origin/${config.baseBranch}`;
  run('git', ['show-ref', '--verify', '--quiet', `refs/remotes/${baseRef}`]);
  const mergeBase = run('git', ['merge-base', 'HEAD', baseRef], {
    allowFailure: true,
  });
  if (mergeBase.status !== 0 || mergeBase.stdout === '') {
    fail(
      `Ветка ${config.branch} не имеет общей истории с ${baseRef}. ` +
        `Исправьте baseBranch до запуска реализации или создания PR.`,
    );
  }

  return mergeBase.stdout;
}

function repositoryName() {
  const repository = parseJson(
    runNetwork('gh', ['repo', 'view', '--json', 'nameWithOwner']).stdout,
    'gh repo view',
  );
  return repository.nameWithOwner;
}

function githubPagedArray(repository, resource, fields, source, dependencies = {}) {
  const execute = dependencies.runNetwork ?? runNetwork;
  const maxPages = dependencies.maxPages ?? runtimeSettings.maxPages;
  const items = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const args = [
      'api',
      '--method',
      'GET',
      `repos/${repository}/${resource}`,
      ...fields.flatMap(([name, value]) => ['-f', `${name}=${value}`]),
      '-F',
      'per_page=100',
      '-F',
      `page=${page}`,
    ];
    const currentPage = parseJson(execute('gh', args).stdout, `${source}, page ${page}`);
    if (!Array.isArray(currentPage)) {
      fail(`${source} вернул не массив на странице ${page}.`);
    }
    items.push(...currentPage);
    if (currentPage.length < 100) return items;
  }
  fail(
    `${source} достиг лимита ${maxPages * 100} объектов. ` +
      'Увеличьте runtime.maxPages после проверки объёма.',
  );
}

// -----------------------------------------------------------------------------
// Получение milestone и очереди открытых GitHub issues
// -----------------------------------------------------------------------------

function verifyMilestone(repository, title) {
  const milestones = githubPagedArray(
    repository,
    'milestones',
    [['state', 'all']],
    'GitHub milestones API',
  );
  const matches = milestones.filter((milestone) => milestone.title === title);

  if (matches.length === 0) {
    fail(`Milestone с точным названием \"${title}\" не найден в ${repository}.`);
  }
  if (matches.length > 1) {
    fail(`В ${repository} найдено несколько milestones с названием \"${title}\".`);
  }

  return matches[0];
}

function openIssues(repository, milestone) {
  const issues = githubPagedArray(
    repository,
    'issues',
    [
      ['state', 'open'],
      ['milestone', milestone.number],
    ],
    'GitHub milestone issues API',
  );

  return issues
    .filter((issue) => !issue.pull_request)
    .map((issue) => ({
      number: issue.number,
      title: issue.title,
      body: issue.body,
      url: issue.html_url,
      updatedAt: issue.updated_at,
      authorLogin: issue.user?.login ?? null,
      authorAssociation: issue.author_association ?? null,
      labels: issue.labels ?? [],
    }))
    .filter((issue) => {
      if (!isRalphInfrastructureIssue(issue)) return true;
      console.log(
        `Issue #${issue.number} относится к Ralph-инфраструктуре и исключена из очереди.`,
      );
      return false;
    })
    .sort((left, right) => left.number - right.number);
}

function issueContentHash(issue) {
  const canonicalBody = String(issue.body ?? '')
    .replaceAll('\r\n', '\n')
    .replace(/\n+$/, '');
  return createHash('sha256')
    .update(JSON.stringify({ title: issue.title ?? '', body: canonicalBody }))
    .digest('hex');
}

function assertTrustedIssueAuthor(config, issue, repository) {
  if (isRalphInfrastructureIssue(issue)) {
    rejectUntrustedIssue(
      `Issue #${issue.number} относится к Ralph-инфраструктуре. ` +
        'Ralph выполняет только продуктовые задачи video-meetings; настройка цикла выполняется вручную.',
    );
  }
  const author = typeof issue.authorLogin === 'string' ? issue.authorLogin : '';
  const repositoryOwner = repository?.split('/')[0]?.toLowerCase();
  const trustedAuthors = new Set(
    [...(config.trustedIssueAuthors ?? []), repositoryOwner]
      .filter(Boolean)
      .map((trustedAuthor) => trustedAuthor.toLowerCase()),
  );
  if (!trustedAuthors.has(author.toLowerCase())) {
    rejectUntrustedIssue(
      `Issue #${issue.number} authored by "${author || 'unknown'}" is not trusted. ` +
        'Only the repository owner or authors configured in trustedIssueAuthors may provide AFK instructions.',
    );
  }
}

function approveConfiguredIssue(
  config,
  issue,
  repository,
  stateStore = activeStateStore,
  { replace = false } = {},
) {
  const key = String(issue.number);
  if ((config.approvedIssueSnapshots?.[key] && !replace) || !config.autoApproveConfiguredIssues) {
    return issue;
  }

  assertTrustedIssueAuthor(config, issue, repository);
  const snapshot = {
    title: issue.title,
    body: issueBodyWithoutRalphMetadata(issue),
  };
  const approvedSnapshot =
    stateStore?.approveIssueSnapshot(issue.number, snapshot, replace) ?? snapshot;
  config.approvedIssueSnapshots[key] = approvedSnapshot;
  console.log(
    `Issue #${issue.number}: immutable snapshot автоматически зафиксирован ` +
      'закоммиченным планом phases.',
  );
  return issue;
}

function rejectUntrustedIssue(message) {
  const error = new Error(message);
  error.code = 'RALPH_UNTRUSTED_ISSUE';
  throw error;
}

function assertTrustedIssue(config, issue, repository) {
  assertTrustedIssueAuthor(config, issue, repository);
  const snapshot = config.approvedIssueSnapshots?.[String(issue.number)];
  if (!snapshot) {
    rejectUntrustedIssue(
      `Issue #${issue.number} has no approved immutable snapshot. ` +
        'Add its exact title and body to approvedIssueSnapshots before AFK execution.',
    );
  }
  const issueAuthoredContent = {
    title: issue.title,
    body: issueBodyWithoutRalphMetadata(issue),
  };
  if (issueContentHash(issueAuthoredContent) !== issueContentHash(snapshot)) {
    rejectUntrustedIssue(
      `Issue #${issue.number} does not match the approved immutable snapshot. ` +
        'Its mutable GitHub title or body changed after approval; review and explicitly update the snapshot.',
    );
  }
  return {
    ...issue,
    title: snapshot.title,
    // Completion markers are only recovery pointers. Review context is retained
    // so the next implementation session receives the latest reviewer findings.
    body: issueBodyWithoutCompletionState(issue),
  };
}

// -----------------------------------------------------------------------------
// Формирование prompt для реализации одной issue
// -----------------------------------------------------------------------------

function renderTemplate(template, replacements) {
  let result = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    result = result.replaceAll(placeholder, value);
  }

  return result;
}

function renderPrompt(config, issue, rules) {
  const replacements = {
    '{milestone}': config.milestone,
    '{branch}': config.branch,
    '{issue_number}': String(issue.number),
    '{issue_title}': issue.title,
    '{issue_url}': issue.url,
    '{max_turns}': String(config.maxTurns),
    '{max_test_fix_attempts}': String(config.maxTestFixAttempts),
  };

  const prompt = renderTemplate(config.prompt, replacements);
  const renderedRules = renderTemplate(rules, replacements);
  const issueBody = issue.body?.trim() || '(Описание issue пустое.)';

  return `${prompt}\n\n## Текущая issue\n\n- Number: #${issue.number}\n- Title: ${issue.title}\n- URL: ${issue.url}\n\n### Body и критерии готовности\n\n${issueBody}\n\n---\n\n${renderedRules}`;
}

function buildIndependentReviewPrompt(issue, commit) {
  const issueBody = issue.body?.trim() || '(empty)';

  return `Review the current branch state at HEAD as the implementation of GitHub issue #${issue.number}: ${issue.title}. Commit ${commit} is the claimed implementation commit; inspect it as evidence, but verify that the current HEAD still satisfies the issue and has not regressed it.

Issue body:
${issueBody}

Complete the entire audit before deciding the verdict. Do not stop after the first problem. Return every distinct, actionable finding you can substantiate in this single response, without duplicates and without inventing findings to fill a quota.

Audit all of these areas:
- every requirement and definition-of-done item from the issue body;
- correctness, edge cases, regressions, security, and test coverage;
- interactions between all files changed for the issue, not only the most obvious file;
- public API response contracts, documentation, configuration, migrations, and deployment/runtime assumptions when relevant;
- whether tests assert the real externally observable behavior rather than only an implementation detail.

Discover documentation paths before reading them: use \`rg --files docs\` and repository file listings, then read only paths confirmed to exist. Never guess conventional paths such as \`docs/README.md\`. For public API work in this repository, treat \`README.md\`, \`docs/api.md\`, and \`docs/api-architecture.md\` as canonical entry points when those files exist, while still inspecting issue-specific documents returned by discovery.

Only report findings caused by the claimed implementation, regressions at current HEAD, or work required by the issue. Ignore unrelated pre-existing debt. Use verdict \"fail\" when at least one actionable finding exists; otherwise use \"pass\" with an empty findings array. Do not edit files.`;
}

// -----------------------------------------------------------------------------
// Проверка состояния issue и повторное открытие при ошибке
// -----------------------------------------------------------------------------

function issueDetails(repository, issueNumber) {
  return parseJson(
    runNetwork('gh', ['api', `repos/${repository}/issues/${issueNumber}`]).stdout,
    `GitHub issue ${issueNumber}`,
  );
}

function issueState(repository, issueNumber) {
  const issue = issueDetails(repository, issueNumber);
  return issue.state?.toUpperCase();
}

function refreshIssue(repository, issueNumber) {
  const issue = issueDetails(repository, issueNumber);
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    url: issue.html_url,
    state: issue.state?.toUpperCase(),
    updatedAt: issue.updated_at,
    authorLogin: issue.user?.login ?? null,
    authorAssociation: issue.author_association ?? null,
    labels: issue.labels ?? [],
  };
}

function patchIssue(repository, issueNumber, values) {
  return parseJson(
    runNetwork(
      'gh',
      ['api', '--method', 'PATCH', `repos/${repository}/issues/${issueNumber}`, '--input', '-'],
      { input: JSON.stringify(values) },
    ).stdout,
    `GitHub update issue ${issueNumber}`,
  );
}

function postIssueCommentOnce(repository, issueNumber, body, marker) {
  const comments = githubPagedArray(
    repository,
    `issues/${issueNumber}/comments`,
    [],
    `GitHub comments for issue #${issueNumber}`,
  );
  if (
    comments.some((comment) => typeof comment.body === 'string' && comment.body.includes(marker))
  ) {
    console.log(`Комментарий ${marker} уже опубликован в issue #${issueNumber}.`);
    return;
  }
  run(
    'gh',
    [
      'api',
      '--method',
      'POST',
      `repos/${repository}/issues/${issueNumber}/comments`,
      '--input',
      '-',
    ],
    { input: JSON.stringify({ body: `${marker}\n${body}`.slice(0, 60_000) }) },
  );
}

function reopenIssueWithComment(repository, issue, comment) {
  if (issueState(repository, issue.number) === 'CLOSED') {
    patchIssue(repository, issue.number, { state: 'open' });
  }

  const fingerprint = createHash('sha256').update(comment).digest('hex').slice(0, 20);
  postIssueCommentOnce(
    repository,
    issue.number,
    comment,
    `<!-- ralph-issue-comment id:${fingerprint} -->`,
  );
}

function formatReviewComment(review) {
  const findings = review.findings
    .map((finding) => {
      const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
      return `- **${finding.severity} — ${finding.title}** (${location})\n  ${finding.body}`;
    })
    .join('\n');

  return `## Ralph Loop: independent review found problems\n\n${review.summary}\n\n${findings}\n\nIssue reopened. Fix the findings, rerun the relevant checks, and start Ralph Loop again.`;
}

function normalizeReviewResult(review) {
  if (review.verdict === 'fail' && review.findings.length === 0) {
    fail('Review returned FAIL without actionable findings.');
  }

  if (review.verdict === 'pass' && review.findings.length > 0) {
    return {
      ...review,
      verdict: 'fail',
      summary:
        `Codex returned PASS together with ${review.findings.length} actionable findings. ` +
        `Ralph treated the result as FAIL. ${review.summary}`,
    };
  }

  return review;
}

const reviewContextPattern =
  /\n*<!-- ralph-issue-review-context:start -->[\s\S]*?<!-- ralph-issue-review-context:end -->\n*/g;

function issueBodyWithoutRalphMetadata(issue) {
  return issueBodyWithoutCompletionState(issue).replace(reviewContextPattern, '').trim();
}

function issueBodyWithReviewContext(issue, review) {
  const startMarker = '<!-- ralph-issue-review-context:start -->';
  const endMarker = '<!-- ralph-issue-review-context:end -->';
  const originalBody = issueBodyWithoutCompletionState(issue)
    .replace(reviewContextPattern, '')
    .trimEnd();
  const reviewContext = formatReviewComment(review).replace(
    '\n\nIssue reopened. Fix the findings, rerun the relevant checks, and start Ralph Loop again.',
    '',
  );
  return `${originalBody}\n\n${startMarker}\n${reviewContext}\n${endMarker}`.trim();
}

function updateIssueReviewContext(repository, issue, review) {
  const latest = issueDetails(repository, issue.number);
  const updatedBody = issueBodyWithReviewContext({ ...issue, body: latest.body }, review);
  issue.body = patchIssue(repository, issue.number, { body: updatedBody }).body;
}

function issueBodyWithoutCompletionState(issue) {
  return (issue.body ?? '')
    .replace(
      /\n*<!-- ralph-issue-completion status:(?:pending-review|review-passed) commit:[0-9a-f]{40} -->\n*/gi,
      '\n',
    )
    .trim();
}

function issueCompletionState(issue) {
  const match = (issue.body ?? '').match(
    /<!-- ralph-issue-completion status:(pending-review|review-passed) commit:([0-9a-f]{40}) -->/i,
  );
  return match ? { status: match[1].toLowerCase(), commit: match[2].toLowerCase() } : null;
}

function issueBodyWithCompletionState(issue, status, commit) {
  const body = issueBodyWithoutCompletionState(issue);
  return `${body}\n\n<!-- ralph-issue-completion status:${status} commit:${commit} -->`.trim();
}

function setIssueCompletionState(repository, issue, status, commit) {
  const latest = issueDetails(repository, issue.number);
  const updatedBody = issueBodyWithCompletionState({ ...issue, body: latest.body }, status, commit);
  issue.body = patchIssue(repository, issue.number, { body: updatedBody }).body;
}

function clearIssueCompletionState(repository, issue) {
  const latest = issueDetails(repository, issue.number);
  const updatedBody = issueBodyWithoutCompletionState({ ...issue, body: latest.body });
  if (updatedBody === (latest.body ?? '').trim()) {
    issue.body = latest.body ?? '';
    return;
  }

  issue.body = patchIssue(repository, issue.number, { body: updatedBody }).body;
}

// -----------------------------------------------------------------------------
// Локальное ревью commit одной issue на модели Terra
// -----------------------------------------------------------------------------

async function runIndependentReview(config, repository, issue, commit) {
  if (!config.review.enabled) {
    return { verdict: 'pass', summary: 'Independent review is disabled.', findings: [] };
  }

  const reviewedHead = run('git', ['rev-parse', 'HEAD']).stdout;
  const reviewedBranch = run('git', ['branch', '--show-current']).stdout;
  if (existsSync(config.review.outputPath)) {
    unlinkSync(config.review.outputPath);
  }

  const reviewPrompt = buildIndependentReviewPrompt(issue, commit);

  console.log(`\n=== Independent Codex review for issue #${issue.number} ===\n`);

  await runCodexWithTurnLimit(
    [
      'exec',
      '--sandbox',
      'read-only',
      '--json',
      '--model',
      config.review.model,
      '--output-schema',
      config.review.schemaPath,
      '--output-last-message',
      config.review.outputPath,
      '-',
    ],
    {
      input: reviewPrompt,
      maxTurns: config.maxTurns,
      timeoutMs: config.runtime.codexTimeoutMs,
      label: `Review issue #${issue.number}`,
    },
  );

  if (!existsSync(config.review.outputPath)) {
    fail(`Review issue #${issue.number} не создал файл результата.`);
  }

  let review = parseJson(readFileSync(config.review.outputPath, 'utf8'), config.review.outputPath);

  if (
    !['pass', 'fail'].includes(review.verdict) ||
    typeof review.summary !== 'string' ||
    !Array.isArray(review.findings)
  ) {
    fail(`Review issue #${issue.number} вернул некорректный результат.`);
  }

  review = normalizeReviewResult(review);

  const changes = run('git', ['status', '--porcelain']).stdout;
  const headAfterReview = run('git', ['rev-parse', 'HEAD']).stdout;
  const branchAfterReview = run('git', ['branch', '--show-current']).stdout;
  if (changes !== '' || headAfterReview !== reviewedHead || branchAfterReview !== reviewedBranch) {
    fail(`Review issue #${issue.number} изменил рабочее дерево.`);
  }

  if (review.verdict !== 'pass' || review.findings.length > 0) {
    console.log(
      `Review issue #${issue.number}: FAIL — найдено замечаний: ${review.findings.length}.`,
    );
    return review;
  }

  console.log(`Review issue #${issue.number}: PASS — ${review.summary}`);
  return review;
}

// -----------------------------------------------------------------------------
// Подготовка commit и закрытие issue силами оркестратора
// -----------------------------------------------------------------------------

function commitMessageFromAgent(lastAgentMessage, issue) {
  const marker = lastAgentMessage.match(/^COMMIT_MESSAGE:\s*(.+)$/im)?.[1]?.trim();
  if (
    marker &&
    marker.length <= 120 &&
    /^(feat|fix|docs|test|refactor|perf|build|ci|chore): [^\r\n]+$/.test(marker)
  ) {
    return marker;
  }

  return `chore: complete issue #${issue.number}`;
}

function alreadyFixedCommitFromAgent(lastAgentMessage) {
  return (
    String(lastAgentMessage ?? '')
      .trimEnd()
      .match(/(?:^|\r?\n)ALREADY_FIXED:\s*([0-9a-f]{7,40})\s*$/i)?.[1] ?? null
  );
}

function linkedCommitForIssue(issue, execute = run) {
  const issueUpdatedAt = Date.parse(issue.updatedAt ?? '');
  if (!Number.isFinite(issueUpdatedAt)) return null;

  const candidate = execute(
    'git',
    [
      'log',
      '-1',
      '--format=%H%x09%cI',
      '--fixed-strings',
      '--grep',
      commitTrailerForIssue(issue),
      'HEAD',
    ],
    { allowFailure: true },
  );
  if (candidate.status !== 0 || candidate.stdout === '') return null;

  const [commit, committedAtText] = candidate.stdout.split('\t');
  const committedAt = Date.parse(committedAtText);
  if (!/^[0-9a-f]{40}$/i.test(commit) || !Number.isFinite(committedAt)) return null;

  // Старый trailer не должен автоматически закрывать issue, которую позднее
  // переоткрыли или дополнили новым review-контекстом.
  if (committedAt <= issueUpdatedAt) return null;

  const trailer = execute('git', [
    'show',
    '-s',
    '--format=%(trailers:key=Ralph-Issue,valueonly)',
    commit,
  ]).stdout;
  return trailer === `#${issue.number}` ? commit : null;
}

function verifiedIssueCommit(commit, issue) {
  const resolved = run('git', ['rev-parse', '--verify', `${commit}^{commit}`], {
    allowFailure: true,
  });
  if (resolved.status !== 0 || !/^[0-9a-f]{40}$/.test(resolved.stdout)) {
    fail(`Issue #${issue.number}: commit ${commit} не найден.`);
  }

  const ancestor = run('git', ['merge-base', '--is-ancestor', resolved.stdout, 'HEAD'], {
    allowFailure: true,
  });
  if (ancestor.status !== 0) {
    fail(`Issue #${issue.number}: commit ${resolved.stdout} не принадлежит текущей ветке.`);
  }
  return resolved.stdout;
}

function closeIssue(config, repository, issue, commit) {
  const completion = config.review.enabled
    ? 'Ralph Loop validations and independent review passed.'
    : 'Ralph Loop validations passed; independent review is disabled in config.';
  const commentMarker = `<!-- ralph-issue-complete commit:${commit} -->`;
  postIssueCommentOnce(
    repository,
    issue.number,
    `Implemented in commit ${commit}. ${completion}`,
    commentMarker,
  );

  const closedIssue = patchIssue(repository, issue.number, {
    state: 'closed',
    state_reason: 'completed',
  });
  if (closedIssue.state?.toUpperCase() !== 'CLOSED') {
    fail(`Issue #${issue.number} не закрылась после успешной реализации.`);
  }
}

function verifyPushedHead(config, expectedHead) {
  const currentBranch = run('git', ['branch', '--show-current']).stdout;
  const localHead = run('git', ['rev-parse', 'HEAD']).stdout;
  const changes = run('git', ['status', '--porcelain']).stdout;
  const remote = runNetwork('git', [
    'ls-remote',
    '--heads',
    'origin',
    `refs/heads/${config.branch}`,
  ]).stdout;
  const remoteHead = remote.split(/\s+/)[0] ?? '';
  if (
    currentBranch !== config.branch ||
    localHead !== expectedHead ||
    remoteHead !== expectedHead ||
    changes !== ''
  ) {
    fail(
      `Проверка pushed HEAD не прошла: branch=${currentBranch}, local=${localHead}, ` +
        `remote=${remoteHead || 'пусто'}, expected=${expectedHead}, dirty=${changes !== ''}.`,
    );
  }
  return expectedHead;
}

function pushBranchAndVerify(config) {
  const localHead = run('git', ['rev-parse', 'HEAD']).stdout;
  try {
    runNetwork('git', ['push', '--set-upstream', 'origin', config.branch], {
      echoOutput: true,
    });
  } catch (pushError) {
    try {
      verifyPushedHead(config, localHead);
      console.log(
        `Push вернул ошибку, но remote уже содержит ${localHead}; продолжаем идемпотентно.`,
      );
    } catch {
      throw pushError;
    }
  }
  return verifyPushedHead(config, localHead);
}

async function runReviewWithRetries(config, operation, label) {
  let lastError;
  for (let attempt = 1; attempt <= config.runtime.reviewRetryAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (error.nonRetryable || attempt === config.runtime.reviewRetryAttempts) throw error;
      const delay = Math.min(config.runtime.networkRetryBaseDelayMs * 2 ** (attempt - 1), 30_000);
      console.error(
        `${label} технически не завершился (попытка ${attempt}): ${error.message}. ` +
          `Повтор через ${delay} ms.`,
      );
      waitSync(delay);
    }
  }
  throw lastError;
}

async function reviewAndCloseCommittedIssue(config, repository, issue, commit, markPending = true) {
  const pushedHead = pushBranchAndVerify(config);
  activeStateStore?.updateIssue({
    phase: 'pushed',
    commit,
    pushedHead,
    lastFailure: null,
  });

  if (!config.review.enabled) {
    verifyPushedHead(config, pushedHead);
    closeIssue(config, repository, issue, commit);
    activeStateStore?.clearIssue();
    return {
      completed: true,
      commit,
      review: { verdict: 'pass', summary: 'Independent review is disabled.', findings: [] },
    };
  }

  if (markPending) {
    setIssueCompletionState(repository, issue, 'pending-review', commit);
  }
  activeStateStore?.updateIssue({ phase: 'reviewing' });
  let review;
  try {
    review = await runReviewWithRetries(
      config,
      () => runIndependentReview(config, repository, issue, commit),
      `Review issue #${issue.number}`,
    );
  } catch (error) {
    activeStateStore?.updateIssue({
      phase: 'pushed',
      lastFailure: error.message,
    });
    try {
      reopenIssueWithComment(
        repository,
        issue,
        `## Ralph Loop: independent review did not complete\n\n${error.message}\n\nThe pushed commit is preserved. AFK will retry the review on the next run.`,
      );
    } catch (commentError) {
      console.error(
        `Не удалось опубликовать техническую ошибку review issue #${issue.number}: ${commentError.message}`,
      );
    }
    throw error;
  }
  if (review.verdict !== 'pass' || review.findings.length > 0) {
    updateIssueReviewContext(repository, issue, review);
    reopenIssueWithComment(repository, issue, formatReviewComment(review));
    activeStateStore?.clearIssue();
    return { completed: false, commit, review };
  }

  verifyPushedHead(config, pushedHead);
  // Удаляем recovery-marker до закрытия: позднее ручное reopen должно снова
  // пройти обычную реализацию, а не использовать старый commit как актуальный.
  clearIssueCompletionState(repository, issue);
  try {
    closeIssue(config, repository, issue, commit);
  } catch (error) {
    // Если закрытие технически не удалось, стараемся сохранить точку resume.
    try {
      setIssueCompletionState(repository, issue, 'pending-review', commit);
    } catch (restoreError) {
      console.error(
        `Не удалось восстановить состояние pending-review для issue #${issue.number}: ${restoreError.message}`,
      );
    }
    throw error;
  }
  activeStateStore?.clearIssue();
  return { completed: true, commit, review };
}

async function resumeIssueCompletion(config, repository, issue, completion) {
  const commit = verifiedIssueCommit(completion.commit, issue);
  if (run('git', ['status', '--porcelain']).stdout !== '') {
    fail(`Issue #${issue.number}: нельзя продолжить review при грязном рабочем дереве.`);
  }

  // Marker хранится в редактируемом body issue и служит только указателем на
  // commit. Он не является доверенным доказательством пройденных проверок.
  runConfiguredValidation(config);
  if (run('git', ['status', '--porcelain']).stdout !== '') {
    fail(`Issue #${issue.number}: проверки при возобновлении изменили рабочее дерево.`);
  }

  console.log(
    `Issue #${issue.number}: повторяем validations и review commit ${commit} ` +
      `(сохранённое состояние: ${completion.status}).`,
  );
  return reviewAndCloseCommittedIssue(config, repository, issue, commit, false);
}

async function commitAndCompleteIssue(config, repository, issue, startingCommit, lastAgentMessage) {
  assertTrustedControlFilesUnchanged(config);
  const currentBranch = run('git', ['branch', '--show-current']).stdout;
  const currentCommit = run('git', ['rev-parse', 'HEAD']).stdout;
  const changes = run('git', ['status', '--porcelain']).stdout;
  const violations = [];

  if (currentBranch !== config.branch) {
    violations.push(`Codex переключился на ветку ${currentBranch}`);
  }
  if (currentCommit !== startingCommit) {
    violations.push('Codex самостоятельно создал commit');
  }
  if (issueState(repository, issue.number) !== 'OPEN') {
    violations.push('Codex самостоятельно изменил состояние issue');
  }
  if (violations.length > 0) {
    fail(`Issue #${issue.number}: ${violations.join('; ')}. Цикл остановлен.`);
  }

  if (changes === '') {
    const alreadyFixedCommit = alreadyFixedCommitFromAgent(lastAgentMessage);
    if (!alreadyFixedCommit) {
      fail(`Issue #${issue.number}: Codex не оставил изменений и не указал ALREADY_FIXED commit.`);
    }
    const commit = verifiedIssueCommit(alreadyFixedCommit, issue);
    activeStateStore?.updateIssue({ phase: 'validating' });
    try {
      runConfiguredValidation(config);
    } catch (error) {
      const attempts = (activeStateStore?.issue?.validationFixAttempts ?? 0) + 1;
      activeStateStore?.updateIssue({
        phase: 'working-tree',
        validationFixAttempts: attempts,
        lastFailure: error.message,
      });
      if (attempts >= config.maxTestFixAttempts) throw error;
      console.error(
        `Issue #${issue.number}: validation не прошла (${attempts}/${config.maxTestFixAttempts}); ` +
          'Ralph передаст ошибку Terra на следующей итерации.',
      );
      return { completed: false, validationFailed: true };
    }
    if (run('git', ['status', '--porcelain']).stdout !== '') {
      fail(`Issue #${issue.number}: проверки already-fixed решения изменили рабочее дерево.`);
    }
    return reviewAndCloseCommittedIssue(config, repository, issue, commit);
  }

  activeStateStore?.updateIssue({ phase: 'validating' });
  try {
    runConfiguredValidation(config);
  } catch (error) {
    const attempts = (activeStateStore?.issue?.validationFixAttempts ?? 0) + 1;
    activeStateStore?.updateIssue({
      phase: 'working-tree',
      validationFixAttempts: attempts,
      lastFailure: error.message,
    });
    if (attempts >= config.maxTestFixAttempts) throw error;
    console.error(
      `Issue #${issue.number}: validation не прошла (${attempts}/${config.maxTestFixAttempts}); ` +
        'Ralph продолжит исправление существующего diff.',
    );
    return { completed: false, validationFailed: true };
  }
  const changesAfterValidation = run('git', ['status', '--porcelain']).stdout;
  if (changesAfterValidation !== changes) {
    fail(
      `Issue #${issue.number}: проектные проверки изменили рабочее дерево. ` +
        'Проверьте generated-файлы перед повторным запуском.',
    );
  }
  activeStateStore?.updateIssue({ phase: 'staging' });
  run('git', ['add', '--all']);

  const stagedDiff = run('git', ['diff', '--cached', '--quiet'], {
    allowFailure: true,
  });
  if (stagedDiff.status === 0) {
    fail(`Issue #${issue.number}: после staging нет изменений для commit.`);
  }
  if (stagedDiff.status !== 1) {
    fail(`Issue #${issue.number}: не удалось проверить staged diff.`);
  }

  const commitMessage = commitMessageFromAgent(lastAgentMessage, issue);
  const expectedTree = run('git', ['write-tree']).stdout;
  activeStateStore?.updateIssue({
    phase: 'staging',
    expectedTree,
    commitMessage,
  });
  commitStagedChanges(commitMessage, issue, config.runtime.validationTimeoutMs);

  const commitCount = Number(run('git', ['rev-list', '--count', `${startingCommit}..HEAD`]).stdout);
  const remainingChanges = run('git', ['status', '--porcelain']).stdout;
  if (commitCount !== 1 || remainingChanges !== '') {
    fail(
      `Issue #${issue.number}: оркестратор ожидал один commit и чистое дерево, ` +
        `получено commits=${commitCount}, changes=${remainingChanges ? 'yes' : 'no'}.`,
    );
  }

  const commit = run('git', ['rev-parse', 'HEAD']).stdout;
  const committedTree = run('git', ['rev-parse', `${commit}^{tree}`]).stdout;
  if (committedTree !== expectedTree) {
    fail(`Issue #${issue.number}: tree созданного commit не совпал с проверенным staged tree.`);
  }
  activeStateStore?.updateIssue({
    phase: 'committed',
    commit,
    pushedHead: null,
    lastFailure: null,
  });
  return reviewAndCloseCommittedIssue(config, repository, issue, commit);
}

// -----------------------------------------------------------------------------
// Реализация одной issue на Terra и проверка правил завершения
// -----------------------------------------------------------------------------

async function runCodex(config, repository, issue, rules) {
  issue = assertTrustedIssue(config, issue, repository);
  const storedIssue =
    activeStateStore?.issue?.number === issue.number ? activeStateStore.issue : null;
  if (storedIssue?.commit && ['committed', 'pushed', 'reviewing'].includes(storedIssue.phase)) {
    if (run('git', ['status', '--porcelain']).stdout !== '') {
      fail(`Issue #${issue.number}: committed recovery требует чистое рабочее дерево.`);
    }
    const commit = verifiedIssueCommit(storedIssue.commit, issue);
    console.log(
      `Issue #${issue.number}: продолжаем pipeline с сохранённого commit ${commit} ` +
        `(phase=${storedIssue.phase}).`,
    );
    const resumePhase = storedIssue.phase;
    try {
      runConfiguredValidation(config);
    } catch (error) {
      activeStateStore.updateIssue({ phase: resumePhase, lastFailure: error.message });
      throw error;
    }
    return reviewAndCloseCommittedIssue(config, repository, issue, commit);
  }

  const completion = issueCompletionState(issue);
  if (completion?.status === 'pending-review') {
    return resumeIssueCompletion(config, repository, issue, completion);
  }
  if (completion) {
    // Совместимость со старым review-passed marker: он не является доверенным
    // состоянием и не должен обходить новую реализацию после reopen.
    clearIssueCompletionState(repository, issue);
  }

  const currentHead = run('git', ['rev-parse', 'HEAD']).stdout;
  const continuation = Boolean(storedIssue);
  const startingCommit = storedIssue?.startingCommit ?? currentHead;
  if (startingCommit !== currentHead) {
    fail(
      `Issue #${issue.number}: recovery ожидал HEAD ${startingCommit}, но найден ${currentHead}.`,
    );
  }
  activeStateStore?.beginIssue(issue, startingCommit, continuation);

  const linkedCommit = issue.linkedCommit ?? linkedCommitForIssue(issue);
  if (!continuation && linkedCommit) {
    console.log(
      `Issue #${issue.number}: найден свежий commit ${linkedCommit} с trailer ` +
        `${commitTrailerForIssue(issue)}; повторная Terra-сессия не требуется.`,
    );
    return commitAndCompleteIssue(
      config,
      repository,
      issue,
      startingCommit,
      `ALREADY_FIXED: ${linkedCommit}`,
    );
  }

  let codexResult;
  console.log(`\n=== Issue #${issue.number}: ${issue.title} ===\n`);
  try {
    codexResult = await runCodexWithTurnLimit(developmentCodexArguments(config), {
      input:
        renderPrompt(config, issue, rules) +
        (continuation
          ? `\n\n## AFK recovery\n\nЭто продолжение незавершённой сессии Ralph. Не сбрасывай существующие изменения. Изучи текущий git diff, продолжи реализацию той же issue и исправь последний сбой оркестратора:\n\n${storedIssue.lastFailure ?? 'процесс завершился до фиксации результата'}`
          : ''),
      maxTurns: config.maxTurns,
      timeoutMs: config.runtime.codexTimeoutMs,
      label: `Codex issue #${issue.number}`,
    });
  } catch (error) {
    activeStateStore?.updateIssue({
      phase: 'working-tree',
      lastFailure: error.message,
    });
    if (error.code === 'RALPH_CODEX_AUTH') {
      throw error;
    }
    if (['RALPH_MAX_TURNS', 'RALPH_CODEX_TIMEOUT'].includes(error.code)) {
      reopenIssueWithComment(
        repository,
        issue,
        `## Ralph Loop: Codex circuit breaker\n\nThe Codex session was stopped by **${error.code}** after ${error.turns ?? 'an unknown number of'} observable steps. Existing work is preserved and AFK will continue the same issue while the shared iteration budget allows.`,
      );
    }
    console.error(
      `Issue #${issue.number}: Terra-сессия не завершилась; существующий diff сохранён: ${error.message}`,
    );
    return { completed: false, agentFailed: true };
  }

  if (agentReportedWriteAccessFailure(codexResult.lastAgentMessage)) {
    const error = new Error(
      `Issue #${issue.number}: дочерний Codex сообщил об отсутствии write-доступа, ` +
        'хотя development-сессия запущена с danger-full-access.',
    );
    error.code = 'RALPH_AGENT_WRITE_ACCESS';
    activeStateStore?.updateIssue({ phase: 'working-tree', lastFailure: error.message });
    throw error;
  }

  return commitAndCompleteIssue(
    config,
    repository,
    issue,
    startingCommit,
    codexResult.lastAgentMessage,
  );
}

// -----------------------------------------------------------------------------
// Финальные проверки, push ветки и создание draft Pull Request
// -----------------------------------------------------------------------------

function existingPullRequest(config, repository) {
  const pullRequests = parseJson(
    runNetwork('gh', [
      'pr',
      'list',
      '--repo',
      repository,
      '--state',
      'open',
      '--head',
      config.branch,
      '--limit',
      '100',
      '--json',
      'number,url',
    ]).stdout,
    'gh pr list',
  );
  return pullRequests[0] ?? null;
}

function pullRequestDetails(repository, pullRequest) {
  return parseJson(
    runNetwork('gh', [
      'pr',
      'view',
      String(pullRequest),
      '--repo',
      repository,
      '--json',
      'number,url,title,headRefOid,headRefName,baseRefName',
    ]).stdout,
    `gh pr view ${pullRequest}`,
  );
}

function verifyPullRequestTarget(config, pullRequest) {
  const localHead = run('git', ['rev-parse', 'HEAD']).stdout;
  const violations = [];
  if (pullRequest.headRefName !== config.branch) {
    violations.push(`head=${pullRequest.headRefName}`);
  }
  if (pullRequest.baseRefName !== config.baseBranch) {
    violations.push(`base=${pullRequest.baseRefName}`);
  }
  if (pullRequest.headRefOid !== localHead) {
    violations.push(`GitHub head=${pullRequest.headRefOid}, local HEAD=${localHead}`);
  }
  if (violations.length > 0) {
    fail(`PR #${pullRequest.number} не соответствует текущему запуску: ${violations.join('; ')}.`);
  }

  return pullRequest;
}

function verifyReviewedPullRequestHead(config, repository, pullRequest) {
  const refreshed = verifyPullRequestTarget(
    config,
    pullRequestDetails(repository, pullRequest.number),
  );
  if (refreshed.headRefOid !== pullRequest.headRefOid) {
    fail(
      `PR #${pullRequest.number} изменился во время milestone review: ` +
        `${pullRequest.headRefOid} -> ${refreshed.headRefOid}. Нужен review нового HEAD.`,
    );
  }
  verifyPushedHead(config, pullRequest.headRefOid);
  return refreshed;
}

function validationContainerRunArgs(config, scripts, snapshotPath) {
  const scriptList = Array.isArray(scripts) ? scripts : [scripts];
  return [
    'run',
    '--rm',
    '--init',
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '512',
    '--user',
    '65532:65532',
    '--tmpfs',
    '/workspace:rw,exec,nosuid,nodev,size=4g,uid=65532,gid=65532',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,nodev,size=1g,uid=65532,gid=65532',
    '--mount',
    `type=bind,source=${snapshotPath},target=/source,readonly`,
    '--workdir',
    '/workspace',
    '--env',
    'HOME=/tmp',
    config.validationContainer.image,
    ...scriptList,
  ];
}

function createValidationWorkspaceSnapshot() {
  const snapshotPath = mkdtempSync(path.join(tmpdir(), 'ralph-validation-'));
  try {
    const files = run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
      .stdout.split('\0')
      .filter(Boolean);
    for (const relativePath of files) {
      const normalizedPath = path.normalize(relativePath);
      if (
        normalizedPath === '.' ||
        path.isAbsolute(normalizedPath) ||
        normalizedPath.startsWith(`..${path.sep}`) ||
        normalizedPath === '..'
      ) {
        fail(`Небезопасный путь в git ls-files: ${relativePath}`);
      }
      const sourcePath = path.join(projectRoot, normalizedPath);
      if (lstatSync(sourcePath).isSymbolicLink()) {
        fail(`Validation snapshot не допускает symbolic link: ${relativePath}`);
      }
      const destinationPath = path.join(snapshotPath, normalizedPath);
      mkdirSync(path.dirname(destinationPath), { recursive: true });
      copyFileSync(sourcePath, destinationPath);
    }
    return snapshotPath;
  } catch (error) {
    rmSync(snapshotPath, { recursive: true, force: true });
    throw error;
  }
}

const validationDependencyFiles = [
  '.env.example',
  'package.json',
  'package-lock.json',
  'apps/api/package.json',
  'apps/web/package.json',
  'scripts/ralph/ralph-validation-docker-shim.sh',
  'scripts/ralph/ralph-validation-entrypoint.sh',
];

function createTrustedValidationDependencySnapshot() {
  const snapshotPath = mkdtempSync(path.join(tmpdir(), 'ralph-validation-dependencies-'));
  try {
    const prismaFiles = run('git', [
      'ls-tree',
      '-r',
      '--name-only',
      'HEAD',
      '--',
      'apps/api/prisma',
    ])
      .stdout.split('\n')
      .filter(Boolean);
    for (const relativePath of [...validationDependencyFiles, ...prismaFiles]) {
      const gitPath = relativePath.split(path.sep).join('/');
      const destinationPath = path.join(snapshotPath, relativePath);
      mkdirSync(path.dirname(destinationPath), { recursive: true });
      writeFileSync(destinationPath, run('git', ['show', `HEAD:${gitPath}`]).stdout);
    }
    return snapshotPath;
  } catch (error) {
    rmSync(snapshotPath, { recursive: true, force: true });
    throw error;
  }
}

function validationInputHash(snapshotPath, hash = createHash('sha256'), relativePath = '') {
  const entries = readdirSync(snapshotPath, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  for (const entry of entries) {
    const nextRelativePath = path.join(relativePath, entry.name);
    const entryPath = path.join(snapshotPath, entry.name);
    if (entry.isDirectory()) {
      validationInputHash(entryPath, hash, nextRelativePath);
    } else if (entry.isFile()) {
      hash
        .update(`${nextRelativePath.replaceAll(path.sep, '/')}\0`)
        .update(readFileSync(entryPath));
    } else {
      fail(`Validation dependency snapshot содержит неподдерживаемый файл: ${nextRelativePath}`);
    }
  }
  return hash;
}

function validationImageForSnapshot(config, snapshotPath) {
  const inputsHash = validationInputHash(snapshotPath);
  const dockerfilePath =
    config.validationContainer.frozenDockerfilePath ?? config.validationContainer.dockerfilePath;
  if (dockerfilePath) {
    inputsHash.update('Dockerfile.validation\0').update(readFileSync(dockerfilePath));
  }
  const inputHash = inputsHash.digest('hex').slice(0, 16);
  const imageRepository = config.validationContainer.image.split('@', 1)[0];
  return `${imageRepository}-inputs-${inputHash}`;
}

function ensureValidationImage(config, snapshotPath, dependencies = {}) {
  const execute = dependencies.run ?? run;
  const dockerfilePath =
    config.validationContainer.frozenDockerfilePath ?? config.validationContainer.dockerfilePath;
  const image = validationImageForSnapshot(config, snapshotPath);
  if (preparedValidationImages.has(image)) return image;
  const existingImage = execute('docker', ['image', 'inspect', image], {
    allowFailure: true,
    allowedExitCodes: [1],
    env: credentialFreeEnvironment(),
  });
  if (existingImage.status === 0) {
    preparedValidationImages.add(image);
    return image;
  }
  if (existingImage.status !== 1) {
    fail(`Не удалось проверить образ изоляции валидации ${image}.`);
  }
  console.log(`\n=== Validation isolation: docker build ${image} ===\n`);
  execute('docker', ['build', '--file', dockerfilePath, '--tag', image, snapshotPath], {
    echoOutput: true,
    timeoutMs: config.runtime.validationTimeoutMs,
    env: credentialFreeEnvironment(),
  });
  preparedValidationImages.add(image);
  return image;
}

function runConfiguredScripts(config, scripts, label, options = {}) {
  const includePreflight = options.includePreflight ?? true;
  const execute = options.run ?? run;
  if (scripts.length === 0) return;
  assertTrustedControlFilesUnchanged(config);
  for (const script of scripts) {
    const snapshotPath = createValidationWorkspaceSnapshot();
    const dependencySnapshotPath = createTrustedValidationDependencySnapshot();
    console.log(`\n=== ${label}: isolated npm run ${script} ===\n`);
    try {
      const isolatedScripts = includePreflight ? [...config.preflightScripts, script] : [script];
      const image = ensureValidationImage(config, dependencySnapshotPath, { run: execute });
      execute(
        'docker',
        validationContainerRunArgs(
          { ...config, validationContainer: { ...config.validationContainer, image } },
          isolatedScripts,
          snapshotPath,
        ),
        {
          echoOutput: true,
          timeoutMs: config.runtime.validationTimeoutMs,
          env: credentialFreeEnvironment(),
        },
      );
    } catch (error) {
      error.code = error.code === 'RALPH_COMMAND_TIMEOUT' ? error.code : 'RALPH_VALIDATION_FAILED';
      error.script = script;
      throw error;
    } finally {
      rmSync(snapshotPath, { recursive: true, force: true });
      rmSync(dependencySnapshotPath, { recursive: true, force: true });
    }
  }
}

function runPreflight(config) {
  runConfiguredScripts(config, config.preflightScripts, 'Preflight', { includePreflight: false });
}

function runConfiguredValidation(config) {
  // Каждый validation-запуск получает новую изолированную БД и повторяет preflight,
  // чтобы migration текущей issue была применена внутри того же контейнера.
  runConfiguredScripts(config, config.validationScripts, 'Validation');
}

function createPullRequest(config, repository) {
  const changes = run('git', ['status', '--porcelain']).stdout;
  if (changes !== '') {
    fail('Нельзя создать PR: в рабочем дереве есть незакоммиченные изменения.');
  }

  runConfiguredValidation(config);
  if (run('git', ['status', '--porcelain']).stdout !== '') {
    fail('Нельзя обновить PR: проектные проверки изменили чистое рабочее дерево.');
  }
  runNetwork('git', ['fetch', 'origin', config.baseBranch], { echoOutput: true });
  const commitCount = Number(
    run('git', ['rev-list', '--count', `origin/${config.baseBranch}..HEAD`]).stdout,
  );
  if (!Number.isInteger(commitCount) || commitCount < 1) {
    fail(`В ветке ${config.branch} нет коммитов поверх origin/${config.baseBranch}.`);
  }

  pushBranchAndVerify(config);

  const existing = existingPullRequest(config, repository);
  if (existing) {
    console.log(`PR уже существует: ${existing.url}`);
    return verifyPullRequestTarget(config, pullRequestDetails(repository, existing.number));
  }

  const args = [
    'pr',
    'create',
    '--base',
    config.baseBranch,
    '--head',
    config.branch,
    '--title',
    `${config.milestone}`,
    '--body',
    `Завершены все issues milestone **${config.milestone}**.\n\nPR создан Ralph Loop и требует ручной проверки.`,
  ];
  if (config.draftPullRequest) {
    args.push('--draft');
  }

  const url = run('gh', args).stdout;
  console.log(`Создан PR: ${url}`);
  return verifyPullRequestTarget(config, pullRequestDetails(repository, url));
}

function closeMilestone(repository, milestone) {
  const beforeClose = openIssues(repository, milestone).filter(
    (issue) => issueState(repository, issue.number) === 'OPEN',
  );
  if (beforeClose.length > 0) {
    fail(
      `Milestone #${milestone.number} нельзя закрыть: появились открытые issues ` +
        beforeClose.map((issue) => `#${issue.number}`).join(', '),
    );
  }
  const current = parseJson(
    runNetwork('gh', ['api', `repos/${repository}/milestones/${milestone.number}`]).stdout,
    `GitHub milestone ${milestone.number}`,
  );
  if (current.state === 'closed') {
    console.log(`Milestone #${milestone.number} уже закрыт.`);
    return current;
  }

  const closed = parseJson(
    runNetwork('gh', [
      'api',
      '--method',
      'PATCH',
      `repos/${repository}/milestones/${milestone.number}`,
      '-f',
      'state=closed',
    ]).stdout,
    `GitHub close milestone ${milestone.number}`,
  );
  if (closed.state !== 'closed') {
    fail(`Milestone #${milestone.number} не закрылся после PASS.`);
  }
  console.log(`Milestone #${milestone.number} закрыт после чистого PASS.`);
  const afterClose = openIssues(repository, milestone).filter(
    (issue) => issueState(repository, issue.number) === 'OPEN',
  );
  if (afterClose.length > 0) {
    runNetwork('gh', [
      'api',
      '--method',
      'PATCH',
      `repos/${repository}/milestones/${milestone.number}`,
      '-f',
      'state=open',
    ]);
    fail(
      `После закрытия milestone появились issues ${afterClose
        .map((issue) => `#${issue.number}`)
        .join(', ')}; milestone снова открыт.`,
    );
  }
  return closed;
}

// -----------------------------------------------------------------------------
// Итоговое ревью всего milestone на Sol и публикация результата в PR
// -----------------------------------------------------------------------------

function milestoneReviewMarker(config, milestone, pullRequest) {
  const milestoneId = createHash('sha256')
    .update(
      `${milestone.number}\n${milestone.title}\n${milestone.description ?? ''}\n${config.baseBranch}`,
    )
    .digest('hex')
    .slice(0, 16);
  return `<!-- ralph-milestone-review milestone:${milestoneId} head:${pullRequest.headRefOid} model:${config.milestoneReview.model} -->`;
}

function milestonePassReviewIsClean(body, marker) {
  if (typeof body !== 'string' || !body.includes(marker)) {
    return false;
  }

  const normalized = body.replace(/\r\n/g, '\n').trim();
  const findingsSections = normalized.match(/^### Findings\s*$/gm) ?? [];
  return (
    findingsSections.length === 1 &&
    normalized.includes('**Verdict:** **PASS**') &&
    /### Findings\s*\n\s*No actionable findings\.\s*\n\s*The pull request remains draft so a human can make the final merge decision\.\s*$/.test(
      normalized,
    )
  );
}

function milestonePassWasPublished(config, repository, milestone, pullRequest) {
  const marker = milestoneReviewMarker(config, milestone, pullRequest);
  const reviews = githubPagedArray(
    repository,
    `pulls/${pullRequest.number}/reviews`,
    [],
    `GitHub reviews for PR #${pullRequest.number}`,
  );

  return reviews.some((review) => milestonePassReviewIsClean(review.body, marker));
}

function limitMilestoneReviewFindings(review, pullRequest, maxFindings) {
  const priorities = { P0: 0, P1: 1, P2: 2, P3: 3 };
  const unique = new Map();
  for (const finding of review.findings) {
    unique.set(reviewFindingFingerprint(pullRequest, finding), finding);
  }
  const sorted = [...unique.values()].sort((left, right) => {
    const severity = (priorities[left.severity] ?? 99) - (priorities[right.severity] ?? 99);
    if (severity !== 0) return severity;
    return `${left.file}:${left.line}:${left.title}`.localeCompare(
      `${right.file}:${right.line}:${right.title}`,
    );
  });
  const omitted = Math.max(0, sorted.length - maxFindings);
  return {
    ...review,
    summary:
      omitted > 0
        ? `${review.summary} Ralph queued the first ${maxFindings} unique findings by severity; ${omitted} findings were deferred to the next full review.`
        : review.summary,
    findings: sorted.slice(0, maxFindings),
  };
}

function formatMilestoneReview(config, milestone, pullRequest, review) {
  const findings = review.findings.length
    ? review.findings
        .map((finding) => {
          const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
          return `- **${finding.severity} — ${finding.title}** (${location})\n  ${finding.body}`;
        })
        .join('\n')
    : 'No actionable findings.';
  const verdict = review.verdict === 'pass' ? 'PASS' : 'FINDINGS';

  const nextStep =
    review.verdict === 'pass'
      ? 'The pull request remains draft so a human can make the final merge decision.'
      : 'Ralph Loop will create or reopen one milestone issue per finding, run the implementation loop, push the fixes, and review the new head again.';

  return `${milestoneReviewMarker(config, milestone, pullRequest)}
## Ralph Loop: milestone review

- **Model:** \`${config.milestoneReview.model}\`
- **Milestone:** ${milestone.title}
- **Reviewed head:** \`${pullRequest.headRefOid}\`
- **Verdict:** **${verdict}**

${review.summary}

### Findings

${findings}

${nextStep}`;
}

function postPullRequestReview(repository, pullRequest, body) {
  const marker = body.match(/<!-- ralph-[^\r\n>]+ -->/)?.[0];
  if (marker) {
    const reviews = githubPagedArray(
      repository,
      `pulls/${pullRequest.number}/reviews`,
      [],
      `GitHub reviews for PR #${pullRequest.number}`,
    );
    if (reviews.some((review) => typeof review.body === 'string' && review.body.includes(marker))) {
      console.log(`Review с marker ${marker} уже опубликован в PR #${pullRequest.number}.`);
      return;
    }
  }
  run(
    'gh',
    [
      'pr',
      'review',
      String(pullRequest.number),
      '--repo',
      repository,
      '--comment',
      '--body-file',
      '-',
    ],
    { input: body.slice(0, 60_000) },
  );
}

function postMilestoneReviewFailure(config, repository, milestone, pullRequest, message) {
  const marker = milestoneReviewMarker(config, milestone, pullRequest).replace(
    'ralph-milestone-review ',
    'ralph-milestone-review-failed ',
  );
  postPullRequestReview(
    repository,
    pullRequest,
    `${marker}\n## Ralph Loop: milestone review did not complete\n\n${message}\n\nThe PR remains draft. Restart Ralph Loop after resolving the failure.`,
  );
}

function buildMilestoneReviewPrompt(config, milestone, pullRequest) {
  const milestoneDescription = milestone.description?.trim() || '(Milestone description is empty.)';

  return `Perform a read-only architectural review of pull request #${pullRequest.number} (${pullRequest.url}) for milestone "${milestone.title}".

Milestone description:
${milestoneDescription}

The branch and pull request may be cumulative and contain work from other milestones. Scope the review exclusively to the requirements in the milestone title and description, plus integrations strictly required for those requirements. Use the branch diff against ${config.baseBranch} as evidence, not as the definition of scope. Do not report defects in unrelated features, infrastructure, or files merely because they are present or changed in the pull request.

Ralph's control plane is maintained manually outside the product loop. Never report findings for .agents/**, scripts/ralph/**, AGENTS.md, or nested **/AGENTS.md files. Those paths must never become milestone issues and must never be modified by an AFK implementation session.

Within that milestone scope, review the complete current implementation rather than only the latest commit. Read AGENTS.md, relevant PRD/plan documents, issue-related documentation, and tests. Discover documentation paths first with \`rg --files docs\` and repository file listings, then read only paths confirmed to exist; never guess conventional paths such as \`docs/README.md\`. For public API work in this repository, treat \`README.md\`, \`docs/api.md\`, and \`docs/api-architecture.md\` as canonical entry points when those files exist, while still inspecting relevant milestone-specific documents returned by discovery. Look for cross-issue integration problems, architectural inconsistencies, security vulnerabilities, performance or scalability risks, regressions, missing tests, and deviations from the milestone requirements.

The Ralph orchestrator has already completed every configured preflight and validation script successfully for the exact reviewed head. Do not rerun npm, npx, builds, linters, type checks, tests, dev servers, or any command that writes caches or artifacts. Use read-only file and git inspection only.

Report every distinct actionable finding in scope in this single response. Use verdict "fail" when at least one actionable finding exists; otherwise use "pass" with an empty findings array. Do not edit files, create comments, change GitHub state, or run destructive commands. The Ralph orchestrator will publish the structured result.`;
}

async function runMilestoneReview(config, repository, milestone, pullRequest) {
  if (!config.milestoneReview.enabled) {
    console.log('Milestone review выключен в конфиге.');
    return {
      verdict: 'pass',
      summary: 'Milestone review is disabled in config.',
      findings: [],
    };
  }

  if (milestonePassWasPublished(config, repository, milestone, pullRequest)) {
    console.log(
      `Milestone уже проверен моделью ${config.milestoneReview.model} для commit ${pullRequest.headRefOid}.`,
    );
    return {
      verdict: 'pass',
      summary: 'PASS review for this head was already published.',
      findings: [],
    };
  }

  const reviewPrompt = buildMilestoneReviewPrompt(config, milestone, pullRequest);

  console.log(
    `\n=== Milestone review for PR #${pullRequest.number} (${config.milestoneReview.model}) ===\n`,
  );

  let review;
  try {
    review = await runReviewWithRetries(
      config,
      async () => {
        if (run('git', ['status', '--porcelain']).stdout !== '') {
          const error = new Error('Milestone review требует чистое рабочее дерево.');
          error.nonRetryable = true;
          throw error;
        }
        const reviewedHead = run('git', ['rev-parse', 'HEAD']).stdout;
        const reviewedBranch = run('git', ['branch', '--show-current']).stdout;
        if (existsSync(config.milestoneReview.outputPath)) {
          unlinkSync(config.milestoneReview.outputPath);
        }

        await runCodexWithTurnLimit(
          [
            'exec',
            '--sandbox',
            'read-only',
            '--json',
            '--model',
            config.milestoneReview.model,
            '--output-schema',
            config.milestoneReview.schemaPath,
            '--output-last-message',
            config.milestoneReview.outputPath,
            '-',
          ],
          {
            input: reviewPrompt,
            maxTurns: config.milestoneReview.maxTurns,
            timeoutMs: config.runtime.codexTimeoutMs,
            label: `Milestone review PR #${pullRequest.number}`,
          },
        );
        if (!existsSync(config.milestoneReview.outputPath)) {
          fail(`Milestone review PR #${pullRequest.number} не создал файл результата.`);
        }

        const candidate = parseJson(
          readFileSync(config.milestoneReview.outputPath, 'utf8'),
          config.milestoneReview.outputPath,
        );
        if (
          !['pass', 'fail'].includes(candidate.verdict) ||
          typeof candidate.summary !== 'string' ||
          !Array.isArray(candidate.findings)
        ) {
          fail(`Milestone review PR #${pullRequest.number} вернул некорректный результат.`);
        }
        const normalized = normalizeReviewResult(candidate);
        const changed = run('git', ['status', '--porcelain']).stdout !== '';
        const headChanged = run('git', ['rev-parse', 'HEAD']).stdout !== reviewedHead;
        const branchChanged = run('git', ['branch', '--show-current']).stdout !== reviewedBranch;
        if (changed || headChanged || branchChanged) {
          const error = new Error(
            `Milestone review PR #${pullRequest.number} изменил Git-состояние.`,
          );
          error.nonRetryable = true;
          throw error;
        }
        return normalized;
      },
      `Milestone review PR #${pullRequest.number}`,
    );
  } catch (error) {
    try {
      postMilestoneReviewFailure(config, repository, milestone, pullRequest, error.message);
    } catch (commentError) {
      console.error(`Не удалось опубликовать ошибку milestone review: ${commentError.message}`);
    }
    fail(`Milestone review PR #${pullRequest.number} не завершился: ${error.message}`);
  }
  review = scopeMilestoneReviewToProduct(review);
  review = limitMilestoneReviewFindings(review, pullRequest, config.milestoneReview.maxFindings);

  postPullRequestReview(
    repository,
    pullRequest,
    formatMilestoneReview(config, milestone, pullRequest, review),
  );
  console.log(
    `Milestone review опубликован в ${pullRequest.url}: ${review.verdict.toUpperCase()} (${review.findings.length} findings).`,
  );
  return review;
}

// -----------------------------------------------------------------------------
// Преобразование замечаний milestone-review в GitHub issues
// -----------------------------------------------------------------------------

function reviewFindingFingerprint(pullRequest, finding) {
  const normalizedTitle = finding.title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  const source = [pullRequest.number, finding.severity, finding.file, normalizedTitle].join('\n');
  return createHash('sha256').update(source).digest('hex').slice(0, 20);
}

function reviewFindingMarker(pullRequest, finding) {
  return `<!-- ralph-milestone-finding pr:${pullRequest.number} id:${reviewFindingFingerprint(pullRequest, finding)} -->`;
}

function milestoneIssues(repository, milestone) {
  const issues = githubPagedArray(
    repository,
    'issues',
    [
      ['state', 'all'],
      ['milestone', milestone.number],
    ],
    `GitHub issues for milestone ${milestone.title}`,
  );

  return issues
    .filter((issue) => !issue.pull_request)
    .map((issue) => ({
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state?.toUpperCase(),
      url: issue.html_url,
    }));
}

function findingIssueTitle(finding) {
  const title = `[${finding.severity}] ${finding.title}`.replace(/\s+/g, ' ').trim();
  return title.slice(0, 240);
}

function findingIssueBody(config, pullRequest, finding) {
  const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
  return `${reviewFindingMarker(pullRequest, finding)}
## Context

**Source:** automated milestone review of PR #${pullRequest.number}
**Milestone:** ${config.milestone}
**Reviewed head:** \`${pullRequest.headRefOid}\`
**Severity:** ${finding.severity}
**Location:** \`${location}\`

## Finding

${finding.body}

## Definition of done

- Fix the root cause without weakening existing behavior or tests.
- Add or update regression coverage for the failure path.
- Run the relevant checks from AGENTS.md and the Ralph configuration.
- Keep the change focused on this finding; do not create a pull request.

The existing draft PR will be updated and reviewed again after all review findings are resolved.`;
}

function createReviewFindingIssue(config, repository, milestone, pullRequest, finding) {
  const issue = parseJson(
    run('gh', ['api', `repos/${repository}/issues`, '--method', 'POST', '--input', '-'], {
      input: JSON.stringify({
        title: findingIssueTitle(finding),
        body: findingIssueBody(config, pullRequest, finding),
        milestone: milestone.number,
      }),
    }).stdout,
    'GitHub issue creation',
  );
  console.log(`Создана issue #${issue.number} из milestone finding: ${issue.html_url}`);
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state?.toUpperCase() ?? 'OPEN',
    url: issue.html_url,
  };
}

function reopenReviewFindingIssue(repository, issue, pullRequest) {
  patchIssue(repository, issue.number, { state: 'open' });
  const marker = `<!-- ralph-finding-reopened head:${pullRequest.headRefOid} issue:${issue.number} -->`;
  postIssueCommentOnce(
    repository,
    issue.number,
    `The milestone review found this issue again at PR head ${pullRequest.headRefOid}. Reopened for another fix iteration.`,
    marker,
  );
  console.log(`Переоткрыта issue #${issue.number}: finding всё ещё присутствует.`);
}

function updateReviewFindingIssue(config, repository, issue, pullRequest, finding) {
  const title = findingIssueTitle(finding);
  const body = findingIssueBody(config, pullRequest, finding);
  const updated = patchIssue(repository, issue.number, { title, body });
  issue.title = updated.title;
  issue.body = updated.body;
}

function createOrReopenReviewIssues(
  config,
  repository,
  milestone,
  pullRequest,
  review,
  dependencies = {
    milestoneIssues,
    createReviewFindingIssue,
    updateReviewFindingIssue,
    reopenReviewFindingIssue,
  },
) {
  if (review.verdict !== 'fail') {
    return [];
  }
  if (review.findings.length === 0) {
    fail('Milestone review вернул FAIL без findings; задачи исправления создать невозможно.');
  }

  const infrastructureFindings = review.findings.filter((finding) =>
    isRalphInfrastructurePath(finding.file),
  );
  if (infrastructureFindings.length > 0) {
    fail(
      `Milestone review содержит ${infrastructureFindings.length} замечаний к Ralph-инфраструктуре. ` +
        'Они не могут быть превращены в продуктовые issues.',
    );
  }

  const existingIssues = dependencies.milestoneIssues(repository, milestone);
  const queuedIssues = [];
  const queuedNumbers = new Set();
  for (const finding of review.findings) {
    const marker = reviewFindingMarker(pullRequest, finding);
    let issue = existingIssues.find(
      (candidate) => typeof candidate.body === 'string' && candidate.body.includes(marker),
    );

    if (!issue) {
      issue = dependencies.createReviewFindingIssue(
        config,
        repository,
        milestone,
        pullRequest,
        finding,
      );
      existingIssues.push(issue);
    } else {
      dependencies.updateReviewFindingIssue(config, repository, issue, pullRequest, finding);
      if (issue.state === 'CLOSED') {
        dependencies.reopenReviewFindingIssue(repository, issue, pullRequest);
        issue.state = 'OPEN';
      } else {
        console.log(`Issue #${issue.number} для finding уже открыта; дубликат не создан.`);
      }
    }

    if (!queuedNumbers.has(issue.number)) {
      queuedNumbers.add(issue.number);
      queuedIssues.push(issue);
    }
  }

  return queuedIssues;
}

// -----------------------------------------------------------------------------
// Диагностика конфигурации для безопасного режима --check
// -----------------------------------------------------------------------------

function printCheck(config, repository, milestone, repositoryState, issues) {
  console.log('Ralph Loop настроен корректно.');
  console.log(`Фаза: ${(config.phaseIndex ?? 0) + 1}/${config.phaseCount ?? 1}`);
  console.log(`Репозиторий: ${repository}`);
  console.log(`Milestone: ${milestone.title} (${issues.length} открытых issues)`);
  console.log(`Ветка: ${repositoryState.currentBranch}`);
  console.log(`Рабочее дерево: ${repositoryState.clean ? 'чистое' : 'есть изменения'}`);
  console.log(`Лимит итераций: ${config.maxIterations}`);
  console.log(`Лимит шагов на сессию: ${config.maxTurns}`);
  console.log(`Лимит исправлений тестов: ${config.maxTestFixAttempts}`);
  console.log(`Модель разработки: ${config.developmentModel}`);
  console.log(`Правила сессии: ${config.rulesFile}`);
  console.log(`Review issue: ${config.review.enabled ? config.review.model : 'выключен'}`);
  console.log(
    `Review milestone: ${
      config.milestoneReview.enabled
        ? `${config.milestoneReview.model} (maxTurns=${config.milestoneReview.maxTurns})`
        : 'выключен'
    }`,
  );
  if (issues[0]) {
    console.log(`Следующая issue: #${issues[0].number} ${issues[0].title}`);
  } else {
    console.log('Открытых issues нет; режим --run попытается создать PR.');
  }
}

// -----------------------------------------------------------------------------
// Главный цикл Ralph Loop: --check, --once и --run
// -----------------------------------------------------------------------------

async function runContinuousLoop(context, actions) {
  const { config, repository, milestone, rules } = context;
  const stateStore = context.stateStore ?? activeStateStore;
  let iteration = stateStore?.iterationsUsed ?? 0;
  const pendingIssues = new Map();
  const completedIssueNumbers = new Set();

  while (true) {
    const listedIssues = actions
      .openIssues(repository, milestone)
      .filter((issue) => !isRalphInfrastructureIssue(issue));
    const issuesByNumber = new Map();
    // Сначала добавляем ответ GitHub, затем локальную очередь: локальная копия
    // содержит самый свежий body после review и должна победить устаревший REST-ответ.
    for (const issue of [...listedIssues, ...pendingIssues.values()]) {
      if (completedIssueNumbers.has(issue.number)) {
        // REST-список может кратко вернуть уже закрытую issue. Прямой GET
        // отличает этот stale-ответ от настоящего повторного открытия.
        if (actions.issueState(repository, issue.number) !== 'OPEN') {
          continue;
        }
        completedIssueNumbers.delete(issue.number);
      }
      issuesByNumber.set(issue.number, issue);
    }
    const recoveryIssue = stateStore?.issue;
    if (recoveryIssue && isRalphInfrastructureIssue(recoveryIssue)) {
      if (actions.workingTreeStatus() !== '') {
        fail(
          `Сохранённая служебная issue #${recoveryIssue.number} имеет незавершённый diff. ` +
            'Ralph остановлен: служебные изменения должен разобрать оператор вручную.',
        );
      }
      console.log(
        `Recovery issue #${recoveryIssue.number} относится к Ralph-инфраструктуре; ` +
          'служебное состояние очищено без запуска Codex.',
      );
      stateStore.clearIssue();
      continue;
    }
    if (recoveryIssue && !issuesByNumber.has(recoveryIssue.number)) {
      if (actions.issueState(repository, recoveryIssue.number) === 'OPEN') {
        issuesByNumber.set(recoveryIssue.number, {
          number: recoveryIssue.number,
          title: recoveryIssue.title,
          url: recoveryIssue.url,
          body: recoveryIssue.body ?? '',
          authorLogin: recoveryIssue.authorLogin ?? null,
          authorAssociation: recoveryIssue.authorAssociation ?? null,
        });
      } else {
        if (actions.workingTreeStatus() !== '') {
          fail(
            `Сохранённая issue #${recoveryIssue.number} закрыта, но её рабочее дерево ` +
              'содержит изменения. Ralph не будет переносить их в следующую issue.',
          );
        }
        actions.clearIssueCompletionState(repository, recoveryIssue);
        console.log(
          `Сохранённая issue #${recoveryIssue.number} уже закрыта; локальная recovery-фаза очищена.`,
        );
        stateStore.clearIssue();
      }
    }
    const issues = [...issuesByNumber.values()].sort((left, right) => {
      if (recoveryIssue) {
        if (left.number === recoveryIssue.number) return -1;
        if (right.number === recoveryIssue.number) return 1;
      }
      return left.number - right.number;
    });
    if (issues.length === 0) {
      const pullRequest = actions.createPullRequest(config, repository);
      const review = await actions.runMilestoneReview(config, repository, milestone, pullRequest);
      if (review.verdict === 'pass' && review.findings.length === 0) {
        const appearedIssues = actions
          .openIssues(repository, milestone)
          .filter((issue) => actions.issueState(repository, issue.number) === 'OPEN');
        if (appearedIssues.length > 0) {
          for (const issue of appearedIssues) pendingIssues.set(issue.number, issue);
          console.log(
            `Во время milestone review появились issues: ${appearedIssues
              .map((issue) => `#${issue.number}`)
              .join(', ')}. Ralph продолжает цикл.`,
          );
          continue;
        }
        actions.verifyReviewedPullRequestHead(config, repository, pullRequest);
        actions.closeMilestone(repository, milestone);
        return { verdict: 'pass', iterations: iteration, pullRequest };
      }

      const reviewIssues = actions.createOrReopenReviewIssues(
        config,
        repository,
        milestone,
        pullRequest,
        review,
      );
      if (reviewIssues.length === 0) {
        fail('Milestone review завершился с FAIL, но ни одной issue исправления не создано.');
      }
      for (const issue of reviewIssues) {
        const refreshedReviewIssue = actions.refreshIssue(repository, issue.number, issue);
        approveConfiguredIssue(config, refreshedReviewIssue, repository, stateStore, {
          replace: true,
        });
        completedIssueNumbers.delete(refreshedReviewIssue.number);
        pendingIssues.set(refreshedReviewIssue.number, refreshedReviewIssue);
      }
      console.log(
        `Milestone review создал или переоткрыл ${reviewIssues.length} issues. Ralph продолжает цикл исправлений.`,
      );
      continue;
    }

    let currentIssue = issues[0];
    const refreshedIssue = actions.refreshIssue(repository, currentIssue.number, currentIssue);
    if (refreshedIssue.state !== 'OPEN') {
      if (stateStore?.issue?.number === currentIssue.number) {
        if (actions.workingTreeStatus() !== '') {
          fail(
            `Issue #${currentIssue.number} закрылась во время работы, но локальный diff не пуст. ` +
              'Ralph остановлен, чтобы не смешать изменения со следующей задачей.',
          );
        }
        actions.clearIssueCompletionState(repository, currentIssue);
        stateStore.clearIssue();
      }
      pendingIssues.delete(currentIssue.number);
      completedIssueNumbers.add(currentIssue.number);
      continue;
    }
    approveConfiguredIssue(config, refreshedIssue, repository, stateStore);
    currentIssue = refreshedIssue;
    const completion = issueCompletionState(currentIssue);
    const storedPhase =
      stateStore?.issue?.number === currentIssue.number ? stateStore.issue.phase : null;
    const linkedCommit =
      !completion && !storedPhase ? actions.linkedCommitForIssue?.(currentIssue) : null;
    if (linkedCommit) currentIssue.linkedCommit = linkedCommit;
    const needsDevelopmentIteration =
      completion?.status !== 'pending-review' &&
      !['committed', 'pushed', 'reviewing'].includes(storedPhase) &&
      !linkedCommit;

    if (needsDevelopmentIteration && iteration >= config.maxIterations) {
      fail(
        `Достигнут лимит ${config.maxIterations} итераций; осталось открытых issues: ${issues.length}. PR остаётся draft.`,
      );
    }

    if (needsDevelopmentIteration) {
      iteration = stateStore?.reserveIteration() ?? iteration + 1;
    }
    console.log(
      `${needsDevelopmentIteration ? 'Итерация' : 'Resume'} ${iteration}/${config.maxIterations}; ` +
        `осталось issues: ${issues.length}.`,
    );
    let result;
    try {
      result = await actions.runCodex(config, repository, currentIssue, rules);
    } catch (error) {
      if (
        needsDevelopmentIteration &&
        ['RALPH_CODEX_AUTH', 'RALPH_AGENT_WRITE_ACCESS', 'RALPH_UNTRUSTED_ISSUE'].includes(
          error.code,
        )
      ) {
        iteration = stateStore?.releaseIteration() ?? Math.max(0, iteration - 1);
      }
      throw error;
    }
    if (result?.completed === false) {
      pendingIssues.set(currentIssue.number, currentIssue);
    } else {
      pendingIssues.delete(currentIssue.number);
      completedIssueNumbers.add(currentIssue.number);
    }
  }
}

async function executeMode(context, actions) {
  const { mode: selectedMode, config, repository, milestone, repositoryState, rules } = context;

  if (selectedMode === '--check') {
    const issues = actions.openIssues(repository, milestone);
    actions.printCheck(config, repository, milestone, repositoryState, issues);
    return { mode: 'check', issues: issues.length };
  }

  actions.runPreflight(config);

  if (selectedMode === '--once') {
    const issues = actions.openIssues(repository, milestone);
    if (!issues[0]) {
      console.log('Открытых issues нет. Для push и создания PR запустите --run.');
      context.stateStore?.finish();
      return { mode: 'once', completed: 0 };
    }
    approveConfiguredIssue(config, issues[0], repository, context.stateStore);
    const completion = issueCompletionState(issues[0]);
    const storedPhase =
      context.stateStore?.issue?.number === issues[0].number
        ? context.stateStore.issue.phase
        : null;
    const needsDevelopmentIteration =
      completion?.status !== 'pending-review' &&
      !['committed', 'pushed', 'reviewing'].includes(storedPhase);
    if (
      needsDevelopmentIteration &&
      (context.stateStore?.iterationsUsed ?? 0) >= config.maxIterations
    ) {
      fail(`Достигнут лимит ${config.maxIterations} итераций.`);
    }
    if (needsDevelopmentIteration) context.stateStore?.reserveIteration();
    let result;
    try {
      result = await actions.runCodex(config, repository, issues[0], rules);
    } catch (error) {
      if (
        needsDevelopmentIteration &&
        ['RALPH_CODEX_AUTH', 'RALPH_AGENT_WRITE_ACCESS', 'RALPH_UNTRUSTED_ISSUE'].includes(
          error.code,
        )
      ) {
        context.stateStore?.releaseIteration();
      }
      throw error;
    }
    if (result?.completed === false) {
      console.log(
        `Issue #${issues[0].number} осталась открытой после review. Цикл остановлен после одной итерации.`,
      );
      return { mode: 'once', completed: 0, reviewFailed: true };
    }
    context.stateStore?.finish();
    console.log(`Issue #${issues[0].number} завершена. Цикл остановлен после одной итерации.`);
    return { mode: 'once', completed: 1 };
  }

  return runContinuousLoop(context, actions);
}

function defaultActions() {
  return {
    closeMilestone,
    clearIssueCompletionState,
    issueState,
    openIssues,
    refreshIssue,
    printCheck,
    runPreflight,
    runCodex,
    createPullRequest,
    runMilestoneReview,
    createOrReopenReviewIssues,
    linkedCommitForIssue,
    verifyReviewedPullRequestHead,
    workingTreeStatus: () => run('git', ['status', '--porcelain']).stdout,
  };
}

function initialPhaseIndex(config, state = readJsonFile(runtimeStatePath, null)) {
  if (
    state?.version === 2 &&
    state.phasePlanId === config.phasePlanId &&
    state.phaseCount === config.phases.length &&
    Number.isInteger(state.phaseIndex) &&
    state.phaseIndex >= 0 &&
    state.phaseIndex < config.phases.length
  ) {
    return state.phaseIndex;
  }
  return 0;
}

async function runPhasePlan(config, stateStore, runPhase) {
  const results = [];
  let phaseIndex = stateStore?.phaseIndex ?? 0;
  while (true) {
    const currentConfig = configForPhase(config, phaseIndex);
    console.log(
      `\n=== Фаза ${phaseIndex + 1}/${config.phases.length}: ${currentConfig.milestone} ` +
        `(${currentConfig.branch} -> ${currentConfig.baseBranch}) ===`,
    );
    const result = await runPhase(currentConfig, phaseIndex);
    results.push({ phaseIndex, milestone: currentConfig.milestone, ...result });
    if (result?.verdict !== 'pass') {
      return { verdict: result?.verdict ?? 'stopped', phases: results };
    }

    if (phaseIndex + 1 >= config.phases.length) {
      stateStore?.finish();
      console.log(`Все ${config.phases.length} фаз Ralph Loop завершены.`);
      return { verdict: 'pass', phases: results };
    }

    const nextConfig = configForPhase(config, phaseIndex + 1);
    stateStore?.advancePhase(nextConfig);
    console.log(
      `Фаза ${phaseIndex + 1} завершена. Следующая: ${nextConfig.milestone} (${nextConfig.branch}).`,
    );
    phaseIndex = nextConfig.phaseIndex;
  }
}

async function main() {
  // Проверяем, что передан поддерживаемый режим запуска.
  if (!supportedModes.has(mode)) {
    fail(`Неизвестный режим ${mode}. Используйте --check, --once или --run.`);
  }

  const config = loadConfig();
  try {
    // Проверяем, включён ли Ralph Loop.
    if (!config.active) {
      console.log('Ralph Loop выключен: active=false.');
      return;
    }

    const firstPhaseIndex = initialPhaseIndex(config);
    const firstPhaseConfig = configForPhase(config, firstPhaseIndex);
    const restoreConsole = initializePersistentLog(runtimeLogPath, {
      mode,
      branch: firstPhaseConfig.branch,
      milestone: firstPhaseConfig.milestone,
      phase: `${firstPhaseIndex + 1}/${config.phases.length}`,
    });
    let releaseLock;
    try {
      releaseLock = acquireRunLock(runtimeLockPath, {
        mode,
        projectRoot,
        branch: firstPhaseConfig.branch,
      });
      activeStateStore = createStateStore(firstPhaseConfig, mode);
      Object.assign(config.approvedIssueSnapshots, activeStateStore.approvedIssueSnapshots);
      const rules = loadRalphRules(config);
      verifyTools();
      verifyAgentSkills();
      if (mode !== '--check') {
        verifyCodexAuthentication();
      }
      for (const phase of config.phases) {
        run('git', ['check-ref-format', '--branch', phase.branch]);
        run('git', ['check-ref-format', '--branch', phase.baseBranch]);
      }
      const repository = repositoryName();
      const milestones = config.phases.map((phase) => verifyMilestone(repository, phase.milestone));
      const actions = defaultActions();
      const runPhase = async (phaseConfig) => {
        const repositoryState = verifyRepository(phaseConfig, mode !== '--check');
        if (mode !== '--check') {
          reconcileStateAfterCrash(phaseConfig, activeStateStore);
        }
        verifyBaseHistory(phaseConfig);
        const milestone = milestones[phaseConfig.phaseIndex];
        return executeMode(
          {
            mode,
            config: phaseConfig,
            repository,
            milestone,
            repositoryState,
            rules,
            stateStore: activeStateStore,
          },
          actions,
        );
      };

      if (mode === '--run') {
        return await runPhasePlan(config, activeStateStore, runPhase);
      }
      return await runPhase(firstPhaseConfig);
    } catch (error) {
      console.error(`AFK pipeline error: ${error.message}`);
      throw error;
    } finally {
      try {
        releaseLock?.();
      } finally {
        restoreConsole();
      }
    }
  } finally {
    if (config.validationContainer.frozenDockerfileDirectory) {
      rmSync(config.validationContainer.frozenDockerfileDirectory, {
        recursive: true,
        force: true,
      });
    }
  }
}

// -----------------------------------------------------------------------------
// Точка входа: выполняется только при прямом запуске файла через node
// -----------------------------------------------------------------------------

const isMainModule =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

async function runCli() {
  try {
    await main();
  } catch (error) {
    console.error(`\nRalph Loop остановлен: ${error.message}`);
    process.exitCode = 1;
  }
}

if (isMainModule) {
  await runCli();
}

export {
  agentSkillFiles,
  approveConfiguredIssue,
  assertTrustedIssue,
  assertTrustedControlFilesUnchanged,
  alreadyFixedCommitFromAgent,
  buildIndependentReviewPrompt,
  buildMilestoneReviewPrompt,
  commitStagedChanges,
  configForPhase,
  createTrustedValidationDependencySnapshot,
  createStateStore,
  createSandboxedCodexEnvironment,
  credentialFreeEnvironment,
  developmentCodexArguments,
  createOrReopenReviewIssues,
  executeMode,
  ensureValidationImage,
  issueBodyWithCompletionState,
  issueContentHash,
  githubPagedArray,
  issueBodyWithReviewContext,
  issueCompletionState,
  isRalphInfrastructureIssue,
  isRalphInfrastructurePath,
  limitMilestoneReviewFindings,
  linkedCommitForIssue,
  loadConfig,
  milestonePassReviewIsClean,
  normalizeReviewResult,
  normalizePhases,
  parseSkillFrontmatter,
  reviewFindingMarker,
  renderPrompt,
  reviewFindingFingerprint,
  run,
  runCli,
  runCodex,
  runCodexWithTurnLimit,
  runConfiguredScripts,
  runContinuousLoop,
  runPhasePlan,
  scopeMilestoneReviewToProduct,
  sanitizedChildEnvironment,
  agentReportedWriteAccessFailure,
  validationContainerRunArgs,
  validationImageForSnapshot,
  verifyAgentSkills,
  verifyCodexAuthentication,
};
