import assert from "node:assert/strict";
import test from "node:test";

import {
  alreadyFixedCommitFromAgent,
  createOrReopenReviewIssues,
  executeMode,
  issueBodyWithCompletionState,
  issueBodyWithReviewContext,
  issueCompletionState,
  normalizeReviewResult,
  reviewFindingFingerprint,
  reviewFindingMarker,
  runContinuousLoop,
} from "./ralph-loop.mjs";

function context(overrides = {}) {
  return {
    mode: "--run",
    config: {
      branch: "feature/test",
      milestone: "Test milestone",
      maxIterations: 5,
    },
    repository: "owner/repository",
    milestone: { number: 7, title: "Test milestone" },
    repositoryState: { currentBranch: "feature/test", clean: true },
    rules: "test rules",
    ...overrides,
  };
}

function actions(overrides = {}) {
  return {
    issueState: () => "CLOSED",
    openIssues: () => [],
    printCheck: () => {},
    runCodex: async () => {},
    createPullRequest: () => ({ number: 10, headRefOid: "head-1" }),
    runMilestoneReview: async () => ({ verdict: "pass", summary: "ok", findings: [] }),
    createOrReopenReviewIssues: () => [],
    ...overrides,
  };
}

test("--check reports state without running an issue or creating a PR", async () => {
  const calls = [];
  const result = await executeMode(
    context({ mode: "--check" }),
    actions({
      openIssues: () => [{ number: 1 }],
      printCheck: () => calls.push("check"),
      runCodex: async () => calls.push("codex"),
      createPullRequest: () => calls.push("pr"),
    }),
  );

  assert.deepEqual(result, { mode: "check", issues: 1 });
  assert.deepEqual(calls, ["check"]);
});

test("--once completes exactly one open issue", async () => {
  const completed = [];
  const result = await executeMode(
    context({ mode: "--once" }),
    actions({
      openIssues: () => [{ number: 11 }, { number: 12 }],
      runCodex: async (_config, _repository, issue) => {
        completed.push(issue.number);
        return { completed: true };
      },
    }),
  );

  assert.deepEqual(result, { mode: "once", completed: 1 });
  assert.deepEqual(completed, [11]);
});

test("--once exits cleanly when no issue is open", async () => {
  let codexRuns = 0;
  const result = await executeMode(
    context({ mode: "--once" }),
    actions({ runCodex: async () => (codexRuns += 1) }),
  );

  assert.deepEqual(result, { mode: "once", completed: 0 });
  assert.equal(codexRuns, 0);
});

test("--once reports an issue-level review failure without claiming completion", async () => {
  const result = await executeMode(
    context({ mode: "--once" }),
    actions({
      openIssues: () => [{ number: 11 }],
      runCodex: async () => ({ completed: false }),
    }),
  );

  assert.deepEqual(result, { mode: "once", completed: 0, reviewFailed: true });
});

test("continuous loop fixes new review issues even while GitHub list remains stale", async () => {
  let reviewRuns = 0;
  const completed = [];
  const pullRequests = [];
  const testActions = actions({
    openIssues: () => [],
    createPullRequest: () => {
      const pullRequest = { number: 61, headRefOid: `head-${completed.length}` };
      pullRequests.push(pullRequest.headRefOid);
      return pullRequest;
    },
    runMilestoneReview: async () => {
      reviewRuns += 1;
      if (reviewRuns === 1) {
        return {
          verdict: "fail",
          summary: "two findings",
          findings: [{ title: "first" }, { title: "second" }],
        };
      }
      return { verdict: "pass", summary: "clean", findings: [] };
    },
    createOrReopenReviewIssues: (_config, _repository, _milestone, _pr, review) => {
      return review.findings.map((finding, index) => ({
        number: 101 + index,
        title: finding.title,
      }));
    },
    runCodex: async (_config, _repository, issue) => {
      completed.push(issue.number);
      return { completed: true };
    },
  });

  const result = await runContinuousLoop(context(), testActions);

  assert.equal(result.verdict, "pass");
  assert.equal(result.iterations, 2);
  assert.deepEqual(completed, [101, 102]);
  assert.deepEqual(pullRequests, ["head-0", "head-2"]);
  assert.equal(reviewRuns, 2);
});

