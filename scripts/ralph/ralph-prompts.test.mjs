import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './ralph-config.mjs';
import { milestonePassReviewIsClean } from './ralph-milestone-review.mjs';
import {
  buildIndependentReviewPrompt,
  buildMilestoneReviewPrompt,
  renderPrompt,
} from './ralph-prompts.mjs';
import {
  isRalphInfrastructureIssue,
  isRalphInfrastructurePath,
  scopeMilestoneReviewToProduct,
} from './ralph-scope.mjs';

test('implementation prompt delegates full validation to the outer orchestrator', () => {
  const rules = readFileSync(new URL('../../.agents/ralph-rules.md', import.meta.url), 'utf8');
  const prompt = renderPrompt(
    {
      milestone: 'Efficiency',
      branch: 'feature/efficiency',
      prompt: 'Implement issue #{issue_number} in {milestone}.',
      maxTurns: 50,
      maxTestFixAttempts: 5,
    },
    {
      number: 7,
      title: 'Avoid duplicate validation',
      body: 'Run focused tests.',
      url: 'https://example.test/issues/7',
    },
    rules,
  );

  // Проверяется контракт, а не конкретная формулировка: полный набор делегирован
  // наружу, npm вызывается в обход PowerShell-обёртки, и повторный прогон с
  // увеличенным таймаутом запрещён.
  assert.match(prompt, /`validationScripts`/);
  assert.match(prompt, /снаружи\s+sandbox/);
  assert.match(prompt, /не дублируй/i);
  assert.match(prompt, /npm\.cmd/);
  assert.match(prompt, /не повторяй[\s\S]{0,80}таймаутом/i);
});

test('issue review prompt requires one exhaustive in-scope audit', () => {
  const prompt = buildIndependentReviewPrompt(
    { agentCli: 'claude' },
    {
      number: 62,
      title: 'Rate-limit authentication',
      body: 'Document and test the public contract.',
    },
    'a'.repeat(40),
  );

  assert.match(prompt, /Do not stop after the first problem/);
  assert.match(prompt, /Return every distinct, actionable finding/);
  assert.match(prompt, /public API response contracts, documentation, configuration/);
  assert.match(prompt, /Discover documentation paths/i);
  // Роль запущена с `--tools Read,Glob,Grep`, поэтому поиск описан через Glob:
  // `rg` этому ревьюеру недоступен так же, как и PowerShell.
  assert.match(prompt, /docs\/\*\*\/\*\.md/);
  assert.doesNotMatch(prompt, /rg --files/);
  assert.match(prompt, /guess conventional paths such as `docs\/README\.md`/i);
  assert.match(prompt, /`docs\/api\.md`.*`docs\/api-architecture\.md`/);
  assert.match(prompt, /Ignore unrelated pre-existing debt/);
});

test('issue review prompt carries the change set the reviewer cannot obtain itself', () => {
  const prompt = buildIndependentReviewPrompt(
    { agentCli: 'claude', validationScripts: ['lint', 'build', 'test:e2e:api'] },
    { number: 57, title: 'End the browser session', body: 'Outcome text.' },
    'b'.repeat(40),
    {
      changes: {
        commit: 'b'.repeat(40),
        stat: ' apps/web/app/login/page.tsx | 12 ++++--',
        nameStatus: 'M\tapps/web/app/login/page.tsx',
        diff: '--- a/apps/web/app/login/page.tsx\n+++ b/apps/web/app/login/page.tsx',
        truncated: false,
      },
      previousFindings: '- **P2 — Missing guard** (apps/web/use-meeting-files.ts:36)',
    },
  );

  assert.match(prompt, /M\tapps\/web\/app\/login\/page\.tsx/);
  assert.match(prompt, /```diff/);
  assert.match(prompt, /complete set of changes made for this issue/);
  assert.match(prompt, /already ran lint, build, test:e2e:api/);
  assert.match(prompt, /Do not rerun them/);
  // Замечания прошлого ревью обязаны быть подписаны: внутри тела issue они
  // неотличимы от критериев готовности, и требовать их проверки бессмысленно.
  assert.match(prompt, /previous review of this issue reported the findings below/);
  assert.match(prompt, /P2 — Missing guard/);
  assert.doesNotMatch(prompt, /truncated/);
});

test('a truncated change set says so instead of looking complete', () => {
  const prompt = buildIndependentReviewPrompt(
    { agentCli: 'claude' },
    { number: 58, title: 'Large change', body: 'Outcome text.' },
    'c'.repeat(40),
    {
      changes: {
        commit: 'c'.repeat(40),
        stat: ' 40 files changed',
        nameStatus: 'M\tone.ts',
        diff: '--- a/one.ts',
        truncated: true,
      },
    },
  );

  assert.match(prompt, /The diff above is truncated/);
  // Набор validationScripts не задан: утверждать, что проверки прошли, нечем.
  assert.doesNotMatch(prompt, /already ran/);
  assert.doesNotMatch(prompt, /previous review/);
});

test('a second iteration names every commit of the issue, not just the last', () => {
  const prompt = buildIndependentReviewPrompt(
    { agentCli: 'claude' },
    { number: 57, title: 'Second pass', body: 'Outcome text.' },
    'e'.repeat(40),
    {
      changes: {
        commit: 'e'.repeat(40),
        commits: ['e'.repeat(40), 'f'.repeat(40)],
        stat: ' two.ts | 2 +-',
        nameStatus: 'M\ttwo.ts',
        diff: '--- a/two.ts',
        truncated: false,
      },
    },
  );

  assert.match(prompt, /across the 2 commits of this issue/);
  assert.match(prompt, /complete set of changes made for this issue/);
  assert.doesNotMatch(prompt, /exactly one commit/);
});

test('without a change set the prompt keeps its previous shape', () => {
  const prompt = buildIndependentReviewPrompt(
    { agentCli: 'codex' },
    { number: 59, title: 'No inventory', body: 'Outcome text.' },
    'd'.repeat(40),
  );

  assert.doesNotMatch(prompt, /```diff/);
  assert.match(prompt, /Do not stop after the first problem/);
});

