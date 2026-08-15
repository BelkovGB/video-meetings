-- AddColumn
ALTER TABLE "auth_sessions" ADD COLUMN "expires_at" TIMESTAMP(3);

-- Backfill existing sessions using the maximum lifetime of tokens issued before session expiry tracking.
UPDATE "auth_sessions"
SET "expires_at" = "created_at" + INTERVAL '1 hour 1 second';

-- AlterColumn
ALTER TABLE "auth_sessions" ALTER COLUMN "expires_at" SET NOT NULL;

-- CreateIndex
CREATE INDEX "auth_sessions_expires_at_idx" ON "auth_sessions"("expires_at");

-- CreateIndex
CREATE INDEX "auth_sessions_revoked_at_idx" ON "auth_sessions"("revoked_at");
