-- CreateTable
CREATE TABLE "meeting_summary_task_sources" (
    "task_id" TEXT NOT NULL,
    "meeting_file_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meeting_summary_task_sources_pkey" PRIMARY KEY ("task_id", "meeting_file_id")
);

-- CreateIndex
CREATE INDEX "meeting_summary_task_sources_meeting_file_id_idx" ON "meeting_summary_task_sources"("meeting_file_id");

-- AddForeignKey
ALTER TABLE "meeting_summary_task_sources" ADD CONSTRAINT "meeting_summary_task_sources_task_id_fkey"
    FOREIGN KEY ("task_id") REFERENCES "meeting_summary_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_summary_task_sources" ADD CONSTRAINT "meeting_summary_task_sources_meeting_file_id_fkey"
    FOREIGN KEY ("meeting_file_id") REFERENCES "meeting_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;
