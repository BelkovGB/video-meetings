-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('TODO', 'DONE');

-- AlterTable
ALTER TABLE "meeting_summary_tasks" ADD COLUMN     "status" "TaskStatus" NOT NULL DEFAULT 'TODO';
