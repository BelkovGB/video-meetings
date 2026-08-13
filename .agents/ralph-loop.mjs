#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// -----------------------------------------------------------------------------
// Пути проекта и режим запуска
// -----------------------------------------------------------------------------

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.dirname(scriptDirectory);
const configPath = path.join(scriptDirectory, "ralph.config.json");
const mode = process.argv[2] ?? "--check";
const supportedModes = new Set(["--check", "--once", "--run"]);

// -----------------------------------------------------------------------------
// Запуск внешних команд: Git, GitHub CLI, npm и Codex CLI
// -----------------------------------------------------------------------------

function fail(message) {
  throw new Error(message);
}

function executable(name) {
  if (process.platform !== "win32") {
    return name;
  }

  return `${name}.exe`;
}

function commandSpec(name, args) {
  const useWindowsCommandShim =
    process.platform === "win32" && ["codex", "npm", "npx"].includes(name);
  const command = useWindowsCommandShim
    ? (process.env.ComSpec ?? "cmd.exe")
    : executable(name);
  const commandArgs = useWindowsCommandShim
    ? ["/d", "/s", "/c", `${name}.cmd`, ...args]
    : args;

  return { command, commandArgs };
}

function run(name, args, options = {}) {
  const { command, commandArgs } = commandSpec(name, args);
  const stdio = options.inherit
    ? [options.input === undefined ? "inherit" : "pipe", "inherit", "inherit"]
    : "pipe";
  const result = spawnSync(command, commandArgs, {
    cwd: projectRoot,
    encoding: "utf8",
    input: options.input,
    stdio,
  });

  if (result.error) {
    fail(`Не удалось запустить ${name}: ${result.error.message}`);
  }

  if (result.status !== 0 && !options.allowFailure) {
    const details = [result.stderr, result.stdout]
      .filter(Boolean)
      .map((value) => value.trim())
      .filter(Boolean)
      .join("\n");
    fail(`Команда ${name} ${args.join(" ")} завершилась с кодом ${result.status}.${details ? `\n${details}` : ""}`);
  }

  return {
    status: result.status,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
  };
}

function terminateProcessTree(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
    });
    return;
  }

  child.kill("SIGTERM");
}

function printCodexEvent(event, turn, maxTurns) {
  const item = event.item;
  if (!item) {
    return;
  }

  if (item.type === "error") {
    console.error(`[Codex] ${item.message}`);
    return;
  }

  if (turn !== null) {
    console.log(`[Codex step ${turn}/${maxTurns}] ${item.type}`);
  }

  if (event.type !== "item.completed") {
    return;
  }

  if (item.type === "agent_message" && item.text) {
    console.log(item.text);
  } else if (item.type === "command_execution" && item.aggregated_output) {
    process.stdout.write(item.aggregated_output);
    if (!item.aggregated_output.endsWith("\n")) {
      process.stdout.write("\n");
    }
  }
}

// -----------------------------------------------------------------------------
// Circuit breaker: ограничиваем количество шагов Codex через maxTurns
// -----------------------------------------------------------------------------

async function runCodexWithTurnLimit(args, options) {
  const { command, commandArgs } = commandSpec("codex", args);
  const child = spawn(command, commandArgs, {
    cwd: projectRoot,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let stderr = "";
  let stdoutBuffer = "";
  let lastAgentMessage = "";
  // Счётчик шагов текущей сессии Codex.
  let turns = 0;
  let limitReached = false;
  const seenItemIds = new Set();

  const handleLine = (line) => {
    if (line.trim() === "") {
      return;
    }

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      console.log(line);
      return;
    }

    const item = event.item;
    if (event.type === "item.completed" && item?.type === "agent_message" && item.text) {
      lastAgentMessage = item.text;
    }
    let currentTurn = null;
    if (
      (event.type === "item.started" || event.type === "item.completed") &&
      item?.id &&
      item.type !== "error" &&
      !seenItemIds.has(item.id)
    ) {
      // Проверяем лимит до запуска следующего уникального шага.
      if (turns >= options.maxTurns) {
        limitReached = true;
        console.error(
          `\nCircuit breaker: ${options.label} попытался превысить лимит ${options.maxTurns} шагов.`,
        );
        terminateProcessTree(child);
        return;
      }

      seenItemIds.add(item.id);
      turns += 1;
      currentTurn = turns;
    }

    printCodexEvent(event, currentTurn, options.maxTurns);
  };

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      handleLine(line);
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    process.stderr.write(chunk);
  });

  const childResult = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  child.stdin.end(options.input);
  const result = await childResult;
  if (stdoutBuffer.trim() !== "") {
    handleLine(stdoutBuffer);
  }

  if (limitReached) {
    const error = new Error(
      `${options.label} достиг лимита maxTurns=${options.maxTurns}.`,
    );
    error.code = "RALPH_MAX_TURNS";
    error.turns = turns;
    throw error;
  }

  if (result.code !== 0) {
    fail(
      `${options.label} завершился с кодом ${result.code ?? "null"}` +
        `${result.signal ? ` (сигнал ${result.signal})` : ""}.` +
        `${stderr.trim() ? `\n${stderr.trim()}` : ""}`,
    );
  }

  console.log(`${options.label}: использовано шагов ${turns}/${options.maxTurns}.`);
  return { turns, lastAgentMessage };
}

