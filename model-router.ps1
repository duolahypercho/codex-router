[CmdletBinding()]
param(
  [Parameter(Position = 0, Mandatory = $true)]
  [ValidateSet("codex", "dsh", "gemini", "cursor", "claude")]
  [string]$Target,

  [Parameter(Position = 1, Mandatory = $true)]
  [string]$Command,

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$CommandArguments
)

$ErrorActionPreference = "Stop"
$env:MODEL_ROUTER_TARGET = $Target
# ValueFromRemainingArguments binds no remainder as $null. Splatting that value
# contributes one empty positional argument, which breaks strict zero-argument
# commands such as `start`. Normalize only the absent remainder to an empty array.
if ($null -eq $CommandArguments) { $CommandArguments = @() }
& (Join-Path $PSScriptRoot "codex-router.ps1") $Command @CommandArguments
exit $LASTEXITCODE
