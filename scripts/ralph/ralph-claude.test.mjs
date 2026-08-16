import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  agentBackend,
  agentBinary,
  reasoningEffortsFor,
  runReviewSession,
} from './ralph-agent-backends.mjs';
import {
  claudeBackend,
  createSandboxedClaudeEnvironment,
  developmentClaudeArguments,
  reviewClaudeArguments,
  runClaudeWithTurnLimit,
  verifyClaudeAuthentication,
} from './ralph-claude-session.mjs';
import { withFakeClaude } from './ralph-test-support.mjs';

const schemaPath = fileURLToPath(new URL('../../.agents/review.schema.json', import.meta.url));

test('agentCli selects the backend and its reasoning-effort vocabulary', () => {
  assert.equal(agentBackend({ agentCli: 'claude' }).cli, 'claude');
  assert.equal(agentBackend({ agentCli: 'codex' }).cli, 'codex');
  // Отсутствие поля — это Codex: конфигурации, написанные до появления выбора,
  // должны продолжать работать без правки.
  assert.equal(agentBackend({}).cli, 'codex');
  assert.equal(agentBinary({ agentCli: 'claude' }), 'claude');

  assert.deepEqual(reasoningEffortsFor('codex'), ['minimal', 'low', 'medium', 'high']);
  assert.deepEqual(reasoningEffortsFor('claude'), ['low', 'medium', 'high', 'xhigh', 'max']);
  // Словари не совпадают, поэтому одна общая проверка усилий была бы неверной
  // ровно для этих значений.
  assert.equal(reasoningEffortsFor('claude').includes('minimal'), false);
  assert.equal(reasoningEffortsFor('codex').includes('xhigh'), false);
});

test('claude arguments always carry --verbose alongside stream-json', () => {
  // Без --verbose CLI завершается кодом 1 и пустым stdout: сессия не стартует
  // вообще, а причина видна только в stderr.
  for (const args of [
    developmentClaudeArguments({ developmentModel: 'claude-opus-5', developmentEffort: 'medium' }),
    reviewClaudeArguments({
      model: 'claude-opus-5',
      effort: 'high',
      schemaPath,
      outputPath: 'unused',
    }),
  ]) {
    assert.equal(args.includes('--verbose'), true);
    assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
    assert.equal(args.includes('-p'), true);
  }
});

test('the claude review role gets a read-only tool set and an inline schema', () => {
  const args = reviewClaudeArguments({
    model: 'claude-opus-5',
    effort: 'high',
    schemaPath,
    outputPath: 'unused',
  });

  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep');
  // Флага --output-schema с путём у CLI нет: схема передаётся строкой.
  assert.equal(args.includes('--output-schema'), false);
  assert.deepEqual(
    JSON.parse(args[args.indexOf('--json-schema') + 1]),
    JSON.parse(readFileSync(schemaPath, 'utf8')),
  );
});

