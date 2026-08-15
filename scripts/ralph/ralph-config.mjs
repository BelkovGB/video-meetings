import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fail } from './ralph-scope.mjs';
import { applyRuntimeSettings } from './ralph-process-runner.mjs';
import { reasoningEfforts } from './ralph-codex-session.mjs';

/**
 * Чтение `ralph.config.json`, его проверка и сбор доверенного control plane.
 *
 * `loadConfig` выполняет этапы в том же порядке, в каком они шли одной
 * процедурой: набор значений по умолчанию для контейнера и review идёт после
 * чтения snapshots, потому что на этом порядке держатся сообщения об ошибках.
 */

// Пути выводятся здесь заново, как в `ralph-process-runner.mjs`: импорт из
// оркестратора дал бы цикл.
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..', '..');
const skillsDirectory = path.join(projectRoot, '.agents', 'skills');

export const configPath = path.join(projectRoot, '.agents', 'ralph.config.json');

const approvedIssueSnapshotsHash =
  'c0e278f489ab9e9b20c7d21232b9bb50e1e268eed0ba338966091da84777701e';

export function parseJson(value, source) {
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

export function trustedFileHash(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

const ignoredAgentInstructionDirectories = new Set([
  '.git',
  '.next',
  'coverage',
  'dist',
  'node_modules',
]);

export function agentInstructionFiles(directory = projectRoot) {
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

// Codex загружает project-local skills по YAML frontmatter. Невалидный
// frontmatter не останавливает сессию: агент просто теряет skill и пишет
// `failed to load skill`, поэтому проблему нужно ловить до запуска.
export function parseSkillFrontmatter(content) {
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

export function agentSkillFiles(directory = skillsDirectory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(directory, entry.name, 'SKILL.md'))
    .filter((file) => existsSync(file))
    .sort();
}

export function verifyAgentSkills(dependencies = {}) {
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

export function phasePlanId(phases) {
  return createHash('sha256')
    .update(
      JSON.stringify(
        phases.map(({ milestone, branch, baseBranch }) => ({ milestone, branch, baseBranch })),
      ),
    )
    .digest('hex');
}

export function normalizePhases(config) {
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

export function configForPhase(config, phaseIndex) {
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

function requirePromptTemplate(config) {
  for (const field of ['prompt']) {
    if (typeof config[field] !== 'string' || config[field].trim() === '') {
      fail(`Заполните строковое поле \"${field}\" в ${configPath}.`);
    }
  }
}

function applyLoopDefaults(config) {
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
  // Один контейнер выполняет весь набор, поэтому бюджет задаётся на прогон,
  // а не на команду. validationTimeoutMs остаётся бюджетом docker build.
  config.runtime.validationRunTimeoutMs ??= 3_600_000;
  config.runtime.codexTimeoutMs ??= 5_400_000;
  config.runtime.networkRetryAttempts ??= 3;
  config.runtime.networkRetryBaseDelayMs ??= 2_000;
  config.runtime.maxPages ??= 20;
  config.runtime.reviewRetryAttempts ??= 3;
  config.developmentModel ??= 'gpt-5.6-terra';
  config.developmentEffort ??= 'medium';
  config.rulesFile ??= '.agents/ralph-rules.md';
  config.autoApproveConfiguredIssues ??= true;
  config.trustedIssueAuthors ??= [];
  config.approvedIssueSnapshotsFile ??= 'scripts/ralph/approved-issues.json';
}

function readApprovedIssueSnapshots(config) {
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
}

function applyValidationAndReviewDefaults(config) {
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
}

function validateLoopFields(config) {
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
}

function validateApprovedIssueSnapshots(config) {
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
}

function prepareValidationContainer(config) {
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
}

function validateScriptNames(config) {
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
}

function validateRuntimeSettings(config) {
  if (typeof config.runtime !== 'object' || config.runtime === null) {
    fail('Поле "runtime" должно быть объектом.');
  }
  for (const field of [
    'commandTimeoutMs',
    'validationTimeoutMs',
    'validationRunTimeoutMs',
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
}

function validateAgentRoles(config) {
  if (typeof config.review !== 'object' || config.review === null) {
    fail('Поле "review" должно быть объектом.');
  }
  if (typeof config.review.enabled !== 'boolean') {
    fail('Поле "review.enabled" должно быть true или false.');
  }
  config.review.effort ??= 'medium';
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
  config.milestoneReview.effort ??= 'high';
  for (const [field, value] of [
    ['developmentEffort', config.developmentEffort],
    ['review.effort', config.review.effort],
    ['milestoneReview.effort', config.milestoneReview.effort],
  ]) {
    if (typeof value !== 'string' || !reasoningEfforts.includes(value)) {
      fail(`Поле "${field}" должно быть одним из: ${reasoningEfforts.join(', ')}.`);
    }
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
}

function resolveControlPlanePaths(config) {
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
}

function collectTrustedControlFileHashes(config) {
  const trustedControlFiles = [
    configPath,
    config.rulesPath,
    config.approvedIssueSnapshotsPath,
    config.validationContainer.dockerfilePath,
    // Модули перечислены поимённо, а не сканированием каталога: сканирование
    // приняло бы в доверенный набор любой подложенный файл. Тест требует, чтобы
    // каждый .mjs из scripts/ralph был в этом списке.
    path.join(scriptDirectory, 'ralph-codex-session.mjs'),
    path.join(scriptDirectory, 'ralph-command-runner.mjs'),
    path.join(scriptDirectory, 'ralph-config.mjs'),
    path.join(scriptDirectory, 'ralph-failure-summary.mjs'),
    path.join(scriptDirectory, 'ralph-git.mjs'),
    path.join(scriptDirectory, 'ralph-github-client.mjs'),
    path.join(scriptDirectory, 'ralph-issue-contract.mjs'),
    path.join(scriptDirectory, 'ralph-loop.mjs'),
    path.join(scriptDirectory, 'ralph-milestone-review.mjs'),
    path.join(scriptDirectory, 'ralph-process-runner.mjs'),
    path.join(scriptDirectory, 'ralph-prompts.mjs'),
    path.join(scriptDirectory, 'ralph-runtime.mjs'),
    path.join(scriptDirectory, 'ralph-scope.mjs'),
    path.join(scriptDirectory, 'ralph-state-store.mjs'),
    path.join(scriptDirectory, 'ralph-validation-docker-shim.sh'),
    path.join(scriptDirectory, 'ralph-validation-entrypoint.sh'),
    path.join(scriptDirectory, 'ralph-validation-runner.mjs'),
    path.join(projectRoot, '.agents', 'RALPH.md'),
    ...agentInstructionFiles(),
  ];
  if (config.review.enabled) trustedControlFiles.push(config.review.schemaPath);
  if (config.milestoneReview.enabled) trustedControlFiles.push(config.milestoneReview.schemaPath);
  return new Map(
    [...new Set(trustedControlFiles)].map((file) => {
      if (!existsSync(file) || lstatSync(file).isSymbolicLink()) {
        fail(`Доверенный control-plane файл недоступен или является symbolic link: ${file}`);
      }
      return [file, trustedFileHash(file)];
    }),
  );
}

export function loadConfig() {
  const config = parseJson(readFileSync(configPath, 'utf8'), configPath);

  requirePromptTemplate(config);
  applyLoopDefaults(config);
  readApprovedIssueSnapshots(config);
  applyValidationAndReviewDefaults(config);
  validateLoopFields(config);
  validateApprovedIssueSnapshots(config);
  prepareValidationContainer(config);
  validateScriptNames(config);
  validateRuntimeSettings(config);
  validateAgentRoles(config);
  resolveControlPlanePaths(config);
  config.trustedControlFileHashes = collectTrustedControlFileHashes(config);

  applyRuntimeSettings(config.runtime);
  return config;
}

export function loadRalphRules(config) {
  const rules = readFileSync(config.rulesPath, 'utf8').trim();
  if (rules === '') {
    fail(`Файл правил пуст: ${config.rulesPath}`);
  }

  return rules;
}
