import { Injectable } from '@nestjs/common';
import { TaskOrigin } from '@prisma/client';
import { z } from 'zod';

import { McpServerModule } from '../mcp-sdk/import-mcp-sdk';
import { TaskService } from '../meeting-summary/services/task.service';
import { McpRequester } from './mcp.service';

type McpServer = InstanceType<McpServerModule['McpServer']>;
type ResourceTemplateClass = McpServerModule['ResourceTemplate'];

/**
 * Registers every task tool, resource and prompt this server exposes, on
 * whichever `McpServer` instance is asked for — a fresh one per request,
 * since `McpService.createConnectedTransport` builds a new server for every
 * call. Every callback here goes straight to `TaskService`: no Prisma query
 * is duplicated here that already lives there.
 *
 * `ResourceTemplate` is a constructor argument rather than a module-level
 * import so this class never touches `@modelcontextprotocol/sdk` directly —
 * only `McpService` imports the SDK (through the shared ESM/CJS bridge in
 * `../mcp-sdk`), and hands this class the class reference it already
 * resolved for building the server itself.
 *
 * Every callback is scoped to the `requester` `registerOn` was given — the
 * authenticated caller `McpController` took from the request. A summaryId or
 * a task id arrives from the caller, so none of them grant access by
 * themselves: they say what to search for or write, and `requester.userId`
 * is what decides whether the call may see or touch it.
 */
@Injectable()
export class TaskTools {
  constructor(private readonly taskService: TaskService) {}

  registerOn(
    server: McpServer,
    ResourceTemplate: ResourceTemplateClass,
    requester: McpRequester,
  ): void {
    this.registerTools(server, requester);
    this.registerResources(server, ResourceTemplate, requester);
    this.registerPrompts(server);
  }

  private registerTools(server: McpServer, requester: McpRequester): void {
    server.registerTool(
      'find_tasks',
      {
        title: 'Find meeting tasks',
        description:
          'Finds tasks you own, recorded for a meeting summary, whose title or ' +
          'assignee resembles the given text. An empty query lists every task ' +
          'you own for the summary.',
        inputSchema: {
          summaryId: z.string().min(1).describe('Id of the meeting summary to search within.'),
          query: z.string().describe('Free text to match against task titles and assignee names.'),
        },
        annotations: { readOnlyHint: true },
      },
      async ({ summaryId, query }) => {
        const tasks = await this.taskService.findSimilar(summaryId, query, requester.userId);

        return { content: [{ type: 'text' as const, text: JSON.stringify({ tasks }) }] };
      },
    );

    server.registerTool(
      'upsert_task',
      {
        title: 'Create or update a meeting task',
        description:
          'Creates a new task for a meeting summary of a meeting you own or ' +
          'take part in, owned by you, or updates one of your own tasks ' +
          'identified by taskId instead of creating a duplicate.',
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
        // Reading is scoped by ownership, but writing needs its own check:
        // the row's owner is stamped from the caller, so `summaryId` alone
        // decides whose meeting the task lands in. Without this a caller who
        // learns any summary id can plant a task in a stranger's meeting —
        // permanently, since an MCP-origin row survives every rerun and no
        // route deletes it.
        if (!(await this.taskService.isSummaryWritableBy(summaryId, requester.userId))) {
          return {
            content: [{ type: 'text' as const, text: `No summary ${summaryId} found.` }],
            isError: true,
          };
        }

        // Ownership is stamped from the authenticated caller, never from an
        // argument: there is no owner field in this schema for exactly that
        // reason — a caller cannot claim someone else's task by naming them.
        const result = await this.taskService.upsert({
          summaryId,
          taskId,
          title,
          status,
          ownerId: requester.userId,
          // Marks the row as one a summary rerun must not delete — see the
          // `origin` field doc on `MeetingSummaryTask` in schema.prisma. It
          // is stamped on an update too: once a client has edited the
          // agent's task, no rerun will reproduce what it now says.
          origin: TaskOrigin.MCP,
        });

        if (!result.found) {
          return {
            content: [
              {
                type: 'text' as const,
                text: taskId
                  ? `No task ${taskId} found for this summary.`
                  : `No summary ${summaryId} found.`,
              },
            ],
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
    requester: McpRequester,
  ): void {
    server.registerResource(
      'open-tasks',
      'tasks://open',
      {
        title: 'Open tasks',
        description: 'Every task not yet marked DONE that you own.',
        mimeType: 'application/json',
      },
      async (uri) => {
        const tasks = await this.taskService.listOpenForOwner(requester.userId);

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
        description: 'A single task by id, if you own it.',
        mimeType: 'application/json',
      },
      async (uri, variables) => {
        const id = Array.isArray(variables.id) ? variables.id[0] : variables.id;
        const task = await this.taskService.findById(id);

        if (!task) {
          throw new Error(`No task ${id} found.`);
        }
        // The id said what to load; ownership says whether this caller may
        // see it — a mismatch is a 403, distinct from the 404 above.
        if (task.ownerId !== requester.userId) {
          throw new Error(`403 Forbidden: task ${id} does not belong to you.`);
        }

        return {
          contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(task) }],
        };
      },
    );
  }

  /** Needs no `requester`: it only returns instruction text for the client's
   * own model, which then calls `find_tasks`/`upsert_task` — already scoped
   * to whoever is authenticated on that call. */
  private registerPrompts(server: McpServer): void {
    server.registerPrompt(
      'gather_meeting_tasks',
      {
        title: 'Gather meeting tasks',
        description:
          'Walks through recording every task raised in a meeting summary: check ' +
          "what's already recorded with find_tasks before adding more with " +
          "upsert_task, so a task mentioned twice doesn't end up as two rows.",
        argsSchema: {
          summaryId: z.string().min(1).describe('Id of the meeting summary to record tasks for.'),
        },
      },
      ({ summaryId }) => ({
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text:
                `Record every task raised in meeting summary ${summaryId}. For each ` +
                'one: call find_tasks with a short query for its title or assignee ' +
                'first — if it returns a match, update that task with upsert_task ' +
                'and its id instead of creating a duplicate; if not, create it. Once ' +
                'every task is recorded, call find_tasks with an empty query and ' +
                'report back the full list with its statuses.',
            },
          },
        ],
      }),
    );
  }
}
