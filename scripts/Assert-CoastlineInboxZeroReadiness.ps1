[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-f0-9]{40}$')]
  [string]$ExpectedSha,
  [string]$LocalEvidencePath,
  [string]$ProtectedEnvironmentEvidencePath,
  [string]$RemoteStagingReceiptPath,
  [string]$CanaryReceiptPath,
  [string]$RollbackReceiptPath,
  [string]$PrReviewEvidencePath,
  [string]$OutputPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$requiredSecretNames = @(
  "COASTLINE_INBOX_ZERO_STAGING_AUTH_SECRET",
  "COASTLINE_INBOX_ZERO_STAGING_CRON_SECRET",
  "COASTLINE_INBOX_ZERO_STAGING_DATABASE_URL",
  "COASTLINE_INBOX_ZERO_STAGING_MICROSOFT_CLIENT_ID",
  "COASTLINE_INBOX_ZERO_STAGING_MICROSOFT_CLIENT_SECRET"
)
$requiredVariableNames = @(
  "COASTLINE_INBOX_ZERO_PROTECTED_SHA",
  "COASTLINE_INBOX_ZERO_STAGING_BASE_URL",
  "COASTLINE_INBOX_ZERO_STAGING_MICROSOFT_EMULATOR_URL"
)
$matrix = [System.Collections.Generic.List[object]]::new()
$reasonCodes = [System.Collections.Generic.List[string]]::new()

function Get-PropertyValue {
  param([object]$InputObject, [string]$Name)
  if ($null -eq $InputObject) { return $null }
  $property = $InputObject.PSObject.Properties[$Name]
  if ($null -eq $property) { return $null }
  return $property.Value
}

function Get-EvidenceFile {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) {
    return [pscustomobject]@{ supplied = $false; valid = $false; value = $null }
  }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return [pscustomobject]@{ supplied = $true; valid = $false; value = $null }
  }
  $resolvedPath = (Resolve-Path -LiteralPath $Path).Path
  $resolvedRoot = (Resolve-Path -LiteralPath $repoRoot).Path.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  if ($resolvedPath.StartsWith("$resolvedRoot$([IO.Path]::DirectorySeparatorChar)", [StringComparison]::OrdinalIgnoreCase)) {
    return [pscustomobject]@{ supplied = $true; valid = $false; value = $null }
  }
  try {
    $value = Get-Content -LiteralPath $resolvedPath -Raw | ConvertFrom-Json
    return [pscustomobject]@{ supplied = $true; valid = $true; value = $value }
  } catch {
    return [pscustomobject]@{ supplied = $true; valid = $false; value = $null }
  }
}

function Add-Evidence {
  param(
    [string]$Id,
    [ValidateSet("pass", "missing", "fail")][string]$Status,
    [string]$ReasonCode,
    [object]$Counts = $null
  )
  if ($ReasonCode) { $reasonCodes.Add($ReasonCode) }
  $matrix.Add([pscustomobject][ordered]@{
    id = $Id
    status = $Status
    reason_code = if ($ReasonCode) { $ReasonCode } else { $null }
    counts = $Counts
  })
}

function Test-PositiveInteger {
  param([object]$Value, [switch]$AllowZero)
  if ($Value -isnot [int] -and $Value -isnot [long]) { return $false }
  if ($AllowZero) { return $Value -ge 0 }
  return $Value -gt 0
}

function Test-ExactSet {
  param([object[]]$Actual, [string[]]$Expected)
  if ($null -eq $Actual) { return $false }
  return (@($Actual | ForEach-Object { [string]$_ } | Sort-Object) -join "`n") -ceq
    (@($Expected | Sort-Object) -join "`n")
}

function Test-ExactProperties {
  param([object]$Value, [string[]]$Expected)
  if ($null -eq $Value) { return $false }
  return Test-ExactSet @($Value.PSObject.Properties.Name) $Expected
}

function Get-EvidenceTimestamp {
  param([object]$Value)
  try { return [DateTimeOffset]::Parse([string]$Value) } catch { return $null }
}

function Test-FreshWindow {
  param([object]$StartedAt, [object]$CompletedAt)
  $started = Get-EvidenceTimestamp $StartedAt
  $completed = Get-EvidenceTimestamp $CompletedAt
  $now = [DateTimeOffset]::UtcNow
  return $null -ne $started -and $null -ne $completed -and
    $started -le $completed -and $completed -le $now.AddMinutes(2) -and
    $completed -ge $now.AddHours(-24) -and ($completed - $started).TotalMinutes -le 60
}

