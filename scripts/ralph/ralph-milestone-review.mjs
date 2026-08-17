import { createHash } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';

import { fail, isRalphInfrastructurePath, scopeMilestoneReviewToProduct } from './ralph-scope.mjs';
import { run } from './ralph-process-runner.mjs';
import { runReviewWithRetries } from './ralph-agent-session.mjs';
import { runReviewSession } from './ralph-agent-backends.mjs';
import { parseJson } from './ralph-config.mjs';
import {
  githubPagedArray,
  milestoneIssues,
  patchIssue,
  postIssueCommentOnce,
  postPullRequestReview,
} from './ralph-github-client.mjs';
import { branchChangeInventory } from './ralph-git.mjs';
import { assertReviewPayloadShape, normalizeReviewResult } from './ralph-issue-contract.mjs';
import { buildMilestoneReviewPrompt } from './ralph-prompts.mjs';

/**
 * Итоговое ревью milestone на Sol и превращение его замечаний в GitHub issues.
 */

export function milestoneReviewMarker(config, milestone, pullRequest) {
  const milestoneId = createHash('sha256')
    .update(
      `${milestone.number}\n${milestone.title}\n${milestone.description ?? ''}\n${config.baseBranch}`,
    )
    .digest('hex')
    .slice(0, 16);
  return `<!-- ralph-milestone-review milestone:${milestoneId} head:${pullRequest.headRefOid} model:${config.milestoneReview.model} effort:${config.milestoneReview.effort} -->`;
}

