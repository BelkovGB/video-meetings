-- Preserve existing development data while making historical meetings inaccessible
-- until an explicit ownership backfill is provided.
ALTER TABLE "meetings" ADD COLUMN "date" TIMESTAMP(3);
UPDATE "meetings" SET "date" = "created_at" WHERE "date" IS NULL;
ALTER TABLE "meetings" ALTER COLUMN "date" SET NOT NULL;

ALTER TABLE "meetings" ADD COLUMN "owner_id" TEXT;

ALTER TABLE "meetings" ADD CONSTRAINT "meetings_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "meetings_owner_id_created_at_idx" ON "meetings"("owner_id", "created_at");
