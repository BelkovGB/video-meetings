import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { McpServerModule } from '../mcp-sdk/import-mcp-sdk';
import { TaskService } from '../meeting-summary/services/task.service';

type McpServer = InstanceType<McpServerModule['McpServer']>;
type ResourceTemplateClass = McpServerModule['ResourceTemplate'];

/**
 * Registers every task tool and resource this server exposes, on whichever
 * `McpServer` instance is asked for — a fresh one per request, since
 * `McpService.createConnectedTransport` builds a new server for every call.
 * Every callback here goes straight to `TaskService`: no Prisma query is
 * duplicated here that already lives there.
 *
 * `ResourceTemplate` is a constructor argument rather than a module-level
 * import so this class never touches `@modelcontextprotocol/sdk` directly —
 * only `McpService` imports the SDK (through the shared ESM/CJS bridge in
 * `../mcp-sdk`), and hands this class the class reference it already
 * resolved for building the server itself.
 *
 * Every callback is scoped to the `viewerId` `registerOn` was given — the
 * authenticated caller `McpController` took from the request. A summaryId or
 * a task id arrives from the caller, so nothing here trusts it: a summary the
 * viewer is not part of comes back as "not found", the same answer a summary
 * that does not exist gets, so the endpoint never confirms another meeting's
 * ids to a stranger.
 */
@Injectable()
export class TaskTools {
  constructor(private readonly taskService: TaskService) {}

  registerOn(server: McpServer, ResourceTemplate: ResourceTemplateClass, viewerId: string): void {
    this.registerTools(server, viewerId);
    this.registerResources(server, ResourceTemplate, viewerId);
  }

  private registerTools(server: McpServer, viewerId: string): void {
    server.registerTool(
      'find_tasks',
      {
        title: 'Find meeting tasks',
        description:
          'Finds tasks recorded for a meeting summary whose title or assignee ' +
          'resembles the given text. An empty query lists every task for the summary.',
        inputSchema: {
          summaryId: z.string().min(1).describe('Id of the meeting summary to search within.'),
          query: z.string().describe('Free text to match against task titles and assignee names.'),
        },
        annotations: { readOnlyHint: true },
      },
      async ({ summaryId, query }) => {
        if (!(await this.taskService.isSummaryVisibleTo(summaryId, viewerId))) {
          return summaryNotFound(summaryId);
        }

        const tasks = await this.taskService.findSimilar(summaryId, query);

        return { content: [{ type: 'text' as const, text: JSON.stringify({ tasks }) }] };
      },
    );

    server.registerTool(
      'upsert_task',
      {
        title: 'Create or update a meeting task',
        description:
          'Creates a new task for a meeting summary, or updates one identified ' +
          'by taskId instead of creating a duplicate.',
        inputSchema: {
          summaryId: z.string().min(1).describe('Id of the meeting summary the task belongs to.'),
          taskId: z
            .string()
            .optional()
            .describe(
              'Id of an existing task (from find_tasks) to update. Omit to create a new task.',
            ),
          title: z.string().min(1).describe('The task as one short sentence.'),
          status: z.enum(['TODO', 'DONE']).describe('The task status.'),
        },
        annotations: { readOnlyHint: false },
      },
      async ({ summaryId, taskId, title, status }) => {
        if (!(await this.taskService.isSummaryVisibleTo(summaryId, viewerId))) {
          return summaryNotFound(summaryId);
        }

        const result = await this.taskService.upsert({ summaryId, taskId, title, status });

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
                status: result.task.status,
              }),
            },
          ],
        };
      },
    );
  }

  private registerResources(
    server: McpServer,
    ResourceTemplate: ResourceTemplateClass,
    viewerId: string,
  ): void {
    server.registerResource(
      'open-tasks',
      'tasks://open',
      {
        title: 'Open tasks',
        description: 'Every task not yet marked DONE in a meeting you take part in.',
        mimeType: 'application/json',
      },
      async (uri) => {
        const tasks = await this.taskService.listOpenForViewer(viewerId);

        return {
          contents: [
            { uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ tasks }) },
          ],
        };
      },
    );

    server.registerResource(
      'task',
      new ResourceTemplate('task://{id}', { list: undefined }),
      {
        title: 'Task',
        description: 'A single task by id.',
        mimeType: 'application/json',
      },
      async (uri, variables) => {
        const id = Array.isArray(variables.id) ? variables.id[0] : variables.id;
        const task = await this.taskService.findByIdForViewer(id, viewerId);

        if (!task) {
          throw new Error(`No task ${id} found.`);
        }

        return {
          contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(task) }],
        };
      },
    );
  }
}

/** The answer for a summary the viewer may not see, word for word the answer
 * for one that does not exist. */
function summaryNotFound(summaryId: string) {
  return {
    content: [{ type: 'text' as const, text: `No summary ${summaryId} found.` }],
    isError: true,
  };
}
