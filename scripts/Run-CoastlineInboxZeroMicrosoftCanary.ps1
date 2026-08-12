[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [Uri]$BaseUrl,
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$SourceMessageId,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[^\s@]+@[^\s@]+\.[^\s@]+$')]
  [string]$TestRecipient,
  [string]$BlockedReceiptPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$missingPrerequisiteCode = "COASTLINE_CANARY_MISSING_PROTECTED_PREREQUISITE"
$repoRoot = Split-Path -Parent $PSScriptRoot
$requiredVariables = @(
  "COASTLINE_INBOX_ZERO_PROTECTED_SHA",
  "COASTLINE_STAGING_BASE_URL",
  "COASTLINE_MICROSOFT_CANARY_EXECUTOR_REGISTRATION_PATH",
  "COASTLINE_MICROSOFT_CANARY_EXECUTOR_REGISTRATION_SHA256",
  "COASTLINE_MICROSOFT_CANARY_EXECUTOR_AUTH_TOKEN",
  "COASTLINE_MICROSOFT_CANARY_MAILBOX",
  "COASTLINE_MICROSOFT_CANARY_ACCOUNT_ID",
  "COASTLINE_MICROSOFT_CANARY_THREAD_ID",
  "COASTLINE_MICROSOFT_CANARY_SOURCE_MESSAGE_ID",
  "COASTLINE_MICROSOFT_CANARY_TEST_RECIPIENT",
  "COASTLINE_MICROSOFT_CANARY_SCOPE_IDENTITY",
  "COASTLINE_MICROSOFT_CANARY_SCOPES",
  "COASTLINE_MICROSOFT_CANARY_RECEIPT_DIR",
  "COASTLINE_DRAFT_PROPOSALS_ENABLED",
  "NEXT_PUBLIC_EMAIL_SEND_ENABLED"
)
$requiredEvidenceVariables = @(
  "COASTLINE_INBOX_ZERO_PROMOTION_RUN_NONCE",
  "COASTLINE_MICROSOFT_CANARY_PROTECTED_ENV_EVIDENCE_PATH",
  "COASTLINE_MICROSOFT_CANARY_PROTECTED_ENV_EVIDENCE_SHA256",
  "COASTLINE_MICROSOFT_CANARY_STAGING_EVIDENCE_PATH",
  "COASTLINE_MICROSOFT_CANARY_STAGING_EVIDENCE_SHA256",
  "COASTLINE_MICROSOFT_CANARY_ROLLBACK_CONTROL_PATH",
  "COASTLINE_MICROSOFT_CANARY_ROLLBACK_CONTROL_SHA256"
)
$contactedSystems = [System.Collections.Generic.List[string]]::new()

function Start-ExternalContact {
  param([string]$System)
  if (-not $contactedSystems.Contains($System)) { $contactedSystems.Add($System) }
}

function Stop-Canary {
  param(
    [string]$Code,
    [string]$Message,
    [string[]]$MissingPrerequisites = @()
  )
  Write-BlockedReceipt -Code $Code -MissingPrerequisites $MissingPrerequisites
  throw "[$Code] $Message"
}

function Write-BlockedReceipt {
  param(
    [string]$Code,
    [string[]]$MissingPrerequisites
  )

  if ([string]::IsNullOrWhiteSpace($BlockedReceiptPath)) {
    return
  }

  try {
    $resolvedRoot = (Resolve-Path -LiteralPath $repoRoot).Path.TrimEnd(
      [IO.Path]::DirectorySeparatorChar,
      [IO.Path]::AltDirectorySeparatorChar
    )
    $parent = Split-Path -Parent $BlockedReceiptPath
    if ([string]::IsNullOrWhiteSpace($parent) -or -not (Test-Path -LiteralPath $parent -PathType Container)) {
      return
    }
    $resolvedParent = (Resolve-Path -LiteralPath $parent).Path.TrimEnd(
      [IO.Path]::DirectorySeparatorChar,
      [IO.Path]::AltDirectorySeparatorChar
    )
    if ($resolvedParent.StartsWith("$resolvedRoot$([IO.Path]::DirectorySeparatorChar)", [StringComparison]::OrdinalIgnoreCase) -or
      $resolvedParent -ceq $resolvedRoot) {
      return
    }

    $currentSha = (& git -C $repoRoot rev-parse HEAD 2>$null).Trim()
    if ($currentSha -notmatch '^[a-f0-9]{40}$') {
      $currentSha = $null
    }
    [ordered]@{
      schema_version = "coastline_inbox_zero_canary_blocked_receipt.v1"
      terminal_state = "blocked"
      reason_code = $Code
      current_sha = $currentSha
      missing_prerequisites = @($MissingPrerequisites | Sort-Object -Unique)
      observed_at = [DateTimeOffset]::UtcNow.ToString("o")
      external_systems_touched = @($contactedSystems | Sort-Object)
    } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $BlockedReceiptPath -Encoding utf8NoBOM
  } catch {
    # Preserve the primary fail-closed canary error if receipt persistence is unavailable.
  }
}

function Get-Sha256 {
  param([string]$Value)
  $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
  return ([Security.Cryptography.SHA256]::HashData($bytes) | ForEach-Object { $_.ToString("x2") }) -join ""
}

function Get-IdempotencyKey {
  param([string]$AccountId, [string]$ThreadId, [string]$MessageId)
  return (@("inbox-zero", "draft", $AccountId, $ThreadId, $MessageId) |
    ForEach-Object { [Uri]::EscapeDataString($_) }) -join "/"
}

function Get-ExactMicrosoftScopes {
  param([string]$Value)

  $expected = @("Calendars.ReadWrite", "Mail.ReadWrite", "User.Read", "email", "offline_access", "openid", "profile")
  [string[]]$configured = @($Value -split '[,\s]+' | Where-Object { $_ })
  [Array]::Sort($configured, [StringComparer]::Ordinal)
  if (($configured -join "|") -cne ($expected -join "|")) {
    return $null
  }
  return $configured
}

function Test-ExactHttpsUrl {
  param([string]$Value, [string]$Expected)
  $actualUri = $null
  $expectedUri = $null
  return [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$actualUri) -and
    [Uri]::TryCreate($Expected, [UriKind]::Absolute, [ref]$expectedUri) -and
    $actualUri.Scheme -ceq "https" -and
    [string]::IsNullOrEmpty($actualUri.UserInfo) -and
    [string]::IsNullOrEmpty($actualUri.Query) -and
    [string]::IsNullOrEmpty($actualUri.Fragment) -and
    $actualUri.AbsoluteUri.TrimEnd("/") -ceq $expectedUri.AbsoluteUri.TrimEnd("/")
}

function Test-OpaqueValue {
  param([object]$Value, [int]$MaximumLength = 512)
  if ($Value -isnot [string] -or [string]::IsNullOrWhiteSpace($Value)) { return $false }
  $text = [string]$Value
  return $text.Length -le $MaximumLength -and $text -ceq $text.Trim() -and
    $text -notmatch '[\s@<>]' -and
    $text -notmatch '(?i)(token|secret|cookie|oauth|bearer|authorization|password|subject|body|recipient)'
}

function Test-IsoTimestamp {
  param([object]$Value)
  if ($Value -isnot [string] -or $Value -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$') { return $false }
  $parsed = [DateTimeOffset]::MinValue
  return [DateTimeOffset]::TryParse([string]$Value, [ref]$parsed)
}

function Assert-ExactProperties {
  param([object]$Value, [string[]]$Expected, [string]$Label)
  $actual = @($Value.PSObject.Properties.Name | Sort-Object)
  $expectedNames = @($Expected | Sort-Object)
  if (($actual -join "|") -cne ($expectedNames -join "|")) {
    throw "$Label returned unapproved fields."
  }
}

function Get-ProtectedEvidenceFile {
  param([string]$Path, [string]$ExpectedHash, [string[]]$ExpectedProperties, [string]$Label)
  if ([string]::IsNullOrWhiteSpace($Path) -or $ExpectedHash -notmatch '^[a-f0-9]{64}$' -or
    -not (Test-Path -LiteralPath $Path -PathType Leaf) -or
    (Resolve-Path -LiteralPath $Path).Path.StartsWith((Resolve-Path -LiteralPath $repoRoot).Path, [StringComparison]::OrdinalIgnoreCase) -or
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ExpectedHash) {
    throw "$Label provenance is invalid."
  }
  try {
    $value = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -DateKind String
    Assert-ExactProperties -Value $value -Expected $ExpectedProperties -Label $Label
    return $value
  } catch { throw "$Label is unreadable or has an invalid schema: $($_.Exception.Message)" }
}

function Test-FreshEvidenceTimestamp {
  param([object]$Value)
  if ($Value -is [DateTimeOffset]) {
    $time = $Value
  } elseif ($Value -is [DateTime]) {
    $time = [DateTimeOffset]$Value
  } else {
    if (-not (Test-IsoTimestamp $Value)) { return $false }
    $time = [DateTimeOffset]::Parse([string]$Value)
  }
  $now = [DateTimeOffset]::UtcNow
  return $time -ge $now.AddMinutes(-30) -and $time -le $now.AddMinutes(2)
}

function Test-OrderedStagingTimestamps {
  param([object]$StartedAt, [object]$WorkerHeartbeatAt, [object]$CompletedAt)
  if (-not (Test-IsoTimestamp $StartedAt) -or -not (Test-IsoTimestamp $WorkerHeartbeatAt) -or -not (Test-IsoTimestamp $CompletedAt)) { return $false }
  $started = [DateTimeOffset]::Parse([string]$StartedAt)
  $heartbeat = [DateTimeOffset]::Parse([string]$WorkerHeartbeatAt)
  $completed = [DateTimeOffset]::Parse([string]$CompletedAt)
  return $started -le $heartbeat -and $heartbeat -le $completed
}

function Get-IndependentEvidence {
  param([string]$Base, [string]$Kind, [hashtable]$Headers, [hashtable]$Query)
  $uri = [UriBuilder]::new("$($Base.TrimEnd('/'))/$Kind")
  $uri.Query = (($Query.GetEnumerator() | ForEach-Object {
    "{0}={1}" -f [Uri]::EscapeDataString($_.Key), [Uri]::EscapeDataString([string]$_.Value)
  }) -join "&")
  Start-ExternalContact -System "independent_verifier"
  if ($Kind -in @("graph-readback", "idempotency-replay", "no-duplicate")) {
    Start-ExternalContact -System "microsoft_graph_readback"
  }
  return Invoke-RestMethod -Uri $uri.Uri -Method Get -Headers $Headers -TimeoutSec 30
}

function Assert-IndependentEvidence {
  param(
    [object]$Evidence,
    [string]$Kind,
    [object]$Registration,
    [hashtable]$Expected
  )
  $expectedProperties = @(
    "schemaVersion", "kind", "evidenceId", "verifierId", "verifiedAt", "verified",
    "accountId", "mailboxSha256", "sourceMessageId", "threadId", "draftId",
    "scopeIdentity", "mailSendCapability", "recipientSha256", "idempotencyKey",
    "idempotencyDraftCount", "runNonce"
  )
  if ($Kind -eq "identity") {
    $expectedProperties += @("mailboxPurpose", "isSharedMailbox", "isProductionMailbox")
  }
  Assert-ExactProperties -Value $Evidence -Expected $expectedProperties -Label "Independent $Kind evidence"
  if ($Evidence.schemaVersion -cne "coastline_microsoft_canary_evidence.v1" -or
    $Evidence.kind -cne $Kind -or $Evidence.verifierId -cne $Registration.independentVerifierId -or
    $Evidence.verified -ne $true -or -not (Test-OpaqueValue $Evidence.evidenceId) -or
    -not (Test-OpaqueValue $Evidence.accountId) -or -not (Test-OpaqueValue $Evidence.threadId) -or
    -not (Test-OpaqueValue $Evidence.sourceMessageId) -or
    $Evidence.accountId -cne $Expected.accountId -or $Evidence.threadId -cne $Expected.threadId -or
    $Evidence.sourceMessageId -cne $Expected.sourceMessageId -or
    $Evidence.mailboxSha256 -cne $Expected.mailboxSha256 -or
    $Evidence.recipientSha256 -cne $Expected.recipientSha256 -or
    $Evidence.scopeIdentity -cne $Expected.scopeIdentity -or
    $Evidence.idempotencyKey -cne $Expected.idempotencyKey -or $Evidence.runNonce -cne $Expected.runNonce -or
    $Evidence.mailSendCapability -cne "absent" -or -not (Test-IsoTimestamp $Evidence.verifiedAt)) {
    throw "Independent $Kind evidence did not bind the protected identity and no-send values."
  }
  if ($Expected.ContainsKey("draftId") -and
    (-not (Test-OpaqueValue $Evidence.draftId) -or $Evidence.draftId -cne $Expected.draftId)) {
    throw "Independent $Kind evidence did not bind the created draft ID."
  }
  if ($Kind -eq "no-duplicate" -and
    (($Evidence.idempotencyDraftCount -isnot [int] -and $Evidence.idempotencyDraftCount -isnot [long]) -or
      $Evidence.idempotencyDraftCount -ne 1)) {
    throw "Independent no-duplicate evidence did not attest an exact idempotency-bound draft count of one."
  }
  if ($Kind -ne "no-duplicate" -and $null -ne $Evidence.idempotencyDraftCount) {
    throw "Only the independent no-duplicate attestation may contain an idempotency draft count."
  }
  if ($Kind -eq "identity" -and
    ($Evidence.mailboxPurpose -cne "dedicated_non_production_canary" -or
      $Evidence.isSharedMailbox -ne $false -or $Evidence.isProductionMailbox -ne $false)) {
    throw "Independent identity evidence did not attest a dedicated non-production, non-shared mailbox."
  }
  return $Evidence
}

$values = @{}
foreach ($name in $requiredVariables) {
  $value = [Environment]::GetEnvironmentVariable($name)
  if (-not [string]::IsNullOrWhiteSpace($value)) { $values[$name] = $value.Trim() }
}
$missing = @($requiredVariables | Where-Object { -not $values.ContainsKey($_) })
if ($missing.Count -gt 0) {
  Stop-Canary -Code $missingPrerequisiteCode -Message "Missing protected prerequisites: $($missing -join ',')." -MissingPrerequisites $missing
}

$currentSha = (& git -C $repoRoot rev-parse HEAD 2>$null).Trim()
if ($currentSha -notmatch '^[a-f0-9]{40}$' -or
  $values.COASTLINE_INBOX_ZERO_PROTECTED_SHA -notmatch '^[a-f0-9]{40}$' -or
  $values.COASTLINE_INBOX_ZERO_PROTECTED_SHA -cne $currentSha) {
  Stop-Canary -Code "COASTLINE_CANARY_PROTECTED_SHA_MISMATCH" -Message "Protected staging SHA does not match the current approved artifact."
}

if (-not (Test-ExactHttpsUrl -Value $BaseUrl.AbsoluteUri -Expected $values.COASTLINE_STAGING_BASE_URL)) {
  Stop-Canary -Code "COASTLINE_CANARY_UNSAFE_STAGING_TARGET" -Message "BaseUrl must exactly match the protected HTTPS staging origin."
}
if ($SourceMessageId -cne $values.COASTLINE_MICROSOFT_CANARY_SOURCE_MESSAGE_ID) {
  Stop-Canary -Code "COASTLINE_CANARY_SOURCE_MESSAGE_MISMATCH" -Message "SourceMessageId does not match the protected dedicated-test source message."
}
if ($TestRecipient -cne $values.COASTLINE_MICROSOFT_CANARY_TEST_RECIPIENT -or
  $TestRecipient -match '(?i)(^|[-_.@])(owner|resident|tenant|vendor|ap|accounts?payable|production|operations?)([-_.@]|$)') {
  Stop-Canary -Code "COASTLINE_CANARY_TEST_RECIPIENT_UNSAFE" -Message "TestRecipient is not the protected dedicated-test recipient."
}
if ($values.COASTLINE_MICROSOFT_CANARY_MAILBOX -notmatch '^[^\s@]+@[^\s@]+\.[^\s@]+$' -or
  $values.COASTLINE_MICROSOFT_CANARY_MAILBOX -match '(?i)(^|[-_.@])(owner|resident|tenant|vendor|ap|accounts?payable|production|operations?)([-_.@]|$)') {
  Stop-Canary -Code "COASTLINE_CANARY_MAILBOX_UNSAFE" -Message "Protected mailbox is not a dedicated test mailbox."
}
if ($values.COASTLINE_DRAFT_PROPOSALS_ENABLED -cne "true" -or $values.NEXT_PUBLIC_EMAIL_SEND_ENABLED -cne "false") {
  Stop-Canary -Code "COASTLINE_CANARY_DRAFT_ONLY_POLICY_UNVERIFIED" -Message "Draft-only staging policy is not enabled with sending disabled."
}
$scopes = @(Get-ExactMicrosoftScopes -Value $values.COASTLINE_MICROSOFT_CANARY_SCOPES)
$expectedScopeIdentity = "delegated:$($scopes -join ',')"
if ($scopes.Count -ne 7 -or $values.COASTLINE_MICROSOFT_CANARY_SCOPE_IDENTITY -cne $expectedScopeIdentity) {
  Stop-Canary -Code "COASTLINE_CANARY_MICROSOFT_SCOPES_MISMATCH" -Message "Protected Microsoft scopes and connected identity must exactly match the draft-only allowlist."
}

foreach ($name in $requiredEvidenceVariables) {
  $value = [Environment]::GetEnvironmentVariable($name)
  if (-not [string]::IsNullOrWhiteSpace($value)) { $values[$name] = $value.Trim() }
}
$missingEvidence = @($requiredEvidenceVariables | Where-Object { -not $values.ContainsKey($_) })
if ($missingEvidence.Count -gt 0) {
  Stop-Canary -Code $missingPrerequisiteCode -Message "Missing protected evidence prerequisites: $($missingEvidence -join ',')." -MissingPrerequisites $missingEvidence
}
$runNonce = $values.COASTLINE_INBOX_ZERO_PROMOTION_RUN_NONCE
if ($runNonce -notmatch '^[a-f0-9]{32}$') {
  Stop-Canary -Code "COASTLINE_CANARY_PROMOTION_NONCE_INVALID" -Message "Protected promotion run nonce is invalid."
}

$registrationPath = $values.COASTLINE_MICROSOFT_CANARY_EXECUTOR_REGISTRATION_PATH
if (-not (Test-Path -LiteralPath $registrationPath -PathType Leaf) -or
  (Resolve-Path $registrationPath).Path.StartsWith((Resolve-Path $repoRoot).Path, [StringComparison]::OrdinalIgnoreCase) -or
  (Get-FileHash -LiteralPath $registrationPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $values.COASTLINE_MICROSOFT_CANARY_EXECUTOR_REGISTRATION_SHA256) {
  Stop-Canary -Code "COASTLINE_CANARY_EXECUTOR_PROVENANCE_INVALID" -Message "Protected executor registration provenance could not be verified."
}
try { $registration = Get-Content -LiteralPath $registrationPath -Raw | ConvertFrom-Json } catch {
  Stop-Canary -Code "COASTLINE_CANARY_EXECUTOR_PROVENANCE_INVALID" -Message "Protected executor registration is unreadable."
}
try {
  Assert-ExactProperties -Value $registration -Expected @(
    "schemaVersion", "registrationId", "executorId", "executorUrl", "authentication",
    "provider", "action", "draftOnly", "noSend", "independentVerifierId", "independentVerifierBaseUrl"
  ) -Label "Executor registration"
  $expectedExecutorUrl = "$($BaseUrl.AbsoluteUri.TrimEnd('/'))/api/coastline/microsoft-draft-canary/v1"
  if ($registration.schemaVersion -cne "coastline_inbox_zero_microsoft_canary_executor_registration.v1" -or
    -not (Test-OpaqueValue $registration.registrationId 256) -or -not (Test-OpaqueValue $registration.executorId 256) -or
    -not (Test-OpaqueValue $registration.independentVerifierId 256) -or
    -not (Test-ExactHttpsUrl -Value $registration.executorUrl -Expected $expectedExecutorUrl) -or
    $registration.authentication -cne "bearer" -or $registration.provider -cne "microsoft" -or
    $registration.action -cne "outlook_draft_create" -or $registration.draftOnly -ne $true -or
    $registration.noSend -ne $true -or
    -not (Test-ExactHttpsUrl -Value $registration.independentVerifierBaseUrl -Expected $registration.independentVerifierBaseUrl) -or
    ([Uri]$registration.independentVerifierBaseUrl).Authority -ceq ([Uri]$registration.executorUrl).Authority) {
    throw "Executor registration is not the registered authenticated draft-only allowlist entry."
  }
} catch {
  Stop-Canary -Code "COASTLINE_CANARY_EXECUTOR_PROVENANCE_INVALID" -Message "Protected executor registration did not satisfy the allowlist contract."
}

try {
  $protectedEnvironmentEvidence = Get-ProtectedEvidenceFile -Path $values.COASTLINE_MICROSOFT_CANARY_PROTECTED_ENV_EVIDENCE_PATH -ExpectedHash $values.COASTLINE_MICROSOFT_CANARY_PROTECTED_ENV_EVIDENCE_SHA256 -ExpectedProperties @("schema_version", "artifact_sha", "environment_name", "protected", "run_nonce", "observed_at") -Label "Protected environment evidence"
  $validProtectedEnvironment = ([string]$protectedEnvironmentEvidence.schema_version) -ceq "coastline_inbox_zero_protected_environment_evidence.v1" -and
    ([string]$protectedEnvironmentEvidence.artifact_sha) -ceq $currentSha -and ([string]$protectedEnvironmentEvidence.environment_name) -ceq "coastline-inbox-zero-staging" -and
    ([bool]$protectedEnvironmentEvidence.'protected') -eq $true -and ([string]$protectedEnvironmentEvidence.run_nonce) -ceq $runNonce -and
    (Test-FreshEvidenceTimestamp $protectedEnvironmentEvidence.observed_at)
  if (-not $validProtectedEnvironment) { throw "Protected environment evidence is not bound to this approved artifact and promotion run." }
} catch {
  Stop-Canary -Code "COASTLINE_CANARY_PROTECTED_ENV_EVIDENCE_INVALID" -Message "Exact current-SHA protected-environment evidence is required before external contact."
}

try {
  $stagingEvidence = Get-ProtectedEvidenceFile -Path $values.COASTLINE_MICROSOFT_CANARY_STAGING_EVIDENCE_PATH -ExpectedHash $values.COASTLINE_MICROSOFT_CANARY_STAGING_EVIDENCE_SHA256 -ExpectedProperties @("schema_version", "provenance", "is_loopback", "run_nonce", "started_at", "completed_at", "artifact_sha", "worker_artifact_sha", "worker_heartbeat_at", "remote_worker_identity", "remote_queue_identity", "cron_evidence_id", "service_states", "checks", "outcome") -Label "Remote staging evidence"
  $expectedStagingChecks = @("WEB_HEALTH", "CRON_UNAUTHENTICATED_REJECTED", "CRON_AUTHENTICATED_SUCCESS", "REMOTE_ARTIFACT_WORKER_QUEUE")
  $stagingChecks = @($stagingEvidence.checks)
  $validStagingChecks = $stagingChecks.Count -eq 4 -and
    ((@($stagingChecks | ForEach-Object { $_.code } | Sort-Object) -join "|") -ceq (($expectedStagingChecks | Sort-Object) -join "|")) -and
    @($stagingChecks | Where-Object {
      -not (($_.PSObject.Properties.Name | Sort-Object) -join "|" -ceq ((@("code", "status") | Sort-Object) -join "|")) -or $_.status -cne "pass"
    }).Count -eq 0
  $validStagingEvidence = $stagingEvidence.schema_version -ceq "coastline_inbox_zero_staging_receipt.v2" -and $stagingEvidence.provenance -ceq "remote_https" -and
    $stagingEvidence.is_loopback -eq $false -and $stagingEvidence.run_nonce -ceq $runNonce -and
    $stagingEvidence.artifact_sha -ceq $currentSha -and $stagingEvidence.worker_artifact_sha -ceq $currentSha -and
    $stagingEvidence.outcome -ceq "pass" -and $stagingEvidence.cron_evidence_id -match '^[a-f0-9]{64}$' -and
    -not [string]::IsNullOrWhiteSpace($stagingEvidence.remote_worker_identity) -and -not [string]::IsNullOrWhiteSpace($stagingEvidence.remote_queue_identity) -and
    (Test-FreshEvidenceTimestamp $stagingEvidence.completed_at) -and (Test-FreshEvidenceTimestamp $stagingEvidence.worker_heartbeat_at) -and
    (Test-OrderedStagingTimestamps $stagingEvidence.started_at $stagingEvidence.worker_heartbeat_at $stagingEvidence.completed_at) -and
    $stagingEvidence.service_states.web -ceq "healthy" -and $stagingEvidence.service_states.worker -ceq "running" -and
    $stagingEvidence.service_states.queue -ceq "reachable" -and $stagingEvidence.service_states.cron_unauthenticated -ceq "rejected" -and
    $stagingEvidence.service_states.cron_authenticated -ceq "verified" -and $validStagingChecks
  if (-not $validStagingEvidence) { throw "Remote staging evidence is not a fresh nonce-bound immutable worker-artifact receipt." }
} catch {
  Stop-Canary -Code "COASTLINE_CANARY_STAGING_EVIDENCE_INVALID" -Message "Fresh nonce-bound remote staging evidence is required before external contact."
}

try {
  $rollbackControl = Get-ProtectedEvidenceFile -Path $values.COASTLINE_MICROSOFT_CANARY_ROLLBACK_CONTROL_PATH -ExpectedHash $values.COASTLINE_MICROSOFT_CANARY_ROLLBACK_CONTROL_SHA256 -ExpectedProperties @("schema_version", "artifact_sha", "run_nonce", "prepared_at", "terminal_state", "disable_draft_proposals", "preserve_mailbox_data", "rollback_artifact_sha") -Label "Rollback control"
  $validRollbackControl = $rollbackControl.schema_version -ceq "coastline_inbox_zero_rollback_control.v1" -and $rollbackControl.artifact_sha -ceq $currentSha -and
    $rollbackControl.run_nonce -ceq $runNonce -and $rollbackControl.terminal_state -ceq "prepared" -and
    $rollbackControl.disable_draft_proposals -eq $true -and $rollbackControl.preserve_mailbox_data -eq $true -and
    $rollbackControl.rollback_artifact_sha -match '^[a-f0-9]{40}$' -and (Test-FreshEvidenceTimestamp $rollbackControl.prepared_at)
  if (-not $validRollbackControl) { throw "Rollback control is not bound to this approved artifact and promotion run." }
} catch {
  Stop-Canary -Code "COASTLINE_CANARY_ROLLBACK_CONTROL_INVALID" -Message "An explicit no-mailbox-delete rollback control is required before external contact."
}

$receiptDirectory = $values.COASTLINE_MICROSOFT_CANARY_RECEIPT_DIR
if (-not (Test-Path -LiteralPath $receiptDirectory -PathType Container) -or
  (Resolve-Path $receiptDirectory).Path.StartsWith((Resolve-Path $repoRoot).Path, [StringComparison]::OrdinalIgnoreCase)) {
  Stop-Canary -Code $missingPrerequisiteCode -Message "Receipt directory must exist outside the repository."
}

$headers = @{ Authorization = "Bearer $($values.COASTLINE_MICROSOFT_CANARY_EXECUTOR_AUTH_TOKEN)"; "X-Coastline-Canary-Executor-Id" = $registration.executorId }
$runStartedAt = [DateTimeOffset]::UtcNow
$expected = @{
  accountId = $values.COASTLINE_MICROSOFT_CANARY_ACCOUNT_ID
  threadId = $values.COASTLINE_MICROSOFT_CANARY_THREAD_ID
  sourceMessageId = $SourceMessageId
  mailboxSha256 = Get-Sha256 $values.COASTLINE_MICROSOFT_CANARY_MAILBOX
  recipientSha256 = Get-Sha256 $TestRecipient
  scopeIdentity = $values.COASTLINE_MICROSOFT_CANARY_SCOPE_IDENTITY
  runNonce = $runNonce
}
$idempotencyKey = Get-IdempotencyKey -AccountId $expected.accountId -ThreadId $expected.threadId -MessageId $SourceMessageId
$expected.idempotencyKey = $idempotencyKey
try {
  $evidence = @{}
  foreach ($kind in @("identity", "scopes", "no-send")) {
    $evidence[$kind] = Assert-IndependentEvidence -Evidence (Get-IndependentEvidence -Base $registration.independentVerifierBaseUrl -Kind $kind -Headers $headers -Query $expected) -Kind $kind -Registration $registration -Expected $expected
  }
} catch {
  Stop-Canary -Code "COASTLINE_CANARY_INDEPENDENT_EVIDENCE_MISSING" -Message "Independent identity, scope, or no-send evidence was unavailable or mismatched."
}

$payload = [ordered]@{ action = "outlook_draft_create"; provider = "microsoft"; sourceMessageId = $SourceMessageId; testRecipient = $TestRecipient; idempotencyKey = $idempotencyKey; runNonce = $runNonce; draftOnly = $true; externalMessage = $false }
try {
  Start-ExternalContact -System "draft_only_executor"
  $response = Invoke-RestMethod -Uri $registration.executorUrl -Method Post -Headers $headers -ContentType "application/json" -Body ($payload | ConvertTo-Json -Compress) -TimeoutSec 30
} catch {
  Stop-Canary -Code "COASTLINE_CANARY_EXECUTOR_UNVERIFIED" -Message "The authenticated draft-only executor did not return a receipt."
}
if (-not (Test-OpaqueValue $response.draftId)) {
  Stop-Canary -Code "COASTLINE_CANARY_DRAFT_ID_INVALID" -Message "The executor returned an invalid draft ID."
}
$expected.draftId = $response.draftId
try {
  $evidence["graph-readback"] = Assert-IndependentEvidence -Evidence (Get-IndependentEvidence -Base $registration.independentVerifierBaseUrl -Kind "graph-readback" -Headers $headers -Query $expected) -Kind "graph-readback" -Registration $registration -Expected $expected
  Start-ExternalContact -System "draft_only_executor"
  $replayResponse = Invoke-RestMethod -Uri $registration.executorUrl -Method Post -Headers $headers -ContentType "application/json" -Body ($payload | ConvertTo-Json -Compress) -TimeoutSec 30
  if (-not (Test-OpaqueValue $replayResponse.draftId) -or $replayResponse.draftId -cne $expected.draftId -or
    $replayResponse.idempotencyReplay -notin @("existing_draft_reconciled", "duplicate_prevented")) {
    throw "Idempotency replay did not reconcile the original draft."
  }
  $evidence["idempotency-replay"] = Assert-IndependentEvidence -Evidence (Get-IndependentEvidence -Base $registration.independentVerifierBaseUrl -Kind "idempotency-replay" -Headers $headers -Query $expected) -Kind "idempotency-replay" -Registration $registration -Expected $expected
  $evidence["no-duplicate"] = Assert-IndependentEvidence -Evidence (Get-IndependentEvidence -Base $registration.independentVerifierBaseUrl -Kind "no-duplicate" -Headers $headers -Query $expected) -Kind "no-duplicate" -Registration $registration -Expected $expected
} catch {
  Stop-Canary -Code "COASTLINE_CANARY_REPLAY_OR_READBACK_UNVERIFIED" -Message "Independent Graph readback or same-key idempotency replay was unavailable, mismatched, or created another draft."
}

$expectedReceiptProperties = @("schemaVersion", "provider", "action", "accountId", "threadId", "sourceMessageId", "draftId", "idempotencyKey", "runNonce", "graphReadbackStatus", "scopeIdentity", "noSendCapability", "idempotencyReplay", "terminalState", "generatedAt", "executorRegistrationId", "executorProvenanceSha256", "connectedIdentityEvidenceId", "grantedScopesEvidenceId", "noSendEvidenceId", "graphReadbackEvidenceId", "replayGraphReadbackEvidenceId", "noDuplicateEvidenceId", "idempotencyDraftCount")
try {
  Assert-ExactProperties -Value $response -Expected $expectedReceiptProperties -Label "Canary receipt"
  $valid = $response.schemaVersion -ceq "inbox_zero_microsoft_canary_receipt.v1" -and $response.provider -ceq "microsoft" -and $response.action -ceq "draft_only" -and
    $response.accountId -ceq $expected.accountId -and $response.threadId -ceq $expected.threadId -and $response.sourceMessageId -ceq $expected.sourceMessageId -and $response.draftId -ceq $expected.draftId -and
    $response.idempotencyKey -ceq $idempotencyKey -and $response.runNonce -ceq $runNonce -and $response.graphReadbackStatus -ceq "verified" -and $response.scopeIdentity -ceq $expected.scopeIdentity -and
    $response.noSendCapability -ceq "Mail.Send_absent" -and $response.idempotencyReplay -in @("existing_draft_reconciled", "duplicate_prevented") -and $response.terminalState -ceq "created_verified" -and
    $response.executorRegistrationId -ceq $registration.registrationId -and $response.executorProvenanceSha256 -ceq $values.COASTLINE_MICROSOFT_CANARY_EXECUTOR_REGISTRATION_SHA256 -and
    $response.connectedIdentityEvidenceId -ceq $evidence["identity"].evidenceId -and
    $response.grantedScopesEvidenceId -ceq $evidence["scopes"].evidenceId -and
    $response.noSendEvidenceId -ceq $evidence["no-send"].evidenceId -and
    $response.graphReadbackEvidenceId -ceq $evidence["graph-readback"].evidenceId -and
    $response.replayGraphReadbackEvidenceId -ceq $evidence["idempotency-replay"].evidenceId -and
    $response.noDuplicateEvidenceId -ceq $evidence["no-duplicate"].evidenceId -and
    ($response.idempotencyDraftCount -is [int] -or $response.idempotencyDraftCount -is [long]) -and
    $response.idempotencyDraftCount -eq 1
  if (-not $valid) { throw "Canary receipt values did not satisfy the independent-evidence contract." }
  foreach ($field in $expectedReceiptProperties) {
    if ($field -notin @("schemaVersion", "provider", "action", "graphReadbackStatus", "noSendCapability", "idempotencyReplay", "terminalState", "generatedAt", "executorProvenanceSha256", "idempotencyDraftCount") -and -not (Test-OpaqueValue $response.$field 512)) { throw "Canary receipt contains an unsafe value." }
  }
  $orderedTimes = @($evidence.identity.verifiedAt, $evidence.scopes.verifiedAt, $evidence."no-send".verifiedAt, $response.generatedAt, $evidence."graph-readback".verifiedAt, $evidence."idempotency-replay".verifiedAt, $evidence."no-duplicate".verifiedAt) | ForEach-Object { [DateTimeOffset]::Parse($_) }
  $now = [DateTimeOffset]::UtcNow
  if ($response.executorProvenanceSha256 -notmatch '^[a-f0-9]{64}$' -or -not (Test-IsoTimestamp $response.generatedAt) -or @($orderedTimes | Where-Object { $_ -lt $runStartedAt.AddMinutes(-2) -or $_ -gt $now.AddMinutes(2) }).Count -gt 0) { throw "Canary receipt contains an invalid or unbounded timestamp." }
  for ($i = 1; $i -lt $orderedTimes.Count; $i++) { if ($orderedTimes[$i] -lt $orderedTimes[$i - 1]) { throw "Canary evidence timestamps are not ordered." } }
} catch {
  Stop-Canary -Code "COASTLINE_CANARY_RECEIPT_INVALID" -Message "The canary receipt was invalid or contained unapproved fields."
}

$receiptSuffix = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssZ")
$runId = Get-Sha256 "$currentSha|$runNonce|$($registration.registrationId)"
$runnerProvenance = [ordered]@{
  schema_version = "coastline_inbox_zero_canary_runner_provenance.v1"
  artifact_sha = $currentSha
  run_id = $runId
  run_nonce = $runNonce
  executor_registration_id = $registration.registrationId
  executor_registration_sha256 = $values.COASTLINE_MICROSOFT_CANARY_EXECUTOR_REGISTRATION_SHA256
  executor_id = $registration.executorId
  verifier_id = $registration.independentVerifierId
}
$dedicatedMailbox = [ordered]@{
  schema_version = "coastline_inbox_zero_dedicated_mailbox_evidence.v1"
  artifact_sha = $currentSha
  run_id = $runId
  run_nonce = $runNonce
  verified_at = $evidence["identity"].verifiedAt
  environment = "staging"
  mailbox_identity_sha256 = $expected.mailboxSha256
  account_id = $expected.accountId
  identity_evidence_id = $evidence["identity"].evidenceId
  mailbox_purpose = $evidence["identity"].mailboxPurpose
  is_shared_mailbox = $evidence["identity"].isSharedMailbox
  is_production_mailbox = $evidence["identity"].isProductionMailbox
}
$replayEvidence = [ordered]@{
  schema_version = "coastline_inbox_zero_replay_evidence.v1"
  artifact_sha = $currentSha
  run_id = $runId
  run_nonce = $runNonce
  verified_at = $evidence["idempotency-replay"].verifiedAt
  terminal_state = "created_verified"
  idempotency_key = $response.idempotencyKey
  draft_id = $response.draftId
  idempotency_replay = $response.idempotencyReplay
  replay_graph_readback_evidence_id = $response.replayGraphReadbackEvidenceId
  no_duplicate_evidence_id = $response.noDuplicateEvidenceId
  idempotency_draft_count = $response.idempotencyDraftCount
}
$canaryReceiptPath = Join-Path $receiptDirectory ("inbox-zero-microsoft-canary-{0}.json" -f $receiptSuffix)
$runnerProvenancePath = Join-Path $receiptDirectory ("inbox-zero-runner-provenance-{0}.json" -f $receiptSuffix)
$dedicatedMailboxPath = Join-Path $receiptDirectory ("inbox-zero-dedicated-mailbox-{0}.json" -f $receiptSuffix)
$replayEvidencePath = Join-Path $receiptDirectory ("inbox-zero-replay-evidence-{0}.json" -f $receiptSuffix)
$promotionBundlePath = Join-Path $receiptDirectory ("inbox-zero-promotion-canary-evidence-{0}.json" -f $receiptSuffix)
$assemblerPath = Join-Path $repoRoot "scripts/Assemble-CoastlineInboxZeroPromotionCanaryEvidence.ps1"
try {
  if (-not (Test-Path -LiteralPath $assemblerPath -PathType Leaf)) { throw "Promotion assembler is unavailable." }
  $response | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $canaryReceiptPath -Encoding utf8NoBOM
  $runnerProvenance | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $runnerProvenancePath -Encoding utf8NoBOM
  $dedicatedMailbox | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $dedicatedMailboxPath -Encoding utf8NoBOM
  $replayEvidence | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $replayEvidencePath -Encoding utf8NoBOM
  & $assemblerPath -ExpectedSha $currentSha -RemoteStagingReceiptPath $values.COASTLINE_MICROSOFT_CANARY_STAGING_EVIDENCE_PATH -RunnerProvenancePath $runnerProvenancePath -DedicatedMailboxEvidencePath $dedicatedMailboxPath -CanaryReceiptPath $canaryReceiptPath -ReplayReceiptPath $replayEvidencePath -OutputPath $promotionBundlePath | Out-Null
} catch {
  Stop-Canary -Code "COASTLINE_CANARY_EVIDENCE_PERSISTENCE_INVALID" -Message "The sanitized promotion evidence bundle could not be persisted."
}
$response | ConvertTo-Json -Depth 4
