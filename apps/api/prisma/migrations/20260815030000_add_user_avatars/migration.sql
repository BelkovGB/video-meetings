ALTER TABLE "users"
  ADD COLUMN "avatar_storage_key" TEXT,
  ADD COLUMN "avatar_mime_type" VARCHAR(32),
  ADD COLUMN "avatar_size_bytes" INTEGER,
  ADD COLUMN "avatar_updated_at" TIMESTAMP(3);

CREATE UNIQUE INDEX "users_avatar_storage_key_key" ON "users"("avatar_storage_key");