export function milestonePassReviewIsClean(body, marker) {
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

export function limitMilestoneReviewFindings(review, pullRequest, maxFindings) {
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

export async function runMilestoneReview(config, repository, milestone, pullRequest) {
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

  // База берётся с origin, а не с локальной ветки: локальная может отставать, и
  // тогда в diff попадёт чужая работа, которую ревьюер обязан игнорировать.
  const reviewPrompt = buildMilestoneReviewPrompt(config, milestone, pullRequest, {
    changes: branchChangeInventory(`origin/${config.baseBranch}`, pullRequest.headRefOid),
  });

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

        await runReviewSession(config, config.milestoneReview, {
          input: reviewPrompt,
          maxTurns: config.milestoneReview.maxTurns,
          timeoutMs: config.runtime.agentTimeoutMs,
          label: `Milestone review PR #${pullRequest.number}`,
        });
        if (!existsSync(config.milestoneReview.outputPath)) {
          fail(`Milestone review PR #${pullRequest.number} не создал файл результата.`);
        }

        const candidate = parseJson(
          readFileSync(config.milestoneReview.outputPath, 'utf8'),
          config.milestoneReview.outputPath,
        );
        assertReviewPayloadShape(candidate, `Milestone review PR #${pullRequest.number}`);
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

export function reviewFindingFingerprint(pullRequest, finding) {
  const normalizedTitle = finding.title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  const source = [pullRequest.number, finding.severity, finding.file, normalizedTitle].join('\n');
  return createHash('sha256').update(source).digest('hex').slice(0, 20);
}

export function reviewFindingMarker(pullRequest, finding) {
  return `<!-- ralph-milestone-finding pr:${pullRequest.number} id:${reviewFindingFingerprint(pullRequest, finding)} -->`;
}

/**
 * Замечания, которые имеет смысл чинить одной задачей.
 *
 * Ключ — файл и полоса важности. Файл потому, что фиксированная часть цикла —
 * холодная сессия, чтение репозитория, контейнер валидации, ревью — не зависит
 * от размера правки: на milestone фазы 8 шесть из семи замечаний пришлись на
 * один компонент и стоили шести отдельных циклов по 450–650 тысяч базовых
 * токенов вместо одного.
 *
 * Полоса важности потому, что задача закрывается целиком: без разделения
 * косметическое P3, не прошедшее ревью, держало бы открытым исправленный P1.
 */
const criticalSeverities = new Set(['P0', 'P1']);

function findingBatchKey(finding) {
  return `${criticalSeverities.has(finding.severity) ? 'critical' : 'routine'}\n${finding.file}`;
}

export function groupFindingsIntoBatches(findings, maxBatchSize = 5) {
  const batches = new Map();
  for (const finding of findings) {
    const key = findingBatchKey(finding);
    const open = batches.get(key);
    // Ограничение размера: задача должна оставаться обозримой на ревью.
    if (open && open.at(-1).length < maxBatchSize) open.at(-1).push(finding);
    else if (open) open.push([finding]);
    else batches.set(key, [[finding]]);
  }

  return [...batches.values()].flat();
}

function severityRank(severity) {
  return Number.parseInt(String(severity).replace(/\D/g, ''), 10);
}

function batchSeverity(batch) {
  return batch.reduce((worst, finding) =>
    severityRank(finding.severity) < severityRank(worst.severity) ? finding : worst,
  ).severity;
}

function findingIssueTitle(batch) {
  const [first] = batch;
  const title =
    batch.length === 1
      ? `[${first.severity}] ${first.title}`
      : `[${batchSeverity(batch)}] ${first.file.split('/').at(-1)}: ${batch.length} review findings`;

  return title.replace(/\s+/g, ' ').trim().slice(0, 240);
}

function findingIssueBody(config, pullRequest, batch) {
  // Группа собрана по файлу, поэтому локация у неё одна — и определитель
  // инфраструктурных issues, читающий эту строку, продолжает работать.
  const location =
    batch.length === 1 && batch[0].line ? `${batch[0].file}:${batch[0].line}` : batch[0].file;
  const markers = batch.map((finding) => reviewFindingMarker(pullRequest, finding)).join('\n');
  const findings = batch
    .map((finding, index) => {
      const at = finding.line ? ` (line ${finding.line})` : '';
      const heading =
        batch.length === 1
          ? '## Finding'
          : `### ${index + 1}. [${finding.severity}] ${finding.title}${at}`;
      return `${heading}\n\n${finding.body}`;
    })
    .join('\n\n');
  const checklist = batch
    .map((finding) => `- [ ] [${finding.severity}] ${finding.title}`)
    .join('\n');

  return `${markers}
## Context

**Source:** automated milestone review of PR #${pullRequest.number}
**Milestone:** ${config.milestone}
**Reviewed head:** \`${pullRequest.headRefOid}\`
**Severity:** ${batchSeverity(batch)}
**Location:** \`${location}\`

${findings}

## Definition of done

${checklist}

Fix the root cause of every finding above and add regression coverage for each failure path, without weakening existing tests. The issue is not done until every box is ticked.`;
}

function createReviewFindingIssue(config, repository, milestone, pullRequest, batch) {
  const issue = parseJson(
    run('gh', ['api', `repos/${repository}/issues`, '--method', 'POST', '--input', '-'], {
      input: JSON.stringify({
        title: findingIssueTitle(batch),
        body: findingIssueBody(config, pullRequest, batch),
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

function updateReviewFindingIssue(config, repository, issue, pullRequest, batch) {
  const title = findingIssueTitle(batch);
  const body = findingIssueBody(config, pullRequest, batch);
  const updated = patchIssue(repository, issue.number, { title, body });
  issue.title = updated.title;
  issue.body = updated.body;
}

export function createOrReopenReviewIssues(
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
  // Группа разбивается обратно на отдельные замечания, если её пункты уже
  // разъехались по разным задачам прошлого раунда: слияние осиротило бы их со
  // старым содержимым, а это хуже лишней задачи.
  const batches = groupFindingsIntoBatches(review.findings).flatMap((batch) => {
    const matched = new Set(
      batch
        .map((finding) => matchingIssueFor(existingIssues, pullRequest, finding))
        .filter(Boolean)
        .map((issue) => issue.number),
    );
    return matched.size > 1 ? batch.map((finding) => [finding]) : [batch];
  });

  for (const batch of batches) {
    let issue = batch
      .map((finding) => matchingIssueFor(existingIssues, pullRequest, finding))
      .find(Boolean);

    if (!issue) {
      issue = dependencies.createReviewFindingIssue(
        config,
        repository,
        milestone,
        pullRequest,
        batch,
      );
      existingIssues.push(issue);
    } else {
      dependencies.updateReviewFindingIssue(config, repository, issue, pullRequest, batch);
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

function matchingIssueFor(existingIssues, pullRequest, finding) {
  const marker = reviewFindingMarker(pullRequest, finding);

  return existingIssues.find(
    (candidate) => typeof candidate.body === 'string' && candidate.body.includes(marker),
  );
}
