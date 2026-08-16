import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { fail } from './ralph-scope.mjs';
import { outputTail } from './ralph-process-runner.mjs';
import { createSandboxRoot, genericExitFailure, runAgentSession } from './ralph-agent-session.mjs';

/**
 * Backend Claude Code CLI: аргументы ролей, изолированный CLAUDE_CONFIG_DIR и
 * разбор потока `--output-format stream-json`.
 *
 * Три отличия от Codex меняют не только аргументы, но и то, что считается
 * отказом, поэтому вынесены в отдельный модуль, а не в развилки внутри общего.
 */

// Claude принимает уровень усилий флагом, а не -c override, и словарь у него
// другой: minimal отсутствует, xhigh и max добавлены.
export const reasoningEfforts = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Учётные данные передаются переменной окружения, а не копией файла.
 *
 * Приём Codex — скопировать auth.json в песочницу — для Claude не переносится:
 * на Windows живой токен лежит не в `~/.claude/.credentials.json`, и
 * изолированный CLAUDE_CONFIG_DIR с копией этого файла даёт "Not logged in".
 *
 * Годятся обе переменные, и это не equivalent: `CLAUDE_CODE_OAUTH_TOKEN` от
 * `claude setup-token` работает по уже оплаченной подписке, а
 * `ANTHROPIC_API_KEY` тарифицируется отдельно. Порядок предпочтения не
 * навязывается: если заданы обе, решает CLI.
 */
export const claudeCredentialVariables = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'];

function claudeCredentials(source) {
  return Object.fromEntries(
    claudeCredentialVariables
      .map((name) => [name, source[name]?.trim()])
      .filter(([, value]) => Boolean(value)),
  );
}

function missingClaudeCredentials() {
  const error = new Error(
    `Не задана ни одна из переменных ${claudeCredentialVariables.join(' / ')}. ` +
      'Claude-сессия Ralph запускается с изолированным HOME, где OAuth-состояние CLI ' +
      'недоступно. Токен по подписке выдаёт `claude setup-token`; API-ключ ' +
      'тарифицируется отдельно.',
  );
  error.code = 'RALPH_AGENT_AUTH';
  return error;
}

export function createSandboxedClaudeEnvironment(source = process.env, options = {}) {
  const sandbox = createSandboxRoot(source, 'ralph-claude-');
  const configDir = path.join(sandbox.root, 'claude');
  mkdirSync(configDir, { recursive: true });

  const credentials = options.credentials ?? claudeCredentials(source);
  if (Object.keys(credentials).length === 0) {
    sandbox.cleanup();
    throw missingClaudeCredentials();
  }

  return {
    root: sandbox.root,
    env: { ...sandbox.env, CLAUDE_CONFIG_DIR: configDir, ...credentials },
  };
}

// --output-format stream-json без --verbose завершается кодом 1 и пустым
// stdout, поэтому флаг зашит рядом, а не оставлен на вызывающего.
const streamArguments = ['-p', '--verbose', '--output-format', 'stream-json'];

export function developmentClaudeArguments(config) {
  return [
    ...streamArguments,
    '--model',
    config.developmentModel,
    '--effort',
    config.developmentEffort,
    // Аналог `--sandbox danger-full-access` у Codex: сессия не должна ждать
    // подтверждения, которое в AFK-режиме некому дать.
    '--permission-mode',
    'bypassPermissions',
  ];
}

export function reviewClaudeArguments(role) {
  return [
    ...streamArguments,
    '--model',
    role.model,
    '--effort',
    role.effort,
    // У Claude нет read-only песочницы, поэтому роль ограничивается набором
    // инструментов. Настоящая гарантия — сверка HEAD, ветки и рабочего дерева
    // после ревью: она работает одинаково для обоих CLI.
    '--tools',
    'Read,Glob,Grep',
    // Схема передаётся строкой, а не путём: файлового флага у CLI нет. Строка
    // обязана быть однострочной: на Windows commandSpec пропускает claude через
    // `cmd.exe /d /s /c claude.cmd`, а cmd.exe обрезает командную строку на
    // первом переводе строки — до сериализации сюда доходил только «{», и
    // каждое ревью падало с «--json-schema is not valid JSON».
    '--json-schema',
    singleLineSchema(role.schemaPath),
  ];
}

