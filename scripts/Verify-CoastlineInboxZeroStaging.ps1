[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][Uri]$BaseUrl,
  [string]$OutputPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Test-SafeStagingUrl {
  param([Uri]$Url)
  if ($Url.Scheme -notin @("http", "https") -or $Url.UserInfo -or $Url.Query -or
    $Url.Fragment -or $Url.AbsolutePath -ne "/") { return $false }
  if ($Url.Host.ToLowerInvariant() -in @("localhost", "127.0.0.1", "::1")) { return $true }
  if ($Url.Scheme -ne "https") { return $false }
  $protected = $null
  $value = [Environment]::GetEnvironmentVariable("COASTLINE_STAGING_BASE_URL")
  return [Uri]::TryCreate($value, [UriKind]::Absolute, [ref]$protected) -and
    $Url.AbsoluteUri.TrimEnd("/") -ceq $protected.AbsoluteUri.TrimEnd("/")
}

function Test-BoundedTimestamp {
  param([object]$Value, [DateTimeOffset]$StartedAt, [DateTimeOffset]$Now)
  try { $parsed = [DateTimeOffset]::Parse([string]$Value) } catch { return $false }
  return $parsed -ge $StartedAt.AddMinutes(-2) -and $parsed -le $Now.AddMinutes(2)
}

if (-not (Test-SafeStagingUrl $BaseUrl)) {
  throw "BaseUrl must be loopback or exactly match the protected COASTLINE_STAGING_BASE_URL."
}

$protectedSha = [Environment]::GetEnvironmentVariable("COASTLINE_INBOX_ZERO_PROTECTED_SHA")
if ([string]::IsNullOrWhiteSpace($protectedSha)) {
  # The workflow passes the deployer-provided binding under this legacy name;
  # accept it only as an equivalent protected runtime binding.
  $protectedSha = [Environment]::GetEnvironmentVariable("COASTLINE_STAGING_ARTIFACT_SHA")
}
$cronSecret = [Environment]::GetEnvironmentVariable("CRON_SECRET")
if ($protectedSha -notmatch '^[a-f0-9]{40}$' -or [string]::IsNullOrWhiteSpace($cronSecret)) {
  throw "Remote artifact SHA and cron credential must be configured before staging verification."
}

$started = [DateTimeOffset]::UtcNow
$isLoopback = $BaseUrl.Host.ToLowerInvariant() -in @("localhost", "127.0.0.1", "::1")
if (-not $isLoopback) {
  $repoRoot = Split-Path -Parent $PSScriptRoot
  $currentSha = (& git -C $repoRoot rev-parse HEAD 2>$null).Trim()
  if ($currentSha -notmatch '^[a-f0-9]{40}$' -or $protectedSha -cne $currentSha) {
    throw "Remote artifact SHA must match the current approved checkout before staging verification."
  }
}
$nonceEntropy = [Guid]::NewGuid().ToString("N").Substring(0, 20)
$runNonce = $started.ToUnixTimeMilliseconds().ToString("x12") + $nonceEntropy
$base = $BaseUrl.GetLeftPart([UriPartial]::Authority).TrimEnd("/")
$checks = [System.Collections.Generic.List[object]]::new()
$services = [ordered]@{ web = "unverified"; worker = "unverified"; queue = "unverified"; cron_unauthenticated = "unverified"; cron_authenticated = "unverified" }
$artifactSha = $null
$workerIdentity = $null
$queueIdentity = $null
$cronEvidenceId = $null

try {
  $health = Invoke-WebRequest -Uri "$base/api/health" -Method Get -MaximumRedirection 0 -TimeoutSec 10 -UseBasicParsing
  $body = $health.Content | ConvertFrom-Json
  if ($health.StatusCode -ne 200 -or $body.status -notin @("ok", "healthy")) { throw "unhealthy" }
  $services.web = "healthy"
  $checks.Add([pscustomobject]@{ code = "WEB_HEALTH"; status = "pass" })
} catch {
  $services.web = "unreachable"
  $checks.Add([pscustomobject]@{ code = "WEB_HEALTH"; status = "fail" })
}

try {
  $unauthenticated = Invoke-WebRequest -Uri "$base/api/cron/scheduled-actions?coastline_probe=$runNonce" -Method Get -MaximumRedirection 0 -TimeoutSec 10 -UseBasicParsing -SkipHttpErrorCheck
  if ($unauthenticated.StatusCode -eq 401) {
    $services.cron_unauthenticated = "rejected"
    $checks.Add([pscustomobject]@{ code = "CRON_UNAUTHENTICATED_REJECTED"; status = "pass" })
  } else {
    $checks.Add([pscustomobject]@{ code = "CRON_UNAUTHENTICATED_REJECTED"; status = "fail" })
  }
} catch {
  $checks.Add([pscustomobject]@{ code = "CRON_UNAUTHENTICATED_REJECTED"; status = "fail" })
}

