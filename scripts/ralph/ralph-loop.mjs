#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  acquireRunLock,
  initializePersistentLog,
  readJsonFile,
  waitSync,
} from './ralph-runtime.mjs';

import {
  fail,
  isRalphInfrastructureIssue,
  isRalphInfrastructurePath,
  scopeMilestoneReviewToProduct,
} from './ralph-scope.mjs';

import {
  applyRuntimeSettings,
  credentialFreeEnvironment,
  credentialFreeEnvironmentVariables,
  inheritableEnvironmentVariables,
  run,
  runNetwork,
} from './ralph-process-runner.mjs';

import {
  agentReportedWriteAccessFailure,
  createSandboxedCodexEnvironment,
  developmentCodexArguments,
  reasoningEffortArguments,
  reasoningEfforts,
  runCodexWithTurnLimit,
  verifyCodexAuthentication,
} from './ralph-codex-session.mjs';

import {
  agentSkillFiles,
  configForPhase,
  configPath,
  loadConfig,
  loadRalphRules,
  normalizePhases,
  parseJson,
  parseSkillFrontmatter,
  phasePlanId,
  verifyAgentSkills,
} from './ralph-config.mjs';

import {
  activeStateStore,
  createStateStore,
  runtimeStatePath,
  setActiveStateStore,
} from './ralph-state-store.mjs';

import {
  clearedFailure,
  formatFailureSummary,
  recordedFailure,
  recoveryPrompt,
  summarizeCommandFailure,
  uniqueFailedTests,
} from './ralph-failure-summary.mjs';

import {
  assertTrustedControlFilesUnchanged,
  createTrustedValidationDependencySnapshot,
  ensureValidationImage,
  failedValidationScript,
  hasValidationAttestation,
  purgeValidationAttestations,
  readValidationAttestations,
  recordValidationAttestation,
  runConfiguredScripts,
  runConfiguredValidation,
  runPreflight,
  validationAttestationKey,
  validationContainerRunArgs,
  validationImageForSnapshot,
} from './ralph-validation-runner.mjs';

import {
  alreadyFixedCommitFromAgent,
  commitMessageFromAgent,
  commitStagedChanges,
  linkedCommitForIssue,
  pushBranchAndVerify,
  reconcileStateAfterCrash,
  verifiedIssueCommit,
  verifyBaseHistory,
  verifyRepository,
} from './ralph-git.mjs';

import {
  githubPagedArray,
  issueDetails,
  issueState,
  milestoneIssues,
  openIssues,
  patchIssue,
  postIssueCommentOnce,
  postPullRequestReview,
  refreshIssue,
  reopenIssueWithComment,
  repositoryName,
  verifyMilestone,
} from './ralph-github-client.mjs';

// -----------------------------------------------------------------------------
// Пути проекта и режим запуска
// -----------------------------------------------------------------------------

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mode = process.argv[2] ?? '--check';
const supportedModes = new Set(['--check', '--once', '--run']);
const runtimeDirectory = path.join(projectRoot, '.git', 'ralph-loop');
const runtimeLockPath = path.join(runtimeDirectory, 'run.lock');
const runtimeLogPath = path.join(runtimeDirectory, 'run.log');

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

// -----------------------------------------------------------------------------
// Получение milestone и очереди открытых GitHub issues
// -----------------------------------------------------------------------------

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
  stateStore = activeStateStore(),
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

// Both review prompts carried these blocks verbatim, so editing one silently
// left the other reviewer on an older contract. They live here once.
const reviewShellGuidance =
  'Read efficiently on this Windows/PowerShell host: locate code with `rg -n` before opening a file, read bounded ranges rather than whole files, and pass every discovered path to file cmdlets with `-LiteralPath` so Next.js route segments such as `apps/web/app/meetings/[id]` are not treated as wildcard patterns. Do not dump full logs, lockfiles, or generated files.';
const reviewDocumentationDiscovery =
  'Discover documentation paths before reading them: use `rg --files docs` and repository file listings, then read only paths confirmed to exist. Never guess conventional paths such as `docs/README.md`. For public API work in this repository, treat `README.md`, `docs/api.md`, and `docs/api-architecture.md` as canonical entry points when those files exist, while still inspecting the scope-specific documents returned by discovery.';
const reviewVerdictContract =
  'Use verdict "fail" when at least one actionable finding exists; otherwise use "pass" with an empty findings array.';

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

${reviewShellGuidance}

${reviewDocumentationDiscovery}

