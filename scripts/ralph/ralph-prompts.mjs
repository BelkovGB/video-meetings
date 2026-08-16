/**
 * Prompt для реализации issue и для обоих ревьюеров.
 *
 * Модуль не импортирует ничего: это только текст с подстановками.
 */

function renderTemplate(template, replacements) {
  let result = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    result = result.replaceAll(placeholder, value);
  }

  return result;
}

export function renderPrompt(config, issue, rules) {
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
//
// Подсказка про чтение зависит от того, какой CLI ведёт ревью, и это не
// косметика. Codex-ревьюер работает в read-only песочнице с полноценной
// оболочкой, а Claude-ревьюер запускается с `--tools Read,Glob,Grep` и Bash не
// имеет вовсе: инструкция про `rg -n` и `-LiteralPath` для него неисполнима.
// Важнее второе: единственная защита от того, что сегмент маршрута вида
// `apps/web/app/meetings/[id]` будет прочитан как шаблон, была выражена флагом
// PowerShell, поэтому у Claude-ревьюера защиты не оставалось совсем — его Glob
// и `--glob` у Grep трактуют скобки как класс символов.
const shellReviewGuidance =
  'Read efficiently on this Windows/PowerShell host: locate code with `rg -n` before opening a file, read bounded ranges rather than whole files, and pass every discovered path to file cmdlets with `-LiteralPath` so Next.js route segments such as `apps/web/app/meetings/[id]` are not treated as wildcard patterns. Do not dump full logs, lockfiles, or generated files.';
const toolReviewGuidance =
  'Read efficiently with the only tools you have — Grep, Glob and Read: locate code with Grep before opening a file, and read bounded ranges with Read rather than whole files. Glob patterns and Grep `--glob` filters treat square brackets as a character class, so a Next.js route segment such as `apps/web/app/meetings/[id]` never matches literally: reach it with a wildcard segment like `apps/web/app/meetings/*/page.tsx`, then pass the exact path to Read. Do not dump full logs, lockfiles, or generated files.';

function reviewShellGuidance(config) {
  return config?.agentCli === 'claude' ? toolReviewGuidance : shellReviewGuidance;
}
// Тот же принцип, что и у подсказки про чтение: способ найти документ обязан
// быть исполнимым тем набором инструментов, который получила роль.
const documentationDiscoveryTail =
  'Never guess conventional paths such as `docs/README.md`. For public API work in this repository, treat `README.md`, `docs/api.md`, and `docs/api-architecture.md` as canonical entry points when those files exist, while still inspecting the scope-specific documents returned by discovery.';
const shellDocumentationDiscovery = `Discover documentation paths before reading them: use \`rg --files docs\` and repository file listings, then read only paths confirmed to exist. ${documentationDiscoveryTail}`;
const toolDocumentationDiscovery = `Discover documentation paths before reading them: list them with Glob patterns such as \`docs/**/*.md\`, then read only paths confirmed to exist. ${documentationDiscoveryTail}`;

function reviewDocumentationDiscovery(config) {
  return config?.agentCli === 'claude' ? toolDocumentationDiscovery : shellDocumentationDiscovery;
}
const reviewVerdictContract =
  'Use verdict "fail" when at least one actionable finding exists; otherwise use "pass" with an empty findings array.';

/**
 * Блок изменений: то, что оркестратор уже знает, и то, что ревьюер иначе
 * добывает сам. Claude-ревьюер запускается без оболочки и `git` вызвать не
 * может: без этого блока «изменения для issue» для него — догадка по тексту.
 */
function reviewChangeInventory(changes) {
  if (!changes) return '';
  const truncationNote = changes.truncated
    ? '\n\nThe diff above is truncated. Read the remaining changed files from the list yourself.'
    : '';
  // Со второй итерации у issue больше одного commit, и назвать только
  // последний значило бы выдать доработку за всю реализацию.
  const commits = changes.commits ?? [changes.commit];
  const range =
    commits.length > 1
      ? `across the ${commits.length} commits of this issue (${commits.join(', ')})`
      : `in commit ${changes.commit}`;

  return `

Changes ${range}. This is the complete set of changes made for this issue.

${changes.stat}

${changes.nameStatus}

\`\`\`diff
${changes.diff}
\`\`\`${truncationNote}`;
}

// Ревьюер, которому не сказали, что проверки уже прошли, тратит шаги на их
// повторение или выдаёт «нужно прогнать тесты» за замечание. Ни то, ни другое
// не является дефектом реализации.
function reviewValidationEvidence(config) {
  const scripts = config?.validationScripts ?? [];
  if (scripts.length === 0) return '';

  return `

The Ralph orchestrator already ran ${scripts.join(', ')} in an isolated container against this exact tree, and all of them passed. Do not rerun them, and do not report a finding whose only content is that a check should be run.`;
}

function reviewPreviousFindings(previousFindings) {
  if (!previousFindings) return '';

  return `

The previous review of this issue reported the findings below. Check each one before anything else: state in your summary whether it is resolved at HEAD, and report it again only if it is not.

${previousFindings}`;
}

export function buildIndependentReviewPrompt(config, issue, commit, context = {}) {
  const issueBody = issue.body?.trim() || '(empty)';

  return `Review the current branch state at HEAD as the implementation of GitHub issue #${issue.number}: ${issue.title}. Commit ${commit} is the claimed implementation commit; verify that the current HEAD still satisfies the issue and has not regressed it.

Issue body:
${issueBody}${reviewPreviousFindings(context.previousFindings)}${reviewChangeInventory(context.changes)}${reviewValidationEvidence(config)}

Complete the entire audit before deciding the verdict. Do not stop after the first problem. Return every distinct, actionable finding you can substantiate in this single response, without duplicates and without inventing findings to fill a quota.

Audit all of these areas:
- every requirement and definition-of-done item from the issue body;
- correctness, edge cases, regressions, security, and test coverage;
- interactions between all changed files, not only the most obvious one;
- public API response contracts, documentation, configuration, migrations, and deployment/runtime assumptions when relevant;
- whether tests assert the real externally observable behavior rather than only an implementation detail.

${reviewShellGuidance(config)}

${reviewDocumentationDiscovery(config)}

Only report findings caused by the claimed implementation, regressions at current HEAD, or work required by the issue. Ignore unrelated pre-existing debt. ${reviewVerdictContract} Do not edit files.`;
}

export function buildMilestoneReviewPrompt(config, milestone, pullRequest) {
  const milestoneDescription = milestone.description?.trim() || '(Milestone description is empty.)';

  return `Perform a read-only architectural review of pull request #${pullRequest.number} (${pullRequest.url}) for milestone "${milestone.title}".

Milestone description:
${milestoneDescription}

The branch and pull request may be cumulative and contain work from other milestones. Scope the review exclusively to the requirements in the milestone title and description, plus integrations strictly required for those requirements. Use the branch diff against ${config.baseBranch} as evidence, not as the definition of scope. Do not report defects in unrelated features, infrastructure, or files merely because they are present or changed in the pull request.

Ralph's control plane is maintained manually outside the product loop. Do not open .agents/** or scripts/ralph/**, and never report findings for those paths, for AGENTS.md, or for nested **/AGENTS.md files: they must never become milestone issues and must never be modified by an AFK implementation session. Do read AGENTS.md and the nested ones — they carry the conventions the product code is judged against.

${reviewShellGuidance(config)}

Within that milestone scope, review the complete current implementation rather than only the latest commit. Read AGENTS.md, relevant PRD/plan documents, issue-related documentation, and tests. ${reviewDocumentationDiscovery(config)} Look for cross-issue integration problems, architectural inconsistencies, security vulnerabilities, performance or scalability risks, regressions, missing tests, and deviations from the milestone requirements.

The Ralph orchestrator has already completed every configured preflight and validation script successfully for the exact reviewed head. Do not rerun npm, npx, builds, linters, type checks, tests, dev servers, or any command that writes caches or artifacts. Use read-only file and git inspection only.

Report every distinct actionable finding in scope in this single response. ${reviewVerdictContract} Do not edit files, create comments, change GitHub state, or run destructive commands. The Ralph orchestrator will publish the structured result.`;
}