try {
  $cron = Invoke-WebRequest -Uri "$base/api/cron/scheduled-actions?coastline_probe=$runNonce" -Method Get -Headers @{ Authorization = "Bearer $cronSecret" } -MaximumRedirection 0 -TimeoutSec 10 -UseBasicParsing
  $cronBody = $cron.Content | ConvertFrom-Json
  if ($cron.StatusCode -ne 200 -or $cronBody.authenticated -ne $true -or $cronBody.runNonce -cne $runNonce -or
    $cronBody.evidenceId -notmatch '^[a-f0-9]{64}$' -or
    -not (Test-BoundedTimestamp $cronBody.observedAt $started ([DateTimeOffset]::UtcNow))) { throw "invalid cron proof" }
  $cronEvidenceId = [string]$cronBody.evidenceId
  $services.cron_authenticated = "verified"
  $checks.Add([pscustomobject]@{ code = "CRON_AUTHENTICATED_SUCCESS"; status = "pass" })
} catch {
  $checks.Add([pscustomobject]@{ code = "CRON_AUTHENTICATED_SUCCESS"; status = "fail" })
}

try {
  $evidence = Invoke-WebRequest -Uri "$base/api/coastline/staging-evidence?run_nonce=$runNonce" -Method Get -Headers @{ Authorization = "Bearer $cronSecret" } -MaximumRedirection 0 -TimeoutSec 10 -UseBasicParsing
  $body = $evidence.Content | ConvertFrom-Json
  $properties = @($body.PSObject.Properties.Name | Sort-Object) -join ","
  if ($evidence.StatusCode -ne 200 -or $properties -cne "artifactSha,cronEvidenceId,observedAt,queueIdentity,queueStatus,runNonce,schemaVersion,workerIdentity,workerStatus" -or
    $body.schemaVersion -cne "coastline_inbox_zero_remote_staging_evidence.v1" -or
    $body.runNonce -cne $runNonce -or $body.artifactSha -cne $protectedSha -or
    $body.workerStatus -cne "running" -or $body.queueStatus -cne "reachable" -or
    $body.cronEvidenceId -cne $cronEvidenceId -or
    [string]::IsNullOrWhiteSpace($body.workerIdentity) -or [string]::IsNullOrWhiteSpace($body.queueIdentity) -or
    -not (Test-BoundedTimestamp $body.observedAt $started ([DateTimeOffset]::UtcNow))) { throw "invalid remote evidence" }
  $artifactSha = [string]$body.artifactSha
  $workerIdentity = [string]$body.workerIdentity
  $queueIdentity = [string]$body.queueIdentity
  $services.worker = "running"
  $services.queue = "reachable"
  $checks.Add([pscustomobject]@{ code = "REMOTE_ARTIFACT_WORKER_QUEUE"; status = "pass" })
} catch {
  $checks.Add([pscustomobject]@{ code = "REMOTE_ARTIFACT_WORKER_QUEUE"; status = "fail" })
}

$passed = @($checks | Where-Object status -eq "fail").Count -eq 0
$receipt = [ordered]@{
  schema_version = "coastline_inbox_zero_staging_receipt.v2"
  provenance = if ($isLoopback) { "local_diagnostic" } else { "remote_https" }
  is_loopback = $isLoopback
  run_nonce = $runNonce
  started_at = $started.ToString("o")
  completed_at = [DateTimeOffset]::UtcNow.ToString("o")
  artifact_sha = $artifactSha
  remote_worker_identity = $workerIdentity
  remote_queue_identity = $queueIdentity
  cron_evidence_id = $cronEvidenceId
  service_states = $services
  checks = $checks
  outcome = if ($passed) { "pass" } else { "fail" }
}

if ($OutputPath) {
  $parent = Split-Path -Parent $OutputPath
  if (-not $parent -or -not (Test-Path -LiteralPath $parent -PathType Container)) {
    throw "OutputPath parent directory must already exist."
  }
  $receipt | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $OutputPath -Encoding utf8NoBOM
}
$receipt | ConvertTo-Json -Depth 5
if (-not $passed) { throw "Coastline remote staging verification failed." }
