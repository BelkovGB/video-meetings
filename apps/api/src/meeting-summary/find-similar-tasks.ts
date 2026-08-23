import { PrismaService } from '../prisma/prisma.service';

export interface FindSimilarTasksParams {
  summaryId: string;
  query: string;
}

export interface SimilarTask {
  id: string;
  title: string;
  assignee: string | null;
}

/**
 * Shared by the meeting-summary agent's internal `find_similar_tasks` MCP
 * tool and the standalone `find_tasks` MCP server in `../mcp-server`: both
 * look up the same `meeting_summary_tasks` rows by title/assignee text. The
 * internal caller closes over `summaryId` instead of taking it as a tool
 * argument (see `MeetingToolsService`) because its input is untrusted
 * transcript text; the standalone server takes `summaryId` as a real argument
 * because its caller is a trusted MCP client operated by the meeting owner,
 * not an LLM parsing injected text.
 */
export async function findSimilarTasks(
  prisma: PrismaService,
  { summaryId, query }: FindSimilarTasksParams,
): Promise<SimilarTask[]> {
  return prisma.meetingSummaryTask.findMany({
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
