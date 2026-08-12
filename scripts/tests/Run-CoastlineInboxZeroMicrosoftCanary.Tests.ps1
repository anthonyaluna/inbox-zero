$scriptPath = Join-Path (Split-Path -Parent $PSScriptRoot) "Run-CoastlineInboxZeroMicrosoftCanary.ps1"
$assemblerPath = Join-Path (Split-Path -Parent $PSScriptRoot) "Assemble-CoastlineInboxZeroPromotionCanaryEvidence.ps1"

Describe "Coastline Microsoft canary runner" {
  It "returns nonzero and writes no receipt when prerequisites fail" {
    $testRoot = Join-Path ([IO.Path]::GetTempPath()) "coastline-canary-fail-$([Guid]::NewGuid().ToString('N'))"
    $receiptDirectory = Join-Path $testRoot "receipts"
    New-Item -ItemType Directory -Path $receiptDirectory -Force | Out-Null
    try {
      $escapedScriptPath = $scriptPath.Replace("'", "''")
      $escapedReceiptDirectory = $receiptDirectory.Replace("'", "''")
      $blockedReceiptPath = (Join-Path $receiptDirectory "blocked.json").Replace("'", "''")
      $command = @"
Get-ChildItem Env:COASTLINE_* | Remove-Item -ErrorAction SilentlyContinue
`$env:COASTLINE_MICROSOFT_CANARY_RECEIPT_DIR = '$escapedReceiptDirectory'
& '$escapedScriptPath' -BaseUrl 'https://staging.example.test' -SourceMessageId 'test-message' -TestRecipient 'canary@testing.example' -BlockedReceiptPath '$blockedReceiptPath'
"@
      $output = & pwsh -NoProfile -Command $command 2>&1

      $LASTEXITCODE | Should Be 1
      ($output | Out-String) | Should Match "COASTLINE_CANARY_MISSING_PROTECTED_PREREQUISITE"
      $blocked = Get-Content -LiteralPath (Join-Path $receiptDirectory "blocked.json") -Raw | ConvertFrom-Json
      $blocked.schema_version | Should Be "coastline_inbox_zero_canary_blocked_receipt.v1"
      $blocked.terminal_state | Should Be "blocked"
      $blocked.reason_code | Should Be "COASTLINE_CANARY_MISSING_PROTECTED_PREREQUISITE"
      @($blocked.external_systems_touched).Count | Should Be 0
    } finally {
      Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
  }

  It "rejects a duplicate scope before invoking the protected executor or verifier" {
    $testRoot = Join-Path ([IO.Path]::GetTempPath()) "coastline-canary-scopes-$([Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
    $environment = @{
      COASTLINE_INBOX_ZERO_PROTECTED_SHA = (& git rev-parse HEAD).Trim()
      COASTLINE_STAGING_BASE_URL = "https://staging.example.test"
      COASTLINE_MICROSOFT_CANARY_EXECUTOR_REGISTRATION_PATH = (Join-Path $testRoot "registration.json")
      COASTLINE_MICROSOFT_CANARY_EXECUTOR_REGISTRATION_SHA256 = ("a" * 64)
      COASTLINE_MICROSOFT_CANARY_EXECUTOR_AUTH_TOKEN = "test-auth-token"
      COASTLINE_MICROSOFT_CANARY_MAILBOX = "canary-mailbox@testing.example"
      COASTLINE_MICROSOFT_CANARY_ACCOUNT_ID = "test-account"
      COASTLINE_MICROSOFT_CANARY_THREAD_ID = "test-thread"
      COASTLINE_MICROSOFT_CANARY_SOURCE_MESSAGE_ID = "test-message"
      COASTLINE_MICROSOFT_CANARY_TEST_RECIPIENT = "canary@testing.example"
      COASTLINE_MICROSOFT_CANARY_SCOPE_IDENTITY = "delegated:Mail.ReadWrite,User.Read,email,offline_access,openid,profile"
      COASTLINE_MICROSOFT_CANARY_SCOPES = "openid profile email User.Read offline_access Mail.ReadWrite Mail.ReadWrite"
      COASTLINE_MICROSOFT_CANARY_RECEIPT_DIR = $testRoot
      COASTLINE_DRAFT_PROPOSALS_ENABLED = "true"
      NEXT_PUBLIC_EMAIL_SEND_ENABLED = "false"
    }
    try {
      foreach ($entry in $environment.GetEnumerator()) { Set-Item -Path "Env:$($entry.Key)" -Value $entry.Value }
      $script:restCalls = 0
      function Invoke-RestMethod { $script:restCalls++ }

      $failure = $null
      try { . $scriptPath -BaseUrl $environment.COASTLINE_STAGING_BASE_URL -SourceMessageId $environment.COASTLINE_MICROSOFT_CANARY_SOURCE_MESSAGE_ID -TestRecipient $environment.COASTLINE_MICROSOFT_CANARY_TEST_RECIPIENT } catch { $failure = $_ }

      ($failure | Out-String) | Should Match "COASTLINE_CANARY_MICROSOFT_SCOPES_MISMATCH"
      $script:restCalls | Should Be 0
    } finally {
      Remove-Item Function:Invoke-RestMethod -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
  }

  It "persists a verified receipt when independent no-duplicate evidence attests numeric count one" {
    $testRoot = Join-Path ([IO.Path]::GetTempPath()) "coastline-canary-$([Guid]::NewGuid().ToString('N'))"
    $registrationPath = Join-Path $testRoot "executor-registration.json"
    $receiptDirectory = Join-Path $testRoot "receipts"
    New-Item -ItemType Directory -Path $receiptDirectory -Force | Out-Null

    $baseUrl = "https://staging.example.test"
    $accountId = "test-account"
    $threadId = "test-thread"
    $sourceMessageId = "test-message"
    $mailbox = "canary-mailbox@testing.example"
    $recipient = "canary@testing.example"
    $scopeIdentity = "delegated:Mail.ReadWrite,User.Read,email,offline_access,openid,profile"
    $idempotencyKey = "inbox-zero/draft/test-account/test-thread/test-message"
    $observedAt = [DateTimeOffset]::UtcNow.ToString("o")
    $registration = [ordered]@{
      schemaVersion = "coastline_inbox_zero_microsoft_canary_executor_registration.v1"
      registrationId = "registered-canary-executor"
      executorId = "canary-executor"
      executorUrl = "$baseUrl/api/coastline/microsoft-draft-canary/v1"
      authentication = "bearer"
      provider = "microsoft"
      action = "outlook_draft_create"
      draftOnly = $true
      noSend = $true
      independentVerifierId = "independent-graph-verifier"
      independentVerifierBaseUrl = "https://verifier.example.test"
    }
    $registration | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $registrationPath -Encoding utf8NoBOM
    $registrationHash = (Get-FileHash -LiteralPath $registrationPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $promotionNonce = [Guid]::NewGuid().ToString('N')
    $protectedEnvironmentPath = Join-Path $testRoot "protected-environment.json"
    $stagingEvidencePath = Join-Path $testRoot "staging-evidence.json"
    $rollbackControlPath = Join-Path $testRoot "rollback-control.json"
    @{ schema_version = "coastline_inbox_zero_protected_environment_evidence.v1"; artifact_sha = (& git rev-parse HEAD).Trim(); environment_name = "coastline-inbox-zero-staging"; protected = $true; run_nonce = $promotionNonce; observed_at = $observedAt } | ConvertTo-Json -Compress | Set-Content -LiteralPath $protectedEnvironmentPath -Encoding utf8NoBOM
    @{ schema_version = "coastline_inbox_zero_staging_receipt.v2"; provenance = "remote_https"; is_loopback = $false; run_nonce = $promotionNonce; started_at = $observedAt; completed_at = $observedAt; artifact_sha = (& git rev-parse HEAD).Trim(); worker_artifact_sha = (& git rev-parse HEAD).Trim(); worker_heartbeat_at = $observedAt; remote_worker_identity = "worker-1"; remote_queue_identity = "queue-1"; cron_evidence_id = ("c" * 64); service_states = @{ web = "healthy"; worker = "running"; queue = "reachable"; cron_unauthenticated = "rejected"; cron_authenticated = "verified" }; checks = @(@{ code = "WEB_HEALTH"; status = "pass" }, @{ code = "CRON_UNAUTHENTICATED_REJECTED"; status = "pass" }, @{ code = "CRON_AUTHENTICATED_SUCCESS"; status = "pass" }, @{ code = "REMOTE_ARTIFACT_WORKER_QUEUE"; status = "pass" }); outcome = "pass" } | ConvertTo-Json -Depth 5 -Compress | Set-Content -LiteralPath $stagingEvidencePath -Encoding utf8NoBOM
    @{ schema_version = "coastline_inbox_zero_rollback_control.v1"; artifact_sha = (& git rev-parse HEAD).Trim(); run_nonce = $promotionNonce; prepared_at = $observedAt; terminal_state = "prepared"; disable_draft_proposals = $true; preserve_mailbox_data = $true; rollback_artifact_sha = ("a" * 40) } | ConvertTo-Json -Compress | Set-Content -LiteralPath $rollbackControlPath -Encoding utf8NoBOM
    $mailboxHash = ([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($mailbox)) | ForEach-Object { $_.ToString("x2") }) -join ""
    $recipientHash = ([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($recipient)) | ForEach-Object { $_.ToString("x2") }) -join ""
    $environment = @{
      COASTLINE_INBOX_ZERO_PROTECTED_SHA = (& git rev-parse HEAD).Trim()
      COASTLINE_INBOX_ZERO_PROMOTION_RUN_NONCE = $promotionNonce
      COASTLINE_MICROSOFT_CANARY_PROTECTED_ENV_EVIDENCE_PATH = $protectedEnvironmentPath
      COASTLINE_MICROSOFT_CANARY_PROTECTED_ENV_EVIDENCE_SHA256 = (Get-FileHash -LiteralPath $protectedEnvironmentPath -Algorithm SHA256).Hash.ToLowerInvariant()
      COASTLINE_MICROSOFT_CANARY_STAGING_EVIDENCE_PATH = $stagingEvidencePath
      COASTLINE_MICROSOFT_CANARY_STAGING_EVIDENCE_SHA256 = (Get-FileHash -LiteralPath $stagingEvidencePath -Algorithm SHA256).Hash.ToLowerInvariant()
      COASTLINE_MICROSOFT_CANARY_ROLLBACK_CONTROL_PATH = $rollbackControlPath
      COASTLINE_MICROSOFT_CANARY_ROLLBACK_CONTROL_SHA256 = (Get-FileHash -LiteralPath $rollbackControlPath -Algorithm SHA256).Hash.ToLowerInvariant()
      COASTLINE_STAGING_BASE_URL = $baseUrl
      COASTLINE_MICROSOFT_CANARY_EXECUTOR_REGISTRATION_PATH = $registrationPath
      COASTLINE_MICROSOFT_CANARY_EXECUTOR_REGISTRATION_SHA256 = $registrationHash
      COASTLINE_MICROSOFT_CANARY_EXECUTOR_AUTH_TOKEN = "test-auth-token"
      COASTLINE_MICROSOFT_CANARY_MAILBOX = $mailbox
      COASTLINE_MICROSOFT_CANARY_ACCOUNT_ID = $accountId
      COASTLINE_MICROSOFT_CANARY_THREAD_ID = $threadId
      COASTLINE_MICROSOFT_CANARY_SOURCE_MESSAGE_ID = $sourceMessageId
      COASTLINE_MICROSOFT_CANARY_TEST_RECIPIENT = $recipient
      COASTLINE_MICROSOFT_CANARY_SCOPE_IDENTITY = $scopeIdentity
      COASTLINE_MICROSOFT_CANARY_SCOPES = "openid profile email User.Read offline_access Mail.ReadWrite"
      COASTLINE_MICROSOFT_CANARY_RECEIPT_DIR = $receiptDirectory
      COASTLINE_DRAFT_PROPOSALS_ENABLED = "true"
      NEXT_PUBLIC_EMAIL_SEND_ENABLED = "false"
    }

    try {
      $script:canaryCount = 1
      foreach ($entry in $environment.GetEnumerator()) { Set-Item -Path "Env:$($entry.Key)" -Value $entry.Value }
      function Invoke-RestMethod {
        param($Uri, $Method, $Headers, $ContentType, $Body, $TimeoutSec)
        $script:restCalls++
        if ($Method -eq "Post") {
          $request = $Body | ConvertFrom-Json
          $script:runNonce = $request.runNonce
          return [pscustomobject]@{
            schemaVersion = "inbox_zero_microsoft_canary_receipt.v1"; provider = "microsoft"; action = "draft_only"; accountId = $accountId; threadId = $threadId; sourceMessageId = $sourceMessageId; draftId = "draft-001"; idempotencyKey = $idempotencyKey; runNonce = $script:runNonce; graphReadbackStatus = "verified"; scopeIdentity = $scopeIdentity; noSendCapability = "Mail.Send_absent"; idempotencyReplay = "existing_draft_reconciled"; terminalState = "created_verified"; generatedAt = $observedAt; executorRegistrationId = "registered-canary-executor"; executorProvenanceSha256 = $registrationHash; connectedIdentityEvidenceId = "identity-evidence"; grantedScopesEvidenceId = "scopes-evidence"; noSendEvidenceId = "no-send-evidence"; graphReadbackEvidenceId = "graph-evidence"; replayGraphReadbackEvidenceId = "replay-evidence"; noDuplicateEvidenceId = "unique-evidence"; idempotencyDraftCount = $script:canaryCount
          }
        }
        $query = [Web.HttpUtility]::ParseQueryString(([Uri]$Uri).Query)
        $script:runNonce = $query["runNonce"]
        $kind = ([Uri]$Uri).AbsolutePath.TrimEnd("/").Split("/")[-1]
        $evidenceId = @{ identity = "identity-evidence"; scopes = "scopes-evidence"; "no-send" = "no-send-evidence"; "graph-readback" = "graph-evidence"; "idempotency-replay" = "replay-evidence"; "no-duplicate" = "unique-evidence" }[$kind]
        return [pscustomobject]@{ schemaVersion = "coastline_microsoft_canary_evidence.v1"; kind = $kind; evidenceId = $evidenceId; verifierId = "independent-graph-verifier"; verifiedAt = $observedAt; verified = $true; accountId = $accountId; mailboxSha256 = $mailboxHash; sourceMessageId = $sourceMessageId; threadId = $threadId; draftId = "draft-001"; scopeIdentity = $scopeIdentity; mailSendCapability = "absent"; recipientSha256 = $recipientHash; idempotencyKey = $idempotencyKey; runNonce = $script:runNonce; idempotencyDraftCount = if ($kind -eq "no-duplicate") { 1 } else { $null } }
      }

      $output = . $scriptPath -BaseUrl $baseUrl -SourceMessageId $sourceMessageId -TestRecipient $recipient
      $receiptPath = Get-ChildItem -LiteralPath $receiptDirectory -Filter "inbox-zero-microsoft-canary-*.json" | Select-Object -First 1 -ExpandProperty FullName
      $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
      $receipt.idempotencyDraftCount | Should Be 1
      @(Get-ChildItem -LiteralPath $receiptDirectory -Filter "inbox-zero-runner-provenance-*.json").Count | Should Be 1
      @(Get-ChildItem -LiteralPath $receiptDirectory -Filter "inbox-zero-dedicated-mailbox-*.json").Count | Should Be 1
      @(Get-ChildItem -LiteralPath $receiptDirectory -Filter "inbox-zero-replay-evidence-*.json").Count | Should Be 1
      $bundlePath = Join-Path $testRoot "promotion-bundle.json"
      & $assemblerPath -ExpectedSha (& git rev-parse HEAD).Trim() -RemoteStagingReceiptPath $stagingEvidencePath -RunnerProvenancePath (Get-ChildItem -LiteralPath $receiptDirectory -Filter "inbox-zero-runner-provenance-*.json" | Select-Object -First 1 -ExpandProperty FullName) -DedicatedMailboxEvidencePath (Get-ChildItem -LiteralPath $receiptDirectory -Filter "inbox-zero-dedicated-mailbox-*.json" | Select-Object -First 1 -ExpandProperty FullName) -CanaryReceiptPath $receiptPath -ReplayReceiptPath (Get-ChildItem -LiteralPath $receiptDirectory -Filter "inbox-zero-replay-evidence-*.json" | Select-Object -First 1 -ExpandProperty FullName) -OutputPath $bundlePath | Out-Null
      (Get-Content -LiteralPath $bundlePath -Raw | ConvertFrom-Json).schema_version | Should Be "coastline_inbox_zero_promotion_canary_evidence.v1"
      ($output | Out-String) | Should Not Match "COASTLINE_CANARY_RECEIPT_INVALID"

      Get-ChildItem -LiteralPath $receiptDirectory -Filter "*.json" | Remove-Item -Force
      $stagingEvidence = Get-Content -LiteralPath $stagingEvidencePath -Raw | ConvertFrom-Json
      $stagingEvidence.checks = @()
      $stagingEvidence | ConvertTo-Json -Depth 5 -Compress | Set-Content -LiteralPath $stagingEvidencePath -Encoding utf8NoBOM
      $environment.COASTLINE_MICROSOFT_CANARY_STAGING_EVIDENCE_SHA256 = (Get-FileHash -LiteralPath $stagingEvidencePath -Algorithm SHA256).Hash.ToLowerInvariant()
      Set-Item -Path Env:COASTLINE_MICROSOFT_CANARY_STAGING_EVIDENCE_SHA256 -Value $environment.COASTLINE_MICROSOFT_CANARY_STAGING_EVIDENCE_SHA256
      $script:canaryCount = "1"
      try {
        $failedOutput = . $scriptPath -BaseUrl $baseUrl -SourceMessageId $sourceMessageId -TestRecipient $recipient 2>&1
      } catch {
        $failedOutput = $_
      }
      ($failedOutput | Out-String) | Should Match "COASTLINE_CANARY_STAGING_EVIDENCE_INVALID"
      @(Get-ChildItem -LiteralPath $receiptDirectory -Filter "*.json").Count | Should Be 0

      $stagingEvidence.checks = @(@{ code = "WEB_HEALTH"; status = "pass" }, @{ code = "CRON_UNAUTHENTICATED_REJECTED"; status = "pass" }, @{ code = "CRON_AUTHENTICATED_SUCCESS"; status = "pass" }, @{ code = "REMOTE_ARTIFACT_WORKER_QUEUE"; status = "pass" })
      $stagingEvidence.worker_heartbeat_at = ([DateTimeOffset]::UtcNow.AddMinutes(1)).ToString("o")
      $stagingEvidence | ConvertTo-Json -Depth 5 -Compress | Set-Content -LiteralPath $stagingEvidencePath -Encoding utf8NoBOM
      $environment.COASTLINE_MICROSOFT_CANARY_STAGING_EVIDENCE_SHA256 = (Get-FileHash -LiteralPath $stagingEvidencePath -Algorithm SHA256).Hash.ToLowerInvariant()
      Set-Item -Path Env:COASTLINE_MICROSOFT_CANARY_STAGING_EVIDENCE_SHA256 -Value $environment.COASTLINE_MICROSOFT_CANARY_STAGING_EVIDENCE_SHA256
      $script:restCalls = 0
      try {
        $timestampFailure = . $scriptPath -BaseUrl $baseUrl -SourceMessageId $sourceMessageId -TestRecipient $recipient 2>&1
      } catch {
        $timestampFailure = $_
      }
      ($timestampFailure | Out-String) | Should Match "COASTLINE_CANARY_STAGING_EVIDENCE_INVALID"
      $script:restCalls | Should Be 0
    } finally {
      Remove-Item Function:Invoke-RestMethod -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
  }

  It "rejects a protected SHA that does not match the current checkout before any remote call" {
    $testRoot = Join-Path ([IO.Path]::GetTempPath()) "coastline-canary-sha-$([Guid]::NewGuid().ToString('N'))"
    $blockedReceiptPath = Join-Path $testRoot "blocked.json"
    New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
    $environment = @{
      COASTLINE_INBOX_ZERO_PROTECTED_SHA = "f" * 40
      COASTLINE_STAGING_BASE_URL = "https://staging.example.test"
      COASTLINE_MICROSOFT_CANARY_EXECUTOR_REGISTRATION_PATH = (Join-Path $testRoot "registration.json")
      COASTLINE_MICROSOFT_CANARY_EXECUTOR_REGISTRATION_SHA256 = ("a" * 64)
      COASTLINE_MICROSOFT_CANARY_EXECUTOR_AUTH_TOKEN = "test-auth-token"
      COASTLINE_MICROSOFT_CANARY_MAILBOX = "canary-mailbox@testing.example"
      COASTLINE_MICROSOFT_CANARY_ACCOUNT_ID = "test-account"
      COASTLINE_MICROSOFT_CANARY_THREAD_ID = "test-thread"
      COASTLINE_MICROSOFT_CANARY_SOURCE_MESSAGE_ID = "test-message"
      COASTLINE_MICROSOFT_CANARY_TEST_RECIPIENT = "canary@testing.example"
      COASTLINE_MICROSOFT_CANARY_SCOPE_IDENTITY = "delegated:Mail.ReadWrite,User.Read,email,offline_access,openid,profile"
      COASTLINE_MICROSOFT_CANARY_SCOPES = "openid profile email User.Read offline_access Mail.ReadWrite"
      COASTLINE_MICROSOFT_CANARY_RECEIPT_DIR = $testRoot
      COASTLINE_DRAFT_PROPOSALS_ENABLED = "true"
      NEXT_PUBLIC_EMAIL_SEND_ENABLED = "false"
    }
    try {
      foreach ($entry in $environment.GetEnumerator()) { Set-Item -Path "Env:$($entry.Key)" -Value $entry.Value }
      $script:restCalls = 0
      function Invoke-RestMethod { $script:restCalls++ }

      $failure = $null
      try { . $scriptPath -BaseUrl $environment.COASTLINE_STAGING_BASE_URL -SourceMessageId $environment.COASTLINE_MICROSOFT_CANARY_SOURCE_MESSAGE_ID -TestRecipient $environment.COASTLINE_MICROSOFT_CANARY_TEST_RECIPIENT -BlockedReceiptPath $blockedReceiptPath } catch { $failure = $_ }

      ($failure | Out-String) | Should Match "COASTLINE_CANARY_PROTECTED_SHA_MISMATCH"
      $script:restCalls | Should Be 0
      $blocked = Get-Content -LiteralPath $blockedReceiptPath -Raw | ConvertFrom-Json
      $blocked.reason_code | Should Be "COASTLINE_CANARY_PROTECTED_SHA_MISMATCH"
    } finally {
      Remove-Item Function:Invoke-RestMethod -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
  }

  It "records the independent verifier category when a post-contact verifier call fails" {
    $testRoot = Join-Path ([IO.Path]::GetTempPath()) "coastline-canary-contact-$([Guid]::NewGuid().ToString('N'))"
    $receiptDirectory = Join-Path $testRoot "receipts"
    New-Item -ItemType Directory -Path $receiptDirectory -Force | Out-Null
    $blockedReceiptPath = Join-Path $receiptDirectory "blocked.json"
    try {
      # This fixture intentionally has all pre-contact evidence. The verifier mock
      # then fails, proving the receipt cannot claim zero external contact.
      $registrationPath = Join-Path $testRoot "registration.json"
      $registration = @{ schemaVersion = "coastline_inbox_zero_microsoft_canary_executor_registration.v1"; registrationId = "registered"; executorId = "executor"; executorUrl = "https://staging.example.test/api/coastline/microsoft-draft-canary/v1"; authentication = "bearer"; provider = "microsoft"; action = "outlook_draft_create"; draftOnly = $true; noSend = $true; independentVerifierId = "verifier"; independentVerifierBaseUrl = "https://verifier.example.test" }
      $registration | ConvertTo-Json -Compress | Set-Content -LiteralPath $registrationPath -Encoding utf8NoBOM
      $sha = (& git rev-parse HEAD).Trim(); $nonce = [Guid]::NewGuid().ToString('N'); $now = [DateTimeOffset]::UtcNow.ToString('o')
      $protectedPath = Join-Path $testRoot "protected.json"; @{ schema_version = "coastline_inbox_zero_protected_environment_evidence.v1"; artifact_sha = $sha; environment_name = "coastline-inbox-zero-staging"; protected = $true; run_nonce = $nonce; observed_at = $now } | ConvertTo-Json -Compress | Set-Content $protectedPath -Encoding utf8NoBOM
      $stagingPath = Join-Path $testRoot "staging.json"; @{ schema_version = "coastline_inbox_zero_staging_receipt.v2"; provenance = "remote_https"; is_loopback = $false; run_nonce = $nonce; started_at = $now; completed_at = $now; artifact_sha = $sha; worker_artifact_sha = $sha; worker_heartbeat_at = $now; remote_worker_identity = "worker"; remote_queue_identity = "queue"; cron_evidence_id = ("c" * 64); service_states = @{ web = "healthy"; worker = "running"; queue = "reachable"; cron_unauthenticated = "rejected"; cron_authenticated = "verified" }; checks = @(@{ code = "WEB_HEALTH"; status = "pass" }, @{ code = "CRON_UNAUTHENTICATED_REJECTED"; status = "pass" }, @{ code = "CRON_AUTHENTICATED_SUCCESS"; status = "pass" }, @{ code = "REMOTE_ARTIFACT_WORKER_QUEUE"; status = "pass" }); outcome = "pass" } | ConvertTo-Json -Depth 5 -Compress | Set-Content $stagingPath -Encoding utf8NoBOM
      $rollbackPath = Join-Path $testRoot "rollback.json"; @{ schema_version = "coastline_inbox_zero_rollback_control.v1"; artifact_sha = $sha; run_nonce = $nonce; prepared_at = $now; terminal_state = "prepared"; disable_draft_proposals = $true; preserve_mailbox_data = $true; rollback_artifact_sha = ("a" * 40) } | ConvertTo-Json -Compress | Set-Content $rollbackPath -Encoding utf8NoBOM
      $environment = @{ COASTLINE_INBOX_ZERO_PROTECTED_SHA = $sha; COASTLINE_INBOX_ZERO_PROMOTION_RUN_NONCE = $nonce; COASTLINE_STAGING_BASE_URL = "https://staging.example.test"; COASTLINE_MICROSOFT_CANARY_EXECUTOR_REGISTRATION_PATH = $registrationPath; COASTLINE_MICROSOFT_CANARY_EXECUTOR_REGISTRATION_SHA256 = (Get-FileHash $registrationPath -Algorithm SHA256).Hash.ToLowerInvariant(); COASTLINE_MICROSOFT_CANARY_EXECUTOR_AUTH_TOKEN = "test-auth-token"; COASTLINE_MICROSOFT_CANARY_MAILBOX = "canary-mailbox@testing.example"; COASTLINE_MICROSOFT_CANARY_ACCOUNT_ID = "test-account"; COASTLINE_MICROSOFT_CANARY_THREAD_ID = "test-thread"; COASTLINE_MICROSOFT_CANARY_SOURCE_MESSAGE_ID = "test-message"; COASTLINE_MICROSOFT_CANARY_TEST_RECIPIENT = "canary@testing.example"; COASTLINE_MICROSOFT_CANARY_SCOPE_IDENTITY = "delegated:Mail.ReadWrite,User.Read,email,offline_access,openid,profile"; COASTLINE_MICROSOFT_CANARY_SCOPES = "openid profile email User.Read offline_access Mail.ReadWrite"; COASTLINE_MICROSOFT_CANARY_RECEIPT_DIR = $receiptDirectory; COASTLINE_DRAFT_PROPOSALS_ENABLED = "true"; NEXT_PUBLIC_EMAIL_SEND_ENABLED = "false"; COASTLINE_MICROSOFT_CANARY_PROTECTED_ENV_EVIDENCE_PATH = $protectedPath; COASTLINE_MICROSOFT_CANARY_PROTECTED_ENV_EVIDENCE_SHA256 = (Get-FileHash $protectedPath -Algorithm SHA256).Hash.ToLowerInvariant(); COASTLINE_MICROSOFT_CANARY_STAGING_EVIDENCE_PATH = $stagingPath; COASTLINE_MICROSOFT_CANARY_STAGING_EVIDENCE_SHA256 = (Get-FileHash $stagingPath -Algorithm SHA256).Hash.ToLowerInvariant(); COASTLINE_MICROSOFT_CANARY_ROLLBACK_CONTROL_PATH = $rollbackPath; COASTLINE_MICROSOFT_CANARY_ROLLBACK_CONTROL_SHA256 = (Get-FileHash $rollbackPath -Algorithm SHA256).Hash.ToLowerInvariant() }
      foreach ($entry in $environment.GetEnumerator()) { Set-Item -Path "Env:$($entry.Key)" -Value $entry.Value }
      function Invoke-RestMethod { throw "mock verifier failure" }
      try { . $scriptPath -BaseUrl "https://staging.example.test" -SourceMessageId "test-message" -TestRecipient "canary@testing.example" -BlockedReceiptPath $blockedReceiptPath } catch { }
      $blocked = Get-Content -LiteralPath $blockedReceiptPath -Raw | ConvertFrom-Json
      (@($blocked.external_systems_touched) -join ",") | Should Match "(^|,)independent_verifier(,|$)"
    } finally {
      Remove-Item Function:Invoke-RestMethod -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}
