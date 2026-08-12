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
} elseif (-not $localEvidence.valid -or
  (Get-PropertyValue $localEvidence.value "schema_version") -cne "coastline_inbox_zero_local_validation_receipt.v1") {
  foreach ($id in @("build", "full_test", "integration", "pester")) {
    Add-Evidence -Id $id -Status "fail" -ReasonCode "LOCAL_EVIDENCE_INVALID"
  }
} elseif ((Get-PropertyValue $localEvidence.value "commit_sha") -cne $ExpectedSha) {
  foreach ($id in @("build", "full_test", "integration", "pester")) {
    Add-Evidence -Id $id -Status "fail" -ReasonCode "LOCAL_EVIDENCE_SHA_MISMATCH"
  }
} else {
  $localResults = Get-PropertyValue $localEvidence.value "results"
  $localContracts = [ordered]@{
    build = "pnpm.cmd --filter inbox-zero-ai run build:ci"
    full_test = "pnpm.cmd --filter inbox-zero-ai test -- --run"
    integration = "pnpm.cmd --filter inbox-zero-ai test-integration"
    pester = "Invoke-Pester -Script scripts/tests -PassThru"
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
  $environmentValid = $environmentEvidence.valid -and
    (Get-PropertyValue $environment "schema_version") -ceq "coastline_inbox_zero_protected_environment_receipt.v1" -and
    (Get-PropertyValue $environment "commit_sha") -ceq $ExpectedSha -and
    (Get-PropertyValue $environment "environment") -ceq "coastline-inbox-zero-staging" -and
    (Get-PropertyValue $environment "deployment_branch_rule") -ceq "refs/heads/main" -and
    (Get-PropertyValue $environment "protected_sha") -ceq $ExpectedSha -and
    @(Get-PropertyValue $environment "required_reviewers").Count -gt 0 -and
    (Get-PropertyValue $environment "prevent_self_review") -eq $true -and
    (Test-ExactSet @(Get-PropertyValue $environment "configured_secret_names") $requiredSecretNames)
  if ($environmentValid) {
    Add-Evidence -Id "protected_environment" -Status "pass"
  } else {
    Add-Evidence -Id "protected_environment" -Status "fail" -ReasonCode "PROTECTED_ENVIRONMENT_EVIDENCE_INVALID"
  }
}

$stagingEvidence = Get-EvidenceFile -Path $RemoteStagingReceiptPath
if (-not $stagingEvidence.supplied) {
  Add-Evidence -Id "remote_staging" -Status "missing" -ReasonCode "REMOTE_STAGING_RECEIPT_MISSING"
} else {
  $staging = $stagingEvidence.value
  if ($stagingEvidence.valid -and
    (Get-PropertyValue $staging "schema_version") -ceq "coastline_inbox_zero_staging_receipt.v2" -and
    (Get-PropertyValue $staging "artifact_sha") -ceq $ExpectedSha -and
    (Get-PropertyValue $staging "outcome") -ceq "pass") {
    Add-Evidence -Id "remote_staging" -Status "pass"
  } else {
    Add-Evidence -Id "remote_staging" -Status "fail" -ReasonCode "REMOTE_STAGING_RECEIPT_INVALID"
  }
}

$canaryEvidence = Get-EvidenceFile -Path $CanaryReceiptPath
if (-not $canaryEvidence.supplied) {
  Add-Evidence -Id "dedicated_mailbox" -Status "missing" -ReasonCode "DEDICATED_MAILBOX_EVIDENCE_MISSING"
  Add-Evidence -Id "canary" -Status "missing" -ReasonCode "GRAPH_CANARY_RECEIPT_MISSING"
  Add-Evidence -Id "replay" -Status "missing" -ReasonCode "REPLAY_RESULT_MISSING"
} else {
  $canary = $canaryEvidence.value
  $canaryValid = $canaryEvidence.valid -and
    (Get-PropertyValue $canary "schemaVersion") -ceq "inbox_zero_microsoft_canary_receipt.v1" -and
    (Get-PropertyValue $canary "graphReadbackStatus") -ceq "verified" -and
    (Get-PropertyValue $canary "terminalState") -ceq "created_verified" -and
    (Get-PropertyValue $canary "noSendCapability") -ceq "Mail.Send_absent" -and
    (Get-PropertyValue $canary "idempotencyReplay") -in @("existing_draft_reconciled", "duplicate_prevented") -and
    ((Get-PropertyValue $canary "idempotencyDraftCount") -is [int] -or
      (Get-PropertyValue $canary "idempotencyDraftCount") -is [long]) -and
    (Get-PropertyValue $canary "idempotencyDraftCount") -eq 1
  if ($canaryValid) {
    Add-Evidence -Id "dedicated_mailbox" -Status "pass"
    Add-Evidence -Id "canary" -Status "pass"
    Add-Evidence -Id "replay" -Status "pass"
  } else {
    Add-Evidence -Id "dedicated_mailbox" -Status "fail" -ReasonCode "DEDICATED_MAILBOX_EVIDENCE_INVALID"
    Add-Evidence -Id "canary" -Status "fail" -ReasonCode "GRAPH_CANARY_RECEIPT_INVALID"
    Add-Evidence -Id "replay" -Status "fail" -ReasonCode "REPLAY_RESULT_INVALID"
  }
}

$rollbackEvidence = Get-EvidenceFile -Path $RollbackReceiptPath
if (-not $rollbackEvidence.supplied) {
  Add-Evidence -Id "rollback" -Status "missing" -ReasonCode "ROLLBACK_RESULT_MISSING"
} else {
  $rollback = $rollbackEvidence.value
  if ($rollbackEvidence.valid -and
    (Get-PropertyValue $rollback "schema_version") -ceq "coastline_inbox_zero_rollback_receipt.v1" -and
    (Get-PropertyValue $rollback "commit_sha") -ceq $ExpectedSha -and
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
    @(Get-PropertyValue $review "approving_reviewers").Count -gt 0) {
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
