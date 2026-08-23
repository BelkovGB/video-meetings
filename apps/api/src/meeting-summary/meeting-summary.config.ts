const DEFAULT_MAX_INPUT_CHARS = 500_000;
const DEFAULT_TIMEOUT_MS = 600_000;
// A tool-calling run needs one turn per search/create/update call plus a
// final turn for the answer, not the single turn a plain prompt-response
// exchange takes — generous enough for a long meeting's worth of tasks
// without leaving an ill-behaved conversation to loop indefinitely.
const DEFAULT_MAX_AGENT_TURNS = 30;
// Total tries at getting a parseable final JSON reply, not just retries: 1
// means never retry. A retry reuses the same summaryId-scoped tools, so
// find_similar_tasks on the next attempt sees whatever the failed attempt
// already wrote and merges into it instead of duplicating.
const DEFAULT_MAX_OUTPUT_ATTEMPTS = 3;
// A tool-calling run needs one call per search/create/update, so this is
// generous enough for a long meeting's worth of tasks while still stopping a
// run that a prompt injection has driven into a loop of tool calls.
const DEFAULT_MAX_TOOL_CALLS = 20;
// The scheduler is the only thing standing between "transcript ready" and
// "summary queued" when nobody presses the button, so this is short enough to
// feel automatic without polling the database aggressively.
const DEFAULT_SCHEDULER_INTERVAL_MS = 15_000;

function readPositiveInteger(name: string, fallback: number): number {
  const value = process.env[name];

  if (!value) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name];

  if (value === undefined) {
    return fallback;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }

  throw new Error(`${name} must be either true or false`);
}

export const meetingSummaryConfig = {
  maxInputChars: readPositiveInteger('SUMMARY_MAX_INPUT_CHARS', DEFAULT_MAX_INPUT_CHARS),
  timeoutMs: readPositiveInteger('SUMMARY_TIMEOUT_MS', DEFAULT_TIMEOUT_MS),
  maxAgentTurns: readPositiveInteger('SUMMARY_MAX_AGENT_TURNS', DEFAULT_MAX_AGENT_TURNS),
  maxOutputAttempts: readPositiveInteger(
    'SUMMARY_MAX_OUTPUT_ATTEMPTS',
    DEFAULT_MAX_OUTPUT_ATTEMPTS,
  ),
  maxToolCalls: readPositiveInteger('SUMMARY_MAX_TOOL_CALLS', DEFAULT_MAX_TOOL_CALLS),
  schedulerIntervalMs: readPositiveInteger(
    'SUMMARY_SCHEDULER_INTERVAL_MS',
    DEFAULT_SCHEDULER_INTERVAL_MS,
  ),
  // Off in apps/api/test/setup.ts, on everywhere else — see the comment on
  // MeetingSummarySchedulerService.onApplicationBootstrap.
  schedulerAutoStart: readBoolean('SUMMARY_SCHEDULER_AUTOSTART', true),
};
