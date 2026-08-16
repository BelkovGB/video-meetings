/**
 * Что считается control plane Ralph, а что продуктовой работой.
 *
 * Ralph управляет продуктовым циклом, но его собственная реализация и
 * инструкции настраиваются оператором вручную. Поэтому findings и issues,
 * указывающие на `.agents/**`, `.claude/**`, `scripts/ralph/**` и любые
 * `AGENTS.md`, не должны попадать в продуктовую очередь.
 *
 * Модуль намеренно не импортирует ничего: это делает его пригодным для
 * использования из любого другого модуля Ralph без риска цикла.
 */

export const ralphInfrastructureLabel = 'ralph-infrastructure';

export function fail(message) {
  throw new Error(message);
}

export function isRalphInfrastructurePath(file) {
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
    // Claude Code читает из `.claude/**` агентов, скиллы, настройки и хуки.
    // Файл, положенный туда, меняет поведение будущей сессии, поэтому каталог
    // относится к control plane наравне с `.agents/**`.
    normalized === '.claude' ||
    normalized.startsWith('.claude/') ||
    normalized === 'scripts/ralph' ||
    normalized.startsWith('scripts/ralph/')
  );
}

/**
 * Тот же список путей в виде pathspec для git.
 *
 * Выводится здесь, а не пишется вторым списком рядом с git-командами: два
 * перечисления одного и того же расходятся при первом же добавлении каталога, и
 * расхождение будет тихим — diff просто покажет лишнее.
 */
export const controlPlaneExcludePathspec = [
  ':(exclude).agents',
  ':(exclude).claude',
  ':(exclude)scripts/ralph',
  ':(exclude)AGENTS.md',
  ':(exclude,glob)**/AGENTS.md',
];

export function issueLabels(issue) {
  return (issue?.labels ?? []).map((label) =>
    typeof label === 'string' ? label : String(label?.name ?? ''),
  );
}

export function milestoneFindingPath(issue) {
  if (!String(issue?.body ?? '').includes('<!-- ralph-milestone-finding ')) return null;
  return String(issue.body).match(/^\*\*Location:\*\*\s+`([^`]+)`\s*$/m)?.[1] ?? null;
}

export function isRalphInfrastructureIssue(issue) {
  return (
    issueLabels(issue).some((label) => label.toLowerCase() === ralphInfrastructureLabel) ||
    isRalphInfrastructurePath(milestoneFindingPath(issue))
  );
}

export function scopeMilestoneReviewToProduct(review) {
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
