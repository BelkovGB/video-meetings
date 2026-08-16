#!/usr/bin/env node

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { acquireRunLock, initializePersistentLog, readJsonFile } from './ralph-runtime.mjs';

import { fail, isRalphInfrastructureIssue } from './ralph-scope.mjs';

import { run, runNetwork } from './ralph-process-runner.mjs';

import { agentReportedWriteAccessFailure } from './ralph-codex-session.mjs';

import { runReviewWithRetries } from './ralph-agent-session.mjs';

import {
  agentBinary,
  runDevelopmentSession,
  runReviewSession,
  verifyAgentAuthentication,
} from './ralph-agent-backends.mjs';

import {
  configForPhase,
  configPath,
  loadConfig,
  loadRalphRules,
  parseJson,
  verifyAgentSkills,
} from './ralph-config.mjs';

import {
  activeStateStore,
  createStateStore,
  runtimeStatePath,
  setActiveStateStore,
} from './ralph-state-store.mjs';

import { clearedFailure, recordedFailure, recoveryPrompt } from './ralph-failure-summary.mjs';

import {
  assertTrustedControlFilesUnchanged,
  runConfiguredValidation,
  runPreflight,
} from './ralph-validation-runner.mjs';

import {
  alreadyFixedCommitFromAgent,
  commitMessageFromAgent,
  commitStagedChanges,
  commitTrailerForIssue,
  linkedCommitForIssue,
  pushBranchAndVerify,
  reconcileStateAfterCrash,
  verifiedIssueCommit,
  verifyBaseHistory,
  verifyPushedHead,
  verifyRepository,
} from './ralph-git.mjs';

import {
  issueState,
  openIssues,
  patchIssue,
  postIssueCommentOnce,
  refreshIssue,
  reopenIssueWithComment,
  repositoryName,
  verifyMilestone,
} from './ralph-github-client.mjs';

import {
  approveConfiguredIssue,
  assertReviewPayloadShape,
  assertTrustedIssue,
  clearIssueCompletionState,
  formatReviewComment,
  normalizeReviewResult,
  updateIssueReviewContext,
} from './ralph-issue-contract.mjs';

import { buildIndependentReviewPrompt, renderPrompt } from './ralph-prompts.mjs';

import { createOrReopenReviewIssues, runMilestoneReview } from './ralph-milestone-review.mjs';

// -----------------------------------------------------------------------------
// Пути проекта и режим запуска
// -----------------------------------------------------------------------------

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mode = process.argv[2] ?? '--check';
const supportedModes = new Set(['--check', '--run']);
const runtimeDirectory = path.join(projectRoot, '.git', 'ralph-loop');
const runtimeLockPath = path.join(runtimeDirectory, 'run.lock');
const runtimeLogPath = path.join(runtimeDirectory, 'run.log');

// -----------------------------------------------------------------------------
// Проверка инструментов, Git-репозитория и рабочей ветки
// -----------------------------------------------------------------------------

function workingTreeStatus() {
  return run('git', ['status', '--porcelain']).stdout;
}

function assertCleanTree(message) {
  if (workingTreeStatus() !== '') fail(message);
}

// Проверки не имеют права трогать рабочее дерево: сгенерированный ими файл
// означает, что коммит уже не соответствует проверенному состоянию.
function assertValidationLeftTree(expected, message) {
  if (workingTreeStatus() !== expected) fail(message);
}

function verifyTools(config) {
  run('git', ['--version']);
  run('gh', ['--version']);
  run(agentBinary(config), ['--version']);
  run('docker', ['version']);
  runNetwork('gh', ['auth', 'status']);
}