test("continuous loop treats PASS with findings as recovery work", async () => {
  let reviewRuns = 0;
  const completed = [];

  const result = await runContinuousLoop(
    context(),
    actions({
      openIssues: () => [],
      runMilestoneReview: async () => {
        reviewRuns += 1;
        return reviewRuns === 1
          ? { verdict: "pass", summary: "inconsistent", findings: [{ title: "still broken" }] }
          : { verdict: "pass", summary: "clean", findings: [] };
      },
      createOrReopenReviewIssues: () => [{ number: 201, title: "still broken" }],
      runCodex: async (_config, _repository, issue) => {
        completed.push(issue.number);
        return { completed: true };
      },
    }),
  );

  assert.equal(result.verdict, "pass");
  assert.deepEqual(completed, [201]);
  assert.equal(reviewRuns, 2);
});

test("continuous loop stops when the shared issue iteration budget is exhausted", async () => {
  let open = [{ number: 1 }, { number: 2 }];
  const limitedContext = context({
    config: { branch: "feature/test", milestone: "Test milestone", maxIterations: 1 },
  });

  await assert.rejects(
    runContinuousLoop(
      limitedContext,
      actions({
        openIssues: () => [...open],
        runCodex: async (_config, _repository, issue) => {
          open = open.filter((candidate) => candidate.number !== issue.number);
        },
      }),
    ),
    /Достигнут лимит 1 итераций/,
  );
});

test("continuous loop retries the same issue after an issue-level review finding", async () => {
  let open = [{ number: 8 }];
  let attempts = 0;

  const result = await runContinuousLoop(
    context(),
    actions({
      openIssues: () => [...open],
      runCodex: async () => {
        attempts += 1;
        if (attempts === 2) {
          open = [];
          return { completed: true };
        }
        return { completed: false };
      },
    }),
  );

  assert.equal(result.verdict, "pass");
  assert.equal(result.iterations, 2);
  assert.equal(attempts, 2);
});

test("continuous loop keeps fresh retry context and ignores a stale completed issue", async () => {
  const seenBodies = [];
  const staleIssue = { number: 8, title: "Retry me", body: "stale body" };
  let attempts = 0;

  const result = await runContinuousLoop(
    context(),
    actions({
      // Имитируем eventual consistency: GitHub продолжает возвращать старый объект
      // даже после обновления body и закрытия issue.
      openIssues: () => [{ ...staleIssue }],
      runCodex: async (_config, _repository, issue) => {
        attempts += 1;
        seenBodies.push(issue.body);
        if (attempts === 1) {
          issue.body = "fresh review context";
          return { completed: false };
        }
        return { completed: true };
      },
    }),
  );

  assert.equal(result.verdict, "pass");
  assert.equal(result.iterations, 2);
  assert.deepEqual(seenBodies, ["stale body", "fresh review context"]);
});

test("continuous loop processes an issue that was genuinely reopened", async () => {
  const issue = { number: 8, title: "Reopened", body: "requirements" };
  let codexRuns = 0;
  let visible = true;

  const result = await runContinuousLoop(
    context(),
    actions({
      openIssues: () => (visible ? [{ ...issue }] : []),
      issueState: () => "OPEN",
      runCodex: async () => {
        codexRuns += 1;
        // После первого закрытия GitHub возвращает эту issue как действительно
        // переоткрытую; после второй реализации она исчезает из списка.
        if (codexRuns === 2) {
          visible = false;
        }
        return { completed: true };
      },
    }),
  );

  assert.equal(result.verdict, "pass");
  assert.equal(result.iterations, 2);
  assert.equal(codexRuns, 2);
});

test("continuous loop rejects FAIL without queued recovery issues", async () => {
  await assert.rejects(
    runContinuousLoop(
      context(),
      actions({
        runMilestoneReview: async () => ({
          verdict: "fail",
          summary: "invalid empty recovery",
          findings: [],
        }),
      }),
    ),
    /ни одной issue исправления не создано/,
  );
});

test("finding fingerprint is stable for Unicode titles and changes with location", () => {
  const pullRequest = { number: 61 };
  const finding = {
    severity: "P1",
    title: "Обработать ошибку reconciliation",
    file: "apps/api/src/service.ts",
  };

  const first = reviewFindingFingerprint(pullRequest, finding);
  const equivalent = reviewFindingFingerprint(pullRequest, {
    ...finding,
    title: "ОБРАБОТАТЬ   ОШИБКУ — reconciliation!",
  });
  const anotherFile = reviewFindingFingerprint(pullRequest, {
    ...finding,
    file: "apps/api/src/other.ts",
  });

  assert.equal(first, equivalent);
  assert.notEqual(first, anotherFile);
});

