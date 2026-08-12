[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Local", "Staging")]
  [string]$Mode,
  [string]$EnvironmentFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$composeFile = if ($Mode -eq "Local") {
  Join-Path $repoRoot "docker-compose.dev.yml"
} else {
  Join-Path $repoRoot "docker-compose.yml"
}
$requiredVariables = @(
  "DATABASE_URL",
  "AUTH_SECRET",
  "MICROSOFT_CLIENT_ID",
  "MICROSOFT_CLIENT_SECRET",
  "NEXT_PUBLIC_BASE_URL",
  "MICROSOFT_BASE_URL",
  "QUEUE_BACKEND",
  "CRON_SECRET",
  "COASTLINE_DRAFT_PROPOSALS_ENABLED",
  "NEXT_PUBLIC_EMAIL_SEND_ENABLED",
  "COASTLINE_MICROSOFT_ALLOWED_SCOPES"
)
if ($Mode -eq "Staging") {
  $requiredVariables += "COASTLINE_STAGING_BASE_URL"
}

function Get-EnvironmentValues {
  param([string[]]$Names, [string[]]$Files)

  $values = @{}
  foreach ($name in $Names) {
    $environmentValue = [Environment]::GetEnvironmentVariable($name)
    if (-not [string]::IsNullOrWhiteSpace($environmentValue)) {
      $values[$name] = $environmentValue.Trim()
    }
  }

  foreach ($file in $Files) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
      continue
    }

    foreach ($line in Get-Content -LiteralPath $file) {
      if ($line -match '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
        $name = $matches[1]
        if ($Names -notcontains $name -or $values.ContainsKey($name)) {
          continue
        }

        $value = $matches[2].Trim()
        if ($value.Length -ge 2 -and $value.StartsWith('"') -and $value.EndsWith('"')) {
          $value = $value.Substring(1, $value.Length - 2)
        }
        if ($value.Length -gt 0 -and -not $value.StartsWith("#")) {
          $values[$name] = $value
        }
      }
    }
  }

  return $values
}

function Test-EmulatorUrl {
  param([string]$Url)

  $uri = $null
  if (-not [Uri]::TryCreate($Url, [UriKind]::Absolute, [ref]$uri)) {
    return $false
  }
  if ($uri.Scheme -notin @("http", "https")) {
    return $false
  }

  $providerHost = $uri.Host.ToLowerInvariant()
  return $providerHost -in @("localhost", "127.0.0.1", "::1", "microsoft-emulator")
}

function Get-ExactMicrosoftScopes {
  param([string]$Value)

  $expected = @("Mail.ReadWrite", "User.Read", "email", "offline_access", "openid", "profile")
  [string[]]$configured = @($Value -split '[,\s]+' | Where-Object { $_ })
  [Array]::Sort($configured, [StringComparer]::Ordinal)
  if (($configured -join "|") -cne ($expected -join "|")) {
    return $null
  }
  return $configured
}

function Get-ServiceContainerId {
  param([string]$Service)

  $id = & docker compose -f $composeFile ps -q $Service 2>$null
  if ($LASTEXITCODE -ne 0) {
    return $null
  }
  $firstId = $id | Select-Object -First 1
  if ([string]::IsNullOrWhiteSpace($firstId)) {
    return $null
  }
  return $firstId.Trim()
}

function Get-ServiceHealth {
  param([string]$Service)

  $id = Get-ServiceContainerId -Service $Service
  if ([string]::IsNullOrWhiteSpace($id)) {
    return "missing"
  }

  $state = & docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' $id 2>$null
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($state)) {
    return "unavailable"
  }
  return $state.Trim().ToLowerInvariant()
}

$environmentFiles = if ($EnvironmentFile) {
  @(
    if ([System.IO.Path]::IsPathRooted($EnvironmentFile)) {
      $EnvironmentFile
    } else {
      Join-Path $repoRoot $EnvironmentFile
    }
  )
} else {
  @(
    (Join-Path $repoRoot "apps/web/.env.local"),
    (Join-Path $repoRoot "apps/web/.env")
  )
}
$values = Get-EnvironmentValues -Names @($requiredVariables + "REDIS_URL") -Files $environmentFiles
$checks = [ordered]@{ verification_scope = "local_only" }
$failures = [System.Collections.Generic.List[string]]::new()

