-- CreateTable
CREATE TABLE "meeting_file_download_tickets" (
    "token_hash" CHAR(64) NOT NULL,
    "file_id" TEXT NOT NULL,
    "issued_to_user_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meeting_file_download_tickets_pkey" PRIMARY KEY ("token_hash")
);

-- CreateIndex
CREATE INDEX "meeting_file_download_tickets_file_id_idx"
    ON "meeting_file_download_tickets"("file_id");

-- CreateIndex
CREATE INDEX "meeting_file_download_tickets_expires_at_idx"
    ON "meeting_file_download_tickets"("expires_at");

-- AddForeignKey
ALTER TABLE "meeting_file_download_tickets"
    ADD CONSTRAINT "meeting_file_download_tickets_file_id_fkey"
    FOREIGN KEY ("file_id") REFERENCES "meeting_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_file_download_tickets"
    ADD CONSTRAINT "meeting_file_download_tickets_issued_to_user_id_fkey"
    FOREIGN KEY ("issued_to_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