test("review findings create, reuse, and reopen milestone issues without duplicates", () => {
  const config = { milestone: "Test milestone" };
  const milestone = { number: 7, title: "Test milestone" };
  const pullRequest = { number: 61, headRefOid: "head-1" };
  const findings = [
    { severity: "P1", title: "Open finding", body: "open", file: "open.ts", line: 1 },
    { severity: "P2", title: "Closed finding", body: "closed", file: "closed.ts", line: 2 },
    { severity: "P2", title: "New finding", body: "new", file: "new.ts", line: 3 },
  ];
  const existing = [
    {
      number: 1,
      state: "OPEN",
      body: reviewFindingMarker(pullRequest, findings[0]),
    },
    {
      number: 2,
      state: "CLOSED",
      body: reviewFindingMarker(pullRequest, findings[1]),
    },
  ];
  const created = [];
  const updated = [];
  const reopened = [];

  const queued = createOrReopenReviewIssues(
    config,
    "owner/repository",
    milestone,
    pullRequest,
    { verdict: "fail", findings: [...findings, findings[0]] },
    {
      milestoneIssues: () => existing,
      createReviewFindingIssue: (_config, _repository, _milestone, _pr, finding) => {
        const issue = { number: 3, state: "OPEN", body: reviewFindingMarker(pullRequest, finding) };
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

test("issue review context is replaced instead of growing on every retry", () => {
  const first = issueBodyWithReviewContext(
    { body: "Original requirements" },
    {
      summary: "First review",
      findings: [
        { severity: "P1", title: "First finding", file: "first.ts", line: 1, body: "Fix first" },
      ],
    },
  );
  const second = issueBodyWithReviewContext(
    { body: first },
    {
      summary: "Second review",
      findings: [
        { severity: "P2", title: "Second finding", file: "second.ts", line: 2, body: "Fix second" },
      ],
    },
  );

  assert.match(second, /^Original requirements/);
  assert.doesNotMatch(second, /First review|First finding/);
  assert.match(second, /Second review/);
  assert.equal(second.match(/ralph-issue-review-context:start/g)?.length, 1);
});

test("issue completion state can be replaced and removed by review context", () => {
  const firstCommit = "a".repeat(40);
  const secondCommit = "b".repeat(40);
  const pending = issueBodyWithCompletionState(
    { body: "Original requirements" },
    "pending-review",
    firstCommit,
  );
  const passed = issueBodyWithCompletionState(
    { body: pending },
    "review-passed",
    secondCommit,
  );

  assert.deepEqual(issueCompletionState({ body: pending }), {
    status: "pending-review",
    commit: firstCommit,
  });
  assert.deepEqual(issueCompletionState({ body: passed }), {
    status: "review-passed",
    commit: secondCommit,
  });
  assert.equal(passed.match(/ralph-issue-completion/g)?.length, 1);

  const retryBody = issueBodyWithReviewContext(
    { body: passed },
    {
      summary: "Needs another fix",
      findings: [
        { severity: "P1", title: "Finding", file: "file.ts", line: 1, body: "Fix it" },
      ],
    },
  );
  assert.equal(issueCompletionState({ body: retryBody }), null);
  assert.doesNotMatch(retryBody, /ralph-issue-completion/);
});

test("already-fixed marker accepts a commit SHA only on its own final line", () => {
  assert.equal(
    alreadyFixedCommitFromAgent(`Checks passed.\n\nALREADY_FIXED: ${"c".repeat(40)}`),
    "c".repeat(40),
  );
  assert.equal(alreadyFixedCommitFromAgent("ALREADY_FIXED: not-a-sha"), null);
  assert.equal(
    alreadyFixedCommitFromAgent(`ALREADY_FIXED: ${"d".repeat(40)}\nMore text`),
    null,
  );
  assert.equal(alreadyFixedCommitFromAgent(undefined), null);
});

test("review result invariants reject empty FAIL and convert PASS with findings", () => {
  assert.throws(
    () => normalizeReviewResult({ verdict: "fail", summary: "broken", findings: [] }),
    /FAIL without actionable findings/,
  );

  const normalized = normalizeReviewResult({
    verdict: "pass",
    summary: "inconsistent",
    findings: [
      { severity: "P1", title: "Bug", body: "Fix it", file: "file.ts", line: 1 },
    ],
  });
  assert.equal(normalized.verdict, "fail");
  assert.equal(normalized.findings.length, 1);
  assert.match(normalized.summary, /treated the result as FAIL/);
});