function singleLineSchema(schemaPath) {
  const source = readFileSync(schemaPath, 'utf8');
  try {
    return JSON.stringify(JSON.parse(source));
  } catch (error) {
    fail(`Некорректный JSON схемы ревью ${schemaPath}: ${error.message}`);
  }
}

function readClaudeEvent(line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }

  // Шагом считается ответ ассистента: это та же единица, которую CLI сам
  // называет turn и возвращает в result.num_turns. Счётчик Codex ведётся по
  // item.id и охватывает ещё и выполненные команды, поэтому одно и то же
  // значение maxTurns ограничивает разный объём работы.
  if (event.type === 'assistant') {
    const parts = event.message?.content ?? [];
    const text = parts
      .filter((part) => part.type === 'text' && part.text)
      .map((part) => part.text)
      .join('\n');
    const tools = parts
      .filter((part) => part.type === 'tool_use')
      .map((part) => part.name)
      .join(', ');
    return {
      stepId: event.message?.id ?? event.uuid,
      stepLabel: tools ? `tool_use ${tools}` : 'assistant_message',
      log: text || undefined,
      agentMessage: text || undefined,
    };
  }

  // Результаты инструментов приходят отдельными событиями с ролью user. Без
  // них run.log Claude-сессии содержал бы только реплики модели, тогда как для
  // Codex туда попадает вывод выполненных команд.
  if (event.type === 'user') {
    const output = (event.message?.content ?? [])
      .filter((part) => part.type === 'tool_result')
      .map((part) =>
        typeof part.content === 'string'
          ? part.content
          : (part.content ?? [])
              .filter((piece) => piece.type === 'text' && piece.text)
              .map((piece) => piece.text)
              .join('\n'),
      )
      .filter(Boolean)
      .join('\n')
      .replace(/\r?\n$/, '');
    return output ? { log: outputTail(output) } : {};
  }

  if (event.type !== 'result') return {};

  const resultText = typeof event.result === 'string' ? event.result : '';
  if (!event.is_error) {
    return { agentMessage: resultText || undefined };
  }

  // Единственное место, где виден отказ: код завершения остаётся нулевым и при
  // неавторизованном запуске, и при исчерпании собственного лимита шагов.
  if (event.subtype === 'error_max_turns') {
    const error = new Error(`Claude завершил сессию по собственному лимиту шагов. ${resultText}`);
    error.code = 'RALPH_MAX_TURNS';
    return { error };
  }

  const error = new Error(`Claude завершил сессию с ошибкой: ${resultText || event.subtype}`);
  if (/not logged in|authentication_failed|invalid api key/i.test(resultText || '')) {
    error.code = 'RALPH_AGENT_AUTH';
  }
  return { error };
}

export const claudeBackend = {
  cli: 'claude',
  binary: 'claude',
  label: 'Claude',
  reasoningEfforts,
  createSandboxedEnvironment: createSandboxedClaudeEnvironment,
  developmentArguments: developmentClaudeArguments,
  reviewArguments: reviewClaudeArguments,
  verifyAuthentication: verifyClaudeAuthentication,
  readEvent: readClaudeEvent,
  exitFailure: genericExitFailure,
  // Файлового флага для итогового сообщения у CLI нет, поэтому контракт
  // ревьюеров — «результат лежит в outputPath» — выполняет сам backend.
  writeReviewOutput(role, session) {
    writeFileSync(role.outputPath, session.lastAgentMessage ?? '', 'utf8');
  },
};

export async function runClaudeWithTurnLimit(args, options) {
  return runAgentSession(claudeBackend, args, options);
}

/**
 * Проверяется наличие учётных данных в окружении, а не ответ CLI:
 * `claude auth status` завершается кодом 0 и когда пользователь не авторизован,
 * а его OAuth-состояние всё равно не попадёт в изолированный CLAUDE_CONFIG_DIR
 * сессии.
 */
export function verifyClaudeAuthentication(dependencies = {}) {
  const credentials =
    dependencies.credentials ?? claudeCredentials(dependencies.env ?? process.env);
  if (Object.keys(credentials).length === 0) {
    throw missingClaudeCredentials();
  }
}
