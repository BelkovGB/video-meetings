import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  agentSkillFiles,
  alreadyFixedCommitFromAgent,
  developmentCodexArguments,
  createOrReopenReviewIssues,
  formatFailureSummary,
  issueBodyWithCompletionState,
  issueBodyWithReviewContext,
  issueCompletionState,
  limitMilestoneReviewFindings,
  linkedCommitForIssue,
  loadConfig,
  milestonePassReviewIsClean,
  milestoneReviewMarker,
  normalizeReviewResult,
  parseSkillFrontmatter,
  recoveryPrompt,
  reviewFindingFingerprint,
  reviewFindingMarker,
  summarizeCommandFailure,
  uniqueFailedTests,
  verifyAgentSkills,
} from './ralph-loop.mjs';
import { ralphConfigPath, withPatchedRalphConfig } from './ralph-test-support.mjs';

test('finding fingerprint is stable for Unicode titles and changes with location', () => {
  const pullRequest = { number: 61 };
  const finding = {
    severity: 'P1',
    title: 'Обработать ошибку reconciliation',
    file: 'apps/api/src/service.ts',
  };

  const first = reviewFindingFingerprint(pullRequest, finding);
  const equivalent = reviewFindingFingerprint(pullRequest, {
    ...finding,
    title: 'ОБРАБОТАТЬ   ОШИБКУ — reconciliation!',
  });
  const anotherFile = reviewFindingFingerprint(pullRequest, {
    ...finding,
    file: 'apps/api/src/other.ts',
  });

  assert.equal(first, equivalent);
  assert.notEqual(first, anotherFile);
});

test('review findings create, reuse, and reopen milestone issues without duplicates', () => {
  const config = { milestone: 'Test milestone' };
  const milestone = { number: 7, title: 'Test milestone' };
  const pullRequest = { number: 61, headRefOid: 'head-1' };
  const findings = [
    { severity: 'P1', title: 'Open finding', body: 'open', file: 'open.ts', line: 1 },
    { severity: 'P2', title: 'Closed finding', body: 'closed', file: 'closed.ts', line: 2 },
    { severity: 'P2', title: 'New finding', body: 'new', file: 'new.ts', line: 3 },
  ];
  const existing = [
    {
      number: 1,
      state: 'OPEN',
      body: reviewFindingMarker(pullRequest, findings[0]),
    },
    {
      number: 2,
      state: 'CLOSED',
      body: reviewFindingMarker(pullRequest, findings[1]),
    },
  ];
  const created = [];
  const updated = [];
  const reopened = [];

  const queued = createOrReopenReviewIssues(
    config,
    'owner/repository',
    milestone,
    pullRequest,
    { verdict: 'fail', findings: [...findings, findings[0]] },
    {
      milestoneIssues: () => existing,
      createReviewFindingIssue: (_config, _repository, _milestone, _pr, finding) => {
        const issue = { number: 3, state: 'OPEN', body: reviewFindingMarker(pullRequest, finding) };
        created.push(issue.number);
        return issue;
      },
      updateReviewFindingIssue: (_config, _repository, issue) => updated.push(issue.number),
      reopenReviewFindingIssue: (_repository, issue) => reopened.push(issue.number),
    },
  );

  assert.deepEqual(
    queued.map((issue) => issue.number),
    [1, 2, 3],
  );
  assert.deepEqual(created, [3]);
  assert.deepEqual(updated, [1, 2, 1]);
  assert.deepEqual(reopened, [2]);
});

test('issue review context is replaced instead of growing on every retry', () => {
  const first = issueBodyWithReviewContext(
    { body: 'Original requirements' },
    {
      summary: 'First review',
      findings: [
        { severity: 'P1', title: 'First finding', file: 'first.ts', line: 1, body: 'Fix first' },
      ],
    },
  );
  const second = issueBodyWithReviewContext(
    { body: first },
    {
      summary: 'Second review',
      findings: [
        { severity: 'P2', title: 'Second finding', file: 'second.ts', line: 2, body: 'Fix second' },
      ],
    },
  );

  assert.match(second, /^Original requirements/);
  assert.doesNotMatch(second, /First review|First finding/);
  assert.match(second, /Second review/);
  assert.equal(second.match(/ralph-issue-review-context:start/g)?.length, 1);
});

