$scriptPath = Join-Path (Split-Path -Parent $PSScriptRoot) "Invoke-CoastlineInboxZeroPreflight.ps1"
$verificationScriptPath = Join-Path (Split-Path -Parent $PSScriptRoot) "Verify-CoastlineInboxZeroStaging.ps1"

Describe "Coastline Inbox Zero preflight" {
  It "fails closed for missing variables without printing secret values" {
    $environmentFile = New-TemporaryFile
    try {
      $sentinel = "do-not-print-auth-secret"
      $command = "`$env:AUTH_SECRET='$sentinel'; Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue; & '$($scriptPath.Replace("'", "''"))' -Mode Local -EnvironmentFile '$environmentFile'"
      $output = & pwsh -NoProfile -Command $command 2>&1

      $LASTEXITCODE | Should Be 1
      ($output | Out-String) | Should Match "DATABASE_URL"
      ($output | Out-String) | Should Not Match $sentinel
    } finally {
      Remove-Item -LiteralPath $environmentFile -ErrorAction SilentlyContinue
    }
  }

  It "rejects any Microsoft scope set beyond the exact draft-only allowlist" {
    $environmentFile = New-TemporaryFile
    try {
      @(
        "DATABASE_URL=postgresql://postgres:password@db:5432/inboxzero"
        "AUTH_SECRET=auth-secret"
        "MICROSOFT_CLIENT_ID=client-id"
        "MICROSOFT_CLIENT_SECRET=microsoft-secret"
        "NEXT_PUBLIC_BASE_URL=https://staging.example.test"
        "MICROSOFT_BASE_URL=http://microsoft-emulator:4003"
        "QUEUE_BACKEND=internal"
        "CRON_SECRET=cron-secret"
        "COASTLINE_DRAFT_PROPOSALS_ENABLED=true"
        "NEXT_PUBLIC_EMAIL_SEND_ENABLED=false"
        "COASTLINE_MICROSOFT_ALLOWED_SCOPES=openid profile email User.Read offline_access Mail.ReadWrite MailboxSettings.ReadWrite"
      ) | Set-Content -LiteralPath $environmentFile

      $output = & pwsh -NoProfile -Command "& '$($scriptPath.Replace("'", "''"))' -Mode Local -EnvironmentFile '$environmentFile'" 2>&1
      $LASTEXITCODE | Should Be 1
      ($output | Out-String) | Should Match "microsoft_allowed_scopes=mismatch"
    } finally {
      Remove-Item -LiteralPath $environmentFile -ErrorAction SilentlyContinue
    }
  }

  It "rejects duplicate Microsoft scopes even when the unique set matches the allowlist" {
    $environmentFile = New-TemporaryFile
    try {
      @(
        "DATABASE_URL=postgresql://postgres:password@db:5432/inboxzero"
        "AUTH_SECRET=auth-secret"
        "MICROSOFT_CLIENT_ID=client-id"
        "MICROSOFT_CLIENT_SECRET=microsoft-secret"
        "NEXT_PUBLIC_BASE_URL=https://staging.example.test"
        "MICROSOFT_BASE_URL=http://microsoft-emulator:4003"
        "QUEUE_BACKEND=internal"
        "CRON_SECRET=cron-secret"
        "COASTLINE_DRAFT_PROPOSALS_ENABLED=true"
        "NEXT_PUBLIC_EMAIL_SEND_ENABLED=false"
        "COASTLINE_MICROSOFT_ALLOWED_SCOPES=openid profile email User.Read offline_access Mail.ReadWrite Mail.ReadWrite"
      ) | Set-Content -LiteralPath $environmentFile

      $output = & pwsh -NoProfile -Command "& '$($scriptPath.Replace("'", "''"))' -Mode Local -EnvironmentFile '$environmentFile'" 2>&1
      $LASTEXITCODE | Should Be 1
      ($output | Out-String) | Should Match "microsoft_allowed_scopes=mismatch"
    } finally {
      Remove-Item -LiteralPath $environmentFile -ErrorAction SilentlyContinue
    }
  }
}

