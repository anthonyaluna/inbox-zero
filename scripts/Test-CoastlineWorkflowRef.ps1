[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$WorkflowRef,
  [Parameter(Mandatory = $true)][string]$WorkflowSha,
  [Parameter(Mandatory = $true)][string]$ProtectedSha,
  [string]$ApprovedRef = "refs/heads/main"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($WorkflowRef -cne $ApprovedRef) {
  throw "COASTLINE_WORKFLOW_REF_BLOCKED: workflow_dispatch must use the approved ref."
}
if ($WorkflowSha -notmatch '^[a-f0-9]{40}$' -or
  $ProtectedSha -notmatch '^[a-f0-9]{40}$' -or
  $WorkflowSha -cne $ProtectedSha) {
  throw "COASTLINE_WORKFLOW_SHA_BLOCKED: workflow_dispatch SHA is not the protected SHA."
}

Write-Output "Coastline workflow ref and protected SHA verified."
