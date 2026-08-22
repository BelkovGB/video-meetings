-- CreateEnum
CREATE TYPE "MeetingSummaryStatus" AS ENUM ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "meeting_summaries" (
    "id" TEXT NOT NULL,
    "meeting_id" TEXT NOT NULL,
    "status" "MeetingSummaryStatus" NOT NULL DEFAULT 'QUEUED',
    "summary_text" TEXT,
    "failure_code" VARCHAR(64),
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meeting_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "meeting_summaries_meeting_id_key" ON "meeting_summaries"("meeting_id");

-- CreateIndex
CREATE INDEX "meeting_summaries_status_created_at_idx" ON "meeting_summaries"("status", "created_at");

-- AddForeignKey
ALTER TABLE "meeting_summaries" ADD CONSTRAINT "meeting_summaries_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