test('milestone review stays within milestone scope and trusts completed validations', () => {
  const prompt = buildMilestoneReviewPrompt(
    { baseBranch: 'master' },
    {
      title: 'Phase 1: Core Profile API',
      description: 'Authenticated users can read and update a safe profile.',
    },
    { number: 61, url: 'https://example.test/pull/61' },
  );

  assert.match(prompt, /may be cumulative and contain work from other milestones/);
  assert.match(prompt, /Scope the review exclusively to the requirements/);
  assert.match(prompt, /diff against master as evidence, not as the definition of scope/);
  assert.match(prompt, /Do not rerun npm, npx, builds, linters, type checks, tests/);
  assert.match(prompt, /every configured preflight and validation script successfully/);
  // Запрет читать, а не только сообщать: control plane занимает бо́льшую часть
  // диффа ветки, и открытый файл оплачивается независимо от того, что ревьюер
  // потом отбросит. AGENTS.md при этом читать нужно — там конвенции продукта.
  assert.match(prompt, /Do not open \.agents\/\*\* or scripts\/ralph\/\*\*, and never report/);
  assert.match(prompt, /Do read AGENTS\.md/);
  // Без инвентаря prompt обязан остаться прежним: ревью milestone может идти по
  // ветке, базу которой git не разрешил, и тогда инвентаря просто нет.
  assert.doesNotMatch(prompt, /```diff/);
  assert.match(prompt, /Discover documentation paths/i);
  assert.match(prompt, /rg --files docs/);
  assert.match(prompt, /guess conventional paths such as `docs\/README\.md`/i);
  assert.match(prompt, /`docs\/api\.md`.*`docs\/api-architecture\.md`/);
});

test('the milestone reviewer is shown the branch diff without the control plane', () => {
  const prompt = buildMilestoneReviewPrompt(
    { agentCli: 'claude', baseBranch: 'master' },
    { title: 'Phase 8', description: 'Password change screen.' },
    { number: 61, url: 'https://example.test/pull/61', headRefOid: 'a'.repeat(40) },
    {
      changes: {
        range: 'origin/master...' + 'a'.repeat(40),
        commits: 'abc1234 feat: end the browser session',
        stat: ' apps/api/src/profile.service.ts | 8 ++++',
        nameStatus: 'M\tapps/api/src/profile.service.ts',
        diff: '--- a/apps/api/src/profile.service.ts',
        truncated: false,
      },
    },
  );

  // Диапазон с тремя точками: сравнение идёт с точкой расхождения, иначе в diff
  // попадёт всё, что уехало в базовую ветку после ответвления.
  assert.match(prompt, /origin\/master\.\.\.a{40}/);
  assert.match(prompt, /abc1234 feat: end the browser session/);
  assert.match(prompt, /```diff/);
  assert.match(prompt, /control plane excluded/);
});

