ALTER TABLE "CoastlineCalendarInvitationReservation"
    ADD COLUMN "creationClaimId" TEXT,
    ADD COLUMN "creationClaimExpiresAt" TIMESTAMP(3);

CREATE INDEX "CoastlineCalendarInvitationReservation_creationClaimExpiresAt_idx"
    ON "CoastlineCalendarInvitationReservation"("creationClaimExpiresAt");
