[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [Uri]$BaseUrl,
  [string]$OutputPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot

function Test-SafeStagingUrl {
  param([Uri]$Url)

  if ($Url.Scheme -notin @("http", "https")) {
    return $false
  }

  $stagingHost = $Url.Host.ToLowerInvariant()
  if ($stagingHost -in @("localhost", "127.0.0.1", "::1", "microsoft-emulator") -or
    $stagingHost.EndsWith(".test")) {
    return $true
  }

  foreach ($label in $stagingHost.Split(".")) {
    if ($label -eq "staging" -or $label.StartsWith("staging-") -or $label.EndsWith("-staging")) {
      return $true
    }
  }

  return $false
}

function Get-ServiceState {
  param([string]$Service)

  $id = & docker compose -f (Join-Path $repoRoot "docker-compose.yml") ps -q $Service 2>$null
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($id)) {
    return "missing"
  }

  $firstId = $id | Select-Object -First 1
  if ([string]::IsNullOrWhiteSpace($firstId)) {
    return "missing"
  }
  $state = & docker inspect --format '{{.State.Status}}' ($firstId.Trim()) 2>$null
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($state)) {
    return "unavailable"
  }
  return $state.Trim().ToLowerInvariant()
}

if (-not (Test-SafeStagingUrl -Url $BaseUrl)) {
  throw "BaseUrl must be localhost, an emulator, a .test domain, or a staging host."
}

$checks = [System.Collections.Generic.List[object]]::new()
$services = [ordered]@{}
$base = $BaseUrl.GetLeftPart([UriPartial]::Authority).TrimEnd("/")

try {
  $health = Invoke-WebRequest -Uri "$base/api/health" -Method Get -MaximumRedirection 0 -TimeoutSec 10 -UseBasicParsing
  $healthBody = $health.Content | ConvertFrom-Json
  if ($health.StatusCode -eq 200 -and $healthBody.status -in @("ok", "healthy")) {
    $services["web"] = "healthy"
    $checks.Add([pscustomobject]@{ code = "WEB_HEALTH"; status = "pass" })
  } else {
    $services["web"] = "unhealthy"
    $checks.Add([pscustomobject]@{ code = "WEB_HEALTH"; status = "fail" })
  }
} catch {
  $services["web"] = "unreachable"
  $checks.Add([pscustomobject]@{ code = "WEB_HEALTH"; status = "fail" })
}

try {
  Invoke-WebRequest -Uri "$base/api/cron/scheduled-actions" -Method Get -MaximumRedirection 0 -TimeoutSec 10 -UseBasicParsing | Out-Null
  $services["cron_auth"] = "unexpected_success"
  $checks.Add([pscustomobject]@{ code = "CRON_AUTH_REQUIRED"; status = "fail" })
} catch {
  $statusCode = $null
  if ($_.Exception.Response) {
    $statusCode = [int]$_.Exception.Response.StatusCode
  }
  if ($statusCode -eq 401) {
    $services["cron_auth"] = "required"
    $checks.Add([pscustomobject]@{ code = "CRON_AUTH_REQUIRED"; status = "pass" })
  } else {
    $services["cron_auth"] = "unverified"
    $checks.Add([pscustomobject]@{ code = "CRON_AUTH_REQUIRED"; status = "fail" })
  }
}

$dockerAvailable = & docker version --format '{{.Server.Version}}' 2>$null
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($dockerAvailable)) {
  $services["worker"] = "unavailable"
  $services["redis"] = "unavailable"
  $checks.Add([pscustomobject]@{ code = "WORKER_QUEUE"; status = "fail" })
} else {
  $services["worker"] = Get-ServiceState -Service "worker"
  $services["redis"] = Get-ServiceState -Service "redis"
  if ($services["worker"] -eq "running" -and $services["redis"] -eq "running") {
    $checks.Add([pscustomobject]@{ code = "WORKER_QUEUE"; status = "pass" })
  } else {
    $checks.Add([pscustomobject]@{ code = "WORKER_QUEUE"; status = "fail" })
  }
}

$commitSha = (& git -C $repoRoot rev-parse HEAD 2>$null).Trim()
$passed = @($checks | Where-Object { $_.status -eq "fail" }).Count -eq 0
$receipt = [ordered]@{
  schema_version = "coastline_inbox_zero_staging_receipt.v1"
  generated_at = [DateTime]::UtcNow.ToString("o")
  commit_sha = $commitSha
  service_states = $services
  checks = $checks
  outcome = if ($passed) { "pass" } else { "fail" }
}

if ($OutputPath) {
  $parent = Split-Path -Parent $OutputPath
  if ([string]::IsNullOrWhiteSpace($parent) -or -not (Test-Path -LiteralPath $parent -PathType Container)) {
    throw "OutputPath parent directory must already exist."
  }
  $receipt | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $OutputPath -Encoding utf8NoBOM
}

$receipt | ConvertTo-Json -Depth 5
if (-not $passed) {
  exit 1
}