test('Ralph infrastructure is never treated as product work', () => {
  for (const file of [
    '.agents/ralph.config.json',
    'scripts/ralph/ralph-loop.mjs:975',
    'AGENTS.md',
    'apps/api/AGENTS.md',
    // Claude Code читает `.claude/**`: положенный туда файл управляет будущей
    // сессией, поэтому каталог принадлежит оператору, как и `.agents/**`.
    '.claude/security-reviewer.md',
    '.claude/settings.json',
    '.claude/agents/reviewer.md',
  ]) {
    assert.equal(isRalphInfrastructurePath(file), true, file);
  }
  assert.equal(isRalphInfrastructurePath('apps/api/src/main.ts:10'), false);
  assert.equal(
    isRalphInfrastructureIssue({
      body: '<!-- ralph-milestone-finding pr:61 id:x -->\n**Location:** `scripts/ralph/ralph-loop.mjs:975`',
    }),
    true,
  );
  assert.equal(
    isRalphInfrastructureIssue({ labels: [{ name: 'ralph-infrastructure' }], body: '' }),
    true,
  );
  assert.equal(
    isRalphInfrastructureIssue({
      body: '<!-- ralph-milestone-finding pr:61 id:y -->\n**Location:** `apps/api/src/main.ts:10`',
    }),
    false,
  );
});

test('milestone review removes Ralph findings before product issues are created', () => {
  const scoped = scopeMilestoneReviewToProduct({
    verdict: 'fail',
    summary: 'Two findings.',
    findings: [
      {
        severity: 'P1',
        title: 'Control-plane defect',
        body: 'Fix Ralph.',
        file: 'scripts/ralph/ralph-loop.mjs',
        line: 10,
      },
      {
        severity: 'P2',
        title: 'Product defect',
        body: 'Fix API.',
        file: 'apps/api/src/main.ts',
        line: 20,
      },
    ],
  });

  assert.equal(scoped.verdict, 'fail');
  assert.deepEqual(
    scoped.findings.map((finding) => finding.title),
    ['Product defect'],
  );
  assert.match(scoped.summary, /excluded from the product milestone/);

  const infrastructureOnly = scopeMilestoneReviewToProduct({
    verdict: 'fail',
    summary: 'One finding.',
    findings: [
      {
        severity: 'P1',
        title: 'Control-plane defect',
        body: 'Fix Ralph.',
        file: '.agents/RALPH.md',
      },
    ],
  });
  assert.equal(infrastructureOnly.verdict, 'pass');
  assert.deepEqual(infrastructureOnly.findings, []);
});

test('cached milestone PASS is trusted only with an empty canonical findings section', () => {
  const marker = '<!-- ralph-milestone-review milestone:abc head:def model:gpt-5.6-sol -->';
  const cleanReview = `${marker}
## Ralph Loop: milestone review

- **Verdict:** **PASS**

Everything is ready.

### Findings

No actionable findings.

The pull request remains draft so a human can make the final merge decision.`;
  const malformedReview = `${marker}
## Ralph Loop: milestone review

- **Verdict:** **PASS**

### Findings

- **P2 — Cached defect** (file.ts:10)
  This finding must prevent cached PASS reuse.

The pull request remains draft so a human can make the final merge decision.`;
  const duplicateFindingsReview = `${marker}
## Ralph Loop: milestone review

- **Verdict:** **PASS**

### Findings

- **P2 — Hidden defect** (file.ts:10)
  A second empty section must not hide this finding.

### Findings

No actionable findings.

The pull request remains draft so a human can make the final merge decision.`;

  assert.equal(milestonePassReviewIsClean(cleanReview, marker), true);
  assert.equal(milestonePassReviewIsClean(malformedReview, marker), false);
  assert.equal(milestonePassReviewIsClean(duplicateFindingsReview, marker), false);
  assert.equal(milestonePassReviewIsClean(cleanReview, '<!-- another marker -->'), false);
});

const ralphRulesPath = fileURLToPath(new URL('../../.agents/ralph-rules.md', import.meta.url));

const ralphOperatorDocPath = fileURLToPath(new URL('../../.agents/RALPH.md', import.meta.url));

