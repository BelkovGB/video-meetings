import { Injectable } from '@nestjs/common';
import { Prisma, TaskStatus } from '@prisma/client';

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
}

export interface TaskRow {
  id: string;
  title: string;
  assignee: string | null;
  status: TaskStatus;
}

export type UpsertTaskResult = { found: true; task: TaskRow } | { found: false };

/**
 * Owns every read/write on `meeting_summary_tasks`. Shared by the
 * meeting-summary agent's internal MCP tools (`MeetingToolsService`, closed
 * over a trusted summaryId) and the in-process HTTP MCP server's tools and
 * resources (`../../mcp/task-tools`), which take summaryId as a caller
 * argument and so must say whose eyes the call is made through: every read
 * that starts from something the caller named — a task id, a summary id, or
 * nothing at all — takes a `viewerId` and answers only for meetings that
 * viewer may see. The unscoped `findSimilar` and `upsert` are the exception,
 * and only because both callers establish that right first: the agent is
 * closed over the summaryId of the run it was built for, and the HTTP tools
 * check `isSummaryVisibleTo` before either one.
 */
@Injectable()
export class TaskService {
  constructor(private readonly prisma: PrismaService) {}

  async findByIdForViewer(taskId: string, viewerId: string): Promise<TaskRow | null> {
    return this.prisma.meetingSummaryTask.findFirst({
      where: { id: taskId, ...visibleTo(viewerId) },
      select: { id: true, title: true, assignee: true, status: true },
    });
  }

  async listOpenForViewer(viewerId: string): Promise<TaskRow[]> {
    return this.prisma.meetingSummaryTask.findMany({
      where: { status: TaskStatus.TODO, ...visibleTo(viewerId) },
      orderBy: { position: 'asc' },
      take: 50,
      select: { id: true, title: true, assignee: true, status: true },
    });
  }

  /** Whether the viewer may work with this summary's tasks at all — the check
   * the HTTP MCP tools run before they trust a caller-supplied summaryId. */
  async isSummaryVisibleTo(summaryId: string, viewerId: string): Promise<boolean> {
    const summary = await this.prisma.meetingSummary.findFirst({
      where: { id: summaryId, meeting: meetingVisibleTo(viewerId) },
      select: { id: true },
    });

    return summary !== null;
  }

  async findSimilar(summaryId: string, query: string): Promise<SimilarTask[]> {
    return this.prisma.meetingSummaryTask.findMany({
      where: {
        summaryId,
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
  }: UpsertTaskParams): Promise<UpsertTaskResult> {
    const normalizedAssignee = assignee && assignee.trim().length > 0 ? assignee.trim() : null;
    const assigneePatch = assignee === undefined ? {} : { assignee: normalizedAssignee };

    if (taskId) {
      // Scoped to summaryId, so a taskId cannot reach a task belonging to
      // another meeting even as a typo or a guess.
      const existing = await this.prisma.meetingSummaryTask.findFirst({
        where: { id: taskId, summaryId },
        select: { id: true },
      });

      if (!existing) {
        return { found: false };
      }

      const updated = await this.prisma.meetingSummaryTask.update({
        where: { id: taskId },
        data: { title, ...assigneePatch, ...(status ? { status } : {}) },
      });

      return { found: true, task: updated };
    }

    const created = await this.prisma.meetingSummaryTask.create({
      data: {
        summaryId,
        title,
        assignee: normalizedAssignee,
        position: await this.nextPosition(summaryId),
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
 * The meetings a user may see: the ones they own and the ones they were
 * recorded in — the rule `MeetingAccessService.requireAccess` enforces for
 * meeting files, expressed as a `where` fragment. A fragment rather than a
 * call to that service because these reads filter lists: asking it per row
 * would be one query per task.
 */
function meetingVisibleTo(viewerId: string): Prisma.MeetingWhereInput {
  return { OR: [{ ownerId: viewerId }, { participants: { some: { userId: viewerId } } }] };
}

function visibleTo(viewerId: string): Prisma.MeetingSummaryTaskWhereInput {
  return { summary: { meeting: meetingVisibleTo(viewerId) } };
}
