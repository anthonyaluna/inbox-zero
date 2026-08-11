$scriptPath = Join-Path (Split-Path -Parent $PSScriptRoot) "Test-CoastlineWorkflowRef.ps1"
$protectedSha = "1111111111111111111111111111111111111111"

Describe "Coastline staging workflow ref guard" {
  It "accepts only the approved ref at the exact protected SHA" {
    $output = & $scriptPath -WorkflowRef "refs/heads/main" -WorkflowSha $protectedSha -ProtectedSha $protectedSha
    ($output | Out-String) | Should Match "verified"
  }

  It "rejects an arbitrary workflow_dispatch branch before secret jobs" {
    $caught = $null
    try { . $scriptPath -WorkflowRef "refs/heads/feature" -WorkflowSha $protectedSha -ProtectedSha $protectedSha } catch { $caught = $_ }
    ($caught | Out-String) | Should Match "COASTLINE_WORKFLOW_REF_BLOCKED"
  }

  It "rejects a mismatched SHA on the approved branch" {
    $caught = $null
    try { . $scriptPath -WorkflowRef "refs/heads/main" -WorkflowSha ("2" * 40) -ProtectedSha $protectedSha } catch { $caught = $_ }
    ($caught | Out-String) | Should Match "COASTLINE_WORKFLOW_SHA_BLOCKED"
  }
}
