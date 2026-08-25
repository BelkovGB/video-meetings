import { MeetingSummary, MeetingSummaryStatus } from '@prisma/client';

import { MeetingSummaryFailureCode, meetingSummaryFailureCodes } from './meeting-summary-failure';

export type MeetingSummaryStatusResponse = 'queued' | 'processing' | 'ready' | 'error';

export type MeetingSummaryTaskResponse = {
  id: string;
  title: string;
  assignee: string | null;
};

export type MeetingSummaryDecisionResponse = {
  id: string;
  text: string;
};

export type MeetingSummaryResponse = {
  /** The MeetingSummary row's own id — distinct from the meeting's id, and
   * what MCP clients pass as `summaryId` to `/mcp`'s tools, resources and
   * prompts. `null` until a summary has been started at least once. */
  id: string | null;
  status: MeetingSummaryStatusResponse | null;
  summary: string | null;
  failureCode: MeetingSummaryFailureCode | null;
  tasks: MeetingSummaryTaskResponse[];
  decisions: MeetingSummaryDecisionResponse[];
};

const statusByRowStatus: Record<MeetingSummaryStatus, MeetingSummaryStatusResponse> = {
  [MeetingSummaryStatus.QUEUED]: 'queued',
  [MeetingSummaryStatus.PROCESSING]: 'processing',
  [MeetingSummaryStatus.COMPLETED]: 'ready',
  [MeetingSummaryStatus.FAILED]: 'error',
};

export type MeetingSummaryWithChildren = MeetingSummary & {
  tasks: readonly { id: string; title: string; assignee: string | null }[];
  decisions: readonly { id: string; text: string }[];
};

export function toMeetingSummaryResponse(
  row: MeetingSummaryWithChildren | null,
): MeetingSummaryResponse {
  if (!row) {
    return { id: null, status: null, summary: null, failureCode: null, tasks: [], decisions: [] };
  }

  const status = statusByRowStatus[row.status];

  return {
    id: row.id,
    status,
    summary: row.summaryText,
    failureCode: status === 'error' ? toMeetingSummaryFailureCode(row.failureCode) : null,
    tasks: row.tasks.map((task) => ({ id: task.id, title: task.title, assignee: task.assignee })),
    decisions: row.decisions.map((decision) => ({ id: decision.id, text: decision.text })),
  };
}

// The column is a plain VARCHAR in the schema, and the runner only ever writes
// a `MeetingSummaryFailureCode`, but this response is the client-facing
// boundary: an unrecognised value (a hand-edited row, a restored backup) must
// not reach the client verbatim, so it is coerced to the generic code instead.
function toMeetingSummaryFailureCode(value: string | null): MeetingSummaryFailureCode | null {
  if (value === null) {
    return null;
  }

  return (meetingSummaryFailureCodes as readonly string[]).includes(value)
    ? (value as MeetingSummaryFailureCode)
    : 'INTERNAL_ERROR';
}
