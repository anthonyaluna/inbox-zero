CREATE TYPE "CoastlineDraftReservationState" AS ENUM ('reserved', 'created_unverified', 'created_verified', 'recovery_required');

CREATE TABLE "CoastlineDraftReservation" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "accountId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "sourceMessageId" TEXT NOT NULL,
    "proposalFingerprint" TEXT NOT NULL,
    "executedActionId" TEXT,
    "creationClaimId" TEXT,
    "draftId" TEXT,
    "terminalState" "CoastlineDraftReservationState" NOT NULL DEFAULT 'reserved',
    "recoverableErrorCode" TEXT,
    CONSTRAINT "CoastlineDraftReservation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CoastlineDraftReservation_accountId_idempotencyKey_key" ON "CoastlineDraftReservation"("accountId", "idempotencyKey");
CREATE UNIQUE INDEX "CoastlineDraftReservation_executedActionId_key" ON "CoastlineDraftReservation"("executedActionId");
CREATE INDEX "CoastlineDraftReservation_draftId_idx" ON "CoastlineDraftReservation"("draftId");
CREATE INDEX "CoastlineDraftReservation_terminalState_idx" ON "CoastlineDraftReservation"("terminalState");
ALTER TABLE "CoastlineDraftReservation" ADD CONSTRAINT "CoastlineDraftReservation_executedActionId_fkey" FOREIGN KEY ("executedActionId") REFERENCES "ExecutedAction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
