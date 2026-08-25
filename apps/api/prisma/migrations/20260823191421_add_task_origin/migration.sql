-- CreateEnum
CREATE TYPE "TaskOrigin" AS ENUM ('AGENT', 'MCP');

-- AlterTable
ALTER TABLE "meeting_summary_tasks" ADD COLUMN     "origin" "TaskOrigin" NOT NULL DEFAULT 'AGENT';
