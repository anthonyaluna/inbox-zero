[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [ValidatePattern('^[a-f0-9]{40}$')] [string]$ExpectedSha,
  [Parameter(Mandatory = $true)] [string]$RemoteStagingReceiptPath,
  [Parameter(Mandatory = $true)] [string]$RunnerProvenancePath,
  [Parameter(Mandatory = $true)] [string]$DedicatedMailboxEvidencePath,
  [Parameter(Mandatory = $true)] [string]$CanaryReceiptPath,
  [Parameter(Mandatory = $true)] [string]$ReplayReceiptPath,
  [Parameter(Mandatory = $true)] [string]$OutputPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).Path.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)

function Stop-Assembly { param([string]$Message) throw "[COASTLINE_CANARY_ASSEMBLY_INVALID] $Message" }

function Test-OutsideRepository {
  param([string]$Path, [bool]$MustExist = $true)
  if ($MustExist -and -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  $candidate = if ($MustExist) { (Resolve-Path -LiteralPath $Path).Path } else { Join-Path (Resolve-Path -LiteralPath (Split-Path -Parent $Path)).Path (Split-Path -Leaf $Path) }
  return -not ($candidate.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar).StartsWith("$repoRoot$([IO.Path]::DirectorySeparatorChar)", [StringComparison]::OrdinalIgnoreCase))
}

function Read-Receipt {
  param([string]$Path, [string]$Label)
  if (-not (Test-OutsideRepository $Path)) { Stop-Assembly "$Label must be an existing receipt outside the repository." }
  try { return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -DateKind String } catch { Stop-Assembly "$Label is unreadable JSON." }
}

function Test-ExactProperties {
  param([object]$Value, [string[]]$Expected)
  if ($null -eq $Value) { return $false }
  $actual = @($Value.PSObject.Properties.Name | Sort-Object)
  $expectedNames = @($Expected | Sort-Object)
  return ($actual -join "|") -ceq ($expectedNames -join "|")
}

function Test-OpaqueValue {
  param([object]$Value, [int]$MaximumLength = 512)
  if ($Value -isnot [string] -or [string]::IsNullOrWhiteSpace($Value)) { return $false }
  $text = [string]$Value
  return $text.Length -le $MaximumLength -and $text -ceq $text.Trim() -and $text -notmatch '[\s@<>]' -and
    $text -notmatch '(?i)(token|secret|cookie|oauth|bearer|authorization|password|subject|body|recipient)'
}

function Get-Timestamp {
  param([object]$Value)
  $parsed = [DateTimeOffset]::MinValue
  if ($Value -isnot [string] -or -not [DateTimeOffset]::TryParse([string]$Value, [ref]$parsed)) { return $null }
  return $parsed
}

function Assert-SafeJson {
  param([object]$Value, [string]$Label)
  $json = $Value | ConvertTo-Json -Depth 8 -Compress
  if ($json -match '(?i)"(?:recipient|subject|body|token|secret|cookie|oauth|authorization|password)[^" ]*"') {
    Stop-Assembly "$Label contains prohibited raw content or credential fields."
  }
}

$staging = Read-Receipt $RemoteStagingReceiptPath "Remote staging receipt"
$runner = Read-Receipt $RunnerProvenancePath "Runner provenance"
$mailbox = Read-Receipt $DedicatedMailboxEvidencePath "Dedicated mailbox evidence"
$canary = Read-Receipt $CanaryReceiptPath "Raw canary receipt"
$replay = Read-Receipt $ReplayReceiptPath "Replay evidence"