// -----------------------------------------------------------------------------
// Чтение и проверка ralph.config.json
// -----------------------------------------------------------------------------

function parseJson(value, source) {
  try {
    return JSON.parse(value);
  } catch (error) {
    fail(`Некорректный JSON от ${source}: ${error.message}`);
  }
}

function resolveProjectFile(file, field) {
  if (typeof file !== "string" || file.trim() === "") {
    fail(`Поле "${field}" должно быть непустой строкой.`);
  }

  const resolved = path.resolve(projectRoot, file);
  const relative = path.relative(projectRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    fail(`Поле "${field}" должно указывать файл внутри проекта.`);
  }

  return resolved;
}

function loadConfig() {
  const config = parseJson(readFileSync(configPath, "utf8"), configPath);

  for (const field of ["milestone", "branch", "prompt"]) {
    if (typeof config[field] !== "string" || config[field].trim() === "") {
      fail(`Заполните строковое поле \"${field}\" в ${configPath}.`);
    }
  }

  config.baseBranch ??= "main";
  config.draftPullRequest ??= true;
  config.maxIterations ??= 20;
  config.maxTurns ??= 50;
  config.maxTestFixAttempts ??= 5;
  config.developmentModel ??= "gpt-5.6-terra";
  config.rulesFile ??= ".agents/ralph-rules.md";
  config.validationScripts ??= ["format:check", "lint", "build"];
  config.review ??= {
    enabled: true,
    model: "gpt-5.6-terra",
    schemaFile: ".agents/review.schema.json",
    outputFile: ".agents/last-review.json",
  };
  config.review.model ??= "gpt-5.6-terra";
  config.milestoneReview ??= {
    enabled: true,
    model: "gpt-5.6-sol",
    maxTurns: config.maxTurns,
    schemaFile: ".agents/review.schema.json",
    outputFile: ".agents/last-milestone-review.json",
  };
  config.milestoneReview.maxTurns ??= config.maxTurns;

  if (typeof config.active !== "boolean") {
    fail('Поле "active" должно быть true или false.');
  }
  if (typeof config.baseBranch !== "string" || config.baseBranch.trim() === "") {
    fail('Поле "baseBranch" должно быть непустой строкой.');
  }
  if (typeof config.draftPullRequest !== "boolean") {
    fail('Поле "draftPullRequest" должно быть true или false.');
  }
  if (!Number.isInteger(config.maxIterations) || config.maxIterations < 1) {
    fail('Поле "maxIterations" должно быть целым числом больше 0.');
  }
  if (!Number.isInteger(config.maxTurns) || config.maxTurns < 1) {
    fail('Поле "maxTurns" должно быть целым числом больше 0.');
  }
  if (
    !Number.isInteger(config.maxTestFixAttempts) ||
    config.maxTestFixAttempts < 1
  ) {
    fail(
      'Поле "maxTestFixAttempts" должно быть целым числом больше 0.',
    );
  }
  if (
    !Array.isArray(config.validationScripts) ||
    config.validationScripts.some(
      (script) =>
        typeof script !== "string" ||
        script.trim() === "" ||
        !/^[a-zA-Z0-9:_-]+$/.test(script),
    )
  ) {
    fail(
      'Поле "validationScripts" должно быть массивом безопасных имён npm scripts.',
    );
  }
  if (typeof config.review !== "object" || config.review === null) {
    fail('Поле "review" должно быть объектом.');
  }
  if (typeof config.review.enabled !== "boolean") {
    fail('Поле "review.enabled" должно быть true или false.');
  }
  for (const [field, value] of [
    ["developmentModel", config.developmentModel],
    ["review.model", config.review.model],
  ]) {
    if (
      typeof value !== "string" ||
      value.trim() === "" ||
      !/^[a-zA-Z0-9._-]+$/.test(value)
    ) {
      fail(`Поле "${field}" должно содержать безопасное имя модели.`);
    }
  }
  if (
    typeof config.milestoneReview !== "object" ||
    config.milestoneReview === null
  ) {
    fail('Поле "milestoneReview" должно быть объектом.');
  }
  if (typeof config.milestoneReview.enabled !== "boolean") {
    fail('Поле "milestoneReview.enabled" должно быть true или false.');
  }
  if (
    typeof config.milestoneReview.model !== "string" ||
    config.milestoneReview.model.trim() === "" ||
    !/^[a-zA-Z0-9._-]+$/.test(config.milestoneReview.model)
  ) {
    fail(
      'Поле "milestoneReview.model" должно содержать безопасное имя модели.',
    );
  }
  if (
    !Number.isInteger(config.milestoneReview.maxTurns) ||
    config.milestoneReview.maxTurns < 1
  ) {
    fail(
      'Поле "milestoneReview.maxTurns" должно быть целым числом больше 0.',
    );
  }

  config.rulesPath = resolveProjectFile(config.rulesFile, "rulesFile");
  if (!existsSync(config.rulesPath)) {
    fail(`Файл правил не найден: ${config.rulesPath}`);
  }

  if (config.review.enabled) {
    config.review.schemaPath = resolveProjectFile(
      config.review.schemaFile,
      "review.schemaFile",
    );
    config.review.outputPath = resolveProjectFile(
      config.review.outputFile,
      "review.outputFile",
    );
    if (!existsSync(config.review.schemaPath)) {
      fail(`Схема review не найдена: ${config.review.schemaPath}`);
    }
    parseJson(
      readFileSync(config.review.schemaPath, "utf8"),
      config.review.schemaPath,
    );
  }

  if (config.milestoneReview.enabled) {
    config.milestoneReview.schemaPath = resolveProjectFile(
      config.milestoneReview.schemaFile,
      "milestoneReview.schemaFile",
    );
    config.milestoneReview.outputPath = resolveProjectFile(
      config.milestoneReview.outputFile,
      "milestoneReview.outputFile",
    );
    if (!existsSync(config.milestoneReview.schemaPath)) {
      fail(
        `Схема milestone review не найдена: ${config.milestoneReview.schemaPath}`,
      );
    }
    parseJson(
      readFileSync(config.milestoneReview.schemaPath, "utf8"),
      config.milestoneReview.schemaPath,
    );
  }

  return config;
}