function Test-BoundedEvidenceTimestamp {
  param([object]$Value, [DateTimeOffset]$StartedAt, [DateTimeOffset]$CompletedAt)
  $timestamp = Get-EvidenceTimestamp $Value
  return $null -ne $timestamp -and $timestamp -ge $StartedAt -and $timestamp -le $CompletedAt
}

function Test-OpaqueEvidenceId {
  param([object]$Value, [int]$MaximumLength = 512)
  if ($null -eq $Value) { return $false }
  $text = [string]$Value
  return $text.Length -gt 0 -and $text.Length -le $MaximumLength -and
    $text -ceq $text.Trim() -and $text -notmatch '[\r\n]'
}

function Test-ReviewerIdentities {
  param([object]$Value)
  if ($null -eq $Value) { return $false }
  $reviewers = @($Value)
  if ($reviewers.Count -eq 0) { return $false }
  $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($reviewer in $reviewers) {
    if ($reviewer -isnot [string] -or -not (Test-OpaqueEvidenceId $reviewer 256)) { return $false }
    foreach ($character in $reviewer.ToCharArray()) {
      if ([char]::IsControl($character)) { return $false }
    }
    if (-not $seen.Add($reviewer)) { return $false }
  }
  return $true
}

$actualSha = (& git -C $repoRoot rev-parse HEAD 2>$null).Trim()
if ($LASTEXITCODE -ne 0 -or $actualSha -notmatch '^[a-f0-9]{40}$' -or $actualSha -cne $ExpectedSha) {
  Add-Evidence -Id "current_sha" -Status "fail" -ReasonCode "CURRENT_SHA_MISMATCH"
} else {
  Add-Evidence -Id "current_sha" -Status "pass"
}

