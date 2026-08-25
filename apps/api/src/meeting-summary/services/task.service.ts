import { Injectable } from '@nestjs/common';
import { Prisma, TaskOrigin, TaskStatus } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';

export interface SimilarTask {
  id: string;
  title: string;
  assignee: string | null;
}

export interface UpsertTaskParams {
  summaryId: string;
  taskId?: string;
  title: string;
  /**
   * Left out entirely, an update keeps whatever assignee the task already
   * carries; `null` or blank clears it. The HTTP MCP tools never send it, and
   * they must not silently drop the name the transcript recorded just because
   * a client toggled a task to DONE.
   */
  assignee?: string | null;
  status?: TaskStatus;
  /**
   * Stamped on create, never taken from an update's arguments: the id in
   * `taskId`/`summaryId` says what to write, `ownerId` says who is allowed to
   * write it. An update also has to match the row's existing owner — see
   * `upsert`.
   */
  ownerId: string | null;
  /** Stamped on create, ignored on update — see the `origin` field doc on
   * `MeetingSummaryTask` in schema.prisma. */
  origin: TaskOrigin;
}

export interface TaskRow {
  id: string;
  title: string;
  assignee: string | null;
  status: TaskStatus;
  ownerId: string | null;
}

export type UpsertTaskResult = { found: true; task: TaskRow } | { found: false };

/**
 * Owns every read/write on `meeting_summary_tasks`. Shared by the
 * meeting-summary agent's internal MCP tools (`MeetingToolsService`, which
 * resolves the meeting's owner once per run and passes it as `ownerId`) and
 * the in-process HTTP MCP server's tools and resources (`../../mcp/task-tools`,
 * which pass the authenticated caller's id). `ownerId` is the only access
 * control this service applies: a `summaryId` or `taskId` a caller names says
 * which task to search for or write, never permission to see or change it —
 * `findById` is the one exception, deliberately unscoped, because the
 * resource handler that calls it (`task://{id}`) needs the row's real owner
 * to tell a wrong-owner 403 apart from a genuine 404.
 */
@Injectable()
export class TaskService {
  constructor(private readonly prisma: PrismaService) {}

  /** Unscoped by design — see the class doc. */
  async findById(taskId: string): Promise<TaskRow | null> {
    return this.prisma.meetingSummaryTask.findUnique({
      where: { id: taskId },
      select: { id: true, title: true, assignee: true, status: true, ownerId: true },
    });
  }

  async listOpenForOwner(ownerId: string | null): Promise<TaskRow[]> {
    return this.prisma.meetingSummaryTask.findMany({
      where: { status: TaskStatus.TODO, ownerId },
      orderBy: { position: 'asc' },
      take: 50,
      select: { id: true, title: true, assignee: true, status: true, ownerId: true },
    });
  }

  /**
   * Whether this user may put a task under this summary at all: the meeting
   * behind it is one they own or take part in, the rule
   * `MeetingAccessService.requireAccess` applies to meeting files.
   *
   * `ownerId` decides which tasks a caller may *read or change*, but it
   * cannot decide where a new task may *land*: the row's owner is stamped
   * from the caller, so it is the caller-supplied `summaryId` alone that
   * chooses whose meeting the task appears in. Without this check any
   * authenticated user who learns a summary id can write a task into a
   * stranger's meeting, and an `MCP`-origin row survives every rerun with no
   * route to delete it.
   */
  async isSummaryWritableBy(summaryId: string, userId: string): Promise<boolean> {
    const summary = await this.prisma.meetingSummary.findFirst({
      where: { id: summaryId, meeting: meetingVisibleTo(userId) },
      select: { id: true },
    });

    return summary !== null;
  }

  async findSimilar(
    summaryId: string,
    query: string,
    ownerId: string | null,
  ): Promise<SimilarTask[]> {
    return this.prisma.meetingSummaryTask.findMany({
      where: {
        summaryId,
        ownerId,
        OR: [
          { title: { contains: query, mode: 'insensitive' } },
          { assignee: { contains: query, mode: 'insensitive' } },
        ],
      },
      orderBy: { position: 'asc' },
      take: 20,
      select: { id: true, title: true, assignee: true },
    });
  }

  async upsert({
    summaryId,
    taskId,
    title,
    assignee,
    status,
    ownerId,
    origin,
  }: UpsertTaskParams): Promise<UpsertTaskResult> {
    const normalizedAssignee = assignee && assignee.trim().length > 0 ? assignee.trim() : null;
    const assigneePatch = assignee === undefined ? {} : { assignee: normalizedAssignee };

    if (taskId) {
      // Scoped to summaryId and ownerId together: a taskId cannot reach a
      // task from another meeting even as a guess, and cannot reach one
      // that exists but belongs to someone else.
      const existing = await this.prisma.meetingSummaryTask.findFirst({
        where: { id: taskId, summaryId, ownerId },
        select: { id: true },
      });

      if (!existing) {
        return { found: false };
      }

      const updated = await this.prisma.meetingSummaryTask.update({
        where: { id: taskId },
        data: { title, ...assigneePatch, ...(status ? { status } : {}), ...originPatch(origin) },
      });

      return { found: true, task: updated };
    }

    const created = await this.prisma.meetingSummaryTask.create({
      data: {
        summaryId,
        title,
        assignee: normalizedAssignee,
        position: await this.nextPosition(summaryId),
        ownerId,
        origin,
        ...(status ? { status } : {}),
      },
    });

    return { found: true, task: created };
  }

  private async nextPosition(summaryId: string): Promise<number> {
    const last = await this.prisma.meetingSummaryTask.findFirst({
      where: { summaryId },
      orderBy: { position: 'desc' },
      select: { position: true },
    });

    return (last?.position ?? -1) + 1;
  }
}

/**
 * An update may only move a row from `AGENT` to `MCP`, never back.
 *
 * A task the agent wrote is deleted and rewritten by the next rerun, which is
 * right while the text is only ever the model's. The moment a client edits it
 * through `upsert_task` the row holds something no rerun will reproduce, so
 * it has to start surviving reruns like any other MCP-written task. The
 * reverse — the agent's own tool updating a row a client wrote, and stamping
 * it `AGENT` — would hand that row back to the next rerun's delete.
 */
function originPatch(origin: TaskOrigin): Prisma.MeetingSummaryTaskUpdateInput {
  return origin === TaskOrigin.MCP ? { origin } : {};
}

/**
 * The meetings a user may see: the ones they own and the ones they were
 * recorded in — the rule `MeetingAccessService.requireAccess` enforces for
 * meeting files, expressed as a `where` fragment so a single query can carry
 * it.
 */
function meetingVisibleTo(userId: string): Prisma.MeetingWhereInput {
  return { OR: [{ ownerId: userId }, { participants: { some: { userId } } }] };
}
