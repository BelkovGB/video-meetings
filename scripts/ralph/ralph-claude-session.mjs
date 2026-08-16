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
    '--json-schema',
    inlineSchema(role.schemaPath),
  ];
}

/**
 * Схема передаётся строкой, а не путём: файлового флага у CLI нет. Отсюда два
 * ограничения на эту строку, оба проверены на живом CLI.
 *
 * Однострочность. Когда на Windows рядом нет нативного claude.exe, commandSpec
 * пропускает claude через `cmd.exe /d /s /c claude.cmd`, а cmd.exe обрезает
 * командную строку на первом переводе строки — до сериализации сюда доходил
 * только «{», и каждое ревью падало с «--json-schema is not valid JSON».
 *
 * Отсутствие `$schema`. Валидатор CLI 2.1.229 не знает мета-схему
 * https://json-schema.org/draft/2020-12/schema и отклоняет весь аргумент:
 * «--json-schema is not a valid JSON Schema: no schema with key or ref …»,
 * exit 1, пустой stdout. Отказ наступает до старта сессии, то есть ронял
 * подряд все ревью и все milestone-ревью. Ключ снимается здесь, а не в файле
 * схемы: для Codex и для редактора объявленный диалект остаётся верным.
 */
function inlineSchema(schemaPath) {
  const source = readFileSync(schemaPath, 'utf8');
  try {
    const { $schema: _dialect, ...schema } = JSON.parse(source);
    return JSON.stringify(schema);
  } catch (error) {
    fail(`Некорректный JSON схемы ревью ${schemaPath}: ${error.message}`);
  }
}

function assistantText(parts) {
  return parts
    .filter((part) => part.type === 'text' && part.text)
    .map((part) => part.text)
    .join('\n');
}

function isSyntheticApiError(event) {
  return event.is_api_error_message === true || event.message?.model === '<synthetic>';
}

function readClaudeEvent(line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }

  // Повторы запроса к API — единственный след того, что сессия не висит, а
  // ждёт. Раньше все события system отбрасывались, и run.log замолкал на всё
  // время отката без единой строки. Codex-backend такой дыры не имеет: он
  // выводит item.type === 'error'.
  if (event.type === 'system' && event.subtype === 'api_retry') {
    return {
      errorLog:
        `api_retry ${event.attempt}/${event.max_retries} status=${event.error_status} ` +
        `error=${event.error} повтор через ${event.retry_delay_ms} ms`,
    };
  }

  // Шагом считается ответ ассистента: это та же единица, которую CLI сам
  // называет turn и возвращает в result.num_turns. Счётчик Codex ведётся по
  // item.id и охватывает ещё и выполненные команды, поэтому одно и то же
  // значение maxTurns ограничивает разный объём работы.
  // При ошибке API CLI подставляет собственное сообщение от лица ассистента:
  // `message.model === '<synthetic>'`, `is_api_error_message: true`. У него
  // обычный message.id, поэтому раньше оно считалось шагом и становилось
  // lastAgentMessage — то есть транзиентный 5xx съедал шаг из maxTurns и
  // подменял последнюю реплику агента текстом ошибки. Модель не работала, шага
  // быть не должно; оператору сообщение всё равно нужно, но как ошибка.
  if (event.type === 'assistant' && isSyntheticApiError(event)) {
    const text = assistantText(event.message?.content ?? []);
    return text ? { errorLog: text } : {};
  }

  if (event.type === 'assistant') {
    const parts = event.message?.content ?? [];
    const text = assistantText(parts);
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
  if (isAuthenticationFailure(event, resultText)) {
    error.code = 'RALPH_AGENT_AUTH';
  }
  return { error };
}

const authenticationStatuses = new Set([401, 403]);

const authenticationTexts =
  /not logged in|authentication_failed|failed to authenticate|invalid api key|(?:api key|access token) is invalid/i;

/**
 * Отказ авторизации распознаётся по HTTP-статусу события, а не только по тексту.
 *
 * Реальное событие CLI 2.1.229 с протухшим токеном выглядит так:
 * `is_error: true`, `subtype: "success"`, `terminal_reason: "api_error"`,
 * `api_error_status: 401`, `result: "Failed to authenticate. API Error: 401
 * OAuth access token is invalid."` Ни «not logged in», ни «invalid api key» в
 * тексте нет, поэтому прежняя проверка только по тексту давала промах — и цена
 * промаха велика: с кодом RALPH_AGENT_AUTH цикл останавливается сразу, а без
 * него итерация считается обычным сбоем сессии, и Ralph сжигает все
 * maxIterations, каждый раз заново получая 401.
 *
 * Текстовая ветка остаётся второй опорой: 401 приходит не при каждом виде
 * отказа, а поле `api_error_status` появляется только у ошибок HTTP.
 */
function isAuthenticationFailure(event, resultText) {
  if (authenticationStatuses.has(event.api_error_status)) return true;
  return authenticationTexts.test(resultText || '');
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
