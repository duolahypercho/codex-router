$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$Target = if ($env:MODEL_ROUTER_TARGET) { $env:MODEL_ROUTER_TARGET } else { "codex" }
if ($Target -ne "codex") {
  throw "MODEL_ROUTER_TARGET must be codex."
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
function Invoke-RouterNode([string]$Script, [string[]]$ScriptArguments = @()) {
  & node (Join-Path $Root $Script) @ScriptArguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Script exited with status $LASTEXITCODE."
  }
}

switch ($Command) {
  "setup" {
    Invoke-RouterNode "src\setup.mjs" $Arguments
  }
  "doctor" {
    Invoke-RouterNode "src\doctor.mjs" $Arguments
  }
  "status" {
    Invoke-RouterNode "src\doctor.mjs" $Arguments
  }
  "providers" { Invoke-RouterNode "src\providers.mjs" $Arguments }
  "provider-key" { Invoke-RouterNode "src\provider-key.mjs" $Arguments }
  # `bin/install` accepts --prepare-only/--migrate-known/--force-deps, so the
  # Windows wrapper has to pass the equivalent switches through instead of
  # dropping them; `./model-router.ps1 codex install -ForceDeps` was silently
  # running a plain install.
  "install" { & (Join-Path $Root "install.ps1") -CheckoutInstall -Target $Target @Arguments }
  "enable" { & (Join-Path $Root "install.ps1") -CheckoutInstall -Target $Target }
  "disable" {
    Invoke-RouterNode "src\config-manager.mjs" @("disable")
    Invoke-RouterNode "src\service.mjs" @("uninstall")
  }
  "uninstall" {
    Invoke-RouterNode "src\config-manager.mjs" @("disable")
    Invoke-RouterNode "src\service.mjs" @("uninstall")
  }
  "update" {
    # `update check` stays a read-only comparison; a bare `update` installs.
    $UpdateArguments = if ($Arguments.Count) { $Arguments } else { @("update") }
    Invoke-RouterNode "src\update.mjs" $UpdateArguments
  }
  "rollback" {
    # The subcommand is fixed, so the caller's flags are appended to it rather
    # than replacing it -- the shape `bin/rollback` uses (`update.mjs rollback
    # "$@"`). Hardcoding the list here made `rollback --force` unreachable on
    # Windows, which is the only way past tracked edits that block a rollback.
    Invoke-RouterNode "src\update.mjs" (@("rollback") + $Arguments)
  }
  "support-bundle" { Invoke-RouterNode "src\support-bundle.mjs" $Arguments }
  "smoke-test" {
    Invoke-RouterNode "src\smoke-test.mjs" $Arguments
  }
  "start" { Invoke-RouterNode "src\start.mjs" $Arguments }
  "test-model" { Invoke-RouterNode "src\compatibility-test.mjs" $Arguments }
  "discover-models" { Invoke-RouterNode "src\model-discovery.mjs" $Arguments }
}

exit 0
