$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$scriptPath = Join-Path $repoRoot "scripts/Assert-CoastlineInboxZeroReadiness.ps1"
$readinessPath = Join-Path $repoRoot "docs/operations/inbox-zero-operational-readiness.md"
$contractPath = Join-Path $repoRoot "docs/operations/inbox-zero-promotion-evidence-contract.md"
$pilotPath = Join-Path $repoRoot "docs/hosting/coastline-draft-only-pilot.mdx"
$currentSha = (& git -C $repoRoot rev-parse HEAD).Trim()

function Write-TestJson {
  param([string]$Path, [object]$Value)
  $Value | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $Path -Encoding utf8NoBOM
}

function New-CompleteReadinessEvidence {
  param([string]$Root, [string]$Sha)
  $now = [DateTimeOffset]::UtcNow
  $runId = "promotion-run-1234567890"
  $runNonce = "0123456789abcdef0123456789abcdef"
  $draftId = "draft-001"
  $idempotencyKey = "inbox-zero/draft/account-001/thread-001/message-001"
  $registrationHash = "a" * 64
  $paths = [ordered]@{
    local = Join-Path $Root "local-validation.json"
    environment = Join-Path $Root "protected-environment.json"
    staging = Join-Path $Root "remote-staging.json"
    canary = Join-Path $Root "microsoft-canary-evidence.json"
    rollback = Join-Path $Root "rollback.json"
    review = Join-Path $Root "pr-review.json"
  }
  Write-TestJson $paths.local ([ordered]@{
    schema_version = "coastline_inbox_zero_local_validation_receipt.v1"
    commit_sha = $Sha
    results = [ordered]@{
      build = [ordered]@{ command = "pnpm.cmd --filter inbox-zero-ai run build:ci"; outcome = "pass" }
      full_test = [ordered]@{ command = "pnpm.cmd --filter inbox-zero-ai test -- --run"; outcome = "pass"; test_files_passed = 561; test_files_skipped = 106; tests_passed = 5132; tests_skipped = 321 }
      integration = [ordered]@{ command = "pnpm.cmd --filter inbox-zero-ai test-integration"; outcome = "pass"; test_files_passed = 21; tests_passed = 125 }
      pester = [ordered]@{ command = "Invoke-Pester -Script scripts/tests -PassThru"; outcome = "pass"; tests_passed = 25 }
      check_server_actions = [ordered]@{ command = "pnpm.cmd --filter inbox-zero-ai run check-server-actions"; outcome = "pass" }
      check_client_redirects = [ordered]@{ command = "pnpm.cmd --filter inbox-zero-ai run check-client-redirects"; outcome = "pass" }
      check_test_fixtures = [ordered]@{ command = "pnpm.cmd --filter inbox-zero-ai run check-test-fixtures"; outcome = "pass" }
    }
  })
  Write-TestJson $paths.environment ([ordered]@{
    schema_version = "coastline_inbox_zero_protected_environment_receipt.v1"
    commit_sha = $Sha
    environment = "coastline-inbox-zero-staging"
    deployment_branch_rule = "refs/heads/main"
    protected_sha = $Sha
    required_reviewers = @("staging-reviewer")
    prevent_self_review = $true
    configured_secret_names = @(
      "COASTLINE_INBOX_ZERO_STAGING_DATABASE_URL", "COASTLINE_INBOX_ZERO_STAGING_AUTH_SECRET",
      "COASTLINE_INBOX_ZERO_STAGING_MICROSOFT_CLIENT_ID", "COASTLINE_INBOX_ZERO_STAGING_MICROSOFT_CLIENT_SECRET",
      "COASTLINE_INBOX_ZERO_STAGING_CRON_SECRET"
    )
    configured_variable_names = @(
      "COASTLINE_INBOX_ZERO_STAGING_BASE_URL", "COASTLINE_INBOX_ZERO_STAGING_MICROSOFT_EMULATOR_URL",
      "COASTLINE_INBOX_ZERO_PROTECTED_SHA"
    )
  })
  Write-TestJson $paths.staging ([ordered]@{
    schema_version = "coastline_inbox_zero_staging_receipt.v2"
    provenance = "remote_https"
    is_loopback = $false
    run_nonce = $runNonce
    started_at = $now.AddMinutes(-5).ToString("o")
    completed_at = $now.AddMinutes(-4).ToString("o")
    artifact_sha = $Sha
    remote_worker_identity = "bull:aW5ib3gtemVybw"
    remote_queue_identity = "inbox-zero"
    cron_evidence_id = "b" * 64
    service_states = [ordered]@{ web = "healthy"; worker = "running"; queue = "reachable"; cron_unauthenticated = "rejected"; cron_authenticated = "verified" }
    checks = @(
      [ordered]@{ code = "WEB_HEALTH"; status = "pass" },
      [ordered]@{ code = "CRON_UNAUTHENTICATED_REJECTED"; status = "pass" },
      [ordered]@{ code = "CRON_AUTHENTICATED_SUCCESS"; status = "pass" },
      [ordered]@{ code = "REMOTE_ARTIFACT_WORKER_QUEUE"; status = "pass" }
    )
    outcome = "pass"
  })
  Write-TestJson $paths.canary ([ordered]@{
    schema_version = "coastline_inbox_zero_promotion_canary_evidence.v1"
    artifact_sha = $Sha
    run_id = $runId
    run_nonce = $runNonce
    started_at = $now.AddMinutes(-4).ToString("o")
    completed_at = $now.AddMinutes(-1).ToString("o")
    runner_provenance = [ordered]@{
      schema_version = "coastline_inbox_zero_canary_runner_provenance.v1"
      artifact_sha = $Sha
      run_id = $runId
      run_nonce = $runNonce
      executor_registration_id = "registered-canary-executor"
      executor_registration_sha256 = $registrationHash
      executor_id = "canary-executor"
      verifier_id = "independent-graph-verifier"
    }
    dedicated_mailbox = [ordered]@{
      schema_version = "coastline_inbox_zero_dedicated_mailbox_evidence.v1"
      artifact_sha = $Sha
      run_id = $runId
      run_nonce = $runNonce
      verified_at = $now.AddMinutes(-3).ToString("o")
      environment = "staging"
      mailbox_identity_sha256 = "c" * 64
      account_id = "account-001"
      identity_evidence_id = "identity-evidence-001"
      mailbox_purpose = "dedicated_non_production_canary"
      is_shared_mailbox = $false
      is_production_mailbox = $false
    }
    canary = [ordered]@{
      schemaVersion = "inbox_zero_microsoft_canary_receipt.v1"
      provider = "microsoft"
      action = "draft_only"
      accountId = "account-001"
      threadId = "thread-001"
      sourceMessageId = "message-001"
      draftId = $draftId
      idempotencyKey = $idempotencyKey
      runNonce = $runNonce
      graphReadbackStatus = "verified"
      scopeIdentity = "delegated:Mail.ReadWrite,User.Read,email,offline_access,openid,profile"
      noSendCapability = "Mail.Send_absent"
      idempotencyReplay = "existing_draft_reconciled"
      terminalState = "created_verified"
      generatedAt = $now.AddMinutes(-2).ToString("o")
      executorRegistrationId = "registered-canary-executor"
      executorProvenanceSha256 = $registrationHash
      connectedIdentityEvidenceId = "identity-evidence-001"
      grantedScopesEvidenceId = "scopes-evidence-001"
      noSendEvidenceId = "no-send-evidence-001"
      graphReadbackEvidenceId = "graph-evidence-001"
      replayGraphReadbackEvidenceId = "replay-evidence-001"
      noDuplicateEvidenceId = "no-duplicate-evidence-001"
      idempotencyDraftCount = 1
    }
    replay = [ordered]@{
      schema_version = "coastline_inbox_zero_replay_evidence.v1"
      artifact_sha = $Sha
      run_id = $runId
      run_nonce = $runNonce
      verified_at = $now.AddMinutes(-1).ToString("o")
      terminal_state = "created_verified"
      idempotency_key = $idempotencyKey
      draft_id = $draftId
      idempotency_replay = "existing_draft_reconciled"
      replay_graph_readback_evidence_id = "replay-evidence-001"
      no_duplicate_evidence_id = "no-duplicate-evidence-001"
      idempotency_draft_count = 1
    }
  })
  Write-TestJson $paths.rollback ([ordered]@{
    schema_version = "coastline_inbox_zero_rollback_receipt.v1"; commit_sha = $Sha; outcome = "pass"
    draft_action_unavailable = $true; existing_draft_untouched = $true; no_mailbox_delete = $true
  })
  Write-TestJson $paths.review ([ordered]@{
    schema_version = "coastline_inbox_zero_pr_review_receipt.v1"; commit_sha = $Sha
    base_branch = "main"; review_state = "approved"; approving_reviewers = @("reviewer")
  })
  return [pscustomobject]$paths
}

