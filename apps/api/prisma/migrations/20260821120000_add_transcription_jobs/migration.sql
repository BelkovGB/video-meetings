-- CreateEnum
CREATE TYPE "TranscriptionJobStatus" AS ENUM ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED');

-- AlterTable
ALTER TABLE "meeting_files" ADD COLUMN     "source_file_id" TEXT;

-- CreateTable
CREATE TABLE "transcription_jobs" (
    "id" TEXT NOT NULL,
    "source_file_id" TEXT NOT NULL,
    "status" "TranscriptionJobStatus" NOT NULL DEFAULT 'QUEUED',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "lease_owner" VARCHAR(128),
    "lease_expires_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "failure_code" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transcription_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "transcription_jobs_source_file_id_key" ON "transcription_jobs"("source_file_id");

-- CreateIndex
CREATE INDEX "transcription_jobs_status_created_at_idx" ON "transcription_jobs"("status", "created_at");

-- CreateIndex
CREATE INDEX "transcription_jobs_status_lease_expires_at_idx" ON "transcription_jobs"("status", "lease_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "meeting_files_source_file_id_key" ON "meeting_files"("source_file_id");

-- AddForeignKey
ALTER TABLE "meeting_files" ADD CONSTRAINT "meeting_files_source_file_id_fkey" FOREIGN KEY ("source_file_id") REFERENCES "meeting_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcription_jobs" ADD CONSTRAINT "transcription_jobs_source_file_id_fkey" FOREIGN KEY ("source_file_id") REFERENCES "meeting_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