test('the claude sandbox isolates HOME and carries only the API key', () => {
  const source = {
    PATH: process.env.PATH,
    ANTHROPIC_API_KEY: 'secret-key',
    GH_TOKEN: 'must-not-leak',
    HOME: 'C:/Users/operator',
    CLAUDE_CONFIG_DIR: 'C:/Users/operator/.claude',
  };
  const sandbox = createSandboxedClaudeEnvironment(source);

  try {
    assert.equal(sandbox.env.ANTHROPIC_API_KEY, 'secret-key');
    assert.equal(sandbox.env.GH_TOKEN, undefined);
    assert.notEqual(sandbox.env.HOME, source.HOME);
    assert.notEqual(sandbox.env.CLAUDE_CONFIG_DIR, source.CLAUDE_CONFIG_DIR);
    assert.match(sandbox.env.CLAUDE_CONFIG_DIR, /ralph-claude-/);
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test('a claude session without an API key stops before the process starts', () => {
  assert.throws(
    () => createSandboxedClaudeEnvironment({ PATH: process.env.PATH }),
    (error) => {
      assert.equal(error.code, 'RALPH_AGENT_AUTH');
      assert.match(error.message, /ANTHROPIC_API_KEY/);
      return true;
    },
  );
  assert.throws(() => verifyClaudeAuthentication({ env: {} }), /ANTHROPIC_API_KEY/);
});

// Поддельный CLI записывает полученный argv: аргумент, обрезанный cmd.exe,
// иначе выглядел бы как успешный прогон.
const claudeStreamScript = (events) => `
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

writeFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'received-argv.json'),
  JSON.stringify(process.argv.slice(2)),
);

const lines = ${JSON.stringify(events)};
let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  for (const line of lines) process.stdout.write(JSON.stringify(line) + '\\n');
  process.exit(0);
});
`;

const assistantEvent = (id, text) => ({
  type: 'assistant',
  message: { id, role: 'assistant', content: [{ type: 'text', text }] },
});

test('tool output reaches the log the same way Codex command output does', () => {
  // Без разбора события user в run.log Claude-сессии остались бы только реплики
  // модели, тогда как для Codex туда попадает aggregated_output команд.
  const stringContent = claudeBackend.readEvent(
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', content: '12 passed\n' }] },
    }),
  );
  assert.equal(stringContent.log, '12 passed');

  const blockContent = claudeBackend.readEvent(
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', content: [{ type: 'text', text: 'build ok' }] }],
      },
    }),
  );
  assert.equal(blockContent.log, 'build ok');

  // Событие без вывода не должно печатать пустую строку.
  assert.equal(
    claudeBackend.readEvent(JSON.stringify({ type: 'user', message: { content: [] } })).log,
    undefined,
  );
  // Результат инструмента шагом не считается: шаги — это ответы модели.
  assert.equal(stringContent.stepId, undefined);
});

test('a claude session counts assistant turns and returns the final message', async () => {
  await withFakeClaude(
    claudeStreamScript([
      { type: 'system', subtype: 'init' },
      assistantEvent('msg-1', 'first'),
      assistantEvent('msg-2', 'second'),
      { type: 'result', subtype: 'success', is_error: false, result: 'done', num_turns: 2 },
    ]),
    async () => {
      const session = await runClaudeWithTurnLimit(
        developmentClaudeArguments({
          developmentModel: 'claude-opus-5',
          developmentEffort: 'medium',
        }),
        { input: 'work', maxTurns: 10, timeoutMs: 60_000, label: 'Claude test' },
      );

      assert.equal(session.turns, 2);
      assert.equal(session.lastAgentMessage, 'done');
    },
  );
});

test('an unauthenticated claude session fails even though the CLI exits 0', async () => {
  // Самое опасное расхождение с Codex: без этой проверки полностью
  // неавторизованный прогон выглядел бы успешной сессией с пустым diff, и цикл
  // ушёл бы в ветку «изменений нет» вместо остановки.
  await withFakeClaude(
    claudeStreamScript([
      { type: 'system', subtype: 'init' },
      {
        type: 'result',
        subtype: 'success',
        is_error: true,
        terminal_reason: 'api_error',
        result: 'Not logged in · Please run /login',
      },
    ]),
    async () => {
      await assert.rejects(
        runClaudeWithTurnLimit(
          developmentClaudeArguments({
            developmentModel: 'claude-opus-5',
            developmentEffort: 'medium',
          }),
          { input: 'work', maxTurns: 10, timeoutMs: 60_000, label: 'Claude test' },
        ),
        (error) => {
          assert.equal(error.code, 'RALPH_AGENT_AUTH');
          return true;
        },
      );
    },
  );
});

