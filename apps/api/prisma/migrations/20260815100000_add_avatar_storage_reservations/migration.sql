CREATE TABLE "avatar_storage_reservations" (
  "storage_key" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "avatar_storage_reservations_pkey" PRIMARY KEY ("storage_key")
);

CREATE INDEX "avatar_storage_reservations_created_at_idx"
  ON "avatar_storage_reservations"("created_at");
