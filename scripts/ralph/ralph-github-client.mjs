import { createHash } from 'node:crypto';

import { fail, isRalphInfrastructureIssue } from './ralph-scope.mjs';
import { run, runNetwork, runtimeSettings } from './ralph-process-runner.mjs';
import { parseJson } from './ralph-config.mjs';

/**
 * Обращения к GitHub через `gh`: milestones, issues, комментарии и pull requests.
 *
 * Здесь только вызовы API и разбор ответа. Что считать доверенной issue и что
 * писать в её тело — не здесь.
 */

export function repositoryName() {
  const repository = parseJson(
    runNetwork('gh', ['repo', 'view', '--json', 'nameWithOwner']).stdout,
    'gh repo view',
  );
  return repository.nameWithOwner;
}

/**
 * `gh auth status` завершается нулём при любом залогиненном аккаунте и ничего
 * не говорит о правах на целевой репозиторий. Без этой проверки отказ приходит
 * на push ветки или закрытии issue — то есть после того, как агент отработал,
 * а commit уже создан.
 */
export function verifyRepositoryWriteAccess(repository, dependencies = {}) {
  const execute = dependencies.runNetwork ?? runNetwork;
  const permissions = parseJson(
    execute('gh', ['api', `repos/${repository}`, '--jq', '.permissions']).stdout,
    `gh api repos/${repository}`,
  );
  if (permissions?.push === true) return permissions;

  const login = execute('gh', ['api', 'user', '--jq', '.login'], { allowFailure: true }).stdout;
  fail(
    `Активный аккаунт GitHub${login ? ` (${login})` : ''} не имеет права записи в ${repository}. ` +
      'Ralph остановлен до запуска агента: push и закрытие issue отказали бы уже после его работы.',
  );
}

export function githubPagedArray(repository, resource, fields, source, dependencies = {}) {
  const execute = dependencies.runNetwork ?? runNetwork;
  const maxPages = dependencies.maxPages ?? runtimeSettings().maxPages;
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

export function verifyMilestone(repository, title) {
  const milestones = githubPagedArray(
    repository,
    'milestones',
    [['state', 'all']],
    'GitHub milestones API',
  );
  const matches = milestones.filter((milestone) => milestone.title === title);

  if (matches.length === 0) {
    fail(`Milestone с точным названием "${title}" не найден в ${repository}.`);
  }
  if (matches.length > 1) {
    fail(`В ${repository} найдено несколько milestones с названием "${title}".`);
  }

  return matches[0];
}

export function openIssues(repository, milestone) {
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

export function issueDetails(repository, issueNumber) {
  return parseJson(
    runNetwork('gh', ['api', `repos/${repository}/issues/${issueNumber}`]).stdout,
    `GitHub issue ${issueNumber}`,
  );
}

export function issueState(repository, issueNumber) {
  const issue = issueDetails(repository, issueNumber);
  return issue.state?.toUpperCase();
}

export function refreshIssue(repository, issueNumber) {
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

export function patchIssue(repository, issueNumber, values) {
  return parseJson(
    runNetwork(
      'gh',
      ['api', '--method', 'PATCH', `repos/${repository}/issues/${issueNumber}`, '--input', '-'],
      { input: JSON.stringify(values) },
    ).stdout,
    `GitHub update issue ${issueNumber}`,
  );
}

export function postIssueCommentOnce(repository, issueNumber, body, marker) {
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

export function reopenIssueWithComment(repository, issue, comment) {
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

export function milestoneIssues(repository, milestone) {
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

export function postPullRequestReview(repository, pullRequest, body) {
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