function loadRalphRules(config) {
  const rules = readFileSync(config.rulesPath, "utf8").trim();
  if (rules === "") {
    fail(`Файл правил пуст: ${config.rulesPath}`);
  }

  return rules;
}

// -----------------------------------------------------------------------------
// Проверка инструментов, Git-репозитория и рабочей ветки
// -----------------------------------------------------------------------------

function verifyTools() {
  run("git", ["--version"]);
  run("gh", ["--version"]);
  run("codex", ["--version"]);
  run("gh", ["auth", "status"]);
}

function verifyRepository(config, requireClean) {
  const repositoryRoot = path.resolve(run("git", ["rev-parse", "--show-toplevel"]).stdout);
  if (repositoryRoot.toLowerCase() !== path.resolve(projectRoot).toLowerCase()) {
    fail(`Скрипт ожидает Git-репозиторий ${projectRoot}, но нашёл ${repositoryRoot}.`);
  }

  run("git", ["check-ref-format", "--branch", config.branch]);
  let currentBranch = run("git", ["branch", "--show-current"]).stdout;
  const changes = run("git", ["status", "--porcelain"]).stdout;
  if (requireClean && changes !== "") {
    fail("Рабочее дерево не чистое. Закоммитьте или уберите текущие изменения перед запуском Ralph Loop.");
  }

  if (currentBranch !== config.branch) {
    if (!requireClean) {
      fail(
        `Текущая ветка \"${currentBranch}\", а в конфиге указана \"${config.branch}\". ` +
          "Режим --check не переключает ветки.",
      );
    }

    const localBranchExists =
      run(
        "git",
        [
          "show-ref",
          "--verify",
          "--quiet",
          `refs/heads/${config.branch}`,
        ],
        { allowFailure: true },
      ).status === 0;

    if (localBranchExists) {
      run("git", ["switch", config.branch], { inherit: true });
    } else {
      const remoteBranchExists =
        run(
          "git",
          ["ls-remote", "--exit-code", "--heads", "origin", config.branch],
          { allowFailure: true },
        ).status === 0;

      if (remoteBranchExists) {
        run("git", ["fetch", "origin", config.branch], { inherit: true });
        run(
          "git",
          ["switch", "--track", "-c", config.branch, `origin/${config.branch}`],
          { inherit: true },
        );
      } else {
        run("git", ["fetch", "origin", config.baseBranch], { inherit: true });
        run("git", [
          "show-ref",
          "--verify",
          "--quiet",
          `refs/remotes/origin/${config.baseBranch}`,
        ]);
        run(
          "git",
          ["switch", "-c", config.branch, `origin/${config.baseBranch}`],
          { inherit: true },
        );
      }
    }

    currentBranch = run("git", ["branch", "--show-current"]).stdout;
    if (currentBranch !== config.branch) {
      fail(`Не удалось перейти на ветку \"${config.branch}\".`);
    }
  }

  return { currentBranch, clean: changes === "" };
}

function repositoryName() {
  const repository = parseJson(
    run("gh", ["repo", "view", "--json", "nameWithOwner"]).stdout,
    "gh repo view",
  );
  return repository.nameWithOwner;
}

// -----------------------------------------------------------------------------
// Получение milestone и очереди открытых GitHub issues
// -----------------------------------------------------------------------------