test('issue completion state can be replaced and removed by review context', () => {
  const firstCommit = 'a'.repeat(40);
  const secondCommit = 'b'.repeat(40);
  const pending = issueBodyWithCompletionState(
    { body: 'Original requirements' },
    'pending-review',
    firstCommit,
  );
  const passed = issueBodyWithCompletionState({ body: pending }, 'review-passed', secondCommit);

  assert.deepEqual(issueCompletionState({ body: pending }), {
    status: 'pending-review',
    commit: firstCommit,
  });
  assert.deepEqual(issueCompletionState({ body: passed }), {
    status: 'review-passed',
    commit: secondCommit,
  });
  assert.equal(passed.match(/ralph-issue-completion/g)?.length, 1);

  const retryBody = issueBodyWithReviewContext(
    { body: passed },
    {
      summary: 'Needs another fix',
      findings: [{ severity: 'P1', title: 'Finding', file: 'file.ts', line: 1, body: 'Fix it' }],
    },
  );
  assert.equal(issueCompletionState({ body: retryBody }), null);
  assert.doesNotMatch(retryBody, /ralph-issue-completion/);
});

test('already-fixed marker accepts a commit SHA only on its own final line', () => {
  assert.equal(
    alreadyFixedCommitFromAgent(`Checks passed.\n\nALREADY_FIXED: ${'c'.repeat(40)}`),
    'c'.repeat(40),
  );
  assert.equal(alreadyFixedCommitFromAgent('ALREADY_FIXED: not-a-sha'), null);
  assert.equal(alreadyFixedCommitFromAgent(`ALREADY_FIXED: ${'d'.repeat(40)}\nMore text`), null);
  assert.equal(alreadyFixedCommitFromAgent(undefined), null);
});

test('fresh Ralph-Issue trailer links an existing commit without another Terra run', () => {
  const commit = 'a'.repeat(40);
  const commands = [];
  const execute = (_command, args) => {
    commands.push(args);
    if (args[0] === 'log') {
      return { status: 0, stdout: `${commit}\t2026-08-14T12:39:45+03:00` };
    }
    return { status: 0, stdout: '#64' };
  };

  assert.equal(
    linkedCommitForIssue({ number: 64, updatedAt: '2026-08-14T09:31:03Z' }, execute),
    commit,
  );
  assert.deepEqual(commands[0].slice(-3), ['--grep', 'Ralph-Issue: #64', 'HEAD']);
});

test('Ralph-Issue trailer older than the latest issue update is not reused', () => {
  const execute = (_command, args) => ({
    status: 0,
    stdout: args[0] === 'log' ? `${'b'.repeat(40)}\t2026-08-14T09:00:00Z` : '#64',
  });

  assert.equal(
    linkedCommitForIssue({ number: 64, updatedAt: '2026-08-14T09:31:03Z' }, execute),
    null,
  );
  assert.equal(linkedCommitForIssue({ number: 64 }, execute), null);
});

test('review result invariants reject empty FAIL and convert PASS with findings', () => {
  assert.throws(
    () => normalizeReviewResult({ verdict: 'fail', summary: 'broken', findings: [] }),
    /FAIL without actionable findings/,
  );

  const normalized = normalizeReviewResult({
    verdict: 'pass',
    summary: 'inconsistent',
    findings: [{ severity: 'P1', title: 'Bug', body: 'Fix it', file: 'file.ts', line: 1 }],
  });
  assert.equal(normalized.verdict, 'fail');
  assert.equal(normalized.findings.length, 1);
  assert.match(normalized.summary, /treated the result as FAIL/);
});

test('milestone findings are deduplicated, prioritized, and bounded', () => {
  const pullRequest = { number: 61 };
  const findings = Array.from({ length: 12 }, (_, index) => ({
    severity: index === 11 ? 'P0' : index >= 8 ? 'P1' : 'P2',
    title: `Finding ${index}`,
    body: `Body ${index}`,
    file: `file-${index}.ts`,
    line: index + 1,
  }));
  findings.push({ ...findings[11] });

  const limited = limitMilestoneReviewFindings(
    { verdict: 'fail', summary: 'Review summary.', findings },
    pullRequest,
    10,
  );

  assert.equal(limited.findings.length, 10);
  assert.equal(limited.findings[0].severity, 'P0');
  assert.deepEqual(
    limited.findings.slice(1, 4).map((finding) => finding.severity),
    ['P1', 'P1', 'P1'],
  );
  assert.equal(limited.findings.filter((finding) => finding.title === 'Finding 11').length, 1);
  assert.match(limited.summary, /2 findings were deferred/);
});

