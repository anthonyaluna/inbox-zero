[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [Uri]$BaseUrl,
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$SourceMessageId,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[^\s@]+@[^\s@]+\.[^\s@]+$')]
  [string]$TestRecipient
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$missingPrerequisiteCode = "COASTLINE_CANARY_MISSING_PROTECTED_PREREQUISITE"
$repoRoot = Split-Path -Parent $PSScriptRoot
$requiredVariables = @(
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

function Stop-Canary {
  param([string]$Code, [string]$Message)
  Write-Error "[$Code] $Message"
  exit 1
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

function Get-IndependentEvidence {
  param([string]$Base, [string]$Kind, [hashtable]$Headers, [hashtable]$Query)
  $uri = [UriBuilder]::new("$($Base.TrimEnd('/'))/$Kind")
  $uri.Query = (($Query.GetEnumerator() | ForEach-Object {
    "{0}={1}" -f [Uri]::EscapeDataString($_.Key), [Uri]::EscapeDataString([string]$_.Value)
  }) -join "&")
  return Invoke-RestMethod -Uri $uri.Uri -Method Get -Headers $Headers -TimeoutSec 30
}

function Assert-IndependentEvidence {
  param(
    [object]$Evidence,
    [string]$Kind,
    [object]$Registration,
    [hashtable]$Expected
  )
  Assert-ExactProperties -Value $Evidence -Expected @(
    "schemaVersion", "kind", "evidenceId", "verifierId", "verifiedAt", "verified",
    "accountId", "mailboxSha256", "sourceMessageId", "threadId", "draftId",
    "scopeIdentity", "mailSendCapability", "recipientSha256", "idempotencyKey",
    "idempotencyDraftCount"
  ) -Label "Independent $Kind evidence"
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
    $Evidence.idempotencyKey -cne $Expected.idempotencyKey -or
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
  return $Evidence
}

$values = @{}
foreach ($name in $requiredVariables) {
  $value = [Environment]::GetEnvironmentVariable($name)
  if (-not [string]::IsNullOrWhiteSpace($value)) { $values[$name] = $value.Trim() }
}
$missing = @($requiredVariables | Where-Object { -not $values.ContainsKey($_) })
if ($missing.Count -gt 0) {
  Stop-Canary -Code $missingPrerequisiteCode -Message "Missing protected prerequisites: $($missing -join ',')."
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
$scopes = @($values.COASTLINE_MICROSOFT_CANARY_SCOPES -split '[,\s]+' | Where-Object { $_ })
if ($scopes -contains "Mail.Send") {
  Stop-Canary -Code "COASTLINE_CANARY_MAIL_SEND_SCOPE_PRESENT" -Message "Protected Microsoft scopes include Mail.Send."
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

$receiptDirectory = $values.COASTLINE_MICROSOFT_CANARY_RECEIPT_DIR
if (-not (Test-Path -LiteralPath $receiptDirectory -PathType Container) -or
  (Resolve-Path $receiptDirectory).Path.StartsWith((Resolve-Path $repoRoot).Path, [StringComparison]::OrdinalIgnoreCase)) {
  Stop-Canary -Code $missingPrerequisiteCode -Message "Receipt directory must exist outside the repository."
}

$headers = @{ Authorization = "Bearer $($values.COASTLINE_MICROSOFT_CANARY_EXECUTOR_AUTH_TOKEN)"; "X-Coastline-Canary-Executor-Id" = $registration.executorId }
$expected = @{
  accountId = $values.COASTLINE_MICROSOFT_CANARY_ACCOUNT_ID
  threadId = $values.COASTLINE_MICROSOFT_CANARY_THREAD_ID
  sourceMessageId = $SourceMessageId
  mailboxSha256 = Get-Sha256 $values.COASTLINE_MICROSOFT_CANARY_MAILBOX
  recipientSha256 = Get-Sha256 $TestRecipient
  scopeIdentity = $values.COASTLINE_MICROSOFT_CANARY_SCOPE_IDENTITY
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

$payload = [ordered]@{ action = "outlook_draft_create"; provider = "microsoft"; sourceMessageId = $SourceMessageId; testRecipient = $TestRecipient; idempotencyKey = $idempotencyKey; draftOnly = $true; externalMessage = $false }
try {
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

$expectedReceiptProperties = @("schemaVersion", "provider", "action", "accountId", "threadId", "sourceMessageId", "draftId", "idempotencyKey", "graphReadbackStatus", "scopeIdentity", "noSendCapability", "idempotencyReplay", "terminalState", "generatedAt", "executorRegistrationId", "executorProvenanceSha256", "connectedIdentityEvidenceId", "grantedScopesEvidenceId", "noSendEvidenceId", "graphReadbackEvidenceId", "replayGraphReadbackEvidenceId", "noDuplicateEvidenceId", "idempotencyDraftCount")
try {
  Assert-ExactProperties -Value $response -Expected $expectedReceiptProperties -Label "Canary receipt"
  $valid = $response.schemaVersion -ceq "inbox_zero_microsoft_canary_receipt.v1" -and $response.provider -ceq "microsoft" -and $response.action -ceq "draft_only" -and
    $response.accountId -ceq $expected.accountId -and $response.threadId -ceq $expected.threadId -and $response.sourceMessageId -ceq $expected.sourceMessageId -and $response.draftId -ceq $expected.draftId -and
    $response.idempotencyKey -ceq $idempotencyKey -and $response.graphReadbackStatus -ceq "verified" -and $response.scopeIdentity -ceq $expected.scopeIdentity -and
    $response.noSendCapability -ceq "Mail.Send_absent" -and $response.idempotencyReplay -in @("existing_draft_reconciled", "duplicate_prevented") -and $response.terminalState -ceq "created_verified" -and
    $response.executorRegistrationId -ceq $registration.registrationId -and $response.executorProvenanceSha256 -ceq $values.COASTLINE_MICROSOFT_CANARY_EXECUTOR_REGISTRATION_SHA256 -and
    $response.connectedIdentityEvidenceId -ceq $evidence["identity"].evidenceId -and
    $response.grantedScopesEvidenceId -ceq $evidence["scopes"].evidenceId -and
    $response.noSendEvidenceId -ceq $evidence["no-send"].evidenceId -and
    $response.graphReadbackEvidenceId -ceq $evidence["graph-readback"].evidenceId -and
    $response.replayGraphReadbackEvidenceId -ceq $evidence["idempotency-replay"].evidenceId -and
    $response.noDuplicateEvidenceId -ceq $evidence["no-duplicate"].evidenceId -and
    $response.idempotencyDraftCount -eq 1
  if (-not $valid) { throw "Canary receipt values did not satisfy the independent-evidence contract." }
  foreach ($field in $expectedReceiptProperties) {
    if ($field -notin @("schemaVersion", "provider", "action", "graphReadbackStatus", "noSendCapability", "idempotencyReplay", "terminalState", "generatedAt", "executorProvenanceSha256") -and -not (Test-OpaqueValue $response.$field 512)) { throw "Canary receipt contains an unsafe value." }
  }
  if ($response.executorProvenanceSha256 -notmatch '^[a-f0-9]{64}$' -or -not (Test-IsoTimestamp $response.generatedAt)) { throw "Canary receipt contains an invalid hash or timestamp." }
} catch {
  Stop-Canary -Code "COASTLINE_CANARY_RECEIPT_INVALID" -Message "The canary receipt was invalid or contained unapproved fields."
}

$receiptPath = Join-Path $receiptDirectory ("inbox-zero-microsoft-canary-{0}.json" -f [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssZ"))
$response | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $receiptPath -Encoding utf8NoBOM
$response | ConvertTo-Json -Depth 4
