$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$scriptPath = Join-Path $repoRoot "scripts/Assert-CoastlineInboxZeroReadiness.ps1"
$readinessPath = Join-Path $repoRoot "docs/operations/inbox-zero-operational-readiness.md"
$contractPath = Join-Path $repoRoot "docs/operations/inbox-zero-promotion-evidence-contract.md"
$pilotPath = Join-Path $repoRoot "docs/hosting/coastline-draft-only-pilot.mdx"
$currentSha = (& git -C $repoRoot rev-parse HEAD).Trim()

Describe "Coastline Inbox Zero promotion readiness" {
  It "binds a pilot-only missing-evidence matrix to the current commit" {
    $record = (& $scriptPath -ExpectedSha $currentSha | Out-String) | ConvertFrom-Json

    $record.schema_version | Should Be "coastline_inbox_zero_promotion_readiness.v1"
    $record.current_sha | Should Be $currentSha
    $record.state | Should Be "pilot-only"
    @($record.evidence_matrix.id) | Should Be @(
      "current_sha", "build", "full_test", "integration", "pester",
      "protected_environment", "remote_staging", "dedicated_mailbox",
      "canary", "replay", "rollback", "pr_review"
    )
    (@($record.reason_codes) -contains "PROTECTED_ENVIRONMENT_EVIDENCE_MISSING") | Should Be $true
    (@($record.reason_codes) -contains "REMOTE_STAGING_RECEIPT_MISSING") | Should Be $true
    (@($record.reason_codes) -contains "DEDICATED_MAILBOX_EVIDENCE_MISSING") | Should Be $true
    (@($record.reason_codes) -contains "GRAPH_CANARY_RECEIPT_MISSING") | Should Be $true
    @($record.evidence_matrix | Where-Object id -eq "remote_staging").status | Should Be "missing"
    @($record.evidence_matrix | Where-Object id -eq "canary").status | Should Be "missing"
  }

  It "records exact current local suite counts without promoting absent remote evidence" {
    $testRoot = Join-Path ([IO.Path]::GetTempPath()) "coastline-readiness-$([Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
    try {
      $localPath = Join-Path $testRoot "local-validation.json"
      [ordered]@{
        schema_version = "coastline_inbox_zero_local_validation_receipt.v1"
        commit_sha = $currentSha
        results = [ordered]@{
          build = [ordered]@{ command = "pnpm.cmd --filter inbox-zero-ai run build:ci"; outcome = "pass" }
          full_test = [ordered]@{ command = "pnpm.cmd --filter inbox-zero-ai test -- --run"; outcome = "pass"; test_files_passed = 561; test_files_skipped = 106; tests_passed = 5132; tests_skipped = 321 }
          integration = [ordered]@{ command = "pnpm.cmd --filter inbox-zero-ai test-integration"; outcome = "pass"; test_files_passed = 21; tests_passed = 125 }
          pester = [ordered]@{ command = "Invoke-Pester -Script scripts/tests -PassThru"; outcome = "pass"; tests_passed = 17 }
        }
      } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $localPath -Encoding utf8NoBOM

      $record = (& $scriptPath -ExpectedSha $currentSha -LocalEvidencePath $localPath | Out-String) | ConvertFrom-Json

      $record.state | Should Be "pilot-only"
      @($record.evidence_matrix | Where-Object id -eq "build").status | Should Be "pass"
      @($record.evidence_matrix | Where-Object id -eq "full_test").counts.tests_passed | Should Be 5132
      @($record.evidence_matrix | Where-Object id -eq "integration").counts.tests_passed | Should Be 125
      @($record.evidence_matrix | Where-Object id -eq "pester").counts.tests_passed | Should Be 17
      (@($record.reason_codes) -contains "REMOTE_STAGING_RECEIPT_MISSING") | Should Be $true
      (@($record.reason_codes) -contains "GRAPH_CANARY_RECEIPT_MISSING") | Should Be $true
    } finally {
      Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
  }

  It "blocks a local receipt that is not tied to the expected commit" {
    $testRoot = Join-Path ([IO.Path]::GetTempPath()) "coastline-readiness-$([Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
    try {
      $localPath = Join-Path $testRoot "local-validation.json"
      [ordered]@{
        schema_version = "coastline_inbox_zero_local_validation_receipt.v1"
        commit_sha = ("f" * 40)
        results = [ordered]@{}
      } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $localPath -Encoding utf8NoBOM

      $record = (& $scriptPath -ExpectedSha $currentSha -LocalEvidencePath $localPath | Out-String) | ConvertFrom-Json

      $record.state | Should Be "blocked"
      (@($record.reason_codes) -contains "LOCAL_EVIDENCE_SHA_MISMATCH") | Should Be $true
      @($record.evidence_matrix | Where-Object id -eq "build").status | Should Be "fail"
    } finally {
      Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
  }

  It "returns ready only for current passing local protected remote canary replay rollback and review evidence" {
    $testRoot = Join-Path ([IO.Path]::GetTempPath()) "coastline-readiness-$([Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
    try {
      $localPath = Join-Path $testRoot "local-validation.json"
      $environmentPath = Join-Path $testRoot "protected-environment.json"
      $stagingPath = Join-Path $testRoot "remote-staging.json"
      $canaryPath = Join-Path $testRoot "microsoft-canary.json"
      $rollbackPath = Join-Path $testRoot "rollback.json"
      $reviewPath = Join-Path $testRoot "pr-review.json"
      [ordered]@{
        schema_version = "coastline_inbox_zero_local_validation_receipt.v1"; commit_sha = $currentSha
        results = [ordered]@{
          build = [ordered]@{ command = "pnpm.cmd --filter inbox-zero-ai run build:ci"; outcome = "pass" }
          full_test = [ordered]@{ command = "pnpm.cmd --filter inbox-zero-ai test -- --run"; outcome = "pass"; test_files_passed = 1; test_files_skipped = 0; tests_passed = 1; tests_skipped = 0 }
          integration = [ordered]@{ command = "pnpm.cmd --filter inbox-zero-ai test-integration"; outcome = "pass"; test_files_passed = 1; tests_passed = 1 }
          pester = [ordered]@{ command = "Invoke-Pester -Script scripts/tests -PassThru"; outcome = "pass"; tests_passed = 1 }
        }
      } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $localPath -Encoding utf8NoBOM
      [ordered]@{
        schema_version = "coastline_inbox_zero_protected_environment_receipt.v1"; commit_sha = $currentSha
        environment = "coastline-inbox-zero-staging"; deployment_branch_rule = "refs/heads/main"; protected_sha = $currentSha
        required_reviewers = @("staging-reviewer"); prevent_self_review = $true
        configured_secret_names = @(
          "COASTLINE_INBOX_ZERO_STAGING_DATABASE_URL", "COASTLINE_INBOX_ZERO_STAGING_AUTH_SECRET",
          "COASTLINE_INBOX_ZERO_STAGING_MICROSOFT_CLIENT_ID", "COASTLINE_INBOX_ZERO_STAGING_MICROSOFT_CLIENT_SECRET",
          "COASTLINE_INBOX_ZERO_STAGING_CRON_SECRET"
        )
      } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $environmentPath -Encoding utf8NoBOM
      [ordered]@{ schema_version = "coastline_inbox_zero_staging_receipt.v2"; artifact_sha = $currentSha; outcome = "pass" } |
        ConvertTo-Json | Set-Content -LiteralPath $stagingPath -Encoding utf8NoBOM
      [ordered]@{
        schemaVersion = "inbox_zero_microsoft_canary_receipt.v1"; graphReadbackStatus = "verified"
        terminalState = "created_verified"; noSendCapability = "Mail.Send_absent"
        idempotencyReplay = "existing_draft_reconciled"; idempotencyDraftCount = 1
      } | ConvertTo-Json | Set-Content -LiteralPath $canaryPath -Encoding utf8NoBOM
      [ordered]@{
        schema_version = "coastline_inbox_zero_rollback_receipt.v1"; commit_sha = $currentSha; outcome = "pass"
        draft_action_unavailable = $true; existing_draft_untouched = $true; no_mailbox_delete = $true
      } | ConvertTo-Json | Set-Content -LiteralPath $rollbackPath -Encoding utf8NoBOM
      [ordered]@{
        schema_version = "coastline_inbox_zero_pr_review_receipt.v1"; commit_sha = $currentSha
        base_branch = "main"; review_state = "approved"; approving_reviewers = @("reviewer")
      } | ConvertTo-Json | Set-Content -LiteralPath $reviewPath -Encoding utf8NoBOM

      $record = (& $scriptPath -ExpectedSha $currentSha -LocalEvidencePath $localPath `
        -ProtectedEnvironmentEvidencePath $environmentPath -RemoteStagingReceiptPath $stagingPath `
        -CanaryReceiptPath $canaryPath -RollbackReceiptPath $rollbackPath -PrReviewEvidencePath $reviewPath |
        Out-String) | ConvertFrom-Json

      $record.state | Should Be "ready"
      @($record.reason_codes).Count | Should Be 0
      @($record.evidence_matrix | Where-Object status -ne "pass").Count | Should Be 0
    } finally {
      Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
  }

  It "documents the current implementation base and protected promotion boundary without pass claims" {
    $readiness = Get-Content -LiteralPath $readinessPath -Raw
    $contract = Get-Content -LiteralPath $contractPath -Raw
    $pilot = Get-Content -LiteralPath $pilotPath -Raw

    $readiness | Should Match "9e7b9d034147c538c3428e863d341d29f2e43767"
    $readiness | Should Match "pilot-only"
    $readiness | Should Not Match "Remote staging receipt.*\| pass \|"
    $readiness | Should Not Match "Graph canary receipt.*\| pass \|"
    $contract | Should Match "coastline-inbox-zero-staging"
    $contract | Should Match "COASTLINE_INBOX_ZERO_PROTECTED_SHA"
    $contract | Should Match "required reviewer"
    $contract | Should Match "COASTLINE_INBOX_ZERO_STAGING_CRON_SECRET"
    $pilot | Should Match "refs/heads/main"
    $pilot | Should Match "environment protection"
  }
}
