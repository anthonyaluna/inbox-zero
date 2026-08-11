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
$unsafeMailboxCode = "COASTLINE_CANARY_UNSAFE_MAILBOX"
$repoRoot = Split-Path -Parent $PSScriptRoot
$requiredVariables = @(
  "COASTLINE_STAGING_BASE_URL",
  "COASTLINE_MICROSOFT_CANARY_EXECUTOR_PATH",
  "COASTLINE_MICROSOFT_CANARY_MAILBOX",
  "COASTLINE_MICROSOFT_CANARY_ACCOUNT_ID",
  "COASTLINE_MICROSOFT_CANARY_THREAD_ID",
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

function Get-ProtectedValue {
  param([string]$Name)

  return [Environment]::GetEnvironmentVariable($Name)
}

function Test-ExactBaseUrl {
  param([Uri]$Actual, [string]$ExpectedValue)

  $expected = $null
  if ([string]::IsNullOrWhiteSpace($ExpectedValue) -or
    -not [Uri]::TryCreate($ExpectedValue, [UriKind]::Absolute, [ref]$expected)) {
    return $false
  }

  return $Actual.Scheme -in @("https") -and
    [string]::IsNullOrEmpty($Actual.UserInfo) -and
    [string]::IsNullOrEmpty($Actual.Query) -and
    [string]::IsNullOrEmpty($Actual.Fragment) -and
    $Actual.AbsolutePath -eq "/" -and
    $Actual.AbsoluteUri.TrimEnd("/") -ceq $expected.AbsoluteUri.TrimEnd("/")
}

function Get-IdempotencyKey {
  param([string]$AccountId, [string]$ThreadId, [string]$MessageId)

  $parts = @("inbox-zero", "draft", $AccountId, $ThreadId, $MessageId) |
    ForEach-Object { [Uri]::EscapeDataString($_) }
  return $parts -join "/"
}

function Assert-ExactProperties {
  param([object]$Value, [string[]]$Expected)

  $actual = @($Value.PSObject.Properties.Name | Sort-Object)
  $sortedExpected = @($Expected | Sort-Object)
  if (($actual -join "|") -cne ($sortedExpected -join "|")) {
    throw "Canary executor returned a non-sanitized receipt contract."
  }
}

$values = @{}
foreach ($name in $requiredVariables) {
  $value = Get-ProtectedValue -Name $name
  if (-not [string]::IsNullOrWhiteSpace($value)) {
    $values[$name] = $value.Trim()
  }
}

$missing = @($requiredVariables | Where-Object { -not $values.ContainsKey($_) })
if ($missing.Count -gt 0) {
  Stop-Canary -Code $missingPrerequisiteCode -Message "Missing protected prerequisites: $($missing -join ',')."
}

if (-not (Test-ExactBaseUrl -Actual $BaseUrl -ExpectedValue $values["COASTLINE_STAGING_BASE_URL"])) {
  Stop-Canary -Code "COASTLINE_CANARY_UNSAFE_STAGING_TARGET" -Message "BaseUrl must exactly match the protected COASTLINE_STAGING_BASE_URL over HTTPS."
}

if ($values["COASTLINE_DRAFT_PROPOSALS_ENABLED"] -cne "true") {
  Stop-Canary -Code $missingPrerequisiteCode -Message "COASTLINE_DRAFT_PROPOSALS_ENABLED must be true."
}
if ($values["NEXT_PUBLIC_EMAIL_SEND_ENABLED"] -cne "false") {
  Stop-Canary -Code "COASTLINE_CANARY_MAIL_SEND_ENABLED" -Message "NEXT_PUBLIC_EMAIL_SEND_ENABLED must be false."
}

$scopes = @($values["COASTLINE_MICROSOFT_CANARY_SCOPES"] -split '[,\s]+' | Where-Object { $_ })
if ($scopes -contains "Mail.Send") {
  Stop-Canary -Code "COASTLINE_CANARY_MAIL_SEND_SCOPE_PRESENT" -Message "Protected Microsoft scopes include Mail.Send."
}

$mailbox = $values["COASTLINE_MICROSOFT_CANARY_MAILBOX"]
if ($mailbox -match '(?i)(^|[-_.@])(ap|accounts?payable|owner|resident|tenant|vendor|production|operations?)([-_.@]|$)') {
  Stop-Canary -Code $unsafeMailboxCode -Message "Protected mailbox identity is outside the dedicated test-mailbox allowlist."
}

$executorPath = $values["COASTLINE_MICROSOFT_CANARY_EXECUTOR_PATH"]
if ($executorPath -notmatch '^/api/[A-Za-z0-9/_-]+$' -or
  $executorPath -match '(?i)(send|delete|archive|mark-read|move|unsubscribe|rule)') {
  Stop-Canary -Code "COASTLINE_CANARY_UNSAFE_EXECUTOR" -Message "Protected canary executor path is not draft-only."
}

$receiptDirectory = $values["COASTLINE_MICROSOFT_CANARY_RECEIPT_DIR"]
if (-not (Test-Path -LiteralPath $receiptDirectory -PathType Container) -or
  (Resolve-Path -LiteralPath $receiptDirectory).Path.StartsWith((Resolve-Path -LiteralPath $repoRoot).Path, [System.StringComparison]::OrdinalIgnoreCase)) {
  Stop-Canary -Code $missingPrerequisiteCode -Message "COASTLINE_MICROSOFT_CANARY_RECEIPT_DIR must be an existing directory outside the repository."
}

$idempotencyKey = Get-IdempotencyKey -AccountId $values["COASTLINE_MICROSOFT_CANARY_ACCOUNT_ID"] -ThreadId $values["COASTLINE_MICROSOFT_CANARY_THREAD_ID"] -MessageId $SourceMessageId
$payload = [ordered]@{
  action = "outlook_draft_create"
  provider = "microsoft"
  sourceMessageId = $SourceMessageId
  testRecipient = $TestRecipient
  idempotencyKey = $idempotencyKey
  draftOnly = $true
  externalMessage = $false
}

try {
  $response = Invoke-RestMethod -Uri ("{0}{1}" -f $BaseUrl.AbsoluteUri.TrimEnd("/"), $executorPath) `
    -Method Post -ContentType "application/json" -Body ($payload | ConvertTo-Json -Compress) -TimeoutSec 30
} catch {
  Stop-Canary -Code "COASTLINE_CANARY_EXECUTOR_UNVERIFIED" -Message "The protected draft-only executor did not return a verified canary receipt."
}

$expectedReceiptProperties = @(
  "schemaVersion", "provider", "action", "accountId", "threadId", "sourceMessageId",
  "draftId", "idempotencyKey", "graphReadbackStatus", "scopeIdentity",
  "noSendCapability", "idempotencyReplay", "terminalState", "generatedAt"
)
try {
  Assert-ExactProperties -Value $response -Expected $expectedReceiptProperties
  $valid = $response.schemaVersion -ceq "inbox_zero_microsoft_canary_receipt.v1" -and
    $response.provider -ceq "microsoft" -and
    $response.action -ceq "draft_only" -and
    $response.accountId -ceq $values["COASTLINE_MICROSOFT_CANARY_ACCOUNT_ID"] -and
    $response.threadId -ceq $values["COASTLINE_MICROSOFT_CANARY_THREAD_ID"] -and
    $response.sourceMessageId -ceq $SourceMessageId -and
    $response.idempotencyKey -ceq $idempotencyKey -and
    $response.graphReadbackStatus -ceq "verified" -and
    $response.scopeIdentity -ceq $values["COASTLINE_MICROSOFT_CANARY_SCOPE_IDENTITY"] -and
    $response.noSendCapability -ceq "Mail.Send_absent" -and
    $response.idempotencyReplay -in @("existing_draft_reconciled", "duplicate_prevented") -and
    $response.terminalState -ceq "created_verified" -and
    -not [string]::IsNullOrWhiteSpace($response.draftId)
  if (-not $valid) {
    throw "Canary receipt values did not satisfy the protected draft-only contract."
  }
} catch {
  Stop-Canary -Code "COASTLINE_CANARY_RECEIPT_INVALID" -Message "The canary receipt was invalid or contained unapproved fields."
}

$receiptPath = Join-Path $receiptDirectory ("inbox-zero-microsoft-canary-{0}.json" -f [DateTime]::UtcNow.ToString("yyyyMMddTHHmmssZ"))
$response | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $receiptPath -Encoding utf8NoBOM
$response | ConvertTo-Json -Depth 4
