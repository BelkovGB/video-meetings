import { Injectable } from '@nestjs/common';
import { TaskOrigin } from '@prisma/client';
import { z } from 'zod';

import { ClaudeAgentSdk, importClaudeAgentSdk } from '../claude-agent/import-claude-agent-sdk';
import { PrismaService } from '../prisma/prisma.service';
import { TaskService } from './services/task.service';

/**
 * MCP tools the meeting-summary agent uses to build one run's tasks and
 * decisions incrementally instead of returning a single JSON blob: search for
 * a task already recorded before creating a new one, so the same task
 * mentioned again in another transcript file becomes one row, not a
 * duplicate. Registered by `MeetingSummaryRunnerService` as the `meeting` MCP
 * server passed to `ClaudeAgentService.ask`.
 *
 * `createServer` takes `summaryId` itself and closes over it in every tool
 * below, rather than accepting it as a tool argument the model supplies: the
 * transcript text is untrusted input embedded in the prompt, so a caller
 * cannot let a prompt-injected instruction pick which meeting a tool call
 * touches. There is no `summaryId` field in any input schema for exactly that
 * reason — the model has no way to name a different run even if it tries.
 */
@Injectable()
export class MeetingToolsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly taskService: TaskService,
  ) {}

  async createServer(summaryId: string) {
    const { tool, createSdkMcpServer } = await importClaudeAgentSdk();
    const ownerId = await this.resolveOwnerId(summaryId);

    return createSdkMcpServer({
      name: 'meeting',
      tools: [
        this.findSimilarTasksTool(tool, summaryId, ownerId),
        this.upsertTaskTool(tool, summaryId, ownerId),
        this.writeSummaryAndDecisionsTool(tool, summaryId),
      ],
    });
  }

  /** The meeting owner every task this run writes is stamped with — resolved
   * once per run, not per tool call, since it never changes mid-run. */
  private async resolveOwnerId(summaryId: string): Promise<string | null> {
    const summary = await this.prisma.meetingSummary.findUniqueOrThrow({
      where: { id: summaryId },
      select: { meeting: { select: { ownerId: true } } },
    });

    return summary.meeting.ownerId;
  }

  private findSimilarTasksTool(
    tool: ClaudeAgentSdk['tool'],
    summaryId: string,
    ownerId: string | null,
  ) {
    return tool(
      'find_similar_tasks',
      'Finds tasks already recorded for the current meeting summary whose title ' +
        'or assignee resembles the given text, so a task mentioned again can be ' +
        'merged into the existing row with upsert_task instead of duplicated.',
      {
        query: z
          .string()
          .min(1)
          .describe('Free text to match against existing task titles and assignee names.'),
      },
      async ({ query }) => {
        const tasks = await this.taskService.findSimilar(summaryId, query, ownerId);

        return { content: [{ type: 'text' as const, text: JSON.stringify({ tasks }) }] };
      },
    );
  }

  private upsertTaskTool(tool: ClaudeAgentSdk['tool'], summaryId: string, ownerId: string | null) {
    return tool(
      'upsert_task',
      'Creates a new task for the current meeting summary, or updates one found ' +
        'via find_similar_tasks instead of creating a duplicate.',
      {
        taskId: z
          .string()
          .optional()
          .describe(
            'Id of an existing task (from find_similar_tasks) to update. Omit to create a new task.',
          ),
        title: z.string().min(1).describe('The task as one short sentence.'),
        assignee: z
          .string()
          .nullable()
          .optional()
          .describe(
            "The assignee's name exactly as spoken in the meeting, or null if no one was named.",
          ),
      },
      async ({ taskId, title, assignee }) => {
        const result = await this.taskService.upsert({
          summaryId,
          taskId,
          title,
          assignee,
          ownerId,
          origin: TaskOrigin.AGENT,
        });

        if (!result.found) {
          return {
            content: [{ type: 'text' as const, text: `No task ${taskId} found for this summary.` }],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                id: result.task.id,
                title: result.task.title,
                assignee: result.task.assignee,
              }),
            },
          ],
        };
      },
    );
  }

  private writeSummaryAndDecisionsTool(tool: ClaudeAgentSdk['tool'], summaryId: string) {
    return tool(
      'write_summary_and_decisions',
      'Writes the meeting summary text and replaces the recorded decisions for ' +
        'the current run. Call once, after every task has been recorded with ' +
        'upsert_task.',
      {
        summary: z.string().min(1).describe('A concise summary of the meeting, in Russian.'),
        decisions: z
          .array(z.string().min(1))
          .describe(
            'Every decision the meeting reached, each as one short sentence. Empty if none.',
          ),
      },
      async ({ summary, decisions }) => {
        // Decisions are replaced wholesale, not merged: unlike a task, a decision
        // is not something a later transcript adds detail to, so the dedup
        // problem upsert_task solves does not apply here.
        await this.prisma.$transaction(async (tx) => {
          await tx.meetingSummary.update({
            where: { id: summaryId },
            data: { summaryText: summary },
          });
          await tx.meetingSummaryDecision.deleteMany({ where: { summaryId } });

          if (decisions.length > 0) {
            await tx.meetingSummaryDecision.createMany({
              data: decisions.map((text, index) => ({ summaryId, text, position: index })),
            });
          }
        });

        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true }) }] };
      },
    );
  }
}
