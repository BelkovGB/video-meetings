-- AlterTable
ALTER TABLE "meeting_summary_tasks" ADD COLUMN     "owner_id" TEXT;

-- Backfill existing rows from the owning meeting, so a task the transcript
-- agent already wrote stays reachable through MCP for that meeting's owner
-- instead of becoming permanently unowned.
UPDATE "meeting_summary_tasks" AS "task"
SET "owner_id" = "meeting"."owner_id"
FROM "meeting_summaries" AS "summary"
JOIN "meetings" AS "meeting" ON "meeting"."id" = "summary"."meeting_id"
WHERE "task"."summary_id" = "summary"."id";

-- CreateIndex
CREATE INDEX "meeting_summary_tasks_owner_id_status_idx" ON "meeting_summary_tasks"("owner_id", "status");

-- AddForeignKey
ALTER TABLE "meeting_summary_tasks" ADD CONSTRAINT "meeting_summary_tasks_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
