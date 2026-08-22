-- CreateTable
CREATE TABLE "meeting_summary_tasks" (
    "id" TEXT NOT NULL,
    "summary_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "assignee" TEXT,
    "position" INTEGER NOT NULL,

    CONSTRAINT "meeting_summary_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meeting_summary_decisions" (
    "id" TEXT NOT NULL,
    "summary_id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "meeting_summary_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "meeting_summary_tasks_summary_id_position_idx" ON "meeting_summary_tasks"("summary_id", "position");

-- CreateIndex
CREATE INDEX "meeting_summary_decisions_summary_id_position_idx" ON "meeting_summary_decisions"("summary_id", "position");

-- AddForeignKey
ALTER TABLE "meeting_summary_tasks" ADD CONSTRAINT "meeting_summary_tasks_summary_id_fkey" FOREIGN KEY ("summary_id") REFERENCES "meeting_summaries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_summary_decisions" ADD CONSTRAINT "meeting_summary_decisions_summary_id_fkey" FOREIGN KEY ("summary_id") REFERENCES "meeting_summaries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