$expectedStagingProperties = @("schema_version", "provenance", "is_loopback", "run_nonce", "started_at", "completed_at", "artifact_sha", "worker_artifact_sha", "worker_heartbeat_at", "remote_worker_identity", "remote_queue_identity", "cron_evidence_id", "service_states", "checks", "outcome")
$expectedRunnerProperties = @("schema_version", "artifact_sha", "run_id", "run_nonce", "executor_registration_id", "executor_registration_sha256", "executor_id", "verifier_id")
$expectedMailboxProperties = @("schema_version", "artifact_sha", "run_id", "run_nonce", "verified_at", "environment", "mailbox_identity_sha256", "account_id", "identity_evidence_id", "mailbox_purpose", "is_shared_mailbox", "is_production_mailbox")
$expectedCanaryProperties = @("schemaVersion", "provider", "action", "accountId", "threadId", "sourceMessageId", "draftId", "idempotencyKey", "runNonce", "graphReadbackStatus", "scopeIdentity", "noSendCapability", "idempotencyReplay", "terminalState", "generatedAt", "executorRegistrationId", "executorProvenanceSha256", "connectedIdentityEvidenceId", "grantedScopesEvidenceId", "noSendEvidenceId", "graphReadbackEvidenceId", "replayGraphReadbackEvidenceId", "noDuplicateEvidenceId", "idempotencyDraftCount")
$expectedReplayProperties = @("schema_version", "artifact_sha", "run_id", "run_nonce", "verified_at", "terminal_state", "idempotency_key", "draft_id", "idempotency_replay", "replay_graph_readback_evidence_id", "no_duplicate_evidence_id", "idempotency_draft_count")
$expectedServiceProperties = @("web", "worker", "queue", "cron_unauthenticated", "cron_authenticated")
$expectedCheckCodes = @("WEB_HEALTH", "CRON_UNAUTHENTICATED_REJECTED", "CRON_AUTHENTICATED_SUCCESS", "REMOTE_ARTIFACT_WORKER_QUEUE")

if (-not (Test-ExactProperties $staging $expectedStagingProperties) -or $staging.schema_version -cne "coastline_inbox_zero_staging_receipt.v2" -or $staging.provenance -cne "remote_https" -or $staging.is_loopback -ne $false -or $staging.run_nonce -notmatch '^[a-f0-9]{32}$' -or $staging.artifact_sha -cne $ExpectedSha -or $staging.worker_artifact_sha -cne $ExpectedSha -or $staging.cron_evidence_id -notmatch '^[a-f0-9]{64}$' -or -not (Test-OpaqueValue $staging.remote_worker_identity) -or -not (Test-OpaqueValue $staging.remote_queue_identity) -or $staging.outcome -cne "pass") { Stop-Assembly "Remote staging receipt does not bind this artifact and remote worker runtime." }
if (-not (Test-ExactProperties $staging.service_states $expectedServiceProperties) -or $staging.service_states.web -cne "healthy" -or $staging.service_states.worker -cne "running" -or $staging.service_states.queue -cne "reachable" -or $staging.service_states.cron_unauthenticated -cne "rejected" -or $staging.service_states.cron_authenticated -cne "verified") { Stop-Assembly "Remote staging service states are incomplete." }
if (@($staging.checks).Count -ne 4 -or @($staging.checks | Where-Object { -not (Test-ExactProperties $_ @("code", "status")) -or $_.status -cne "pass" }).Count -ne 0 -or ((@($staging.checks | ForEach-Object code | Sort-Object) -join "|") -cne (($expectedCheckCodes | Sort-Object) -join "|"))) { Stop-Assembly "Remote staging checks are incomplete or failing." }