test('skill frontmatter parser accepts valid YAML and reports tab-separated fields', () => {
  const valid = parseSkillFrontmatter(
    '---\r\nname: read\r\ndescription: Читай файл эффективно\r\n---\r\n# Read File\r\n',
  );
  assert.deepEqual(valid.errors, []);
  assert.equal(valid.fields.get('name'), 'read');
  assert.equal(valid.fields.get('description'), 'Читай файл эффективно');

  const tabSeparated = parseSkillFrontmatter('---\nname\tread\ndescription\tЧитай\n---\n# Read\n');
  assert.equal(tabSeparated.errors.length, 2);
  assert.match(tabSeparated.errors[0], /строка 2: поле "name" отделено табуляцией/);
  assert.match(tabSeparated.errors[1], /строка 3: поле "description" отделено табуляцией/);
});

test('skill frontmatter parser rejects missing, empty, and unterminated frontmatter', () => {
  assert.deepEqual(parseSkillFrontmatter('# Read File\n').errors, [
    'файл должен начинаться со строки `---`',
  ]);
  assert.deepEqual(parseSkillFrontmatter('---\nname: read\n').errors, [
    'frontmatter не закрыт строкой `---`',
  ]);
  assert.deepEqual(parseSkillFrontmatter('---\nname: read\ndescription:\n---\n').errors, [
    'поле "description" пустое',
  ]);
  assert.deepEqual(parseSkillFrontmatter('---\nname: read\n---\n').errors, [
    'отсутствует обязательное поле "description"',
  ]);
});

test('skill frontmatter parser keeps multi-line values and quoted descriptions valid', () => {
  const folded = parseSkillFrontmatter(
    '---\nname: ui-ux-pro-max\ndescription: >-\n  UI/UX design intelligence\n  for web and mobile.\n---\n',
  );
  assert.deepEqual(folded.errors, []);

  const quoted = parseSkillFrontmatter(
    '---\nname: prd\ndescription: "Создаю PRD: документ"\n---\n',
  );
  assert.deepEqual(quoted.errors, []);
  assert.equal(quoted.fields.get('description'), '"Создаю PRD: документ"');
});

test('every project-local SKILL.md exposes loadable frontmatter', () => {
  // .agents/skills is gitignored, so a clean checkout legitimately has none.
  // The assertion is "whatever is present must load", not "skills must exist".
  const files = agentSkillFiles();
  for (const file of files) {
    const { errors } = parseSkillFrontmatter(readFileSync(file, 'utf8'));
    assert.deepEqual(errors, [], `${file}: ${errors.join('; ')}`);
  }
  assert.doesNotThrow(() => verifyAgentSkills());
});

test('skill preflight fails with every invalid skill listed at once', () => {
  const contents = new Map([
    [path.join('a', 'SKILL.md'), '---\nname\ta\ndescription\tbroken\n---\n'],
    [path.join('b', 'SKILL.md'), '---\nname: b\ndescription: fine\n---\n'],
    [path.join('c', 'SKILL.md'), '# no frontmatter\n'],
  ]);
  assert.throws(
    () =>
      verifyAgentSkills({
        files: [...contents.keys()],
        readFile: (file) => contents.get(file),
      }),
    (error) => {
      assert.match(error.message, /Невалидный frontmatter project-local skills/);
      assert.match(error.message, /отделено табуляцией/);
      assert.match(error.message, /должен начинаться со строки/);
      assert.equal(/SKILL\.md:/g.test(error.message), true);
      assert.equal(error.message.includes(path.join('b', 'SKILL.md')), false);
      return true;
    },
  );
});

test('development codex arguments carry an explicit reasoning effort', () => {
  const args = developmentCodexArguments({
    developmentModel: 'gpt-5.6-terra',
    developmentEffort: 'medium',
  });
  const effortIndex = args.indexOf('-c');
  assert.notEqual(effortIndex, -1);
  assert.equal(args[effortIndex + 1], 'model_reasoning_effort="medium"');
  assert.ok(effortIndex > args.indexOf('--model'));
  assert.equal(args.at(-1), '-');
});

test('the committed configuration pins an explicit reasoning effort per role', () => {
  const config = loadConfig();
  try {
    assert.equal(config.developmentEffort, 'medium');
    assert.equal(config.review.effort, 'medium');
    assert.equal(config.milestoneReview.effort, 'high');
  } finally {
    rmSync(config.validationContainer.frozenDockerfileDirectory, {
      recursive: true,
      force: true,
    });
  }
});