test('the claude native turn limit is reported as RALPH_MAX_TURNS despite exit 0', async () => {
  await withFakeClaude(
    claudeStreamScript([
      assistantEvent('msg-1', 'partial'),
      { type: 'result', subtype: 'error_max_turns', is_error: true, result: '' },
    ]),
    async () => {
      await assert.rejects(
        runClaudeWithTurnLimit(
          developmentClaudeArguments({
            developmentModel: 'claude-opus-5',
            developmentEffort: 'medium',
          }),
          { input: 'work', maxTurns: 10, timeoutMs: 60_000, label: 'Claude test' },
        ),
        (error) => {
          assert.equal(error.code, 'RALPH_MAX_TURNS');
          return true;
        },
      );
    },
  );
});

test("Ralph's own step limit stops a claude session that ignores it", async () => {
  await withFakeClaude(
    claudeStreamScript([
      assistantEvent('msg-1', 'one'),
      assistantEvent('msg-2', 'two'),
      assistantEvent('msg-3', 'three'),
      { type: 'result', subtype: 'success', is_error: false, result: 'done' },
    ]),
    async () => {
      await assert.rejects(
        runClaudeWithTurnLimit(
          developmentClaudeArguments({
            developmentModel: 'claude-opus-5',
            developmentEffort: 'medium',
          }),
          { input: 'work', maxTurns: 2, timeoutMs: 60_000, label: 'Claude test' },
        ),
        (error) => {
          assert.equal(error.code, 'RALPH_MAX_TURNS');
          assert.equal(error.turns, 2);
          return true;
        },
      );
    },
  );
});

test('a claude review writes its verdict to the outputPath the orchestrator reads', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'ralph-claude-review-'));
  const outputPath = path.join(directory, 'review.json');
  const verdict = { verdict: 'pass', summary: 'Looks fine.', findings: [] };

  try {
    await withFakeClaude(
      claudeStreamScript([
        assistantEvent('msg-1', 'reading'),
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: JSON.stringify(verdict),
        },
      ]),
      async ({ receivedArguments }) => {
        await runReviewSession(
          { agentCli: 'claude' },
          { model: 'claude-opus-5', effort: 'high', schemaPath, outputPath },
          { input: 'review', maxTurns: 10, timeoutMs: 60_000, label: 'Claude review' },
        );

        // Схема должна дойти до процесса целиком. На Windows аргументы проходят
        // через cmd.exe, который обрезает командную строку на первом переводе
        // строки: pretty-printed схема доходила как «{», ревью падало всегда.
        const received = receivedArguments();
        const schemaArgument = received[received.indexOf('--json-schema') + 1];
        assert.deepEqual(JSON.parse(schemaArgument), JSON.parse(readFileSync(schemaPath, 'utf8')));
        assert.equal(received.at(-1), schemaArgument);
      },
    );

    assert.deepEqual(JSON.parse(readFileSync(outputPath, 'utf8')), verdict);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the codex backend keeps writing its own review output file', () => {
  // Codex пишет файл сам флагом --output-last-message, поэтому backend не
  // должен его перезаписывать: иначе схема-валидированный вывод затёрся бы
  // последним текстовым сообщением.
  assert.equal(claudeBackend.writeReviewOutput === undefined, false);
  assert.equal(agentBackend({ agentCli: 'codex' }).writeReviewOutput, undefined);

  const args = agentBackend({ agentCli: 'codex' }).reviewArguments({
    model: 'gpt-5.6-terra',
    effort: 'medium',
    schemaPath: 'schema.json',
    outputPath: 'out.json',
  });
  assert.equal(args[args.indexOf('--output-last-message') + 1], 'out.json');
  assert.equal(args[args.indexOf('--output-schema') + 1], 'schema.json');
});

test('the fake-claude output file stays a valid review payload path', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'ralph-claude-write-'));
  const outputPath = path.join(directory, 'nested', 'review.json');

  try {
    writeFileSync(path.join(directory, 'marker'), 'x', 'utf8');
    assert.throws(() =>
      claudeBackend.writeReviewOutput({ outputPath }, { lastAgentMessage: '{}' }),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