Only report findings caused by the claimed implementation, regressions at current HEAD, or work required by the issue. Ignore unrelated pre-existing debt. ${reviewVerdictContract} Do not edit files.`;
}

// -----------------------------------------------------------------------------
// Проверка состояния issue и повторное открытие при ошибке
// -----------------------------------------------------------------------------

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
      ...reasoningEffortArguments(config.review.effort),
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

  if (markPending) {
    setIssueCompletionState(repository, issue, 'pending-review', commit);
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
  if (review.verdict !== 'pass' || review.findings.length > 0) {
    updateIssueReviewContext(repository, issue, review);
    reopenIssueWithComment(repository, issue, formatReviewComment(review));
    activeStateStore()?.clearIssue();
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
  activeStateStore()?.clearIssue();
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
    if (run('git', ['status', '--porcelain']).stdout !== '') {
      fail(`Issue #${issue.number}: проверки already-fixed решения изменили рабочее дерево.`);
    }
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
  const changesAfterValidation = run('git', ['status', '--porcelain']).stdout;
  if (changesAfterValidation !== changes) {
    fail(
      `Issue #${issue.number}: проектные проверки изменили рабочее дерево. ` +
        'Проверьте generated-файлы перед повторным запуском.',
    );
  }
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
  const committedTree = run('git', ['rev-parse', `${commit}^{tree}`]).stdout;
  if (committedTree !== expectedTree) {
    fail(`Issue #${issue.number}: tree созданного commit не совпал с проверенным staged tree.`);
  }
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

async function runCodex(config, repository, issue, rules) {
  issue = assertTrustedIssue(config, issue, repository);
  const storedIssue =
    activeStateStore()?.issue?.number === issue.number ? activeStateStore().issue : null;
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
      activeStateStore().updateIssue({ phase: resumePhase, ...recordedFailure(error) });
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
  activeStateStore()?.beginIssue(issue, startingCommit, continuation);

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
      input: renderPrompt(config, issue, rules) + (continuation ? recoveryPrompt(storedIssue) : ''),
      maxTurns: config.maxTurns,
      timeoutMs: config.runtime.codexTimeoutMs,
      label: `Codex issue #${issue.number}`,
    });
  } catch (error) {
    activeStateStore()?.updateIssue({
      phase: 'working-tree',
      ...recordedFailure(error),
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
  return `<!-- ralph-milestone-review milestone:${milestoneId} head:${pullRequest.headRefOid} model:${config.milestoneReview.model} effort:${config.milestoneReview.effort} -->`;
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

${reviewShellGuidance}

Within that milestone scope, review the complete current implementation rather than only the latest commit. Read AGENTS.md, relevant PRD/plan documents, issue-related documentation, and tests. ${reviewDocumentationDiscovery} Look for cross-issue integration problems, architectural inconsistencies, security vulnerabilities, performance or scalability risks, regressions, missing tests, and deviations from the milestone requirements.

The Ralph orchestrator has already completed every configured preflight and validation script successfully for the exact reviewed head. Do not rerun npm, npx, builds, linters, type checks, tests, dev servers, or any command that writes caches or artifacts. Use read-only file and git inspection only.

Report every distinct actionable finding in scope in this single response. ${reviewVerdictContract} Do not edit files, create comments, change GitHub state, or run destructive commands. The Ralph orchestrator will publish the structured result.`;
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
            ...reasoningEffortArguments(config.milestoneReview.effort),
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

// Бюджет итераций живёт в state и переживает перезапуск, поэтому конфигурация
// может быть корректной, а `--run` при этом останавливаться сразу.
function iterationBudget(config, stateStore) {
  const limit = config.maxIterations;
  const used = stateStore?.iterationsUsed ?? 0;
  return { used, limit, remaining: Math.max(0, limit - used) };
}

function printCheck(
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
// Главный цикл Ralph Loop: --check, --once и --run
// -----------------------------------------------------------------------------

async function runContinuousLoop(context, actions) {
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
    const budget = iterationBudget(config, context.stateStore);
    actions.printCheck(config, repository, milestone, repositoryState, issues, budget);
    return { mode: 'check', issues: issues.length, iterationBudget: budget };
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
      setActiveStateStore(createStateStore(firstPhaseConfig, mode));
      Object.assign(config.approvedIssueSnapshots, activeStateStore().approvedIssueSnapshots);
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
  iterationBudget,
  githubPagedArray,
  printCheck,
  issueBodyWithReviewContext,
  issueCompletionState,
  isRalphInfrastructureIssue,
  isRalphInfrastructurePath,
  limitMilestoneReviewFindings,
  linkedCommitForIssue,
  loadConfig,
  milestonePassReviewIsClean,
  milestoneReviewMarker,
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
  credentialFreeEnvironmentVariables,
  inheritableEnvironmentVariables,
  failedValidationScript,
  formatFailureSummary,
  hasValidationAttestation,
  purgeValidationAttestations,
  readValidationAttestations,
  recordValidationAttestation,
  validationAttestationKey,
  recoveryPrompt,
  summarizeCommandFailure,
  uniqueFailedTests,
  agentReportedWriteAccessFailure,
  validationContainerRunArgs,
  validationImageForSnapshot,
  verifyAgentSkills,
  verifyCodexAuthentication,
};