test('the implementation prompt carries the full contract without the operator manual', () => {
  const config = loadConfig();
  const rules = readFileSync(ralphRulesPath, 'utf8');
  const prompt = renderPrompt(
    { ...config, milestone: 'Phase 8', branch: 'features/profile-phase-8' },
    {
      number: 71,
      title: 'Deliver the password change screen',
      url: 'https://example/71',
      body: 'Body.',
    },
    rules,
  );

  // The contract is inlined, so reading the 268-line operator document would be
  // hundreds of lines of input tokens per issue for no requirement.
  assert.match(prompt, /Не читай \.agents\/RALPH\.md/);
  assert.equal(/Прочитай \.agents\/RALPH\.md/.test(prompt), false);
  assert.match(prompt, /правила Ralph Loop, переданные ниже/);
  assert.match(prompt, /# Ralph Loop — правила автономной сессии/);
  // Проверяется, что запрет на control plane дошёл до prompt и называет все
  // защищённые каталоги, а не точная формулировка: правила переписываются, и
  // тест, приколоченный к фразе, ловил бы редактуру вместо потери правила.
  for (const guarded of ['`.agents/**`', '`.claude/**`', '`scripts/ralph/**`']) {
    assert.equal(prompt.includes(guarded), true, guarded);
  }
  assert.match(prompt, /COMMIT_MESSAGE/);
  assert.match(prompt, /ALREADY_FIXED/);
  // Placeholders are still substituted.
  assert.match(prompt, /Работай только над issue #71\./);
  assert.equal(prompt.includes('{issue_number}'), false);
});

test('the operator manual states that it is not the agent contract', () => {
  const operatorDoc = readFileSync(ralphOperatorDocPath, 'utf8');
  assert.match(operatorDoc, /Это операторская документация/);
  assert.match(operatorDoc, /\.agents\/ralph-rules\.md/);
});

test('every generated prompt protects Next.js route segments with the tools it actually has', () => {
  const rules = readFileSync(ralphRulesPath, 'utf8');
  const prompts = (config) => [
    [
      'issue review',
      buildIndependentReviewPrompt(
        config,
        { number: 71, title: 'Issue', body: 'Body.' },
        'a'.repeat(40),
      ),
    ],
    [
      'milestone review',
      buildMilestoneReviewPrompt(
        { ...config, baseBranch: 'master', branch: 'features/profile-phase-8' },
        { title: 'Phase 8', description: 'Description.' },
        { number: 61, url: 'https://example/61', headRefOid: 'b'.repeat(40) },
      ),
    ],
  ];

  // Сегмент обязан быть назван везде: это единственное место, где его вообще
  // объясняют. А вот способ его прочитать у ревьюеров разный, и подсказка
  // обязана совпадать с тем набором инструментов, который роль получила.
  for (const [label, text] of [['rules', rules], ...prompts({ agentCli: 'codex' })]) {
    assert.match(text, /-LiteralPath/, `${label} must require -LiteralPath`);
    assert.match(text, /\[id\]/, `${label} must name the wildcard-prone segment`);
  }

  // Claude-ревьюер запускается с `--tools Read,Glob,Grep` и Bash не имеет:
  // инструкция про PowerShell была бы неисполнима, а защита от скобок —
  // отсутствующей.
  for (const [label, text] of prompts({ agentCli: 'claude' })) {
    assert.match(text, /\[id\]/, `${label} must name the wildcard-prone segment`);
    assert.doesNotMatch(text, /-LiteralPath|rg -n/, `${label} must not prescribe a shell`);
    assert.match(text, /Grep, Glob and Read/, `${label} must name the available tools`);
    assert.match(text, /character class/, `${label} must explain the bracket hazard`);
  }

  assert.match(rules, /Get-ChildItem/);
  assert.match(rules, /Test-Path/);
  assert.match(rules, /FullName/);
});

test('a Next.js route segment is only readable through -LiteralPath on Windows', function (t) {
  if (process.platform !== 'win32') {
    t.skip('PowerShell wildcard behaviour is Windows-specific');
    return;
  }

  const directory = mkdtempSync(path.join(tmpdir(), 'ralph-literal-path-'));
  try {
    const segment = path.join(directory, '[id]');
    mkdirSync(segment, { recursive: true });
    const file = path.join(segment, 'page.tsx');
    writeFileSync(file, 'export default function Page() {}\n', 'utf8');

    const readWithPath = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `Get-Content -Path '${file}'`],
      { encoding: 'utf8' },
    );
    const readWithLiteralPath = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `Get-Content -LiteralPath '${file}'`],
      { encoding: 'utf8' },
    );

    assert.match(
      readWithLiteralPath.stdout,
      /export default function Page/,
      '-LiteralPath must read the file',
    );
    assert.equal(
      /export default function Page/.test(readWithPath.stdout),
      false,
      '-Path treats [id] as a wildcard and finds nothing — this is the failure the rule prevents',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
