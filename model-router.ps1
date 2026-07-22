[CmdletBinding()]
param(
  [Parameter(Position = 0, Mandatory = $true)]
  [ValidateSet("codex", "cursor")]
  [string]$Target,

  [Parameter(Position = 1, Mandatory = $true)]
  [string]$Command,

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$CommandArguments
)

$ErrorActionPreference = "Stop"
$env:MODEL_ROUTER_TARGET = $Target
& (Join-Path $PSScriptRoot "codex-router.ps1") $Command @CommandArguments
exit $LASTEXITCODE