$localEvidence = Get-EvidenceFile -Path $LocalEvidencePath
if (-not $localEvidence.supplied) {
  Add-Evidence -Id "build" -Status "missing" -ReasonCode "LOCAL_BUILD_RESULT_MISSING"
  Add-Evidence -Id "full_test" -Status "missing" -ReasonCode "LOCAL_FULL_TEST_RESULT_MISSING"
  Add-Evidence -Id "integration" -Status "missing" -ReasonCode "LOCAL_INTEGRATION_RESULT_MISSING"
  Add-Evidence -Id "pester" -Status "missing" -ReasonCode "LOCAL_PESTER_RESULT_MISSING"
  Add-Evidence -Id "check_server_actions" -Status "missing" -ReasonCode "LOCAL_CHECK_SERVER_ACTIONS_RESULT_MISSING"
  Add-Evidence -Id "check_client_redirects" -Status "missing" -ReasonCode "LOCAL_CHECK_CLIENT_REDIRECTS_RESULT_MISSING"
  Add-Evidence -Id "check_test_fixtures" -Status "missing" -ReasonCode "LOCAL_CHECK_TEST_FIXTURES_RESULT_MISSING"
} elseif (-not $localEvidence.valid -or
  (Get-PropertyValue $localEvidence.value "schema_version") -cne "coastline_inbox_zero_local_validation_receipt.v1") {
  foreach ($id in @("build", "full_test", "integration", "pester", "check_server_actions", "check_client_redirects", "check_test_fixtures")) {
    Add-Evidence -Id $id -Status "fail" -ReasonCode "LOCAL_EVIDENCE_INVALID"
  }
} elseif ((Get-PropertyValue $localEvidence.value "commit_sha") -cne $ExpectedSha) {
  foreach ($id in @("build", "full_test", "integration", "pester", "check_server_actions", "check_client_redirects", "check_test_fixtures")) {
    Add-Evidence -Id $id -Status "fail" -ReasonCode "LOCAL_EVIDENCE_SHA_MISMATCH"
  }
} else {
  $localResults = Get-PropertyValue $localEvidence.value "results"
  $localContracts = [ordered]@{
    build = "pnpm.cmd --filter inbox-zero-ai run build:ci"
    full_test = "pnpm.cmd --filter inbox-zero-ai test -- --run"
    integration = "pnpm.cmd --filter inbox-zero-ai test-integration"
    pester = "Invoke-Pester -Script scripts/tests -PassThru"
    check_server_actions = "pnpm.cmd --filter inbox-zero-ai run check-server-actions"
    check_client_redirects = "pnpm.cmd --filter inbox-zero-ai run check-client-redirects"
    check_test_fixtures = "pnpm.cmd --filter inbox-zero-ai run check-test-fixtures"
  }
  foreach ($entry in $localContracts.GetEnumerator()) {
    $result = Get-PropertyValue $localResults $entry.Key
    $counts = $null
    $valid = $null -ne $result -and (Get-PropertyValue $result "command") -ceq $entry.Value -and
      (Get-PropertyValue $result "outcome") -ceq "pass"
    if ($valid -and $entry.Key -eq "full_test") {
      $valid = (Test-PositiveInteger (Get-PropertyValue $result "test_files_passed")) -and
        (Test-PositiveInteger (Get-PropertyValue $result "test_files_skipped") -AllowZero) -and
        (Test-PositiveInteger (Get-PropertyValue $result "tests_passed")) -and
        (Test-PositiveInteger (Get-PropertyValue $result "tests_skipped") -AllowZero)
      $counts = [pscustomobject][ordered]@{
        test_files_passed = Get-PropertyValue $result "test_files_passed"
        test_files_skipped = Get-PropertyValue $result "test_files_skipped"
        tests_passed = Get-PropertyValue $result "tests_passed"
        tests_skipped = Get-PropertyValue $result "tests_skipped"
      }
    } elseif ($valid -and $entry.Key -eq "integration") {
      $valid = (Test-PositiveInteger (Get-PropertyValue $result "test_files_passed")) -and
        (Test-PositiveInteger (Get-PropertyValue $result "tests_passed"))
      $counts = [pscustomobject][ordered]@{
        test_files_passed = Get-PropertyValue $result "test_files_passed"
        tests_passed = Get-PropertyValue $result "tests_passed"
      }
    } elseif ($valid -and $entry.Key -eq "pester") {
      $valid = Test-PositiveInteger (Get-PropertyValue $result "tests_passed")
      $counts = [pscustomobject][ordered]@{ tests_passed = Get-PropertyValue $result "tests_passed" }
    }
    if ($valid) {
      Add-Evidence -Id $entry.Key -Status "pass" -Counts $counts
    } else {
      Add-Evidence -Id $entry.Key -Status "fail" -ReasonCode ("LOCAL_{0}_RESULT_INVALID" -f $entry.Key.ToUpperInvariant())
    }
  }
}

$environmentEvidence = Get-EvidenceFile -Path $ProtectedEnvironmentEvidencePath
if (-not $environmentEvidence.supplied) {
  Add-Evidence -Id "protected_environment" -Status "missing" -ReasonCode "PROTECTED_ENVIRONMENT_EVIDENCE_MISSING"
} else {
  $environment = $environmentEvidence.value
  $expectedEnvironmentProperties = @(
    "schema_version", "commit_sha", "environment", "deployment_branch_rule",
    "protected_sha", "required_reviewers", "prevent_self_review",
    "configured_secret_names", "configured_variable_names"
  )
  $environmentValid = $environmentEvidence.valid -and
    (Test-ExactProperties $environment $expectedEnvironmentProperties) -and
    (Get-PropertyValue $environment "schema_version") -ceq "coastline_inbox_zero_protected_environment_receipt.v1" -and
    (Get-PropertyValue $environment "commit_sha") -ceq $ExpectedSha -and
    (Get-PropertyValue $environment "environment") -ceq "coastline-inbox-zero-staging" -and
    (Get-PropertyValue $environment "deployment_branch_rule") -ceq "refs/heads/main" -and
    (Get-PropertyValue $environment "protected_sha") -ceq $ExpectedSha -and
    (Test-ReviewerIdentities (Get-PropertyValue $environment "required_reviewers")) -and
    (Get-PropertyValue $environment "prevent_self_review") -eq $true -and
    (Test-ExactSet @(Get-PropertyValue $environment "configured_secret_names") $requiredSecretNames) -and
    (Test-ExactSet @(Get-PropertyValue $environment "configured_variable_names") $requiredVariableNames)
  if ($environmentValid) {
    Add-Evidence -Id "protected_environment" -Status "pass"
  } else {
    Add-Evidence -Id "protected_environment" -Status "fail" -ReasonCode "PROTECTED_ENVIRONMENT_EVIDENCE_INVALID"
  }
}

