$scriptPath = Join-Path (Split-Path -Parent $PSScriptRoot) "Invoke-CoastlineInboxZeroPreflight.ps1"
$verificationScriptPath = Join-Path (Split-Path -Parent $PSScriptRoot) "Verify-CoastlineInboxZeroStaging.ps1"

Describe "Coastline Inbox Zero preflight" {
  BeforeEach {
    $environmentFile = New-TemporaryFile
  }

  AfterEach {
    Remove-Item -LiteralPath $environmentFile -ErrorAction SilentlyContinue
  }

  It "fails closed for missing required variables without writing their values" {
    $sentinel = "do-not-print-auth-secret"
    $escapedScriptPath = $scriptPath.Replace("'", "''")
    $command = @"
`$env:AUTH_SECRET = '$sentinel'
Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
& '$escapedScriptPath' -Mode Local -EnvironmentFile '$environmentFile'
exit `$LASTEXITCODE
"@

    $output = & pwsh -NoProfile -Command $command 2>&1

    $LASTEXITCODE | Should Be 1
    ($output -join "`n") | Should Match "DATABASE_URL"
    ($output -join "`n") | Should Not Match $sentinel
  }

  It "keeps all provided secret values out of fail-closed output" {
    $sentinel = "do-not-print-microsoft-secret"
    $escapedScriptPath = $scriptPath.Replace("'", "''")
    $command = @"
`$env:MICROSOFT_CLIENT_SECRET = '$sentinel'
Remove-Item Env:CRON_SECRET -ErrorAction SilentlyContinue
& '$escapedScriptPath' -Mode Staging -EnvironmentFile '$environmentFile'
exit `$LASTEXITCODE
"@

    $output = & pwsh -NoProfile -Command $command 2>&1

    $LASTEXITCODE | Should Be 1
    ($output -join "`n") | Should Match "CRON_SECRET"
    ($output -join "`n") | Should Not Match $sentinel
  }

  It "requires a Redis URL for the BullMQ worker without printing secret values" {
    $sentinel = "do-not-print-redis-secret"
    @(
      "DATABASE_URL=postgresql://postgres:password@db:5432/inboxzero"
      "AUTH_SECRET=auth-secret"
      "MICROSOFT_CLIENT_ID=client-id"
      "MICROSOFT_CLIENT_SECRET=microsoft-secret"
      "NEXT_PUBLIC_BASE_URL=https://staging.example.test"
      "MICROSOFT_BASE_URL=http://microsoft-emulator:4003"
      "QUEUE_BACKEND=bullmq"
      "CRON_SECRET=cron-secret"
      "COASTLINE_DRAFT_PROPOSALS_ENABLED=true"
      "NEXT_PUBLIC_EMAIL_SEND_ENABLED=false"
    ) | Set-Content -LiteralPath $environmentFile
    $escapedScriptPath = $scriptPath.Replace("'", "''")
    $command = @"
`$env:REDIS_URL = `$null
`$env:AUTH_SECRET = '$sentinel'
& '$escapedScriptPath' -Mode Staging -EnvironmentFile '$environmentFile'
exit `$LASTEXITCODE
"@

    $output = & pwsh -NoProfile -Command $command 2>&1

    $LASTEXITCODE | Should Be 1
    ($output -join "`n") | Should Match "REDIS_URL"
    ($output -join "`n") | Should Not Match $sentinel
  }

  It "rejects a Microsoft host that only contains the word emulator" {
    @(
      "DATABASE_URL=postgresql://postgres:password@db:5432/inboxzero"
      "AUTH_SECRET=auth-secret"
      "MICROSOFT_CLIENT_ID=client-id"
      "MICROSOFT_CLIENT_SECRET=microsoft-secret"
      "NEXT_PUBLIC_BASE_URL=https://staging.example.test"
      "MICROSOFT_BASE_URL=https://not-an-emulator.example.com"
      "QUEUE_BACKEND=internal"
      "CRON_SECRET=cron-secret"
      "COASTLINE_DRAFT_PROPOSALS_ENABLED=true"
      "NEXT_PUBLIC_EMAIL_SEND_ENABLED=false"
    ) | Set-Content -LiteralPath $environmentFile
    $escapedScriptPath = $scriptPath.Replace("'", "''")

    $output = & pwsh -NoProfile -Command "& '$escapedScriptPath' -Mode Staging -EnvironmentFile '$environmentFile'; exit `$LASTEXITCODE" 2>&1

    $LASTEXITCODE | Should Be 1
    ($output -join "`n") | Should Match "microsoft_provider=not_emulator"
  }
}

Describe "Coastline Inbox Zero staging verification" {
  It "rejects a production-like host that only contains the word staging" {
    $escapedScriptPath = $verificationScriptPath.Replace("'", "''")

    $output = & pwsh -NoProfile -Command "& '$escapedScriptPath' -BaseUrl 'https://notstaging.example.com'; exit `$LASTEXITCODE" 2>&1

    $LASTEXITCODE | Should Be 1
    ($output -join "`n") | Should Match "BaseUrl must be"
    ($output -join "`n") | Should Not Match "coastline_inbox_zero_staging_receipt"
  }
}
