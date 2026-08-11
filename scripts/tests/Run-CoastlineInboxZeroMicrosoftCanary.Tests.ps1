$scriptPath = Join-Path (Split-Path -Parent $PSScriptRoot) "Run-CoastlineInboxZeroMicrosoftCanary.ps1"

Describe "Coastline Microsoft canary runner" {
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
    $scopeIdentity = "delegated:Mail.ReadWrite,User.Read"
    $idempotencyKey = "inbox-zero/draft/test-account/test-thread/test-message"
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
      COASTLINE_MICROSOFT_CANARY_SCOPES = "Mail.ReadWrite User.Read"
      COASTLINE_MICROSOFT_CANARY_RECEIPT_DIR = $receiptDirectory
      COASTLINE_DRAFT_PROPOSALS_ENABLED = "true"
      NEXT_PUBLIC_EMAIL_SEND_ENABLED = "false"
    }

    try {
      foreach ($entry in $environment.GetEnumerator()) { Set-Item -Path "Env:$($entry.Key)" -Value $entry.Value }
      function Invoke-RestMethod {
        param($Uri, $Method, $Headers, $ContentType, $Body, $TimeoutSec)
        if ($Method -eq "Post") {
          return [pscustomobject]@{
            schemaVersion = "inbox_zero_microsoft_canary_receipt.v1"; provider = "microsoft"; action = "draft_only"; accountId = $accountId; threadId = $threadId; sourceMessageId = $sourceMessageId; draftId = "draft-001"; idempotencyKey = $idempotencyKey; graphReadbackStatus = "verified"; scopeIdentity = $scopeIdentity; noSendCapability = "Mail.Send_absent"; idempotencyReplay = "existing_draft_reconciled"; terminalState = "created_verified"; generatedAt = "2026-08-11T12:00:00.000Z"; executorRegistrationId = "registered-canary-executor"; executorProvenanceSha256 = $registrationHash; connectedIdentityEvidenceId = "identity-evidence"; grantedScopesEvidenceId = "scopes-evidence"; noSendEvidenceId = "no-send-evidence"; graphReadbackEvidenceId = "graph-evidence"; replayGraphReadbackEvidenceId = "replay-evidence"; noDuplicateEvidenceId = "unique-evidence"; idempotencyDraftCount = 1
          }
        }
        $kind = ([Uri]$Uri).AbsolutePath.TrimEnd("/").Split("/")[-1]
        $evidenceId = @{ identity = "identity-evidence"; scopes = "scopes-evidence"; "no-send" = "no-send-evidence"; "graph-readback" = "graph-evidence"; "idempotency-replay" = "replay-evidence"; "no-duplicate" = "unique-evidence" }[$kind]
        return [pscustomobject]@{ schemaVersion = "coastline_microsoft_canary_evidence.v1"; kind = $kind; evidenceId = $evidenceId; verifierId = "independent-graph-verifier"; verifiedAt = "2026-08-11T12:00:00.000Z"; verified = $true; accountId = $accountId; mailboxSha256 = $mailboxHash; sourceMessageId = $sourceMessageId; threadId = $threadId; draftId = "draft-001"; scopeIdentity = $scopeIdentity; mailSendCapability = "absent"; recipientSha256 = $recipientHash; idempotencyKey = $idempotencyKey; idempotencyDraftCount = if ($kind -eq "no-duplicate") { 1 } else { $null } }
      }

      $output = . $scriptPath -BaseUrl $baseUrl -SourceMessageId $sourceMessageId -TestRecipient $recipient
      $receiptPath = Get-ChildItem -LiteralPath $receiptDirectory -Filter "*.json" | Select-Object -First 1 -ExpandProperty FullName
      $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
      $receipt.idempotencyDraftCount | Should Be 1
      ($output | Out-String) | Should Not Match "COASTLINE_CANARY_RECEIPT_INVALID"
    } finally {
      Remove-Item Function:Invoke-RestMethod -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}