$stagingValid = $false
$stagingRunNonce = $null
$stagingCompletedAt = $null
$stagingCronEvidenceId = $null
$stagingEvidence = Get-EvidenceFile -Path $RemoteStagingReceiptPath
if (-not $stagingEvidence.supplied) {
  Add-Evidence -Id "remote_staging" -Status "missing" -ReasonCode "REMOTE_STAGING_RECEIPT_MISSING"
} else {
  $staging = $stagingEvidence.value
  $expectedStagingProperties = @(
    "schema_version", "provenance", "is_loopback", "run_nonce", "started_at",
    "completed_at", "artifact_sha", "worker_artifact_sha", "worker_heartbeat_at",
    "remote_worker_identity", "remote_queue_identity",
    "cron_evidence_id", "service_states", "checks", "outcome"
  )
  $expectedServiceProperties = @("web", "worker", "queue", "cron_unauthenticated", "cron_authenticated")
  $expectedCheckCodes = @("WEB_HEALTH", "CRON_UNAUTHENTICATED_REJECTED", "CRON_AUTHENTICATED_SUCCESS", "REMOTE_ARTIFACT_WORKER_QUEUE")
  $stagingChecks = @(Get-PropertyValue $staging "checks")
  $stagingValid = $stagingEvidence.valid -and
    (Test-ExactProperties $staging $expectedStagingProperties) -and
    (Get-PropertyValue $staging "schema_version") -ceq "coastline_inbox_zero_staging_receipt.v2" -and
    (Get-PropertyValue $staging "provenance") -ceq "remote_https" -and
    (Get-PropertyValue $staging "is_loopback") -eq $false -and
    (Get-PropertyValue $staging "run_nonce") -match '^[a-f0-9]{32}$' -and
    (Test-FreshWindow (Get-PropertyValue $staging "started_at") (Get-PropertyValue $staging "completed_at")) -and
    (Get-PropertyValue $staging "artifact_sha") -ceq $ExpectedSha -and
    (Get-PropertyValue $staging "worker_artifact_sha") -ceq $ExpectedSha -and
    (Test-BoundedEvidenceTimestamp (Get-PropertyValue $staging "worker_heartbeat_at") (Get-EvidenceTimestamp (Get-PropertyValue $staging "started_at")) (Get-EvidenceTimestamp (Get-PropertyValue $staging "completed_at"))) -and
    (Test-OpaqueEvidenceId (Get-PropertyValue $staging "remote_worker_identity")) -and
    (Test-OpaqueEvidenceId (Get-PropertyValue $staging "remote_queue_identity")) -and
    (Get-PropertyValue $staging "cron_evidence_id") -match '^[a-f0-9]{64}$' -and
    (Test-ExactProperties (Get-PropertyValue $staging "service_states") $expectedServiceProperties) -and
    (Get-PropertyValue (Get-PropertyValue $staging "service_states") "web") -ceq "healthy" -and
    (Get-PropertyValue (Get-PropertyValue $staging "service_states") "worker") -ceq "running" -and
    (Get-PropertyValue (Get-PropertyValue $staging "service_states") "queue") -ceq "reachable" -and
    (Get-PropertyValue (Get-PropertyValue $staging "service_states") "cron_unauthenticated") -ceq "rejected" -and
    (Get-PropertyValue (Get-PropertyValue $staging "service_states") "cron_authenticated") -ceq "verified" -and
    $stagingChecks.Count -eq 4 -and
    (Test-ExactSet @($stagingChecks | ForEach-Object { Get-PropertyValue $_ "code" }) $expectedCheckCodes) -and
    @($stagingChecks | Where-Object { -not (Test-ExactProperties $_ @("code", "status")) -or (Get-PropertyValue $_ "status") -cne "pass" }).Count -eq 0 -and
    (Get-PropertyValue $staging "outcome") -ceq "pass"
  if ($stagingValid) {
    $stagingRunNonce = Get-PropertyValue $staging "run_nonce"
    $stagingCompletedAt = Get-EvidenceTimestamp (Get-PropertyValue $staging "completed_at")
    $stagingCronEvidenceId = Get-PropertyValue $staging "cron_evidence_id"
    Add-Evidence -Id "remote_staging" -Status "pass"
  } else {
    Add-Evidence -Id "remote_staging" -Status "fail" -ReasonCode "REMOTE_STAGING_RECEIPT_INVALID"
  }
}

