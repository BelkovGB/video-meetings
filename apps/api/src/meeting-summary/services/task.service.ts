import { Injectable } from '@nestjs/common';
import { TaskStatus } from '@prisma/client';

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
 * argument because their caller is a trusted MCP client, not an LLM parsing
 * injected transcript text.
 */
@Injectable()
export class TaskService {
  constructor(private readonly prisma: PrismaService) {}

  async findById(taskId: string): Promise<TaskRow | null> {
    return this.prisma.meetingSummaryTask.findUnique({
      where: { id: taskId },
      select: { id: true, title: true, assignee: true, status: true },
    });
  }

  async listOpen(): Promise<TaskRow[]> {
    return this.prisma.meetingSummaryTask.findMany({
      where: { status: TaskStatus.TODO },
      orderBy: { position: 'asc' },
      take: 50,
      select: { id: true, title: true, assignee: true, status: true },
    });
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
        data: { title, assignee: normalizedAssignee, ...(status ? { status } : {}) },
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