test('reasoning effort defaults to medium/medium/high when the config omits it', () => {
  const original = JSON.parse(readFileSync(ralphConfigPath, 'utf8'));
  const { developmentEffort, ...withoutDevelopmentEffort } = original;
  assert.equal(developmentEffort, 'medium');
  const { effort: reviewEffort, ...review } = original.review;
  const { effort: milestoneEffort, ...milestoneReview } = original.milestoneReview;
  assert.equal(reviewEffort, 'medium');
  assert.equal(milestoneEffort, 'high');

  withPatchedRalphConfig({ ...withoutDevelopmentEffort, review, milestoneReview }, (config) => {
    assert.equal(config.developmentEffort, 'medium');
    assert.equal(config.review.effort, 'medium');
    assert.equal(config.milestoneReview.effort, 'high');
  });
});

test('an unsupported reasoning effort is rejected before a run starts', () => {
  for (const [patch, expected] of [
    [{ developmentEffort: 'extreme' }, /Поле "developmentEffort" должно быть одним из/],
    [
      { review: { enabled: false, model: 'gpt-5.6-terra', effort: 'nope' } },
      /Поле "review\.effort"/,
    ],
    [
      {
        milestoneReview: {
          enabled: false,
          model: 'gpt-5.6-sol',
          maxTurns: 150,
          maxFindings: 10,
          effort: 3,
        },
      },
      /Поле "milestoneReview\.effort"/,
    ],
  ]) {
    assert.throws(
      () =>
        withPatchedRalphConfig(patch, () => {
          throw new Error('loadConfig should have failed');
        }),
      expected,
    );
  }
  assert.match(
    readFileSync(ralphConfigPath, 'utf8'),
    /"developmentEffort": "medium"/,
    'the real config must be restored after each failed load',
  );
});

test('the milestone review marker records the effective model and effort', () => {
  const config = loadConfig();
  try {
    const marker = milestoneReviewMarker(
      config,
      { number: 8, title: 'Phase 8', description: '' },
      { number: 61, headRefOid: 'a'.repeat(40) },
    );
    assert.match(marker, /model:gpt-5\.6-sol effort:high -->$/);
    // A different effort is a different review, so the cached PASS must not match.
    const lowEffortMarker = milestoneReviewMarker(
      { ...config, milestoneReview: { ...config.milestoneReview, effort: 'low' } },
      { number: 8, title: 'Phase 8', description: '' },
      { number: 61, headRefOid: 'a'.repeat(40) },
    );
    assert.notEqual(lowEffortMarker, marker);
    assert.equal(milestonePassReviewIsClean(`${marker}\nirrelevant body`, lowEffortMarker), false);
  } finally {
    rmSync(config.validationContainer.frozenDockerfileDirectory, {
      recursive: true,
      force: true,
    });
  }
});

const escape = String.fromCharCode(27);

const newline = String.fromCharCode(10);

function playwrightFailureOutput() {
  return [
    'Running 42 tests using 4 workers',
    '',
    `${escape}[31m  1) [chromium] > e2e/profile.spec.ts:42:5 > profile > shows avatar ------${escape}[39m`,
    '',
    '    Error: expect(locator).toBeVisible() failed',
    '',
    "    Locator: getByRole('img')",
    '        at ProfilePage.check (e2e/profile.spec.ts:44:12)',
    '        at runNextTicks (node:internal/process/task_queues:104:5)',
    '',
    '    Retry #1 -------------------------------------',
    '    Error: expect(locator).toBeVisible() failed',
    '        at ProfilePage.check (e2e/profile.spec.ts:44:12)',
    '    attachment #1: screenshot (test-results/profile-shows-avatar-chromium/test-failed-1.png)',
    '',
    '    Retry #2 -------------------------------------',
    '    Error: expect(locator).toBeVisible() failed',
    '',
    '  1) [chromium] > e2e/profile.spec.ts:42:5 > profile > shows avatar ------',
    '  2) [mobile] > e2e/files-panel.spec.ts:10:3 > files > uploads ----------',
    '',
    '  2 failed',
    '  40 passed (1.4m)',
  ].join(newline);
}

function validationError(output) {
  return Object.assign(new Error('Команда docker run завершилась с кодом 1.'), {
    code: 'RALPH_COMMAND_FAILED',
    status: 1,
    stdout: output,
    stderr: '',
    script: 'test:e2e:web',
  });
}