function Invoke-TestReadiness {
  param([object]$Paths, [string]$Sha)
  return (& $scriptPath -ExpectedSha $Sha -LocalEvidencePath $Paths.local `
    -ProtectedEnvironmentEvidencePath $Paths.environment -RemoteStagingReceiptPath $Paths.staging `
    -CanaryReceiptPath $Paths.canary -RollbackReceiptPath $Paths.rollback `
    -PrReviewEvidencePath $Paths.review | Out-String) | ConvertFrom-Json
}

Describe "Coastline Inbox Zero promotion readiness" {
  It "binds a pilot-only missing-evidence matrix to the current commit" {
    $record = (& $scriptPath -ExpectedSha $currentSha | Out-String) | ConvertFrom-Json
    $record.current_sha | Should Be $currentSha
    $record.state | Should Be "pilot-only"
    @($record.evidence_matrix.id) | Should Be @(
      "current_sha", "build", "full_test", "integration", "pester",
      "check_server_actions", "check_client_redirects", "check_test_fixtures",
      "protected_environment", "remote_staging", "dedicated_mailbox",
      "canary", "replay", "rollback", "pr_review"
    )
    (@($record.reason_codes) -contains "GRAPH_CANARY_RECEIPT_MISSING") | Should Be $true
  }

  It "records every current local validation result without promoting absent remote evidence" {
    $testRoot = Join-Path ([IO.Path]::GetTempPath()) "coastline-readiness-$([Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
    try {
      $paths = New-CompleteReadinessEvidence $testRoot $currentSha
      $record = (& $scriptPath -ExpectedSha $currentSha -LocalEvidencePath $paths.local | Out-String) | ConvertFrom-Json
      $record.state | Should Be "pilot-only"
      @($record.evidence_matrix | Where-Object id -eq "full_test").counts.tests_passed | Should Be 5132
      @($record.evidence_matrix | Where-Object id -eq "check_server_actions").status | Should Be "pass"
      @($record.evidence_matrix | Where-Object id -eq "check_client_redirects").status | Should Be "pass"
      @($record.evidence_matrix | Where-Object id -eq "check_test_fixtures").status | Should Be "pass"
    } finally { Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue }
  }

  foreach ($requiredLocalResult in @("build", "full_test", "integration", "pester", "check_server_actions", "check_client_redirects", "check_test_fixtures")) {
    It "cannot return ready when local result $requiredLocalResult is absent" {
      $testRoot = Join-Path ([IO.Path]::GetTempPath()) "coastline-readiness-$([Guid]::NewGuid().ToString('N'))"
      New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
      try {
        $paths = New-CompleteReadinessEvidence $testRoot $currentSha
        $local = Get-Content -LiteralPath $paths.local -Raw | ConvertFrom-Json
        $local.results.PSObject.Properties.Remove($requiredLocalResult)
        Write-TestJson $paths.local $local
        $record = Invoke-TestReadiness $paths $currentSha
        $record.state | Should Be "blocked"
        @($record.evidence_matrix | Where-Object id -eq $requiredLocalResult).status | Should Be "fail"
      } finally { Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue }
    }
  }

  It "returns ready only for full current fresh same-run evidence" {
    $testRoot = Join-Path ([IO.Path]::GetTempPath()) "coastline-readiness-$([Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
    try {
      $paths = New-CompleteReadinessEvidence $testRoot $currentSha
      $record = Invoke-TestReadiness $paths $currentSha
      $record.state | Should Be "ready"
      @($record.reason_codes).Count | Should Be 0
      @($record.evidence_matrix | Where-Object status -ne "pass").Count | Should Be 0
    } finally { Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue }
  }

  It "blocks protected environment evidence missing a required variable name" {
    $testRoot = Join-Path ([IO.Path]::GetTempPath()) "coastline-readiness-$([Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
    try {
      $paths = New-CompleteReadinessEvidence $testRoot $currentSha
      $environment = Get-Content -LiteralPath $paths.environment -Raw | ConvertFrom-Json
      $environment.configured_variable_names = @($environment.configured_variable_names | Where-Object { $_ -ne "COASTLINE_INBOX_ZERO_STAGING_BASE_URL" })
      Write-TestJson $paths.environment $environment
      $record = Invoke-TestReadiness $paths $currentSha
      $record.state | Should Be "blocked"
      @($record.evidence_matrix | Where-Object id -eq "protected_environment").status | Should Be "fail"
    } finally { Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue }
  }

  foreach ($invalidReviewerCase in @(
    [pscustomobject]@{ name = "empty"; values = @("staging-reviewer", "") },
    [pscustomobject]@{ name = "whitespace-only"; values = @("staging-reviewer", "   ") },
    [pscustomobject]@{ name = "untrimmed"; values = @(" staging-reviewer") },
    [pscustomobject]@{ name = "control-character"; values = @("staging`treviewer") },
    [pscustomobject]@{ name = "duplicate"; values = @("staging-reviewer", "STAGING-REVIEWER") }
  )) {
    It "blocks protected environment evidence with $($invalidReviewerCase.name) reviewer identities" {
      $testRoot = Join-Path ([IO.Path]::GetTempPath()) "coastline-readiness-$([Guid]::NewGuid().ToString('N'))"
      New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
      try {
        $paths = New-CompleteReadinessEvidence $testRoot $currentSha
        $environment = Get-Content -LiteralPath $paths.environment -Raw | ConvertFrom-Json
        $environment.required_reviewers = @($invalidReviewerCase.values)
        Write-TestJson $paths.environment $environment
        $record = Invoke-TestReadiness $paths $currentSha
        $record.state | Should Be "blocked"
        @($record.evidence_matrix | Where-Object id -eq "protected_environment").status | Should Be "fail"
      } finally { Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue }
    }
  }

  foreach ($invalidReviewerCase in @(
    [pscustomobject]@{ name = "empty"; values = @("reviewer", "") },
    [pscustomobject]@{ name = "whitespace-only"; values = @("reviewer", "`t") },
    [pscustomobject]@{ name = "untrimmed"; values = @("reviewer ") },
    [pscustomobject]@{ name = "control-character"; values = @("review`ter") },
    [pscustomobject]@{ name = "duplicate"; values = @("reviewer", "REVIEWER") }
  )) {
    It "blocks PR review evidence with $($invalidReviewerCase.name) reviewer identities" {
      $testRoot = Join-Path ([IO.Path]::GetTempPath()) "coastline-readiness-$([Guid]::NewGuid().ToString('N'))"
      New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
      try {
        $paths = New-CompleteReadinessEvidence $testRoot $currentSha
        $review = Get-Content -LiteralPath $paths.review -Raw | ConvertFrom-Json
        $review.approving_reviewers = @($invalidReviewerCase.values)
        Write-TestJson $paths.review $review
        $record = Invoke-TestReadiness $paths $currentSha
        $record.state | Should Be "blocked"
        @($record.evidence_matrix | Where-Object id -eq "pr_review").status | Should Be "fail"
      } finally { Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue }
    }
  }

  It "rejects a truncated remote staging receipt" {
    $testRoot = Join-Path ([IO.Path]::GetTempPath()) "coastline-readiness-$([Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
    try {
      $paths = New-CompleteReadinessEvidence $testRoot $currentSha
      Write-TestJson $paths.staging ([ordered]@{ schema_version = "coastline_inbox_zero_staging_receipt.v2"; artifact_sha = $currentSha; outcome = "pass" })
      $record = Invoke-TestReadiness $paths $currentSha
      $record.state | Should Be "blocked"
      @($record.evidence_matrix | Where-Object id -eq "remote_staging").status | Should Be "fail"
    } finally { Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue }
  }

  It "rejects a loopback diagnostic as remote staging evidence" {
    $testRoot = Join-Path ([IO.Path]::GetTempPath()) "coastline-readiness-$([Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
    try {
      $paths = New-CompleteReadinessEvidence $testRoot $currentSha
      $staging = Get-Content -LiteralPath $paths.staging -Raw | ConvertFrom-Json
      $staging.provenance = "local_diagnostic"; $staging.is_loopback = $true
      Write-TestJson $paths.staging $staging
      $record = Invoke-TestReadiness $paths $currentSha
      $record.state | Should Be "blocked"
      (@($record.reason_codes) -contains "REMOTE_STAGING_RECEIPT_INVALID") | Should Be $true
    } finally { Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue }
  }

  It "rejects a truncated canary receipt" {
    $testRoot = Join-Path ([IO.Path]::GetTempPath()) "coastline-readiness-$([Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
    try {
      $paths = New-CompleteReadinessEvidence $testRoot $currentSha
      Write-TestJson $paths.canary ([ordered]@{ schemaVersion = "inbox_zero_microsoft_canary_receipt.v1"; terminalState = "created_verified"; idempotencyDraftCount = 1 })
      $record = Invoke-TestReadiness $paths $currentSha
      $record.state | Should Be "blocked"
      @($record.evidence_matrix | Where-Object id -eq "canary").status | Should Be "fail"
    } finally { Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue }
  }

  It "rejects canary evidence whose replay uses a different run nonce" {
    $testRoot = Join-Path ([IO.Path]::GetTempPath()) "coastline-readiness-$([Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
    try {
      $paths = New-CompleteReadinessEvidence $testRoot $currentSha
      $canary = Get-Content -LiteralPath $paths.canary -Raw | ConvertFrom-Json
      $canary.replay.run_nonce = "ffffffffffffffffffffffffffffffff"
      Write-TestJson $paths.canary $canary
      $record = Invoke-TestReadiness $paths $currentSha
      $record.state | Should Be "blocked"
      @($record.evidence_matrix | Where-Object id -eq "replay").status | Should Be "fail"
    } finally { Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue }
  }

  It "rejects canary evidence whose runner provenance names another artifact" {
    $testRoot = Join-Path ([IO.Path]::GetTempPath()) "coastline-readiness-$([Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
    try {
      $paths = New-CompleteReadinessEvidence $testRoot $currentSha
      $canary = Get-Content -LiteralPath $paths.canary -Raw | ConvertFrom-Json
      $canary.runner_provenance.artifact_sha = "f" * 40
      Write-TestJson $paths.canary $canary
      $record = Invoke-TestReadiness $paths $currentSha
      $record.state | Should Be "blocked"
      @($record.evidence_matrix | Where-Object id -eq "canary").status | Should Be "fail"
    } finally { Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue }
  }

  It "rejects mailbox evidence that does not attest a dedicated non-production identity" {
    $testRoot = Join-Path ([IO.Path]::GetTempPath()) "coastline-readiness-$([Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
    try {
      $paths = New-CompleteReadinessEvidence $testRoot $currentSha
      $canary = Get-Content -LiteralPath $paths.canary -Raw | ConvertFrom-Json
      $canary.dedicated_mailbox.is_production_mailbox = $true
      Write-TestJson $paths.canary $canary
      $record = Invoke-TestReadiness $paths $currentSha
      $record.state | Should Be "blocked"
      @($record.evidence_matrix | Where-Object id -eq "dedicated_mailbox").status | Should Be "fail"
    } finally { Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue }
  }

  It "rejects stale canary evidence" {
    $testRoot = Join-Path ([IO.Path]::GetTempPath()) "coastline-readiness-$([Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
    try {
      $paths = New-CompleteReadinessEvidence $testRoot $currentSha
      $canary = Get-Content -LiteralPath $paths.canary -Raw | ConvertFrom-Json
      $stale = [DateTimeOffset]::UtcNow.AddDays(-2).ToString("o")
      $canary.started_at = $stale; $canary.completed_at = $stale
      $canary.dedicated_mailbox.verified_at = $stale; $canary.canary.generatedAt = $stale; $canary.replay.verified_at = $stale
      Write-TestJson $paths.canary $canary
      $record = Invoke-TestReadiness $paths $currentSha
      $record.state | Should Be "blocked"
      (@($record.reason_codes) -contains "GRAPH_CANARY_RECEIPT_INVALID") | Should Be $true
    } finally { Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue }
  }

  It "documents current protected variable and composite canary evidence requirements" {
    $readiness = Get-Content -LiteralPath $readinessPath -Raw
    $contract = Get-Content -LiteralPath $contractPath -Raw
    $pilot = Get-Content -LiteralPath $pilotPath -Raw
    $readiness | Should Match "pilot-only"
    $contract | Should Match "COASTLINE_INBOX_ZERO_STAGING_BASE_URL"
    $contract | Should Match "coastline_inbox_zero_promotion_canary_evidence.v1"
    $contract | Should Match "check-client-redirects"
    $pilot | Should Match "environment protection"
  }
}
