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
    ($output -join "`n") | Should Match "COASTLINE_STAGING_BASE_URL"
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
  It "rejects a staging-labeled host that does not match the protected base URL" {
    $escapedScriptPath = $verificationScriptPath.Replace("'", "''")
    $command = @"
`$env:COASTLINE_STAGING_BASE_URL = 'https://approved-staging.example.test'
& '$escapedScriptPath' -BaseUrl 'https://staging.example.invalid'
exit `$LASTEXITCODE
"@

    $output = & pwsh -NoProfile -Command $command 2>&1

    $LASTEXITCODE | Should Be 1
    ($output -join "`n") | Should Match "BaseUrl must be"
    ($output -join "`n") | Should Not Match "coastline_inbox_zero_staging_receipt"
  }

  It "writes only the sanitized receipt schema from controlled local responses" {
    $testRoot = Join-Path ([System.IO.Path]::GetTempPath()) "coastline-staging-$([Guid]::NewGuid().ToString('N'))"
    $fakeBin = Join-Path $testRoot "bin"
    $outputPath = Join-Path $testRoot "receipt.json"
    $readyPath = Join-Path $testRoot "ready"
    New-Item -ItemType Directory -Path $fakeBin -Force | Out-Null

    $portProbe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $portProbe.Start()
    $port = $portProbe.LocalEndpoint.Port
    $portProbe.Stop()

    $serverJob = Start-Job -ScriptBlock {
      param($Port, $ReadyPath)

      $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
      $listener.Start()
      Set-Content -LiteralPath $ReadyPath -Value "ready"
      try {
        foreach ($requestNumber in 1..2) {
          $client = $listener.AcceptTcpClient()
          try {
            $stream = $client.GetStream()
            $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::ASCII, $false, 1024, $true)
            $requestLine = $reader.ReadLine()
            while (-not [string]::IsNullOrEmpty($reader.ReadLine())) {}

            if ($requestLine -match ' /api/health ') {
              $status = "200 OK"
              $body = '{"status":"ok","secret":"secret-sentinel","access_token":"token-sentinel","mailbox_body":"body-sentinel"}'
            } else {
              $status = "401 Unauthorized"
              $body = 'body-sentinel'
            }

            $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($body)
            $headers = "HTTP/1.1 $status`r`nContent-Type: application/json`r`nContent-Length: $($bodyBytes.Length)`r`nConnection: close`r`n`r`n"
            $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($headers)
            $stream.Write($headerBytes, 0, $headerBytes.Length)
            $stream.Write($bodyBytes, 0, $bodyBytes.Length)
            $stream.Flush()
          } finally {
            $client.Dispose()
          }
        }
      } finally {
        $listener.Stop()
      }
    } -ArgumentList $port, $readyPath

    try {
      for ($attempt = 0; $attempt -lt 50 -and -not (Test-Path -LiteralPath $readyPath); $attempt++) {
        Start-Sleep -Milliseconds 50
      }
      Test-Path -LiteralPath $readyPath | Should Be $true

      $dockerShim = Join-Path $fakeBin "docker.cmd"
      @(
        '@echo off'
        'if "%1"=="version" (echo 29.6.1& exit /b 0)'
        'if "%1"=="compose" (echo controlled-container-id& exit /b 0)'
        'if "%1"=="inspect" (echo running& exit /b 0)'
        'exit /b 1'
      ) | Set-Content -LiteralPath $dockerShim -Encoding ascii

      $escapedScriptPath = $verificationScriptPath.Replace("'", "''")
      $escapedFakeBin = $fakeBin.Replace("'", "''")
      $escapedOutputPath = $outputPath.Replace("'", "''")
      $command = @"
`$env:PATH = '$escapedFakeBin' + [System.IO.Path]::PathSeparator + `$env:PATH
`$env:AUTH_SECRET = 'secret-sentinel'
`$env:MICROSOFT_CLIENT_SECRET = 'token-sentinel'
& '$escapedScriptPath' -BaseUrl 'http://127.0.0.1:$port' -OutputPath '$escapedOutputPath'
exit `$LASTEXITCODE
"@

      $output = & pwsh -NoProfile -Command $command 2>&1

      $LASTEXITCODE | Should Be 0
      Test-Path -LiteralPath $outputPath | Should Be $true
      $receiptText = Get-Content -LiteralPath $outputPath -Raw
      $receipt = $receiptText | ConvertFrom-Json
      (($receipt.PSObject.Properties.Name | Sort-Object) -join ",") | Should Be "checks,commit_sha,completed_at,outcome,schema_version,service_states,started_at"
      (($receipt.service_states.PSObject.Properties.Name | Sort-Object) -join ",") | Should Be "cron_auth,redis,web,worker"
      $receipt.outcome | Should Be "pass"
      $receiptText | Should Not Match "secret-sentinel"
      $receiptText | Should Not Match "token-sentinel"
      $receiptText | Should Not Match "body-sentinel"
      ($output -join "`n") | Should Not Match "secret-sentinel|token-sentinel|body-sentinel"
    } finally {
      Stop-Job -Job $serverJob -ErrorAction SilentlyContinue
      Remove-Job -Job $serverJob -Force -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}
