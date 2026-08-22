import { mkdir } from 'node:fs/promises';

import { Injectable } from '@nestjs/common';
import type { McpServerConfig, NonNullableUsage, Options } from '@anthropic-ai/claude-agent-sdk';

import {
  claudeAgentApiKey,
  claudeAgentConfigDirectory,
  claudeAgentModel,
} from './claude-agent.config';
import { importClaudeAgentSdk } from './import-claude-agent-sdk';

// Everything the child process needs to start, and nothing else. Spreading
// `process.env` instead would hand it this machine's Claude Code state — the
// login under `~/.claude`, `ANTHROPIC_BASE_URL`, the `CLAUDE_CODE_*` variables a
// developer's own session exports — and the child would answer from that state
// rather than from the configuration below.
const inheritedVariables = [
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'windir',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'LANG',
];

function childEnvironment(apiKey: string): Record<string, string | undefined> {
  const environment: Record<string, string | undefined> = {};

  for (const name of inheritedVariables) {
    environment[name] = process.env[name];
  }
  environment.ANTHROPIC_API_KEY = apiKey;
  environment.CLAUDE_CONFIG_DIR = claudeAgentConfigDirectory;

  return environment;
}

export class ClaudeAgentTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Claude Agent SDK did not respond within ${timeoutMs}ms`);
    this.name = 'ClaudeAgentTimeoutError';
  }
}

/**
 * Sends a prompt to Claude through the Claude Agent SDK and returns the final
 * answer text.
 *
 * The SDK runs Claude Code as a child process, so the options below narrow what
 * that process may reach: no built-in tools (filesystem, Bash, web) and no
 * settings or CLAUDE.md read from disk, ever — each is a separate door into
 * this machine's files, and an API request has no business opening any of
 * them. `mcpServers`/`allowedTools` let a caller hand the model its own
 * in-process tools (see `MeetingToolsService`) without opening any of those
 * doors: an SDK MCP server only runs the handler functions the caller wrote,
 * nothing built into Claude Code. `maxTurns` defaults to a single turn, a
 * plain question-and-answer; raise it only together with `mcpServers`, since a
 * tool-calling conversation needs more than one turn to call a tool and see
 * its result before answering. `hooks` is the SDK's own `Options['hooks']`
 * shape, passed through unchanged — see `buildMeetingHooks` in
 * `meeting-summary/hooks.ts` for the one caller that uses it. `onResult`, if
 * given, is called with the SDK's own cost/usage fields from the `result`
 * message right before `ask` returns; omitting it is a no-op, so every
 * existing caller is unaffected.
 */
@Injectable()
export class ClaudeAgentService {
  readonly model = claudeAgentModel;

  async ask(
    prompt: string,
    options?: {
      timeoutMs?: number;
      mcpServers?: Record<string, McpServerConfig>;
      allowedTools?: string[];
      maxTurns?: number;
      hooks?: Options['hooks'];
      onResult?: (info: { totalCostUsd: number; usage: NonNullableUsage }) => void;
    },
  ): Promise<string> {
    if (!claudeAgentApiKey) {
      throw new Error('Missing required environment variable: ANTHROPIC_API_KEY');
    }

    await mkdir(claudeAgentConfigDirectory, { recursive: true });

    const timeoutMs = options?.timeoutMs;
    const abortController = timeoutMs !== undefined ? new AbortController() : undefined;
    let timedOut = false;
    // Aborting stops the SDK's outstanding work and, through it, kills the
    // spawned Claude Code child process — a rejected Promise alone would leave
    // that process running and billing after the caller gives up on it.
    const timer =
      timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true;
            abortController?.abort();
          }, timeoutMs)
        : undefined;

    const { query } = await importClaudeAgentSdk();
    const conversation = query({
      prompt,
      options: {
        model: this.model,
        tools: [],
        settingSources: [],
        maxTurns: options?.maxTurns ?? 1,
        // Setting `env` replaces the child environment rather than extending
        // it, which is the point: see `childEnvironment`.
        env: childEnvironment(claudeAgentApiKey),
        ...(abortController ? { abortController } : {}),
        ...(options?.mcpServers ? { mcpServers: options.mcpServers } : {}),
        ...(options?.allowedTools ? { allowedTools: options.allowedTools } : {}),
        ...(options?.hooks ? { hooks: options.hooks } : {}),
      },
    });

    try {
      try {
        for await (const message of conversation) {
          // The CLI retries a failed request ten times with a growing delay, so a
          // rejected credential otherwise takes about three minutes to surface and
          // arrives as a bare `is_error` result. Nothing about 401 or 403 improves
          // on the next attempt, so stop at the first one and say what happened.
          if (message.type === 'system' && message.subtype === 'api_retry') {
            if (message.error_status === 401 || message.error_status === 403) {
              throw new Error(
                `Claude Agent SDK could not authenticate: the API answered ${message.error_status} ` +
                  `(${message.error}). Check ANTHROPIC_API_KEY in apps/api/.env.`,
              );
            }
            continue;
          }
          if (message.type !== 'result') {
            continue;
          }
          if (message.subtype !== 'success' || message.is_error) {
            throw new Error(`Claude Agent SDK ended the turn with "${message.subtype}"`);
          }

          options?.onResult?.({ totalCostUsd: message.total_cost_usd, usage: message.usage });

          return message.result;
        }
      } catch (error) {
        if (timedOut) {
          throw new ClaudeAgentTimeoutError(timeoutMs as number);
        }
        throw error;
      }
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
      // Releases the CLI subprocess. Without it a thrown error leaves the child
      // running and jest reports that it could not exit.
      conversation.close();
    }

    if (timedOut) {
      throw new ClaudeAgentTimeoutError(timeoutMs as number);
    }
    throw new Error('Claude Agent SDK ended the turn without a result message');
  }
}
