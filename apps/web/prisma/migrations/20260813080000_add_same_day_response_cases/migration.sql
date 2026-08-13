CREATE TABLE "SameDayResponseCase" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "matterId" TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "sourceMessageId" TEXT NOT NULL,
    "sourceThreadId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "responseDeadlineAt" TIMESTAMP(3) NOT NULL,
    "nextUpdateAt" TIMESTAMP(3),
    "accountableOwner" TEXT NOT NULL,
    "nextAction" TEXT NOT NULL,
    "draftId" TEXT,
    "followUpId" TEXT,
    "responseMessageId" TEXT,
    "respondedAt" TIMESTAMP(3),
    "contract" JSONB NOT NULL,
    "emailAccountId" TEXT NOT NULL,

    CONSTRAINT "SameDayResponseCase_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SameDayResponseCase_emailAccountId_matterId_key"
  ON "SameDayResponseCase"("emailAccountId", "matterId");
CREATE INDEX "SameDayResponseCase_emailAccountId_state_responseDeadlineAt_idx"
  ON "SameDayResponseCase"("emailAccountId", "state", "responseDeadlineAt");
CREATE INDEX "SameDayResponseCase_responseDeadlineAt_state_idx"
  ON "SameDayResponseCase"("responseDeadlineAt", "state");
CREATE INDEX "SameDayResponseCase_respondedAt_idx"
  ON "SameDayResponseCase"("respondedAt");

ALTER TABLE "SameDayResponseCase"
  ADD CONSTRAINT "SameDayResponseCase_emailAccountId_fkey"
  FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