if (-not (Test-ExactProperties $runner $expectedRunnerProperties) -or $runner.schema_version -cne "coastline_inbox_zero_canary_runner_provenance.v1" -or $runner.artifact_sha -cne $ExpectedSha -or -not (Test-OpaqueValue $runner.run_id 256) -or $runner.run_nonce -cne $staging.run_nonce -or $runner.executor_registration_sha256 -notmatch '^[a-f0-9]{64}$' -or -not (Test-OpaqueValue $runner.executor_registration_id 256) -or -not (Test-OpaqueValue $runner.executor_id 256) -or -not (Test-OpaqueValue $runner.verifier_id 256)) { Stop-Assembly "Runner provenance is invalid." }
if (-not (Test-ExactProperties $mailbox $expectedMailboxProperties) -or $mailbox.schema_version -cne "coastline_inbox_zero_dedicated_mailbox_evidence.v1" -or $mailbox.artifact_sha -cne $ExpectedSha -or $mailbox.run_id -cne $runner.run_id -or $mailbox.run_nonce -cne $runner.run_nonce -or $mailbox.environment -cne "staging" -or $mailbox.mailbox_identity_sha256 -notmatch '^[a-f0-9]{64}$' -or -not (Test-OpaqueValue $mailbox.account_id 256) -or -not (Test-OpaqueValue $mailbox.identity_evidence_id 256) -or $mailbox.mailbox_purpose -cne "dedicated_non_production_canary" -or $mailbox.is_shared_mailbox -ne $false -or $mailbox.is_production_mailbox -ne $false) { Stop-Assembly "Dedicated mailbox evidence is invalid." }
if (-not (Test-ExactProperties $canary $expectedCanaryProperties) -or $canary.schemaVersion -cne "inbox_zero_microsoft_canary_receipt.v1" -or $canary.provider -cne "microsoft" -or $canary.action -cne "draft_only" -or $canary.accountId -cne $mailbox.account_id -or $canary.runNonce -cne $runner.run_nonce -or $canary.graphReadbackStatus -cne "verified" -or $canary.scopeIdentity -cne "delegated:Mail.ReadWrite,User.Read,email,offline_access,openid,profile" -or $canary.noSendCapability -cne "Mail.Send_absent" -or $canary.idempotencyReplay -notin @("existing_draft_reconciled", "duplicate_prevented") -or $canary.terminalState -cne "created_verified" -or $canary.executorRegistrationId -cne $runner.executor_registration_id -or $canary.executorProvenanceSha256 -cne $runner.executor_registration_sha256 -or $canary.connectedIdentityEvidenceId -cne $mailbox.identity_evidence_id -or $canary.idempotencyDraftCount -ne 1) { Stop-Assembly "Raw canary receipt is invalid." }
foreach ($name in @("threadId", "sourceMessageId", "draftId", "idempotencyKey", "connectedIdentityEvidenceId", "grantedScopesEvidenceId", "noSendEvidenceId", "graphReadbackEvidenceId", "replayGraphReadbackEvidenceId", "noDuplicateEvidenceId")) { if (-not (Test-OpaqueValue $canary.$name)) { Stop-Assembly "Raw canary receipt contains an unsafe $name value." } }
if (-not (Test-ExactProperties $replay $expectedReplayProperties) -or $replay.schema_version -cne "coastline_inbox_zero_replay_evidence.v1" -or $replay.artifact_sha -cne $ExpectedSha -or $replay.run_id -cne $runner.run_id -or $replay.run_nonce -cne $runner.run_nonce -or $replay.terminal_state -cne "created_verified" -or $replay.idempotency_key -cne $canary.idempotencyKey -or $replay.draft_id -cne $canary.draftId -or $replay.idempotency_replay -cne $canary.idempotencyReplay -or $replay.replay_graph_readback_evidence_id -cne $canary.replayGraphReadbackEvidenceId -or $replay.no_duplicate_evidence_id -cne $canary.noDuplicateEvidenceId -or $replay.idempotency_draft_count -ne 1) { Stop-Assembly "Replay evidence is invalid." }

$stagingCompleted = Get-Timestamp $staging.completed_at; $mailboxVerified = Get-Timestamp $mailbox.verified_at; $canaryGenerated = Get-Timestamp $canary.generatedAt; $replayVerified = Get-Timestamp $replay.verified_at; $heartbeat = Get-Timestamp $staging.worker_heartbeat_at
if ($null -eq $stagingCompleted -or $null -eq $mailboxVerified -or $null -eq $canaryGenerated -or $null -eq $replayVerified -or $null -eq $heartbeat -or $heartbeat -gt $stagingCompleted -or $stagingCompleted -gt $mailboxVerified -or $mailboxVerified -gt $canaryGenerated -or $canaryGenerated -gt $replayVerified) { Stop-Assembly "Evidence timestamps are unordered or invalid." }
foreach ($pair in @(@($runner, "Runner provenance"), @($mailbox, "Dedicated mailbox evidence"), @($canary, "Raw canary receipt"), @($replay, "Replay evidence"))) { Assert-SafeJson -Value $pair[0] -Label $pair[1] }

$outputParent = Split-Path -Parent $OutputPath
if ([string]::IsNullOrWhiteSpace($outputParent) -or -not (Test-Path -LiteralPath $outputParent -PathType Container) -or -not (Test-OutsideRepository $OutputPath $false) -or (Test-Path -LiteralPath $OutputPath)) { Stop-Assembly "OutputPath must be a new receipt path outside the repository with an existing parent." }
$bundle = [ordered]@{
  schema_version = "coastline_inbox_zero_promotion_canary_evidence.v1"
  artifact_sha = $ExpectedSha
  run_id = $runner.run_id
  run_nonce = $runner.run_nonce
  started_at = $mailboxVerified.ToString("o")
  completed_at = $replayVerified.ToString("o")
  runner_provenance = $runner
  dedicated_mailbox = $mailbox
  canary = $canary
  replay = $replay
}
$bundle | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $OutputPath -Encoding utf8NoBOM
$bundle | ConvertTo-Json -Depth 8