test('a failed validation is stored as a bounded structured summary', () => {
  const summary = summarizeCommandFailure(validationError(playwrightFailureOutput()));

  assert.equal(summary.command, 'npm run test:e2e:web');
  assert.equal(summary.exitCode, 1);
  assert.equal(summary.code, 'RALPH_COMMAND_FAILED');
  assert.equal(summary.error, 'Error: expect(locator).toBeVisible() failed');
  assert.deepEqual(summary.failedTests, [
    '[chromium] > e2e/profile.spec.ts:42:5 > profile > shows avatar',
    '[mobile] > e2e/files-panel.spec.ts:10:3 > files > uploads',
  ]);
  assert.equal(summary.omittedFailedTests, 0);
  assert.deepEqual(summary.artifacts, [
    'test-results/profile-shows-avatar-chromium/test-failed-1.png',
  ]);
  assert.ok(summary.excerpt.length <= 20);
  assert.equal(
    summary.excerpt.some((line) => line.includes(escape)),
    false,
    'ANSI colouring must be stripped',
  );
  assert.equal(
    summary.excerpt.some((line) => line.startsWith('at ')),
    false,
    'stack frames must be dropped',
  );
  assert.equal(
    summary.excerpt.filter((line) => line === 'Error: expect(locator).toBeVisible() failed').length,
    1,
    'identical retry lines must collapse into one',
  );
});

test('the rendered failure summary is far smaller than the raw output and points at run.log', () => {
  const output = [playwrightFailureOutput(), 'noise line '.repeat(4_000)].join(newline);
  const rendered = formatFailureSummary(summarizeCommandFailure(validationError(output)));

  assert.ok(output.length > 40_000);
  assert.ok(rendered.length <= 2_100, `summary was ${rendered.length} chars`);
  assert.match(rendered, /Команда: npm run test:e2e:web/);
  assert.match(rendered, /Exit code: 1/);
  assert.match(rendered, /run\.log/);
});

test('failed tests are deduplicated across retries and bounded with a visible remainder', () => {
  const many = Array.from(
    { length: 14 },
    (_, index) => `  ${index + 1}) [chromium] > e2e/spec-${index}.spec.ts:1:1 > case ${index}`,
  );
  const withRetries = [...many, ...many, ...many].join(newline);
  const { tests, omitted } = uniqueFailedTests(withRetries);

  assert.equal(tests.length, 10);
  assert.equal(omitted, 4);
  assert.equal(new Set(tests).size, 10);
  assert.match(
    formatFailureSummary(summarizeCommandFailure(validationError(withRetries))),
    /Упавшие проверки \(показано 10 из 14\):/,
  );
});

test('jest and node:test failures are recognized alongside Playwright output', () => {
  const jest = [
    'FAIL test/profile.e2e-spec.ts',
    '  ● profile e2e > rejects an oversized current password',
    '',
    '    expect(received).toBe(expected)',
    '  ● Console',
    'Tests:       1 failed, 126 passed, 127 total',
  ].join(newline);
  assert.deepEqual(uniqueFailedTests(jest).tests, [
    'profile e2e > rejects an oversized current password',
  ]);

  const nodeTest = ['✖ config rejects an unsafe model (1.2ms)', 'ℹ fail 1'].join(newline);
  assert.deepEqual(uniqueFailedTests(nodeTest).tests, ['config rejects an unsafe model']);
});

test('a failure without command output degrades to the error message', () => {
  const summary = summarizeCommandFailure(
    Object.assign(new Error('Изолированный Codex не авторизован.'), {
      code: 'RALPH_CODEX_AUTH',
    }),
  );

  assert.equal(summary.command, null);
  assert.equal(summary.exitCode, null);
  assert.equal(summary.code, 'RALPH_CODEX_AUTH');
  assert.equal(summary.error, 'Изолированный Codex не авторизован.');
  assert.deepEqual(summary.failedTests, []);
  assert.match(formatFailureSummary(summary), /Код ошибки: RALPH_CODEX_AUTH/);
});

test('the recovery prompt carries the summary and tells the agent to rerun only what failed', () => {
  const summary = summarizeCommandFailure(validationError(playwrightFailureOutput()));
  const prompt = recoveryPrompt({
    lastFailure: formatFailureSummary(summary),
    lastFailureSummary: summary,
  });

  assert.match(prompt, /## AFK recovery/);
  assert.match(prompt, /npm run test:e2e:web/);
  assert.match(prompt, /Сначала повтори только упавшие проверки/);
  assert.match(prompt, /не дублируй его/);
  assert.ok(prompt.length < 2_500);

  const withoutFailure = recoveryPrompt({});
  assert.match(withoutFailure, /процесс завершился до фиксации результата/);
  assert.equal(/Сначала повтори только упавшие проверки/.test(withoutFailure), false);
});
