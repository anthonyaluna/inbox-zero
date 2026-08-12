CREATE TYPE "CoastlineCalendarInvitationReservationState" AS ENUM ('reserved', 'created_verified', 'recovery_required');

CREATE TABLE "CoastlineCalendarInvitationReservation" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "accountId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "sourceMessageId" TEXT NOT NULL,
    "proposalFingerprint" TEXT NOT NULL,
    "providerEventId" TEXT,
    "providerCalendarId" TEXT,
    "providerConnectionId" TEXT,
    "terminalState" "CoastlineCalendarInvitationReservationState" NOT NULL DEFAULT 'reserved',
    "recoverableErrorCode" TEXT,
    CONSTRAINT "CoastlineCalendarInvitationReservation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CoastlineCalendarInvitationReservation_accountId_idempotencyKey_key" ON "CoastlineCalendarInvitationReservation"("accountId", "idempotencyKey");
CREATE INDEX "CoastlineCalendarInvitationReservation_providerEventId_idx" ON "CoastlineCalendarInvitationReservation"("providerEventId");
CREATE INDEX "CoastlineCalendarInvitationReservation_terminalState_idx" ON "CoastlineCalendarInvitationReservation"("terminalState");