Describe "Coastline Inbox Zero staging verification" {
  It "rejects a host that does not match the protected base URL" {
    $prior = $env:COASTLINE_STAGING_BASE_URL
    try {
      $env:COASTLINE_STAGING_BASE_URL = "https://approved-staging.example.test"
      $caught = $null
      try { . $verificationScriptPath -BaseUrl "https://staging.example.invalid" } catch { $caught = $_ }
      ($caught | Out-String) | Should Match "BaseUrl must be"
    } finally {
      $env:COASTLINE_STAGING_BASE_URL = $prior
    }
  }

  It "binds the receipt only to remote artifact, worker, queue, and authenticated cron evidence" {
    $testRoot = Join-Path ([IO.Path]::GetTempPath()) "coastline-staging-$([Guid]::NewGuid().ToString('N'))"
    $outputPath = Join-Path $testRoot "receipt.json"
    New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
    $priorSha = $env:COASTLINE_STAGING_ARTIFACT_SHA
    $priorSecret = $env:CRON_SECRET
    $artifactSha = "1" * 40
    $readyPath = Join-Path $testRoot "ready"
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = $listener.LocalEndpoint.Port
    $listener.Stop()
    $serverJob = Start-Job -ScriptBlock {
      param($Port, $ReadyPath)
      $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
      $listener.Start()
      Set-Content -LiteralPath $ReadyPath -Value ready
      try {
        foreach ($requestNumber in 1..4) {
          $client = $listener.AcceptTcpClient()
          try {
            $stream = $client.GetStream()
            $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::ASCII, $false, 1024, $true)
            $requestLine = $reader.ReadLine()
            $headers = @{}
            while ($line = $reader.ReadLine()) {
              if ([string]::IsNullOrEmpty($line)) { break }
              $parts = $line -split ':', 2
              if ($parts.Count -eq 2) { $headers[$parts[0].Trim()] = $parts[1].Trim() }
            }
            $requestTarget = ($requestLine -split ' ')[1]
            $nonce = (($requestTarget -split '\?', 2)[1] -split '&' | Where-Object { $_ -match '^(?:coastline_probe|run_nonce)=' } | Select-Object -First 1) -replace '^[^=]+=', ''
            if ($requestNumber -eq 1) {
              $status = "200 OK"; $body = '{"status":"ok","secret":"body-sentinel"}'
            } elseif ($requestNumber -eq 2) {
              $status = "401 Unauthorized"; $body = 'Unauthorized'
            } elseif ($requestNumber -eq 3) {
              $status = "200 OK"; $body = (@{ authenticated = $true; runNonce = $nonce; evidenceId = ("c" * 64); observedAt = [DateTimeOffset]::UtcNow.ToString("o") } | ConvertTo-Json -Compress)
            } else {
              $status = "200 OK"; $body = (@{ schemaVersion = "coastline_inbox_zero_remote_staging_evidence.v1"; runNonce = $nonce; artifactSha = ("1" * 40); workerIdentity = "remote-worker-1"; queueIdentity = "remote-queue-1"; workerStatus = "running"; queueStatus = "reachable"; cronEvidenceId = ("c" * 64); observedAt = [DateTimeOffset]::UtcNow.ToString("o") } | ConvertTo-Json -Compress)
            }
            $bytes = [Text.Encoding]::UTF8.GetBytes($body)
            $head = [Text.Encoding]::ASCII.GetBytes("HTTP/1.1 $status`r`nContent-Type: application/json`r`nContent-Length: $($bytes.Length)`r`nConnection: close`r`n`r`n")
            $stream.Write($head, 0, $head.Length); $stream.Write($bytes, 0, $bytes.Length); $stream.Flush()
          } finally { $client.Dispose() }
        }
      } finally { $listener.Stop() }
    } -ArgumentList $port, $readyPath
    try {
      for ($attempt = 0; $attempt -lt 50 -and -not (Test-Path $readyPath); $attempt++) { Start-Sleep -Milliseconds 50 }
      $env:COASTLINE_STAGING_ARTIFACT_SHA = $artifactSha
      $env:CRON_SECRET = "secret-sentinel"
      $failure = $null
      try { & $verificationScriptPath -BaseUrl "http://127.0.0.1:$port" -OutputPath $outputPath | Out-Null } catch { $failure = $_ }
      $receiptText = Get-Content -LiteralPath $outputPath -Raw
      $receipt = $receiptText | ConvertFrom-Json
      if ($failure) { $serverLog = Receive-Job $serverJob -Keep 2>&1 | Out-String; throw "Verification failed: $failure Server: $serverLog Receipt: $receiptText" }
      $receipt.schema_version | Should Be "coastline_inbox_zero_staging_receipt.v2"
      $nonceIssuedAt = [DateTimeOffset]::FromUnixTimeMilliseconds(
        [Convert]::ToInt64($receipt.run_nonce.Substring(0, 12), 16)
      )
      $nonceAgeMinutes = ([DateTimeOffset]::UtcNow - $nonceIssuedAt).TotalMinutes
      $nonceAgeMinutes | Should BeGreaterThan -1
      $nonceAgeMinutes | Should BeLessThan 5
      $receipt.artifact_sha | Should Be $artifactSha
      $receipt.remote_worker_identity | Should Be "remote-worker-1"
      $receipt.remote_queue_identity | Should Be "remote-queue-1"
      $receipt.service_states.cron_unauthenticated | Should Be "rejected"
      $receipt.service_states.cron_authenticated | Should Be "verified"
      $receipt.outcome | Should Be "pass"
      $receiptText | Should Not Match "secret-sentinel|body-sentinel"
    } finally {
      Stop-Job $serverJob -ErrorAction SilentlyContinue
      Remove-Job $serverJob -Force -ErrorAction SilentlyContinue
      $env:COASTLINE_STAGING_ARTIFACT_SHA = $priorSha
      $env:CRON_SECRET = $priorSecret
      Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
  }

  It "writes a failed receipt when remote evidence does not match the protected SHA" {
    $testRoot = Join-Path ([IO.Path]::GetTempPath()) "coastline-staging-$([Guid]::NewGuid().ToString('N'))"
    $outputPath = Join-Path $testRoot "receipt.json"
    New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
    $priorSha = $env:COASTLINE_STAGING_ARTIFACT_SHA
    $priorSecret = $env:CRON_SECRET
    try {
      $env:COASTLINE_STAGING_ARTIFACT_SHA = "1" * 40
      $env:CRON_SECRET = "secret-sentinel"
      Mock Invoke-WebRequest {
        param($Uri, $Method, $Headers)
        $target = [string]$Uri
        $nonce = ([Uri]$target).Query.TrimStart("?").Split("&") |
          Where-Object { $_ -match "^(?:coastline_probe|run_nonce)=" } |
          Select-Object -First 1
        $nonce = $nonce -replace "^[^=]+=", ""
        if ($target -like "*/api/health") {
          return [pscustomobject]@{ StatusCode = 200; Content = '{"status":"ok"}' }
        }
        if ($target -like "*/api/cron/*" -and -not $Headers) {
          return [pscustomobject]@{ StatusCode = 401; Content = "Unauthorized" }
        }
        if ($target -like "*/api/cron/*") {
          return [pscustomobject]@{ StatusCode = 200; Content = (@{ authenticated = $true; runNonce = $nonce; evidenceId = ("c" * 64); observedAt = [DateTimeOffset]::UtcNow.ToString("o") } | ConvertTo-Json -Compress) }
        }
        return [pscustomobject]@{ StatusCode = 200; Content = (@{ schemaVersion = "coastline_inbox_zero_remote_staging_evidence.v1"; runNonce = $nonce; artifactSha = ("2" * 40); workerIdentity = "remote-worker-1"; queueIdentity = "remote-queue-1"; workerStatus = "running"; queueStatus = "reachable"; cronEvidenceId = ("c" * 64); observedAt = [DateTimeOffset]::UtcNow.ToString("o") } | ConvertTo-Json -Compress) }
      }

      $failure = $null
      try { . $verificationScriptPath -BaseUrl "http://127.0.0.1:45678" -OutputPath $outputPath | Out-Null } catch { $failure = $_ }

      ($failure | Out-String) | Should Match "remote staging verification failed"
      $receipt = Get-Content -LiteralPath $outputPath -Raw | ConvertFrom-Json
      $receipt.outcome | Should Be "fail"
      $receipt.artifact_sha | Should BeNullOrEmpty
      @($receipt.checks | Where-Object code -eq "REMOTE_ARTIFACT_WORKER_QUEUE").status | Should Be "fail"
    } finally {
      $env:COASTLINE_STAGING_ARTIFACT_SHA = $priorSha
      $env:CRON_SECRET = $priorSecret
      Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}
