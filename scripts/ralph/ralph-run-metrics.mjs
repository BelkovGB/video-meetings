import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readJsonFile, writeJsonAtomic } from './ralph-runtime.mjs';

/**
 * Стоимость одной issue: время по стадиям и телеметрия сессий агента.
 *
 * Журнал ведётся отдельно от state.json намеренно: `finish()` удаляет состояние
 * целиком, то есть метрики исчезали бы ровно на успешном завершении — в том
 * единственном случае, ради которого их и собирают.
 *
 * Каталог `.git/ralph-loop` выбран потому, что он невидим для
 * `git status --porcelain` и не попадает в snapshot валидации: запись метрик не
 * может изменить проверяемое дерево и не может сдвинуть attestation.
 */

const metricsProjectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Имя не должно начинаться с `run-` и заканчиваться на `.log`: ретенция журнала
// прогонов удаляет такие файлы по маске, оставляя пять последних.
export const issueMetricsPath = path.join(
  metricsProjectRoot,
  '.git',
  'ralph-loop',
  'issue-metrics.json',
);

const metricsVersion = 1;
const maxStoredIssueRecords = 200;

// -----------------------------------------------------------------------------
// Активная запись
// -----------------------------------------------------------------------------

// Тот же приём, что и у `activeStateStore`: одна запись на процесс, доступ
// только через функции этого модуля. Альтернатива — протаскивать recorder через
// runAgentOnIssue → commitAndCompleteIssue → reviewAndCloseCommittedIssue, то
// есть через каждую сигнатуру на пути, включая те, что метрик не касаются.
let activeIssueMetrics = null;

export function beginIssueMetrics(context, dependencies = {}) {
  const now = dependencies.now ?? Date.now;
  const startedMs = now();
  activeIssueMetrics = {
    issue: context.issue,
    milestone: context.milestone ?? null,
    branch: context.branch ?? null,
    iteration: context.iteration ?? null,
    agentCli: context.agentCli ?? null,
    startedMs,
    startedAt: new Date(startedMs).toISOString(),
    stages: new Map(),
    agents: [],
    now,
  };

  return activeIssueMetrics;
}

export function currentIssueMetrics() {
  return activeIssueMetrics;
}

/**
 * Возвращает функцию завершения стадии. Вызывать её нужно в `finally`: самые
 * дорогие стадии — те, что упали, и запись без них показала бы дешёвый цикл там,
 * где оператор ищет причину траты.
 */
export function startStage(name) {
  const metrics = activeIssueMetrics;
  if (!metrics) return () => {};
  const startedMs = metrics.now();
  let closed = false;

  return (extra = {}) => {
    if (closed) return;
    closed = true;
    const previous = metrics.stages.get(name) ?? { ms: 0, runs: 0 };
    metrics.stages.set(name, {
      ...previous,
      ...extra,
      ms: previous.ms + (metrics.now() - startedMs),
      runs: previous.runs + 1,
    });
  };
}

export function recordAgentTelemetry(role, telemetry) {
  if (!activeIssueMetrics || !telemetry) return;
  activeIssueMetrics.agents.push({ role, ...telemetry });
}

/**
 * Телеметрия снимается здесь, а не на каждой площадке вызова: у сессии два
 * выхода, и путь с исключением — это ровно сгоревший maxTurns или timeout,
 * самая дорогая сессия из возможных.
 */
export async function withRecordedTelemetry(role, operation) {
  try {
    const session = await operation();
    recordAgentTelemetry(role, session?.telemetry);
    return session;
  } catch (error) {
    recordAgentTelemetry(role, error?.telemetry);
    throw error;
  }
}

// -----------------------------------------------------------------------------
// Свод и запись
// -----------------------------------------------------------------------------

function sumTelemetry(agents, field) {
  const reported = agents.map((agent) => agent[field]).filter((value) => typeof value === 'number');

  return reported.length > 0 ? reported.reduce((total, value) => total + value, 0) : null;
}