function verifyMilestone(repository, title) {
  const milestones = parseJson(
    run("gh", [
      "api",
      `repos/${repository}/milestones?state=all&per_page=100`,
    ]).stdout,
    "GitHub milestones API",
  );
  const matches = milestones.filter((milestone) => milestone.title === title);

  if (matches.length === 0) {
    fail(`Milestone с точным названием \"${title}\" не найден в ${repository}.`);
  }
  if (matches.length > 1) {
    fail(`В ${repository} найдено несколько milestones с названием \"${title}\".`);
  }

  return matches[0];
}

function openIssues(repository, milestone) {
  const issues = parseJson(
    run("gh", [
      "issue",
      "list",
      "--repo",
      repository,
      "--milestone",
      milestone,
      "--state",
      "open",
      "--limit",
      "100",
      "--json",
      "number,title,body,url",
    ]).stdout,
    "gh issue list",
  );

  return issues.sort((left, right) => left.number - right.number);
}

// -----------------------------------------------------------------------------
// Формирование prompt для реализации одной issue
// -----------------------------------------------------------------------------

function renderTemplate(template, replacements) {
  let result = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    result = result.replaceAll(placeholder, value);
  }

  return result;
}

function renderPrompt(config, issue, rules) {
  const replacements = {
    "{milestone}": config.milestone,
    "{branch}": config.branch,
    "{issue_number}": String(issue.number),
    "{issue_title}": issue.title,
    "{issue_url}": issue.url,
    "{max_turns}": String(config.maxTurns),
    "{max_test_fix_attempts}": String(config.maxTestFixAttempts),
  };

  const prompt = renderTemplate(config.prompt, replacements);
  const renderedRules = renderTemplate(rules, replacements);
  const issueBody = issue.body?.trim() || "(Описание issue пустое.)";

  return `${prompt}\n\n## Текущая issue\n\n- Number: #${issue.number}\n- Title: ${issue.title}\n- URL: ${issue.url}\n\n### Body и критерии готовности\n\n${issueBody}\n\n---\n\n${renderedRules}`;
}

// -----------------------------------------------------------------------------
// Проверка состояния issue и повторное открытие при ошибке
// -----------------------------------------------------------------------------

function issueState(repository, issueNumber) {
  return parseJson(
    run("gh", [
      "issue",
      "view",
      String(issueNumber),
      "--repo",
      repository,
      "--json",
      "state",
    ]).stdout,
    `gh issue view ${issueNumber}`,
  ).state;
}

function reopenIssueWithComment(repository, issue, comment) {
  if (issueState(repository, issue.number) === "CLOSED") {
    run("gh", [
      "issue",
      "reopen",
      String(issue.number),
      "--repo",
      repository,
    ]);
  }

  run("gh", [
    "issue",
    "comment",
    String(issue.number),
    "--repo",
    repository,
    "--body",
    comment.slice(0, 60_000),
  ]);
}

function formatReviewComment(review) {
  const findings = review.findings
    .map((finding) => {
      const location = finding.line
        ? `${finding.file}:${finding.line}`
        : finding.file;
      return `- **${finding.severity} — ${finding.title}** (${location})\n  ${finding.body}`;
    })
    .join("\n");

  return `## Ralph Loop: independent review found problems\n\n${review.summary}\n\n${findings}\n\nIssue reopened. Fix the findings, rerun the relevant checks, and start Ralph Loop again.`;
}

// -----------------------------------------------------------------------------
// Локальное ревью commit одной issue на модели Terra
// -----------------------------------------------------------------------------