$canaryValid = $false
$replayValid = $false
$runId = $null
$runNonce = $null
$completedAt = $null
$canary = $null
$replay = $null
$canaryEvidence = Get-EvidenceFile -Path $CanaryReceiptPath
if (-not $canaryEvidence.supplied) {
  Add-Evidence -Id "dedicated_mailbox" -Status "missing" -ReasonCode "DEDICATED_MAILBOX_EVIDENCE_MISSING"
  Add-Evidence -Id "canary" -Status "missing" -ReasonCode "GRAPH_CANARY_RECEIPT_MISSING"
  Add-Evidence -Id "replay" -Status "missing" -ReasonCode "REPLAY_RESULT_MISSING"
} else {
  $bundle = $canaryEvidence.value
  $runner = Get-PropertyValue $bundle "runner_provenance"
  $mailbox = Get-PropertyValue $bundle "dedicated_mailbox"
  $canary = Get-PropertyValue $bundle "canary"
  $replay = Get-PropertyValue $bundle "replay"
  $runId = Get-PropertyValue $bundle "run_id"
  $runNonce = Get-PropertyValue $bundle "run_nonce"
  $startedAt = Get-EvidenceTimestamp (Get-PropertyValue $bundle "started_at")
  $completedAt = Get-EvidenceTimestamp (Get-PropertyValue $bundle "completed_at")
  $expectedBundleProperties = @("schema_version", "artifact_sha", "run_id", "run_nonce", "started_at", "completed_at", "runner_provenance", "dedicated_mailbox", "canary", "replay")
  $expectedRunnerProperties = @("schema_version", "artifact_sha", "run_id", "run_nonce", "executor_registration_id", "executor_registration_sha256", "executor_id", "verifier_id")
  $expectedMailboxProperties = @("schema_version", "artifact_sha", "run_id", "run_nonce", "verified_at", "environment", "mailbox_identity_sha256", "account_id", "identity_evidence_id", "mailbox_purpose", "is_shared_mailbox", "is_production_mailbox")
  $expectedCanaryProperties = @("schemaVersion", "provider", "action", "accountId", "threadId", "sourceMessageId", "draftId", "idempotencyKey", "runNonce", "graphReadbackStatus", "scopeIdentity", "noSendCapability", "idempotencyReplay", "terminalState", "generatedAt", "executorRegistrationId", "executorProvenanceSha256", "connectedIdentityEvidenceId", "grantedScopesEvidenceId", "noSendEvidenceId", "graphReadbackEvidenceId", "replayGraphReadbackEvidenceId", "noDuplicateEvidenceId", "idempotencyDraftCount")
  $expectedReplayProperties = @("schema_version", "artifact_sha", "run_id", "run_nonce", "verified_at", "terminal_state", "idempotency_key", "draft_id", "idempotency_replay", "replay_graph_readback_evidence_id", "no_duplicate_evidence_id", "idempotency_draft_count")
  $sharedBindingValid = $canaryEvidence.valid -and
    (Test-ExactProperties $bundle $expectedBundleProperties) -and
    (Get-PropertyValue $bundle "schema_version") -ceq "coastline_inbox_zero_promotion_canary_evidence.v1" -and
    (Get-PropertyValue $bundle "artifact_sha") -ceq $ExpectedSha -and
    (Test-OpaqueEvidenceId $runId 256) -and $runNonce -match '^[a-f0-9]{32}$' -and
    (Test-FreshWindow (Get-PropertyValue $bundle "started_at") (Get-PropertyValue $bundle "completed_at")) -and
    ((-not $stagingEvidence.supplied) -or ($stagingValid -and $stagingRunNonce -ceq $runNonce -and $stagingCompletedAt -le $startedAt)) -and
    (Test-ExactProperties $runner $expectedRunnerProperties) -and
    (Get-PropertyValue $runner "schema_version") -ceq "coastline_inbox_zero_canary_runner_provenance.v1" -and
    (Get-PropertyValue $runner "artifact_sha") -ceq $ExpectedSha -and
    (Get-PropertyValue $runner "run_id") -ceq $runId -and
    (Get-PropertyValue $runner "run_nonce") -ceq $runNonce -and
    (Get-PropertyValue $runner "executor_registration_sha256") -match '^[a-f0-9]{64}$' -and
    (Test-OpaqueEvidenceId (Get-PropertyValue $runner "executor_registration_id") 256) -and
    (Test-OpaqueEvidenceId (Get-PropertyValue $runner "executor_id") 256) -and
    (Test-OpaqueEvidenceId (Get-PropertyValue $runner "verifier_id") 256)
  $mailboxValid = $sharedBindingValid -and
    (Test-ExactProperties $mailbox $expectedMailboxProperties) -and
    (Get-PropertyValue $mailbox "schema_version") -ceq "coastline_inbox_zero_dedicated_mailbox_evidence.v1" -and
    (Get-PropertyValue $mailbox "artifact_sha") -ceq $ExpectedSha -and
    (Get-PropertyValue $mailbox "run_id") -ceq $runId -and
    (Get-PropertyValue $mailbox "run_nonce") -ceq $runNonce -and
    (Test-BoundedEvidenceTimestamp (Get-PropertyValue $mailbox "verified_at") $startedAt $completedAt) -and
    (Get-PropertyValue $mailbox "environment") -ceq "staging" -and
    (Get-PropertyValue $mailbox "mailbox_identity_sha256") -match '^[a-f0-9]{64}$' -and
    (Test-OpaqueEvidenceId (Get-PropertyValue $mailbox "account_id") 256) -and
    (Test-OpaqueEvidenceId (Get-PropertyValue $mailbox "identity_evidence_id") 256) -and
    (Get-PropertyValue $mailbox "mailbox_purpose") -ceq "dedicated_non_production_canary" -and
    (Get-PropertyValue $mailbox "is_shared_mailbox") -eq $false -and
    (Get-PropertyValue $mailbox "is_production_mailbox") -eq $false
  $canaryValid = $sharedBindingValid -and $mailboxValid -and
    (Test-ExactProperties $canary $expectedCanaryProperties) -and
    (Get-PropertyValue $canary "schemaVersion") -ceq "inbox_zero_microsoft_canary_receipt.v1" -and
    (Get-PropertyValue $canary "provider") -ceq "microsoft" -and
    (Get-PropertyValue $canary "action") -ceq "draft_only" -and
    (Test-OpaqueEvidenceId (Get-PropertyValue $canary "threadId") 512) -and
    (Test-OpaqueEvidenceId (Get-PropertyValue $canary "sourceMessageId") 512) -and
    (Test-OpaqueEvidenceId (Get-PropertyValue $canary "draftId") 512) -and
    (Test-OpaqueEvidenceId (Get-PropertyValue $canary "idempotencyKey") 512) -and
    (Get-PropertyValue $canary "accountId") -ceq (Get-PropertyValue $mailbox "account_id") -and
    (Get-PropertyValue $canary "runNonce") -ceq $runNonce -and
    (Test-BoundedEvidenceTimestamp (Get-PropertyValue $canary "generatedAt") $startedAt $completedAt) -and
    (Get-PropertyValue $canary "graphReadbackStatus") -ceq "verified" -and
    (Get-PropertyValue $canary "scopeIdentity") -ceq "delegated:Mail.ReadWrite,User.Read,email,offline_access,openid,profile" -and
    (Get-PropertyValue $canary "noSendCapability") -ceq "Mail.Send_absent" -and
    (Get-PropertyValue $canary "idempotencyReplay") -in @("existing_draft_reconciled", "duplicate_prevented") -and
    (Get-PropertyValue $canary "terminalState") -ceq "created_verified" -and
    (Get-PropertyValue $canary "executorRegistrationId") -ceq (Get-PropertyValue $runner "executor_registration_id") -and
    (Get-PropertyValue $canary "executorProvenanceSha256") -ceq (Get-PropertyValue $runner "executor_registration_sha256") -and
    (Get-PropertyValue $canary "connectedIdentityEvidenceId") -ceq (Get-PropertyValue $mailbox "identity_evidence_id") -and
    (Test-OpaqueEvidenceId (Get-PropertyValue $canary "grantedScopesEvidenceId") 512) -and
    (Test-OpaqueEvidenceId (Get-PropertyValue $canary "noSendEvidenceId") 512) -and
    (Test-OpaqueEvidenceId (Get-PropertyValue $canary "graphReadbackEvidenceId") 512) -and
    (Test-OpaqueEvidenceId (Get-PropertyValue $canary "replayGraphReadbackEvidenceId") 512) -and
    (Test-OpaqueEvidenceId (Get-PropertyValue $canary "noDuplicateEvidenceId") 512) -and
    ((Get-PropertyValue $canary "idempotencyDraftCount") -is [int] -or (Get-PropertyValue $canary "idempotencyDraftCount") -is [long]) -and
    (Get-PropertyValue $canary "idempotencyDraftCount") -eq 1
  $replayValid = $sharedBindingValid -and $canaryValid -and
    (Test-ExactProperties $replay $expectedReplayProperties) -and
    (Get-PropertyValue $replay "schema_version") -ceq "coastline_inbox_zero_replay_evidence.v1" -and
    (Get-PropertyValue $replay "artifact_sha") -ceq $ExpectedSha -and
    (Get-PropertyValue $replay "run_id") -ceq $runId -and
    (Get-PropertyValue $replay "run_nonce") -ceq $runNonce -and
    (Test-BoundedEvidenceTimestamp (Get-PropertyValue $replay "verified_at") $startedAt $completedAt) -and
    (Get-PropertyValue $replay "terminal_state") -ceq "created_verified" -and
    (Get-PropertyValue $replay "idempotency_key") -ceq (Get-PropertyValue $canary "idempotencyKey") -and
    (Get-PropertyValue $replay "draft_id") -ceq (Get-PropertyValue $canary "draftId") -and
    (Get-PropertyValue $replay "idempotency_replay") -ceq (Get-PropertyValue $canary "idempotencyReplay") -and
    (Get-PropertyValue $replay "replay_graph_readback_evidence_id") -ceq (Get-PropertyValue $canary "replayGraphReadbackEvidenceId") -and
    (Get-PropertyValue $replay "no_duplicate_evidence_id") -ceq (Get-PropertyValue $canary "noDuplicateEvidenceId") -and
    ((Get-PropertyValue $replay "idempotency_draft_count") -is [int] -or (Get-PropertyValue $replay "idempotency_draft_count") -is [long]) -and
    (Get-PropertyValue $replay "idempotency_draft_count") -eq 1 -and
    (Get-EvidenceTimestamp (Get-PropertyValue $mailbox "verified_at")) -le (Get-EvidenceTimestamp (Get-PropertyValue $canary "generatedAt")) -and
    (Get-EvidenceTimestamp (Get-PropertyValue $canary "generatedAt")) -le (Get-EvidenceTimestamp (Get-PropertyValue $replay "verified_at"))
  if ($mailboxValid) {
    Add-Evidence -Id "dedicated_mailbox" -Status "pass"
  } else {
    Add-Evidence -Id "dedicated_mailbox" -Status "fail" -ReasonCode "DEDICATED_MAILBOX_EVIDENCE_INVALID"
  }
  if ($canaryValid) {
    Add-Evidence -Id "canary" -Status "pass"
  } else {
    Add-Evidence -Id "canary" -Status "fail" -ReasonCode "GRAPH_CANARY_RECEIPT_INVALID"
  }
  if ($replayValid) {
    Add-Evidence -Id "replay" -Status "pass"
  } else {
    Add-Evidence -Id "replay" -Status "fail" -ReasonCode "REPLAY_RESULT_INVALID"
  }
}

