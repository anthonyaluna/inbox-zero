$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$scriptPath = Join-Path $repoRoot "scripts/Assemble-CoastlineInboxZeroPromotionCanaryEvidence.ps1"

Describe "Coastline Inbox Zero promotion canary evidence assembler" {
  It "assembles the exact readiness bundle from verified, sanitized component receipts" {
    $testRoot = Join-Path ([IO.Path]::GetTempPath()) "coastline-canary-assembler-$([Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
    try {
      $sha = (& git -C $repoRoot rev-parse HEAD).Trim()
      $nonce = [Guid]::NewGuid().ToString('N')
      $runId = "canary-run-001"
      $now = [DateTimeOffset]::UtcNow
      $stagingPath = Join-Path $testRoot "staging.json"
      $runnerPath = Join-Path $testRoot "runner.json"
      $mailboxPath = Join-Path $testRoot "mailbox.json"
      $canaryPath = Join-Path $testRoot "canary.json"
      $replayPath = Join-Path $testRoot "replay.json"
      $outputPath = Join-Path $testRoot "bundle.json"

      [ordered]@{
        schema_version = "coastline_inbox_zero_staging_receipt.v2"; provenance = "remote_https"; is_loopback = $false; run_nonce = $nonce
        started_at = $now.AddMinutes(-2).ToString("o"); completed_at = $now.AddMinutes(-1).ToString("o"); artifact_sha = $sha; worker_artifact_sha = $sha; worker_heartbeat_at = $now.AddMinutes(-1).ToString("o")
        remote_worker_identity = "bull:YXV0b21hdGlvbi1qb2Jz:w:worker-1"; remote_queue_identity = "bullmq:automation-jobs"; cron_evidence_id = ("a" * 64)
        service_states = [ordered]@{ web = "healthy"; worker = "running"; queue = "reachable"; cron_unauthenticated = "rejected"; cron_authenticated = "verified" }
        checks = @(@{ code = "WEB_HEALTH"; status = "pass" }, @{ code = "CRON_UNAUTHENTICATED_REJECTED"; status = "pass" }, @{ code = "CRON_AUTHENTICATED_SUCCESS"; status = "pass" }, @{ code = "REMOTE_ARTIFACT_WORKER_QUEUE"; status = "pass" }); outcome = "pass"
      } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $stagingPath -Encoding utf8NoBOM
      [ordered]@{ schema_version = "coastline_inbox_zero_canary_runner_provenance.v1"; artifact_sha = $sha; run_id = $runId; run_nonce = $nonce; executor_registration_id = "registered-canary-executor"; executor_registration_sha256 = ("b" * 64); executor_id = "canary-executor"; verifier_id = "independent-graph-verifier" } | ConvertTo-Json | Set-Content -LiteralPath $runnerPath -Encoding utf8NoBOM
      [ordered]@{ schema_version = "coastline_inbox_zero_dedicated_mailbox_evidence.v1"; artifact_sha = $sha; run_id = $runId; run_nonce = $nonce; verified_at = $now.ToString("o"); environment = "staging"; mailbox_identity_sha256 = ("c" * 64); account_id = "test-account"; identity_evidence_id = "identity-evidence"; mailbox_purpose = "dedicated_non_production_canary"; is_shared_mailbox = $false; is_production_mailbox = $false } | ConvertTo-Json | Set-Content -LiteralPath $mailboxPath -Encoding utf8NoBOM
      [ordered]@{ schemaVersion = "inbox_zero_microsoft_canary_receipt.v1"; provider = "microsoft"; action = "draft_only"; accountId = "test-account"; threadId = "test-thread"; sourceMessageId = "test-message"; draftId = "draft-001"; idempotencyKey = "inbox-zero/draft/test-account/test-thread/test-message"; runNonce = $nonce; graphReadbackStatus = "verified"; scopeIdentity = "delegated:Calendars.ReadWrite,Mail.ReadWrite,User.Read,email,offline_access,openid,profile"; noSendCapability = "Mail.Send_absent"; idempotencyReplay = "existing_draft_reconciled"; terminalState = "created_verified"; generatedAt = $now.AddSeconds(5).ToString("o"); executorRegistrationId = "registered-canary-executor"; executorProvenanceSha256 = ("b" * 64); connectedIdentityEvidenceId = "identity-evidence"; grantedScopesEvidenceId = "scopes-evidence"; noSendEvidenceId = "no-send-evidence"; graphReadbackEvidenceId = "graph-evidence"; replayGraphReadbackEvidenceId = "replay-evidence"; noDuplicateEvidenceId = "unique-evidence"; idempotencyDraftCount = 1 } | ConvertTo-Json | Set-Content -LiteralPath $canaryPath -Encoding utf8NoBOM
      [ordered]@{ schema_version = "coastline_inbox_zero_replay_evidence.v1"; artifact_sha = $sha; run_id = $runId; run_nonce = $nonce; verified_at = $now.AddSeconds(10).ToString("o"); terminal_state = "created_verified"; idempotency_key = "inbox-zero/draft/test-account/test-thread/test-message"; draft_id = "draft-001"; idempotency_replay = "existing_draft_reconciled"; replay_graph_readback_evidence_id = "replay-evidence"; no_duplicate_evidence_id = "unique-evidence"; idempotency_draft_count = 1 } | ConvertTo-Json | Set-Content -LiteralPath $replayPath -Encoding utf8NoBOM

      & $scriptPath -ExpectedSha $sha -RemoteStagingReceiptPath $stagingPath -RunnerProvenancePath $runnerPath -DedicatedMailboxEvidencePath $mailboxPath -CanaryReceiptPath $canaryPath -ReplayReceiptPath $replayPath -OutputPath $outputPath
      $bundle = Get-Content -LiteralPath $outputPath -Raw | ConvertFrom-Json
      @($bundle.PSObject.Properties.Name | Sort-Object) | Should Be @("artifact_sha", "canary", "completed_at", "dedicated_mailbox", "replay", "run_id", "run_nonce", "runner_provenance", "schema_version", "started_at")
      $bundle.schema_version | Should Be "coastline_inbox_zero_promotion_canary_evidence.v1"
      $bundle.canary.draftId | Should Be "draft-001"
      $bundle.replay.idempotency_draft_count | Should Be 1

      $validMailboxJson = Get-Content -LiteralPath $mailboxPath -Raw
      foreach ($invalidClassification in @(
        @{ property = "mailbox_purpose"; value = "production_operations" },
        @{ property = "is_shared_mailbox"; value = $true },
        @{ property = "is_production_mailbox"; value = $true }
      )) {
        Remove-Item -LiteralPath $outputPath -Force -ErrorAction SilentlyContinue
        $invalidMailbox = $validMailboxJson | ConvertFrom-Json
        $invalidMailbox.PSObject.Properties[$invalidClassification.property].Value = $invalidClassification.value
        $invalidMailbox | ConvertTo-Json | Set-Content -LiteralPath $mailboxPath -Encoding utf8NoBOM
        $failure = $null
        try {
          & $scriptPath -ExpectedSha $sha -RemoteStagingReceiptPath $stagingPath -RunnerProvenancePath $runnerPath -DedicatedMailboxEvidencePath $mailboxPath -CanaryReceiptPath $canaryPath -ReplayReceiptPath $replayPath -OutputPath $outputPath | Out-Null
        } catch {
          $failure = $_
        }
        ($failure | Out-String) | Should Match "COASTLINE_CANARY_ASSEMBLY_INVALID"
        Test-Path -LiteralPath $outputPath | Should Be $false
      }
    } finally {
      Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}
