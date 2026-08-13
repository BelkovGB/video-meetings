import assert from "node:assert/strict";
import test from "node:test";

import {
  createOrReopenReviewIssues,
  executeMode,
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

test("continuous loop converts findings to issues, fixes all of them, and reviews again", async () => {
  let open = [];
  let reviewRuns = 0;
  const completed = [];
  const pullRequests = [];
  const testActions = actions({
    openIssues: () => [...open],
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
      open = review.findings.map((finding, index) => ({
        number: 101 + index,
        title: finding.title,
      }));
      return [...open];
    },
    runCodex: async (_config, _repository, issue) => {
      completed.push(issue.number);
      open = open.filter((candidate) => candidate.number !== issue.number);
    },
  });

  const result = await runContinuousLoop(context(), testActions);

  assert.equal(result.verdict, "pass");
  assert.equal(result.iterations, 2);
  assert.deepEqual(completed, [101, 102]);
  assert.deepEqual(pullRequests, ["head-0", "head-2"]);
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