$rollbackEvidence = Get-EvidenceFile -Path $RollbackReceiptPath
if (-not $rollbackEvidence.supplied) {
  Add-Evidence -Id "rollback" -Status "missing" -ReasonCode "ROLLBACK_RESULT_MISSING"
} else {
  $rollback = $rollbackEvidence.value
  $rollbackStartedAt = Get-EvidenceTimestamp (Get-PropertyValue $rollback "started_at")
  $rollbackCompletedAt = Get-EvidenceTimestamp (Get-PropertyValue $rollback "completed_at")
  $expectedRollbackProperties = @(
    "schema_version", "artifact_sha", "run_id", "run_nonce", "started_at", "completed_at",
    "remote_staging_evidence_id", "canary_evidence_id", "replay_evidence_id",
    "rollback_evidence_id", "outcome", "draft_action_unavailable",
    "existing_draft_untouched", "no_mailbox_delete"
  )
  if ($rollbackEvidence.valid -and $stagingValid -and $canaryValid -and $replayValid -and
    (Test-ExactProperties $rollback $expectedRollbackProperties) -and
    (Get-PropertyValue $rollback "schema_version") -ceq "coastline_inbox_zero_rollback_receipt.v2" -and
    (Get-PropertyValue $rollback "artifact_sha") -ceq $ExpectedSha -and
    (Get-PropertyValue $rollback "run_id") -ceq $runId -and
    (Get-PropertyValue $rollback "run_nonce") -ceq $stagingRunNonce -and
    (Get-PropertyValue $rollback "run_nonce") -ceq $runNonce -and
    (Test-FreshWindow (Get-PropertyValue $rollback "started_at") (Get-PropertyValue $rollback "completed_at")) -and
    $rollbackStartedAt -ge $completedAt -and
    (Test-OpaqueEvidenceId (Get-PropertyValue $rollback "remote_staging_evidence_id")) -and
    (Get-PropertyValue $rollback "remote_staging_evidence_id") -ceq $stagingCronEvidenceId -and
    (Test-OpaqueEvidenceId (Get-PropertyValue $rollback "canary_evidence_id")) -and
    (Get-PropertyValue $rollback "canary_evidence_id") -ceq (Get-PropertyValue $canary "graphReadbackEvidenceId") -and
    (Test-OpaqueEvidenceId (Get-PropertyValue $rollback "replay_evidence_id")) -and
    (Get-PropertyValue $rollback "replay_evidence_id") -ceq (Get-PropertyValue $replay "replay_graph_readback_evidence_id") -and
    (Test-OpaqueEvidenceId (Get-PropertyValue $rollback "rollback_evidence_id")) -and
    (Get-PropertyValue $rollback "outcome") -ceq "pass" -and
    (Get-PropertyValue $rollback "draft_action_unavailable") -eq $true -and
    (Get-PropertyValue $rollback "existing_draft_untouched") -eq $true -and
    (Get-PropertyValue $rollback "no_mailbox_delete") -eq $true) {
    Add-Evidence -Id "rollback" -Status "pass"
  } else {
    Add-Evidence -Id "rollback" -Status "fail" -ReasonCode "ROLLBACK_RESULT_INVALID"
  }
}

