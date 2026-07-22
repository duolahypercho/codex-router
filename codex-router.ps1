$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$Target = if ($env:MODEL_ROUTER_TARGET) { $env:MODEL_ROUTER_TARGET } else { "codex" }
if ($Target -notin @("codex", "cursor")) {
  throw "MODEL_ROUTER_TARGET must be codex or cursor."
}
$Command = if ($args.Count) { [string]$args[0] } else { "status" }
$Arguments = if ($args.Count -gt 1) { @($args[1..($args.Count - 1)]) } else { @() }
$Commands = @(
  "setup", "install", "doctor", "status", "providers", "provider-key", "enable",
  "disable", "uninstall", "update", "rollback", "support-bundle",
  "smoke-test", "start", "test-model", "discover-models"
)
if ($Command -notin $Commands) {
  throw "Unknown command '$Command'. Choose: $($Commands -join ', ')."
}
if ($Target -eq "cursor" -and $Command -eq "smoke-test") {
  throw "Command '$Command' is currently available only for the Codex target."
}

function Invoke-RouterNode([string]$Script, [string[]]$ScriptArguments = @()) {
  & node (Join-Path $Root $Script) @ScriptArguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Script exited with status $LASTEXITCODE."
  }
}

switch ($Command) {
  "setup" {
    $Script = if ($Target -eq "cursor") { "src\cursor-setup.mjs" } else { "src\setup.mjs" }
    Invoke-RouterNode $Script $Arguments
  }
  "doctor" {
    $Script = if ($Target -eq "cursor") { "src\cursor-doctor.mjs" } else { "src\doctor.mjs" }
    Invoke-RouterNode $Script $Arguments
  }
  "status" {
    $Script = if ($Target -eq "cursor") { "src\cursor-doctor.mjs" } else { "src\doctor.mjs" }
    Invoke-RouterNode $Script $Arguments
  }
  "providers" { Invoke-RouterNode "src\providers.mjs" $Arguments }
  "provider-key" { Invoke-RouterNode "src\provider-key.mjs" $Arguments }
  "install" { & (Join-Path $Root "install.ps1") -CheckoutInstall -Target $Target }
  "enable" { & (Join-Path $Root "install.ps1") -CheckoutInstall -Target $Target }
  "disable" {
    $Script = if ($Target -eq "cursor") { "src\cursor-config-manager.mjs" } else { "src\config-manager.mjs" }
    Invoke-RouterNode $Script @("disable")
    Invoke-RouterNode "src\service.mjs" @("uninstall")
  }
  "uninstall" {
    $Script = if ($Target -eq "cursor") { "src\cursor-config-manager.mjs" } else { "src\config-manager.mjs" }
    Invoke-RouterNode $Script @("disable")
    Invoke-RouterNode "src\service.mjs" @("uninstall")
  }
  "update" { Invoke-RouterNode "src\update.mjs" @("update") }
  "rollback" { Invoke-RouterNode "src\update.mjs" @("rollback") }
  "support-bundle" { Invoke-RouterNode "src\support-bundle.mjs" $Arguments }
  "smoke-test" {
    Invoke-RouterNode "src\smoke-test.mjs" $Arguments
  }
  "start" { Invoke-RouterNode "src\start.mjs" $Arguments }
  "test-model" { Invoke-RouterNode "src\compatibility-test.mjs" $Arguments }
  "discover-models" { Invoke-RouterNode "src\model-discovery.mjs" $Arguments }
}

exit 0
