import { Logger } from '@nestjs/common';
import type { HookCallback, Options } from '@anthropic-ai/claude-agent-sdk';

// Fully-qualified the same way meeting-summary-runner.service.ts names it in
// allowedTools — see the comment there on the `mcp__<server>__<tool>` shape.
const UPSERT_TASK_TOOL_NAME = 'mcp__meeting__upsert_task';
const MIN_TASK_TITLE_LENGTH = 3;

/**
 * Defense-in-depth hooks for one meeting-summary run — a backstop behind
 * prompt instructions and Zod input validation, not a replacement for them:
 * a transcript is untrusted input, so nothing here assumes the model behaves.
 *
 * Registered catch-all (no `matcher`) rather than matched on an MCP tool
 * name, which the SDK does not match reliably; each callback below checks
 * `tool_name` itself instead. That is harmless for this run specifically —
 * `ClaudeAgentService.ask` is called with `allowedTools` limited to the three
 * `mcp__meeting__*` tools (see meeting-summary-runner.service.ts), so "every
 * tool call in this run" already means "every meeting tool call".
 *
 * Call this once per `process(summaryId)` run, mirroring the summaryId-
 * closure pattern `MeetingToolsService.createServer` uses: `maxToolCalls` is
 * enforced through a counter closed over here, not a class field or module
 * variable, so it starts fresh for this run alone and is never shared across
 * concurrent or later runs.
 */
export function buildMeetingHooks(deps: {
  logger: Logger;
  maxToolCalls: number;
}): Options['hooks'] {
  let toolCallCount = 0;

  const preToolUseGuard: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== UPSERT_TASK_TOOL_NAME) {
      return {};
    }

    const toolInput = input.tool_input as { title?: unknown } | null | undefined;
    const rawTitle = typeof toolInput?.title === 'string' ? toolInput.title : '';
    const title = rawTitle.trim();

    if (title.length < MIN_TASK_TITLE_LENGTH) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason:
            `upsert_task title ${JSON.stringify(rawTitle)} is missing or shorter than ` +
            `${MIN_TASK_TITLE_LENGTH} characters after trimming; give the task a real title.`,
        },
      };
    }

    return {};
  };

  const callBudget: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse') {
      return {};
    }

    toolCallCount += 1;

    if (toolCallCount > deps.maxToolCalls) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `This run already made ${deps.maxToolCalls} tool calls, the maximum allowed.`,
        },
      };
    }

    return {};
  };

  const auditLog: HookCallback = async (input) => {
    // Never throws: a logging failure must not fail the tool call it audits.
    try {
      if (input.hook_event_name === 'PostToolUse') {
        deps.logger.log(
          `tool=${input.tool_name} input=${safeStringify(input.tool_input)} ` +
            `response=${safeStringify(input.tool_response)}`,
        );
      }
    } catch (error) {
      try {
        deps.logger.warn(`meeting hooks audit log failed: ${String(error)}`);
      } catch {
        // Swallow: even the fallback log call must not throw out of a hook.
      }
    }

    return {};
  };

  return {
    PreToolUse: [{ hooks: [preToolUseGuard, callBudget] }],
    PostToolUse: [{ hooks: [auditLog] }],
  };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