$reviewEvidence = Get-EvidenceFile -Path $PrReviewEvidencePath
if (-not $reviewEvidence.supplied) {
  Add-Evidence -Id "pr_review" -Status "missing" -ReasonCode "PR_REVIEW_MISSING"
} else {
  $review = $reviewEvidence.value
  if ($reviewEvidence.valid -and
    (Get-PropertyValue $review "schema_version") -ceq "coastline_inbox_zero_pr_review_receipt.v1" -and
    (Get-PropertyValue $review "commit_sha") -ceq $ExpectedSha -and
    (Get-PropertyValue $review "base_branch") -ceq "main" -and
    (Get-PropertyValue $review "review_state") -ceq "approved" -and
    (Test-ReviewerIdentities (Get-PropertyValue $review "approving_reviewers"))) {
    Add-Evidence -Id "pr_review" -Status "pass"
  } else {
    Add-Evidence -Id "pr_review" -Status "fail" -ReasonCode "PR_REVIEW_INVALID"
  }
}

$state = if (@($matrix | Where-Object status -eq "fail").Count -gt 0) {
  "blocked"
} elseif (@($matrix | Where-Object status -eq "missing").Count -gt 0) {
  "pilot-only"
} else {
  "ready"
}
$record = [pscustomobject][ordered]@{
  schema_version = "coastline_inbox_zero_promotion_readiness.v1"
  current_sha = $actualSha
  evaluated_at = [DateTimeOffset]::UtcNow.ToString("o")
  state = $state
  reason_codes = @($reasonCodes | Select-Object -Unique)
  evidence_matrix = @($matrix)
}
$json = $record | ConvertTo-Json -Depth 7

if ($OutputPath) {
  $parent = Split-Path -Parent $OutputPath
  if (-not $parent -or -not (Test-Path -LiteralPath $parent -PathType Container)) {
    throw "OutputPath parent directory must already exist."
  }
  $resolvedParent = (Resolve-Path -LiteralPath $parent).Path
  $resolvedRoot = (Resolve-Path -LiteralPath $repoRoot).Path.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  if ($resolvedParent.StartsWith($resolvedRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "OutputPath must remain outside the repository."
  }
  $json | Set-Content -LiteralPath $OutputPath -Encoding utf8NoBOM
}

$json
