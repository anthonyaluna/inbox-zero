$scriptPath = Join-Path (Split-Path -Parent $PSScriptRoot) "Run-CoastlineInboxZeroMicrosoftCanary.ps1"

Describe "Coastline Microsoft canary runner" {
  It "returns nonzero and writes no receipt when prerequisites fail" {
    $testRoot = Join-Path ([IO.Path]::GetTempPath()) "coastline-canary-fail-$([Guid]::NewGuid().ToString('N'))"
    $receiptDirectory = Join-Path $testRoot "receipts"
    New-Item -ItemType Directory -Path $receiptDirectory -Force | Out-Null
    try {
      $escapedScriptPath = $scriptPath.Replace("'", "''")
      $escapedReceiptDirectory = $receiptDirectory.Replace("'", "''")
      $command = @"
Get-ChildItem Env:COASTLINE_* | Remove-Item -ErrorAction SilentlyContinue
`$env:COASTLINE_MICROSOFT_CANARY_RECEIPT_DIR = '$escapedReceiptDirectory'
& '$escapedScriptPath' -BaseUrl 'https://staging.example.test' -SourceMessageId 'test-message' -TestRecipient 'canary@testing.example'
"@
      $output = & pwsh -NoProfile -Command $command 2>&1

      $LASTEXITCODE | Should Be 1
      ($output | Out-String) | Should Match "COASTLINE_CANARY_MISSING_PROTECTED_PREREQUISITE"
      @(Get-ChildItem -LiteralPath $receiptDirectory -Filter "*.json").Count | Should Be 0
    } finally {
      Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
  }

  It "rejects a duplicate scope before invoking the protected executor or verifier" {
    $testRoot = Join-Path ([IO.Path]::GetTempPath()) "coastline-canary-scopes-$([Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
    $environment = @{
      COASTLINE_STAGING_BASE_URL = "https://staging.example.test"
      COASTLINE_MICROSOFT_CANARY_EXECUTOR_REGISTRATION_PATH = (Join-Path $testRoot "registration.json")
      COASTLINE_MICROSOFT_CANARY_EXECUTOR_REGISTRATION_SHA256 = ("a" * 64)
      COASTLINE_MICROSOFT_CANARY_EXECUTOR_AUTH_TOKEN = "test-auth-token"
      COASTLINE_MICROSOFT_CANARY_MAILBOX = "canary-mailbox@testing.example"
      COASTLINE_MICROSOFT_CANARY_ACCOUNT_ID = "test-account"
      COASTLINE_MICROSOFT_CANARY_THREAD_ID = "test-thread"
      COASTLINE_MICROSOFT_CANARY_SOURCE_MESSAGE_ID = "test-message"
      COASTLINE_MICROSOFT_CANARY_TEST_RECIPIENT = "canary@testing.example"
      COASTLINE_MICROSOFT_CANARY_SCOPE_IDENTITY = "delegated:Mail.ReadWrite,User.Read,email,offline_access,openid,profile"
      COASTLINE_MICROSOFT_CANARY_SCOPES = "openid profile email User.Read offline_access Mail.ReadWrite Mail.ReadWrite"
      COASTLINE_MICROSOFT_CANARY_RECEIPT_DIR = $testRoot
      COASTLINE_DRAFT_PROPOSALS_ENABLED = "true"
      NEXT_PUBLIC_EMAIL_SEND_ENABLED = "false"
    }
    try {
      foreach ($entry in $environment.GetEnumerator()) { Set-Item -Path "Env:$($entry.Key)" -Value $entry.Value }
      $script:restCalls = 0
      function Invoke-RestMethod { $script:restCalls++ }

      $failure = $null
      try { . $scriptPath -BaseUrl $environment.COASTLINE_STAGING_BASE_URL -SourceMessageId $environment.COASTLINE_MICROSOFT_CANARY_SOURCE_MESSAGE_ID -TestRecipient $environment.COASTLINE_MICROSOFT_CANARY_TEST_RECIPIENT } catch { $failure = $_ }

      ($failure | Out-String) | Should Match "COASTLINE_CANARY_MICROSOFT_SCOPES_MISMATCH"
      $script:restCalls | Should Be 0
    } finally {
      Remove-Item Function:Invoke-RestMethod -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
  }

  It "persists a verified receipt when independent no-duplicate evidence attests numeric count one" {
    $testRoot = Join-Path ([IO.Path]::GetTempPath()) "coastline-canary-$([Guid]::NewGuid().ToString('N'))"
    $registrationPath = Join-Path $testRoot "executor-registration.json"
    $receiptDirectory = Join-Path $testRoot "receipts"
    New-Item -ItemType Directory -Path $receiptDirectory -Force | Out-Null

    $baseUrl = "https://staging.example.test"
    $accountId = "test-account"
    $threadId = "test-thread"
    $sourceMessageId = "test-message"
    $mailbox = "canary-mailbox@testing.example"
    $recipient = "canary@testing.example"
    $scopeIdentity = "delegated:Mail.ReadWrite,User.Read,email,offline_access,openid,profile"
    $idempotencyKey = "inbox-zero/draft/test-account/test-thread/test-message"
    $observedAt = [DateTimeOffset]::UtcNow.ToString("o")
    $registration = [ordered]@{
      schemaVersion = "coastline_inbox_zero_microsoft_canary_executor_registration.v1"
      registrationId = "registered-canary-executor"
      executorId = "canary-executor"
      executorUrl = "$baseUrl/api/coastline/microsoft-draft-canary/v1"
      authentication = "bearer"
      provider = "microsoft"
      action = "outlook_draft_create"
      draftOnly = $true
      noSend = $true
      independentVerifierId = "independent-graph-verifier"
      independentVerifierBaseUrl = "https://verifier.example.test"
    }
    $registration | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $registrationPath -Encoding utf8NoBOM
    $registrationHash = (Get-FileHash -LiteralPath $registrationPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $mailboxHash = ([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($mailbox)) | ForEach-Object { $_.ToString("x2") }) -join ""
    $recipientHash = ([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($recipient)) | ForEach-Object { $_.ToString("x2") }) -join ""
    $environment = @{
      COASTLINE_STAGING_BASE_URL = $baseUrl
      COASTLINE_MICROSOFT_CANARY_EXECUTOR_REGISTRATION_PATH = $registrationPath
      COASTLINE_MICROSOFT_CANARY_EXECUTOR_REGISTRATION_SHA256 = $registrationHash
      COASTLINE_MICROSOFT_CANARY_EXECUTOR_AUTH_TOKEN = "test-auth-token"
      COASTLINE_MICROSOFT_CANARY_MAILBOX = $mailbox
      COASTLINE_MICROSOFT_CANARY_ACCOUNT_ID = $accountId
      COASTLINE_MICROSOFT_CANARY_THREAD_ID = $threadId
      COASTLINE_MICROSOFT_CANARY_SOURCE_MESSAGE_ID = $sourceMessageId
      COASTLINE_MICROSOFT_CANARY_TEST_RECIPIENT = $recipient
      COASTLINE_MICROSOFT_CANARY_SCOPE_IDENTITY = $scopeIdentity
      COASTLINE_MICROSOFT_CANARY_SCOPES = "openid profile email User.Read offline_access Mail.ReadWrite"
      COASTLINE_MICROSOFT_CANARY_RECEIPT_DIR = $receiptDirectory
      COASTLINE_DRAFT_PROPOSALS_ENABLED = "true"
      NEXT_PUBLIC_EMAIL_SEND_ENABLED = "false"
    }

    try {
      $script:canaryCount = 1
      foreach ($entry in $environment.GetEnumerator()) { Set-Item -Path "Env:$($entry.Key)" -Value $entry.Value }
      function Invoke-RestMethod {
        param($Uri, $Method, $Headers, $ContentType, $Body, $TimeoutSec)
        if ($Method -eq "Post") {
          $request = $Body | ConvertFrom-Json
          $script:runNonce = $request.runNonce
          return [pscustomobject]@{
            schemaVersion = "inbox_zero_microsoft_canary_receipt.v1"; provider = "microsoft"; action = "draft_only"; accountId = $accountId; threadId = $threadId; sourceMessageId = $sourceMessageId; draftId = "draft-001"; idempotencyKey = $idempotencyKey; runNonce = $script:runNonce; graphReadbackStatus = "verified"; scopeIdentity = $scopeIdentity; noSendCapability = "Mail.Send_absent"; idempotencyReplay = "existing_draft_reconciled"; terminalState = "created_verified"; generatedAt = $observedAt; executorRegistrationId = "registered-canary-executor"; executorProvenanceSha256 = $registrationHash; connectedIdentityEvidenceId = "identity-evidence"; grantedScopesEvidenceId = "scopes-evidence"; noSendEvidenceId = "no-send-evidence"; graphReadbackEvidenceId = "graph-evidence"; replayGraphReadbackEvidenceId = "replay-evidence"; noDuplicateEvidenceId = "unique-evidence"; idempotencyDraftCount = $script:canaryCount
          }
        }
        $query = [Web.HttpUtility]::ParseQueryString(([Uri]$Uri).Query)
        $script:runNonce = $query["runNonce"]
        $kind = ([Uri]$Uri).AbsolutePath.TrimEnd("/").Split("/")[-1]
        $evidenceId = @{ identity = "identity-evidence"; scopes = "scopes-evidence"; "no-send" = "no-send-evidence"; "graph-readback" = "graph-evidence"; "idempotency-replay" = "replay-evidence"; "no-duplicate" = "unique-evidence" }[$kind]
        return [pscustomobject]@{ schemaVersion = "coastline_microsoft_canary_evidence.v1"; kind = $kind; evidenceId = $evidenceId; verifierId = "independent-graph-verifier"; verifiedAt = $observedAt; verified = $true; accountId = $accountId; mailboxSha256 = $mailboxHash; sourceMessageId = $sourceMessageId; threadId = $threadId; draftId = "draft-001"; scopeIdentity = $scopeIdentity; mailSendCapability = "absent"; recipientSha256 = $recipientHash; idempotencyKey = $idempotencyKey; runNonce = $script:runNonce; idempotencyDraftCount = if ($kind -eq "no-duplicate") { 1 } else { $null } }
      }

      $output = . $scriptPath -BaseUrl $baseUrl -SourceMessageId $sourceMessageId -TestRecipient $recipient
      $receiptPath = Get-ChildItem -LiteralPath $receiptDirectory -Filter "*.json" | Select-Object -First 1 -ExpandProperty FullName
      $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
      $receipt.idempotencyDraftCount | Should Be 1
      ($output | Out-String) | Should Not Match "COASTLINE_CANARY_RECEIPT_INVALID"

      Remove-Item -LiteralPath $receiptPath -Force
      $script:canaryCount = "1"
      try {
        $failedOutput = . $scriptPath -BaseUrl $baseUrl -SourceMessageId $sourceMessageId -TestRecipient $recipient 2>&1
      } catch {
        $failedOutput = $_
      }
      ($failedOutput | Out-String) | Should Match "COASTLINE_CANARY_RECEIPT_INVALID"
      @(Get-ChildItem -LiteralPath $receiptDirectory -Filter "*.json").Count | Should Be 0
    } finally {
      Remove-Item Function:Invoke-RestMethod -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}