$status = & git -C $repoRoot status --porcelain 2>$null
if ($LASTEXITCODE -ne 0 -or -not [string]::IsNullOrWhiteSpace($status)) {
  $checks["artifact"] = "dirty"
  $failures.Add("artifact")
} else {
  $checks["artifact_sha"] = (& git -C $repoRoot rev-parse HEAD).Trim()
}

$nodeVersion = & node --version 2>$null
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v24\.') {
  $checks["node_24"] = "failed"
  $failures.Add("node_24")
} else {
  $checks["node_24"] = "pass"
}

$pnpmVersion = & pnpm --version 2>$null
if ($LASTEXITCODE -ne 0 -or $pnpmVersion -notmatch '^11\.') {
  $checks["pnpm_11"] = "failed"
  $failures.Add("pnpm_11")
} else {
  $checks["pnpm_11"] = "pass"
}

$missing = @($requiredVariables | Where-Object { -not $values.ContainsKey($_) })
if ($missing.Count -gt 0) {
  $checks["required_variables"] = "missing:$($missing -join ',')"
  $failures.Add("required_variables")
} else {
  $checks["required_variables"] = "pass"
}

if ($values.ContainsKey("COASTLINE_DRAFT_PROPOSALS_ENABLED") -and
  $values["COASTLINE_DRAFT_PROPOSALS_ENABLED"] -eq "true") {
  $checks["coastline_draft_only"] = "pass"
} else {
  $checks["coastline_draft_only"] = "failed"
  $failures.Add("coastline_draft_only")
}

if ($values.ContainsKey("NEXT_PUBLIC_EMAIL_SEND_ENABLED") -and
  $values["NEXT_PUBLIC_EMAIL_SEND_ENABLED"] -eq "false") {
  $checks["mail_send_capability"] = "disabled"
} else {
  $checks["mail_send_capability"] = "enabled_or_missing"
  $failures.Add("mail_send_capability")
}

if ($values.ContainsKey("QUEUE_BACKEND") -and
  $values["QUEUE_BACKEND"] -in @("bullmq", "internal", "qstash") -and
  ($values["QUEUE_BACKEND"] -ne "bullmq" -or $values.ContainsKey("REDIS_URL"))) {
  $checks["queue_configuration"] = "pass"
} else {
  $checks["queue_configuration"] = if (
    $values.ContainsKey("QUEUE_BACKEND") -and
    $values["QUEUE_BACKEND"] -eq "bullmq" -and
    -not $values.ContainsKey("REDIS_URL")
  ) { "missing:REDIS_URL" } else { "failed" }
  $failures.Add("queue_configuration")
}

if ($values.ContainsKey("MICROSOFT_BASE_URL") -and
  (Test-EmulatorUrl -Url $values["MICROSOFT_BASE_URL"])) {
  $checks["microsoft_provider"] = "emulator"
} else {
  $checks["microsoft_provider"] = "not_emulator"
  $failures.Add("microsoft_provider")
}

$configuredScopes = @(if ($values.ContainsKey("COASTLINE_MICROSOFT_ALLOWED_SCOPES")) {
    Get-ExactMicrosoftScopes -Value $values["COASTLINE_MICROSOFT_ALLOWED_SCOPES"]
  })
if ($configuredScopes.Count -eq 6) {
  $checks["microsoft_allowed_scopes"] = "exact"
} else {
  $checks["microsoft_allowed_scopes"] = "mismatch"
  $failures.Add("microsoft_allowed_scopes")
}

$dockerVersion = & docker version --format '{{.Server.Version}}' 2>$null
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($dockerVersion)) {
  $checks["docker"] = "unavailable"
  $failures.Add("docker")
} else {
  $checks["docker"] = "pass"
  $databaseHealth = Get-ServiceHealth -Service "db"
  $checks["database"] = $databaseHealth
  if ($databaseHealth -ne "healthy") {
    $failures.Add("database")
  }

  $redisHealth = Get-ServiceHealth -Service "redis"
  $checks["redis"] = $redisHealth
  $redisPing = & docker compose -f $composeFile exec -T redis redis-cli ping 2>$null
  if ($redisHealth -ne "running" -or $LASTEXITCODE -ne 0 -or ($redisPing | Select-Object -Last 1).Trim() -ne "PONG") {
    $checks["redis"] = "unreachable"
    $failures.Add("redis")
  }
}

foreach ($entry in $checks.GetEnumerator()) {
  Write-Output "$($entry.Key)=$($entry.Value)"
}

if ($failures.Count -gt 0) {
  Write-Error "Coastline Inbox Zero $Mode preflight failed: $($failures -join ',')"
  exit 1
}
