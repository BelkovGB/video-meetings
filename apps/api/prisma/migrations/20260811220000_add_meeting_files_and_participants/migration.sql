-- CreateEnum
CREATE TYPE "MeetingFileCategory" AS ENUM ('AUDIO', 'VIDEO', 'TRANSCRIPT', 'DOCUMENT');

-- CreateEnum
CREATE TYPE "MeetingFileStatus" AS ENUM ('READY', 'DELETING', 'MISSING');

-- CreateTable
CREATE TABLE "meeting_participants" (
    "meeting_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meeting_participants_pkey" PRIMARY KEY ("meeting_id", "user_id")
);

-- CreateTable
CREATE TABLE "meeting_files" (
    "id" TEXT NOT NULL,
    "meeting_id" TEXT NOT NULL,
    "uploaded_by_id" TEXT,
    "original_name" VARCHAR(255) NOT NULL,
    "storage_key" TEXT NOT NULL,
    "category" "MeetingFileCategory" NOT NULL,
    "mime_type" VARCHAR(255) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "status" "MeetingFileStatus" NOT NULL DEFAULT 'READY',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meeting_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "meeting_participants_user_id_idx" ON "meeting_participants"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "meeting_files_storage_key_key" ON "meeting_files"("storage_key");

-- CreateIndex
CREATE INDEX "meeting_files_meeting_id_status_created_at_idx" ON "meeting_files"("meeting_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "meeting_files_uploaded_by_id_idx" ON "meeting_files"("uploaded_by_id");

-- AddForeignKey
ALTER TABLE "meeting_participants" ADD CONSTRAINT "meeting_participants_meeting_id_fkey"
    FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_participants" ADD CONSTRAINT "meeting_participants_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_files" ADD CONSTRAINT "meeting_files_meeting_id_fkey"
    FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_files" ADD CONSTRAINT "meeting_files_uploaded_by_id_fkey"
    FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