async function runIndependentReview(config, repository, issue, commit) {
  if (!config.review.enabled) {
    return;
  }

  if (existsSync(config.review.outputPath)) {
    unlinkSync(config.review.outputPath);
  }

  const reviewPrompt = `Review commit ${commit} only as the implementation of GitHub issue #${issue.number}: ${issue.title}.\n\nIssue body:\n${issue.body?.trim() || "(empty)"}\n\nCheck correctness, regressions, security, edge cases, tests, and every requirement from the issue body. Use verdict \"fail\" when at least one actionable finding exists; otherwise use \"pass\" with an empty findings array. Do not edit files.`;

  console.log(`\n=== Independent Codex review for issue #${issue.number} ===\n`);

  try {
    await runCodexWithTurnLimit(
      [
        "exec",
        "--sandbox",
        "read-only",
        "--json",
        "--model",
        config.review.model,
        "--output-schema",
        config.review.schemaPath,
        "--output-last-message",
        config.review.outputPath,
        "-",
      ],
      {
        input: reviewPrompt,
        maxTurns: config.maxTurns,
        label: `Review issue #${issue.number}`,
      },
    );
  } catch (error) {
    reopenIssueWithComment(
      repository,
      issue,
      `## Ralph Loop: independent review did not complete\n\n${error.message}\n\nIssue reopened because the required review was not completed.`,
    );
    fail(`Независимый review issue #${issue.number} не завершился.`);
  }

  if (!existsSync(config.review.outputPath)) {
    reopenIssueWithComment(
      repository,
      issue,
      "## Ralph Loop: independent review did not produce a result\n\nIssue reopened because Codex did not create the expected structured review output.",
    );
    fail(`Review issue #${issue.number} не создал файл результата.`);
  }

  let review;
  try {
    review = parseJson(
      readFileSync(config.review.outputPath, "utf8"),
      config.review.outputPath,
    );
  } catch (error) {
    reopenIssueWithComment(
      repository,
      issue,
      `## Ralph Loop: independent review output is invalid\n\n${error.message}\n\nIssue reopened because the review result could not be verified.`,
    );
    throw error;
  }

  if (
    !["pass", "fail"].includes(review.verdict) ||
    typeof review.summary !== "string" ||
    !Array.isArray(review.findings)
  ) {
    reopenIssueWithComment(
      repository,
      issue,
      "## Ralph Loop: independent review output has an unexpected shape\n\nIssue reopened because the review result could not be verified.",
    );
    fail(`Review issue #${issue.number} вернул некорректный результат.`);
  }

  if (review.verdict !== "pass" || review.findings.length > 0) {
    reopenIssueWithComment(repository, issue, formatReviewComment(review));
    fail(`Review issue #${issue.number} нашёл ${review.findings.length} замечаний.`);
  }

  const changes = run("git", ["status", "--porcelain"]).stdout;
  if (changes !== "") {
    reopenIssueWithComment(
      repository,
      issue,
      "## Ralph Loop: review unexpectedly changed the working tree\n\nIssue reopened because an independent review must be read-only.",
    );
    fail(`Review issue #${issue.number} изменил рабочее дерево.`);
  }

  console.log(`Review issue #${issue.number}: PASS — ${review.summary}`);
}

// -----------------------------------------------------------------------------
// Подготовка commit и закрытие issue силами оркестратора
// -----------------------------------------------------------------------------