// -----------------------------------------------------------------------------
// Формирование prompt для реализации одной issue
// -----------------------------------------------------------------------------

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

  console.log(`\n=== Independent review for issue #${issue.number} ===\n`);

  await runReviewSession(config, config.review, {
    input: reviewPrompt,
    maxTurns: config.maxTurns,
    timeoutMs: config.runtime.agentTimeoutMs,
    label: `Review issue #${issue.number}`,
  });

  if (!existsSync(config.review.outputPath)) {
    fail(`Review issue #${issue.number} не создал файл результата.`);
  }

  let review = parseJson(readFileSync(config.review.outputPath, 'utf8'), config.review.outputPath);

  assertReviewPayloadShape(review, `Review issue #${issue.number}`);
  review = normalizeReviewResult(review);

  const changes = run('git', ['status', '--porcelain']).stdout;
  const headAfterReview = run('git', ['rev-parse', 'HEAD']).stdout;
  const branchAfterReview = run('git', ['branch', '--show-current']).stdout;
  if (changes !== '' || headAfterReview !== reviewedHead || branchAfterReview !== reviewedBranch) {
    fail(`Review issue #${issue.number} изменил рабочее дерево.`);
  }

  if (review.verdict !== 'pass') {
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

async function reviewAndCloseCommittedIssue(config, repository, issue, commit) {
  const pushedHead = pushBranchAndVerify(config);
  activeStateStore()?.updateIssue({
    phase: 'pushed',
    commit,
    pushedHead,
    ...clearedFailure,
  });

  if (!config.review.enabled) {
    verifyPushedHead(config, pushedHead);
    closeIssue(config, repository, issue, commit);
    activeStateStore()?.clearIssue();
    return {
      completed: true,
      commit,
      review: { verdict: 'pass', summary: 'Independent review is disabled.', findings: [] },
    };
  }

  activeStateStore()?.updateIssue({ phase: 'reviewing' });
  let review;
  try {
    review = await runReviewWithRetries(
      config,
      () => runIndependentReview(config, repository, issue, commit),
      `Review issue #${issue.number}`,
    );
  } catch (error) {
    activeStateStore()?.updateIssue({
      phase: 'pushed',
      ...recordedFailure(error),
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
  if (review.verdict !== 'pass') {
    updateIssueReviewContext(repository, issue, review);
    reopenIssueWithComment(repository, issue, formatReviewComment(review));
    activeStateStore()?.clearIssue();
    return { completed: false, commit, review };
  }

  verifyPushedHead(config, pushedHead);
  closeIssue(config, repository, issue, commit);
  activeStateStore()?.clearIssue();
  return { completed: true, commit, review };
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
    activeStateStore()?.updateIssue({ phase: 'validating' });
    try {
      runConfiguredValidation(config);
    } catch (error) {
      const attempts = (activeStateStore()?.issue?.validationFixAttempts ?? 0) + 1;
      activeStateStore()?.updateIssue({
        phase: 'working-tree',
        validationFixAttempts: attempts,
        ...recordedFailure(error),
      });
      if (attempts >= config.maxTestFixAttempts) throw error;
      console.error(
        `Issue #${issue.number}: validation не прошла (${attempts}/${config.maxTestFixAttempts}); ` +
          'Ralph передаст ошибку Terra на следующей итерации.',
      );
      return { completed: false, validationFailed: true };
    }
    assertValidationLeftTree(
      '',
      `Issue #${issue.number}: проверки already-fixed решения изменили рабочее дерево.`,
    );
    return reviewAndCloseCommittedIssue(config, repository, issue, commit);
  }

  activeStateStore()?.updateIssue({ phase: 'validating' });
  try {
    runConfiguredValidation(config);
  } catch (error) {
    const attempts = (activeStateStore()?.issue?.validationFixAttempts ?? 0) + 1;
    activeStateStore()?.updateIssue({
      phase: 'working-tree',
      validationFixAttempts: attempts,
      ...recordedFailure(error),
    });
    if (attempts >= config.maxTestFixAttempts) throw error;
    console.error(
      `Issue #${issue.number}: validation не прошла (${attempts}/${config.maxTestFixAttempts}); ` +
        'Ralph продолжит исправление существующего diff.',
    );
    return { completed: false, validationFailed: true };
  }
  assertValidationLeftTree(
    changes,
    `Issue #${issue.number}: проектные проверки изменили рабочее дерево. ` +
      'Проверьте generated-файлы перед повторным запуском.',
  );
  activeStateStore()?.updateIssue({ phase: 'staging' });
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
  // expectedTree переживает падение процесса: только он позволяет
  // восстановлению отличить «проверенный индекс цел» от «индекс кто-то трогал».
  // Сверять его с tree только что созданного commit не нужно — commitStagedChanges
  // коммитит индекс с пустым core.hooksPath, между двумя вызовами ничего не
  // выполняется.
  const expectedTree = run('git', ['write-tree']).stdout;
  activeStateStore()?.updateIssue({
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
  activeStateStore()?.updateIssue({
    phase: 'committed',
    commit,
    pushedHead: null,
    ...clearedFailure,
  });
  return reviewAndCloseCommittedIssue(config, repository, issue, commit);
}

// -----------------------------------------------------------------------------
// Реализация одной issue на Terra и проверка правил завершения
// -----------------------------------------------------------------------------

export async function runCodex(config, repository, issue, rules) {
  issue = assertTrustedIssue(config, issue, repository);
  const storedIssue =
    activeStateStore()?.issue?.number === issue.number ? activeStateStore().issue : null;
  if (storedIssue?.commit && ['committed', 'pushed', 'reviewing'].includes(storedIssue.phase)) {
    assertCleanTree(`Issue #${issue.number}: committed recovery требует чистое рабочее дерево.`);
    const commit = verifiedIssueCommit(storedIssue.commit, issue);
    console.log(
      `Issue #${issue.number}: продолжаем pipeline с сохранённого commit ${commit} ` +
        `(phase=${storedIssue.phase}).`,
    );
    const resumePhase = storedIssue.phase;
    try {
      runConfiguredValidation(config);
    } catch (error) {
      activeStateStore().updateIssue({ phase: resumePhase, ...recordedFailure(error) });
      throw error;
    }
    return reviewAndCloseCommittedIssue(config, repository, issue, commit);
  }

  const currentHead = run('git', ['rev-parse', 'HEAD']).stdout;
  const continuation = Boolean(storedIssue);
  const startingCommit = storedIssue?.startingCommit ?? currentHead;
  if (startingCommit !== currentHead) {
    fail(
      `Issue #${issue.number}: recovery ожидал HEAD ${startingCommit}, но найден ${currentHead}.`,
    );
  }
  activeStateStore()?.beginIssue(issue, startingCommit);

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
    codexResult = await runDevelopmentSession(config, {
      input: renderPrompt(config, issue, rules) + (continuation ? recoveryPrompt(storedIssue) : ''),
      maxTurns: config.maxTurns,
      timeoutMs: config.runtime.agentTimeoutMs,
      label: `${config.agentCli} issue #${issue.number}`,
    });
  } catch (error) {
    activeStateStore()?.updateIssue({
      phase: 'working-tree',
      ...recordedFailure(error),
    });
    if (error.code === 'RALPH_AGENT_AUTH') {
      throw error;
    }
    if (['RALPH_MAX_TURNS', 'RALPH_AGENT_TIMEOUT'].includes(error.code)) {
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
    activeStateStore()?.updateIssue({ phase: 'working-tree', ...recordedFailure(error) });
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

// Сравнение с OID до ревью формально перекрывается verifyPullRequestTarget,
// который и так требует совпадения с локальным HEAD. Оно остаётся ради
// сообщения: «PR изменился во время milestone review» называет реальное
// событие — кто-то запушил в ветку, пока шло ревью, — а не «head не совпал».
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

function createPullRequest(config, repository) {
  assertCleanTree('Нельзя создать PR: в рабочем дереве есть незакоммиченные изменения.');

  runConfiguredValidation(config);
  assertValidationLeftTree(
    '',
    'Нельзя обновить PR: проектные проверки изменили чистое рабочее дерево.',
  );
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

// -----------------------------------------------------------------------------
// Диагностика конфигурации для безопасного режима --check
// -----------------------------------------------------------------------------

// Бюджет итераций живёт в state и переживает перезапуск, поэтому конфигурация
// может быть корректной, а `--run` при этом останавливаться сразу.
export function iterationBudget(config, stateStore) {
  const limit = config.maxIterations;
  const used = stateStore?.iterationsUsed ?? 0;
  return { used, limit, remaining: Math.max(0, limit - used) };
}

export function printCheck(
  config,
  repository,
  milestone,
  repositoryState,
  issues,
  budget = iterationBudget(config, null),
) {
  console.log('Ralph Loop настроен корректно.');
  console.log(`Фаза: ${(config.phaseIndex ?? 0) + 1}/${config.phaseCount ?? 1}`);
  console.log(`Репозиторий: ${repository}`);
  console.log(`Milestone: ${milestone.title} (${issues.length} открытых issues)`);
  console.log(`Ветка: ${repositoryState.currentBranch}`);
  console.log(`Рабочее дерево: ${repositoryState.clean ? 'чистое' : 'есть изменения'}`);
  console.log(
    `Итерации: использовано ${budget.used}/${budget.limit}, осталось ${budget.remaining}`,
  );
  console.log(`Лимит шагов на сессию: ${config.maxTurns}`);
  console.log(`Лимит исправлений тестов: ${config.maxTestFixAttempts}`);
  console.log(`Модель разработки: ${config.developmentModel} (effort=${config.developmentEffort})`);
  console.log(`Правила сессии: ${config.rulesFile}`);
  console.log(
    `Review issue: ${
      config.review.enabled ? `${config.review.model} (effort=${config.review.effort})` : 'выключен'
    }`,
  );
  console.log(
    `Review milestone: ${
      config.milestoneReview.enabled
        ? `${config.milestoneReview.model} (effort=${config.milestoneReview.effort}, ` +
          `maxTurns=${config.milestoneReview.maxTurns})`
        : 'выключен'
    }`,
  );
  if (issues[0]) {
    console.log(`Следующая issue: #${issues[0].number} ${issues[0].title}`);
  } else {
    console.log('Открытых issues нет; режим --run попытается создать PR.');
  }
  if (budget.remaining === 0) {
    console.log(
      `ВНИМАНИЕ: сохранённый бюджет итераций исчерпан (${budget.used}/${budget.limit}). ` +
        'Режим --run остановится на первой issue, которой нужна новая итерация.',
    );
    console.log(
      `Продолжение без ручного редактирования state: увеличьте "maxIterations" в ${path.relative(
        projectRoot,
        configPath,
      )} и закоммитьте конфигурацию; осталось будет пересчитано автоматически.`,
    );
  }
  return budget;
}

// -----------------------------------------------------------------------------
// Главный цикл Ralph Loop: --check и --run
// -----------------------------------------------------------------------------

export async function runContinuousLoop(context, actions) {
  const { config, repository, milestone, rules } = context;
  const stateStore = context.stateStore ?? activeStateStore();
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
      if (config.stopAfterFirstIssue) {
        console.log('Открытых issues нет. Для push и создания PR снимите stopAfterFirstIssue.');
        stateStore?.finish();
        return { mode: 'run', completed: 0 };
      }
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
    const storedPhase =
      stateStore?.issue?.number === currentIssue.number ? stateStore.issue.phase : null;
    const linkedCommit = storedPhase ? null : actions.linkedCommitForIssue?.(currentIssue);
    if (linkedCommit) currentIssue.linkedCommit = linkedCommit;
    const needsDevelopmentIteration =
      !['committed', 'pushed', 'reviewing'].includes(storedPhase) && !linkedCommit;

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
        ['RALPH_AGENT_AUTH', 'RALPH_AGENT_WRITE_ACCESS', 'RALPH_UNTRUSTED_ISSUE'].includes(
          error.code,
        )
      ) {
        // Возврат итерации в состояние — единственный нужный эффект: следом
        // идёт throw, и локальная `iteration` уже никем не читается.
        stateStore?.releaseIteration();
      }
      throw error;
    }
    if (result?.completed === false) {
      pendingIssues.set(currentIssue.number, currentIssue);
    } else {
      pendingIssues.delete(currentIssue.number);
      completedIssueNumbers.add(currentIssue.number);
    }
    if (config.stopAfterFirstIssue) {
      if (result?.completed === false) {
        console.log(
          `Issue #${currentIssue.number} осталась открытой после review. ` +
            'Цикл остановлен после одной итерации.',
        );
        return { mode: 'run', completed: 0, reviewFailed: true };
      }
      stateStore?.finish();
      console.log(`Issue #${currentIssue.number} завершена. Цикл остановлен после одной итерации.`);
      return { mode: 'run', completed: 1 };
    }
  }
}

export async function executeMode(context, actions) {
  const { mode: selectedMode, config, repository, milestone, repositoryState } = context;

  if (selectedMode === '--check') {
    const issues = actions.openIssues(repository, milestone);
    const budget = iterationBudget(config, context.stateStore);
    actions.printCheck(config, repository, milestone, repositoryState, issues, budget);
    return { mode: 'check', issues: issues.length, iterationBudget: budget };
  }

  actions.runPreflight(config);

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
    workingTreeStatus,
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

export async function runPhasePlan(config, stateStore, runPhase) {
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
    fail(`Неизвестный режим ${mode}. Используйте --check или --run.`);
  }

  const config = loadConfig();
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
    setActiveStateStore(createStateStore(firstPhaseConfig, mode));
    Object.assign(config.approvedIssueSnapshots, activeStateStore().approvedIssueSnapshots);
    const rules = loadRalphRules(config);
    verifyTools(config);
    verifyAgentSkills();
    if (mode !== '--check') {
      verifyAgentAuthentication(config);
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
        reconcileStateAfterCrash(phaseConfig, activeStateStore());
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
          stateStore: activeStateStore(),
        },
        actions,
      );
    };

    if (mode === '--run') {
      return await runPhasePlan(config, activeStateStore(), runPhase);
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
}

// -----------------------------------------------------------------------------
// Точка входа: выполняется только при прямом запуске файла через node
// -----------------------------------------------------------------------------

const isMainModule =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

export async function runCli() {
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
