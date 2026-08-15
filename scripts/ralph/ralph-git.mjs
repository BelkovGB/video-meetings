import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fail } from './ralph-scope.mjs';
import { run, runNetwork } from './ralph-process-runner.mjs';
import { activeStateStore } from './ralph-state-store.mjs';
import { clearedFailure } from './ralph-failure-summary.mjs';

/**
 * Работа с Git-репозиторием: ветки, commit, push и восстановление после сбоя.
 */

// Пути выводятся здесь заново, как в `ralph-process-runner.mjs`.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function commitTrailerForIssue(issue) {
  return `Ralph-Issue: #${issue.number}`;
}

export function commitStagedChanges(commitMessage, issue, timeoutMs, dependencies = {}) {
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

export function reconcileStateAfterCrash(config, stateStore = activeStateStore()) {
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
    stateStore.updateIssue({ phase: 'committed', commit, ...clearedFailure });
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
  stateStore.updateIssue({ phase: 'committed', commit, ...clearedFailure });
  console.log(`Issue #${storedIssue.number}: staging завершён commit ${commit} после crash.`);
}

export function verifyRepository(config, requireClean) {
  const repositoryRoot = path.resolve(run('git', ['rev-parse', '--show-toplevel']).stdout);
  if (repositoryRoot.toLowerCase() !== path.resolve(projectRoot).toLowerCase()) {
    fail(`Скрипт ожидает Git-репозиторий ${projectRoot}, но нашёл ${repositoryRoot}.`);
  }

  run('git', ['check-ref-format', '--branch', config.branch]);
  let currentBranch = run('git', ['branch', '--show-current']).stdout;
  const changes = run('git', ['status', '--porcelain']).stdout;
  const currentHead = run('git', ['rev-parse', 'HEAD']).stdout;
  const recoveryAllowed = activeStateStore()?.allowsDirtyRecovery(currentBranch, currentHead);
  if (requireClean && changes !== '' && !recoveryAllowed) {
    fail(
      'Рабочее дерево не чистое. Закоммитьте или уберите текущие изменения перед запуском Ralph Loop.',
    );
  }
  if (changes !== '' && recoveryAllowed) {
    console.log(
      `Найдена незавершённая работа Ralph для issue #${activeStateStore().issue.number}; ` +
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

export function verifyBaseHistory(config) {
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

export function commitMessageFromAgent(lastAgentMessage, issue) {
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

export function alreadyFixedCommitFromAgent(lastAgentMessage) {
  return (
    String(lastAgentMessage ?? '')
      .trimEnd()
      .match(/(?:^|\r?\n)ALREADY_FIXED:\s*([0-9a-f]{7,40})\s*$/i)?.[1] ?? null
  );
}

export function linkedCommitForIssue(issue, execute = run) {
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

export function verifiedIssueCommit(commit, issue) {
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

export function pushBranchAndVerify(config) {
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
