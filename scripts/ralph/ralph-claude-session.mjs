import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

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
 * Документированный путь для headless-запуска — ANTHROPIC_API_KEY, поэтому
 * ключ явно пропускается в песочницу, а остальное окружение остаётся
 * очищенным.
 */
export function createSandboxedClaudeEnvironment(source = process.env, options = {}) {
  const sandbox = createSandboxRoot(source, 'ralph-claude-');
  const configDir = path.join(sandbox.root, 'claude');
  mkdirSync(configDir, { recursive: true });

  const apiKey = options.apiKey === undefined ? source.ANTHROPIC_API_KEY?.trim() : options.apiKey;
  if (options.apiKey !== null) {
    if (!apiKey) {
      sandbox.cleanup();
      const error = new Error(
        'ANTHROPIC_API_KEY не задан. Claude-сессия Ralph запускается с изолированным ' +
          'HOME, где OAuth-токен CLI недоступен; задайте ключ в окружении оператора.',
      );
      error.code = 'RALPH_AGENT_AUTH';
      throw error;
    }
  }

  return {
    root: sandbox.root,
    env: {
      ...sandbox.env,
      CLAUDE_CONFIG_DIR: configDir,
      ...(apiKey ? { ANTHROPIC_API_KEY: apiKey } : {}),
    },
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
    // Схема передаётся строкой, а не путём: файлового флага у CLI нет.
    '--json-schema',
    readFileSync(role.schemaPath, 'utf8'),
  ];
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
 * Проверяется наличие ключа, а не ответ CLI: `claude auth status` завершается
 * кодом 0 и когда пользователь не авторизован, а его OAuth-состояние всё равно
 * не попадёт в изолированный CLAUDE_CONFIG_DIR сессии.
 */
export function verifyClaudeAuthentication(dependencies = {}) {
  const source = dependencies.env ?? process.env;
  if (!(dependencies.apiKey ?? source.ANTHROPIC_API_KEY?.trim())) {
    const error = new Error(
      'ANTHROPIC_API_KEY не задан. Claude-сессия Ralph запускается с изолированным HOME, ' +
        'где OAuth-токен CLI недоступен; задайте ключ в окружении оператора.',
    );
    error.code = 'RALPH_AGENT_AUTH';
    throw error;
  }
}