export function summarizeIssueMetrics(metrics, outcome) {
  const finishedMs = metrics.now();
  const agents = metrics.agents;

  return {
    version: metricsVersion,
    issue: metrics.issue,
    milestone: metrics.milestone,
    branch: metrics.branch,
    iteration: metrics.iteration,
    agentCli: metrics.agentCli,
    outcome: outcome?.outcome ?? 'unknown',
    reason: outcome?.reason ?? null,
    startedAt: metrics.startedAt,
    finishedAt: new Date(finishedMs).toISOString(),
    wallMs: finishedMs - metrics.startedMs,
    stages: Object.fromEntries(metrics.stages),
    agents,
    totals: {
      // Роли считаются отдельно от суммы: цену одной issue задаёт не только
      // общий счёт, но и распределение между реализацией и ревью.
      sessions: agents.length,
      // Число сессий, приславших цену. Codex её не отдаёт, и общая сумма без
      // этого счётчика выглядела бы полной, будучи частичной.
      costReportedBy: agents.filter((agent) => typeof agent.costUsd === 'number').length,
      costUsd: sumTelemetry(agents, 'costUsd'),
      turns: sumTelemetry(agents, 'turns'),
      inputTokens: sumTelemetry(agents, 'inputTokens'),
      outputTokens: sumTelemetry(agents, 'outputTokens'),
      cacheReadTokens: sumTelemetry(agents, 'cacheReadTokens'),
      cacheCreationTokens: sumTelemetry(agents, 'cacheCreationTokens'),
    },
  };
}

export function appendIssueMetrics(record, dependencies = {}) {
  const metricsPath = dependencies.metricsPath ?? issueMetricsPath;
  const stored = readJsonFile(metricsPath, null);
  const entries =
    stored?.version === metricsVersion && Array.isArray(stored.entries) ? stored.entries : [];
  writeJsonAtomic(metricsPath, {
    version: metricsVersion,
    entries: [record, ...entries].slice(0, maxStoredIssueRecords),
  });

  return record;
}

/**
 * Закрывает активную запись и возвращает её. Активная запись снимается до
 * записи на диск: сбой файловой операции не должен оставить процесс с чужими
 * метриками на следующей issue.
 */
export function finishIssueMetrics(outcome, dependencies = {}) {
  const metrics = activeIssueMetrics;
  activeIssueMetrics = null;
  if (!metrics) return null;

  return appendIssueMetrics(summarizeIssueMetrics(metrics, outcome), dependencies);
}

// -----------------------------------------------------------------------------
// Строка для оператора
// -----------------------------------------------------------------------------

function formatDuration(ms) {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;

  return `${Math.floor(totalSeconds / 60)}m${String(totalSeconds % 60).padStart(2, '0')}s`;
}

function formatTokens(value) {
  if (typeof value !== 'number') return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1000)}k`;

  return String(value);
}

function formatCost(record) {
  const { costUsd, costReportedBy, sessions } = record.totals;
  if (typeof costUsd !== 'number') return null;
  const partial = costReportedBy < sessions ? ` (цену прислали ${costReportedBy}/${sessions})` : '';

  return `$${costUsd.toFixed(2)}${partial}`;
}

export function formatIssueMetrics(record) {
  const stages = Object.entries(record.stages)
    .map(([name, stage]) => {
      const runs = stage.runs > 1 ? ` ×${stage.runs}` : '';
      const attested = stage.attested === true ? ', из attestation' : '';
      return `${name} ${formatDuration(stage.ms)}${runs}${attested}`;
    })
    .join(', ');
  const { turns, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens } = record.totals;
  const cost = formatCost(record);
  const tokens =
    typeof inputTokens === 'number' || typeof outputTokens === 'number'
      ? `токены ${formatTokens(inputTokens)}/${formatTokens(outputTokens)} ` +
        `(кэш: чтение ${formatTokens(cacheReadTokens)}, запись ${formatTokens(cacheCreationTokens)})`
      : null;

  return [
    `Стоимость issue #${record.issue}: ${formatDuration(record.wallMs)} — ${stages || 'без стадий'}`,
    `${record.totals.sessions} сессий${typeof turns === 'number' ? `, шагов ${turns}` : ''}`,
    cost,
    tokens,
    `итог: ${record.reason ?? record.outcome}`,
  ]
    .filter(Boolean)
    .join('; ');
}