function commitMessageFromAgent(lastAgentMessage, issue) {
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

function closeIssue(config, repository, issue, commit) {
  const completion = config.review.enabled
    ? "Ralph Loop validations and independent review passed."
    : "Ralph Loop validations passed; independent review is disabled in config.";
  run("gh", [
    "issue",
    "close",
    String(issue.number),
    "--repo",
    repository,
    "--reason",
    "completed",
    "--comment",
    `Implemented in commit ${commit}. ${completion}`,
  ]);

  if (issueState(repository, issue.number) !== "CLOSED") {
    fail(`Issue #${issue.number} не закрылась после успешной реализации.`);
  }
}

async function commitAndCompleteIssue(config, repository, issue, startingCommit, lastAgentMessage) {
  const currentBranch = run("git", ["branch", "--show-current"]).stdout;
  const currentCommit = run("git", ["rev-parse", "HEAD"]).stdout;
  const changes = run("git", ["status", "--porcelain"]).stdout;
  const violations = [];

  if (currentBranch !== config.branch) {
    violations.push(`Codex переключился на ветку ${currentBranch}`);
  }
  if (currentCommit !== startingCommit) {
    violations.push("Codex самостоятельно создал commit");
  }
  if (changes === "") {
    violations.push("Codex не оставил изменений для commit");
  }
  if (issueState(repository, issue.number) !== "OPEN") {
    violations.push("Codex самостоятельно изменил состояние issue");
  }
  if (violations.length > 0) {
    fail(`Issue #${issue.number}: ${violations.join("; ")}. Цикл остановлен.`);
  }

  runConfiguredValidation(config);
  run("git", ["add", "--all"]);

  const stagedDiff = run("git", ["diff", "--cached", "--quiet"], {
    allowFailure: true,
  });
  if (stagedDiff.status === 0) {
    fail(`Issue #${issue.number}: после staging нет изменений для commit.`);
  }
  if (stagedDiff.status !== 1) {
    fail(`Issue #${issue.number}: не удалось проверить staged diff.`);
  }

  const commitMessage = commitMessageFromAgent(lastAgentMessage, issue);
  run("git", ["commit", "-m", commitMessage], { inherit: true });

  const commitCount = Number(
    run("git", ["rev-list", "--count", `${startingCommit}..HEAD`]).stdout,
  );
  const remainingChanges = run("git", ["status", "--porcelain"]).stdout;
  if (commitCount !== 1 || remainingChanges !== "") {
    fail(
      `Issue #${issue.number}: оркестратор ожидал один commit и чистое дерево, ` +
        `получено commits=${commitCount}, changes=${remainingChanges ? "yes" : "no"}.`,
    );
  }

  const commit = run("git", ["rev-parse", "HEAD"]).stdout;
  await runIndependentReview(config, repository, issue, commit);
  closeIssue(config, repository, issue, commit);
}

// -----------------------------------------------------------------------------
// Реализация одной issue на Terra и проверка правил завершения
// -----------------------------------------------------------------------------

async function runCodex(config, repository, issue, rules) {
  const startingCommit = run("git", ["rev-parse", "HEAD"]).stdout;
  let codexResult;
  console.log(`\n=== Issue #${issue.number}: ${issue.title} ===\n`);
  try {
    codexResult = await runCodexWithTurnLimit(
      [
        "exec",
        "--json",
        "--sandbox",
        "workspace-write",
        "--model",
        config.developmentModel,
        "-C",
        projectRoot,
        "-",
      ],
      {
        input: renderPrompt(config, issue, rules),
        maxTurns: config.maxTurns,
        label: `Codex issue #${issue.number}`,
      },
    );
  } catch (error) {
    if (error.code === "RALPH_MAX_TURNS") {
      reopenIssueWithComment(
        repository,
        issue,
        `## Ralph Loop: maxTurns circuit breaker\n\nThe Codex session reached the hard limit of **${config.maxTurns} observable steps** and was stopped before it could start another step.\n\nReview the current branch and working tree before restarting Ralph Loop.`,
      );
    }
    throw error;
  }

  await commitAndCompleteIssue(
    config,
    repository,
    issue,
    startingCommit,
    codexResult.lastAgentMessage,
  );
}

// -----------------------------------------------------------------------------
// Финальные проверки, push ветки и создание draft Pull Request
// -----------------------------------------------------------------------------

function existingPullRequest(config, repository) {
  const pullRequests = parseJson(
    run("gh", [
      "pr",
      "list",
      "--repo",
      repository,
      "--state",
      "open",
      "--head",
      config.branch,
      "--json",
      "number,url",
    ]).stdout,
    "gh pr list",
  );
  return pullRequests[0] ?? null;
}

function pullRequestDetails(repository, pullRequest) {
  return parseJson(
    run("gh", [
      "pr",
      "view",
      String(pullRequest),
      "--repo",
      repository,
      "--json",
      "number,url,title,headRefOid,headRefName,baseRefName",
    ]).stdout,
    `gh pr view ${pullRequest}`,
  );
}

function verifyPullRequestTarget(config, pullRequest) {
  const localHead = run("git", ["rev-parse", "HEAD"]).stdout;
  const violations = [];
  if (pullRequest.headRefName !== config.branch) {
    violations.push(`head=${pullRequest.headRefName}`);
  }
  if (pullRequest.baseRefName !== config.baseBranch) {
    violations.push(`base=${pullRequest.baseRefName}`);
  }
  if (pullRequest.headRefOid !== localHead) {
    violations.push(
      `GitHub head=${pullRequest.headRefOid}, local HEAD=${localHead}`,
    );
  }
  if (violations.length > 0) {
    fail(
      `PR #${pullRequest.number} не соответствует текущему запуску: ${violations.join("; ")}.`,
    );
  }

  return pullRequest;
}

function runConfiguredValidation(config) {
  for (const script of config.validationScripts) {
    console.log(`\n=== npm run ${script} ===\n`);
    run("npm", ["run", script], { inherit: true });
  }
}

function createPullRequest(config, repository) {
  const changes = run("git", ["status", "--porcelain"]).stdout;
  if (changes !== "") {
    fail("Нельзя создать PR: в рабочем дереве есть незакоммиченные изменения.");
  }

  runConfiguredValidation(config);
  run("git", ["fetch", "origin", config.baseBranch], { inherit: true });
  const commitCount = Number(
    run("git", [
      "rev-list",
      "--count",
      `origin/${config.baseBranch}..HEAD`,
    ]).stdout,
  );
  if (!Number.isInteger(commitCount) || commitCount < 1) {
    fail(`В ветке ${config.branch} нет коммитов поверх origin/${config.baseBranch}.`);
  }

  run("git", ["push", "--set-upstream", "origin", config.branch], {
    inherit: true,
  });

  const existing = existingPullRequest(config, repository);
  if (existing) {
    console.log(`PR уже существует: ${existing.url}`);
    return verifyPullRequestTarget(
      config,
      pullRequestDetails(repository, existing.number),
    );
  }

  const args = [
    "pr",
    "create",
    "--base",
    config.baseBranch,
    "--head",
    config.branch,
    "--title",
    `${config.milestone}`,
    "--body",
    `Завершены все issues milestone **${config.milestone}**.\n\nPR создан Ralph Loop и требует ручной проверки.`,
  ];
  if (config.draftPullRequest) {
    args.push("--draft");
  }

  const url = run("gh", args).stdout;
  console.log(`Создан PR: ${url}`);
  return verifyPullRequestTarget(config, pullRequestDetails(repository, url));
}

// -----------------------------------------------------------------------------
// Итоговое ревью всего milestone на Sol и публикация результата в PR
// -----------------------------------------------------------------------------

function milestoneReviewMarker(config, pullRequest) {
  return `<!-- ralph-milestone-review head:${pullRequest.headRefOid} model:${config.milestoneReview.model} -->`;
}

function milestoneWasReviewed(config, repository, pullRequest) {
  const marker = milestoneReviewMarker(config, pullRequest);
  const reviews = parseJson(
    run("gh", [
      "api",
      `repos/${repository}/pulls/${pullRequest.number}/reviews?per_page=100`,
    ]).stdout,
    `GitHub reviews for PR #${pullRequest.number}`,
  );

  return reviews.some(
    (review) => typeof review.body === "string" && review.body.includes(marker),
  );
}

function formatMilestoneReview(config, milestone, pullRequest, review) {
  const findings = review.findings.length
    ? review.findings
        .map((finding) => {
          const location = finding.line
            ? `${finding.file}:${finding.line}`
            : finding.file;
          return `- **${finding.severity} — ${finding.title}** (${location})\n  ${finding.body}`;
        })
        .join("\n")
    : "No actionable findings.";
  const verdict = review.verdict === "pass" ? "PASS" : "FINDINGS";

  return `${milestoneReviewMarker(config, pullRequest)}
## Ralph Loop: milestone review

- **Model:** \`${config.milestoneReview.model}\`
- **Milestone:** ${milestone.title}
- **Reviewed head:** \`${pullRequest.headRefOid}\`
- **Verdict:** **${verdict}**

${review.summary}

### Findings

${findings}

This is an automated whole-PR review. The pull request remains draft so a human can decide whether to fix the findings or merge later.`;
}

function postPullRequestReview(repository, pullRequest, body) {
  run(
    "gh",
    [
      "pr",
      "review",
      String(pullRequest.number),
      "--repo",
      repository,
      "--comment",
      "--body-file",
      "-",
    ],
    { input: body.slice(0, 60_000) },
  );
}

function postMilestoneReviewFailure(
  config,
  repository,
  pullRequest,
  message,
) {
  const marker = `<!-- ralph-milestone-review-failed head:${pullRequest.headRefOid} model:${config.milestoneReview.model} -->`;
  postPullRequestReview(
    repository,
    pullRequest,
    `${marker}\n## Ralph Loop: milestone review did not complete\n\n${message}\n\nThe PR remains draft. Restart Ralph Loop after resolving the failure.`,
  );
}

async function runMilestoneReview(
  config,
  repository,
  milestone,
  pullRequest,
) {
  if (!config.milestoneReview.enabled) {
    console.log("Milestone review выключен в конфиге.");
    return;
  }

  if (milestoneWasReviewed(config, repository, pullRequest)) {
    console.log(
      `Milestone уже проверен моделью ${config.milestoneReview.model} для commit ${pullRequest.headRefOid}.`,
    );
    return;
  }

  if (existsSync(config.milestoneReview.outputPath)) {
    unlinkSync(config.milestoneReview.outputPath);
  }

  const milestoneDescription =
    milestone.description?.trim() || "(Milestone description is empty.)";
  const reviewPrompt = `Perform a read-only architectural review of the entire pull request #${pullRequest.number} (${pullRequest.url}) for milestone "${milestone.title}".

Milestone description:
${milestoneDescription}

Review the complete branch diff against ${config.baseBranch}, not just the latest commit. Read AGENTS.md, relevant PRD/plan documents, issue-related documentation, and tests available in the repository. Look specifically for cross-issue integration problems, architectural inconsistencies, security vulnerabilities, performance or scalability risks, regressions, missing tests, and deviations from the milestone requirements or PRD.

Report only actionable findings introduced by this PR. Use verdict "fail" when at least one actionable finding exists; otherwise use "pass" with an empty findings array. Do not edit files, create comments, change GitHub state, or run destructive commands. The Ralph orchestrator will publish the structured result.`;

  console.log(
    `\n=== Milestone review for PR #${pullRequest.number} (${config.milestoneReview.model}) ===\n`,
  );

  try {
    await runCodexWithTurnLimit(
      [
        "exec",
        "--sandbox",
        "read-only",
        "--json",
        "--model",
        config.milestoneReview.model,
        "--output-schema",
        config.milestoneReview.schemaPath,
        "--output-last-message",
        config.milestoneReview.outputPath,
        "-",
      ],
      {
        input: reviewPrompt,
        maxTurns: config.milestoneReview.maxTurns,
        label: `Milestone review PR #${pullRequest.number}`,
      },
    );
  } catch (error) {
    postMilestoneReviewFailure(
      config,
      repository,
      pullRequest,
      error.message,
    );
    fail(`Milestone review PR #${pullRequest.number} не завершился.`);
  }

  if (!existsSync(config.milestoneReview.outputPath)) {
    const message = "Codex did not create the expected structured review output.";
    postMilestoneReviewFailure(config, repository, pullRequest, message);
    fail(`Milestone review PR #${pullRequest.number} не создал файл результата.`);
  }

  let review;
  try {
    review = parseJson(
      readFileSync(config.milestoneReview.outputPath, "utf8"),
      config.milestoneReview.outputPath,
    );
  } catch (error) {
    postMilestoneReviewFailure(
      config,
      repository,
      pullRequest,
      error.message,
    );
    throw error;
  }

  if (
    !["pass", "fail"].includes(review.verdict) ||
    typeof review.summary !== "string" ||
    !Array.isArray(review.findings)
  ) {
    const message = "Codex returned a review result with an unexpected shape.";
    postMilestoneReviewFailure(config, repository, pullRequest, message);
    fail(`Milestone review PR #${pullRequest.number} вернул некорректный результат.`);
  }

  const changes = run("git", ["status", "--porcelain"]).stdout;
  if (changes !== "") {
    const message = "The read-only milestone review changed the working tree.";
    postMilestoneReviewFailure(config, repository, pullRequest, message);
    fail(`Milestone review PR #${pullRequest.number} изменил рабочее дерево.`);
  }

  postPullRequestReview(
    repository,
    pullRequest,
    formatMilestoneReview(config, milestone, pullRequest, review),
  );
  console.log(
    `Milestone review опубликован в ${pullRequest.url}: ${review.verdict.toUpperCase()} (${review.findings.length} findings).`,
  );
}

// -----------------------------------------------------------------------------
// Диагностика конфигурации для безопасного режима --check
// -----------------------------------------------------------------------------

function printCheck(config, repository, milestone, repositoryState, issues) {
  console.log("Ralph Loop настроен корректно.");
  console.log(`Репозиторий: ${repository}`);
  console.log(`Milestone: ${milestone.title} (${issues.length} открытых issues)`);
  console.log(`Ветка: ${repositoryState.currentBranch}`);
  console.log(`Рабочее дерево: ${repositoryState.clean ? "чистое" : "есть изменения"}`);
  console.log(`Лимит итераций: ${config.maxIterations}`);
  console.log(`Лимит шагов на сессию: ${config.maxTurns}`);
  console.log(`Лимит исправлений тестов: ${config.maxTestFixAttempts}`);
  console.log(`Модель разработки: ${config.developmentModel}`);
  console.log(`Правила сессии: ${config.rulesFile}`);
  console.log(
    `Review issue: ${config.review.enabled ? config.review.model : "выключен"}`,
  );
  console.log(
    `Review milestone: ${
      config.milestoneReview.enabled
        ? `${config.milestoneReview.model} (maxTurns=${config.milestoneReview.maxTurns})`
        : "выключен"
    }`,
  );
  if (issues[0]) {
    console.log(`Следующая issue: #${issues[0].number} ${issues[0].title}`);
  } else {
    console.log("Открытых issues нет; режим --run попытается создать PR.");
  }
}

// -----------------------------------------------------------------------------
// Главный цикл Ralph Loop: --check, --once и --run
// -----------------------------------------------------------------------------

async function main() {
  // Проверяем, что передан поддерживаемый режим запуска.
  if (!supportedModes.has(mode)) {
    fail(`Неизвестный режим ${mode}. Используйте --check, --once или --run.`);
  }

  const config = loadConfig();

  // Проверяем, включён ли Ralph Loop.
  if (!config.active) {
    console.log("Ralph Loop выключен: active=false.");
    return;
  }

  const rules = loadRalphRules(config);
  verifyTools();
  const repositoryState = verifyRepository(config, mode !== "--check");
  const repository = repositoryName();
  const milestone = verifyMilestone(repository, config.milestone);
  let issues = openIssues(repository, config.milestone);

  if (mode === "--check") {
    printCheck(config, repository, milestone, repositoryState, issues);
    return;
  }

  // Выполняем ровно одну issue без автоматического перехода к следующей.
  if (mode === "--once") {
    if (!issues[0]) {
      console.log("Открытых issues нет. Для push и создания PR запустите --run.");
      return;
    }
    await runCodex(config, repository, issues[0], rules);
    console.log(`Issue #${issues[0].number} завершена. Цикл остановлен после одной итерации.`);
    return;
  }

  // Счётчик итераций: одна итерация соответствует обработке одной issue.
  for (let iteration = 1; iteration <= config.maxIterations; iteration += 1) {
    // Перед каждой итерацией заново получаем актуальные открытые issues.
    issues = openIssues(repository, config.milestone);
    if (issues.length === 0) {
      // Все issues закрыты: создаём PR и запускаем итоговое Sol-review.
      const pullRequest = createPullRequest(config, repository);
      await runMilestoneReview(config, repository, milestone, pullRequest);
      return;
    }

    console.log(`Итерация ${iteration}/${config.maxIterations}; осталось issues: ${issues.length}.`);
    await runCodex(config, repository, issues[0], rules);
  }

  // Проверяем общий лимит итераций и не создаём PR при досрочной остановке.
  fail(`Достигнут лимит ${config.maxIterations} итераций. PR не создан.`);
}

// -----------------------------------------------------------------------------
// Точка входа: выполняется только при прямом запуске файла через node
// -----------------------------------------------------------------------------

const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  try {
    await main();
  } catch (error) {
    console.error(`\nRalph Loop остановлен: ${error.message}`);
    process.exitCode = 1;
  }
}

export { runCodexWithTurnLimit };
