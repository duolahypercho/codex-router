$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$Target = if ($env:MODEL_ROUTER_TARGET) { $env:MODEL_ROUTER_TARGET } else { "codex" }
if ($Target -ne "codex") {
  throw "MODEL_ROUTER_TARGET must be codex."
}
$Command = if ($args.Count) { [string]$args[0] } else { "status" }
# The @() wraps the whole `if`, not its branches. PowerShell enumerates a
# statement's output into an assignment, so a one-element array collapses to
# the element itself: `tray status` bound $Arguments to the String "status",
# and $Arguments[0] then indexed the string and yielded "s". Every
# single-argument subcommand -- tray status/start/stop/restart/uninstall --
# failed with "Unknown tray action 's'".
$Arguments = @(if ($args.Count -gt 1) { $args[1..($args.Count - 1)] })
$Commands = @(
  "setup", "install", "doctor", "status", "providers", "provider-key", "enable",
  "disable", "uninstall", "update", "rollback", "support-bundle",
  "smoke-test", "start", "stop", "test-model", "discover-models", "local-mlx",
  "signed-routing", "refresh-catalog", "media", "tray", "panel", "companion"
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

function Resolve-AccountSid([string]$Identity) {
  try {
    return ([Security.Principal.SecurityIdentifier]::new($Identity)).Value
  } catch {
    return ([Security.Principal.NTAccount]::new($Identity)).Translate(
      [Security.Principal.SecurityIdentifier]
    ).Value
  }
}

function Get-ValidatedTrayTask {
  $TaskName = "Codex Router Tray"
  $Task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  $CurrentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $PrincipalSid = Resolve-AccountSid ([string]$Task.Principal.UserId)
  if ($PrincipalSid -ne $CurrentSid) {
    throw "Refusing to repair '$TaskName': its principal is not the current user."
  }
  if ($Task.Principal.LogonType.ToString() -ne "Interactive") {
    throw "Refusing to repair '$TaskName': it is not an interactive user task."
  }

  $Actions = @($Task.Actions)
  if ($Actions.Count -ne 1) {
    throw "Refusing to repair '$TaskName': it does not have one recognized action."
  }
  $TaskAction = $Actions[0]
  $Execute = [IO.Path]::GetFullPath(
    [Environment]::ExpandEnvironmentVariables([string]$TaskAction.Execute)
  )
  $Argument = [string]$TaskAction.Arguments
  $TauriExecute = [IO.Path]::GetFullPath(
    (Join-Path $Root "apps\desktop\src-tauri\target\release\codex-router-desktop.exe")
  )
  $ElectronExecute = [IO.Path]::GetFullPath(
    (Join-Path $Root "apps\electron\node_modules\electron\dist\electron.exe")
  )
  $ElectronDirectory = [IO.Path]::GetFullPath((Join-Path $Root "apps\electron"))
  $TauriAction = [string]::Equals($Execute, $TauriExecute, [StringComparison]::OrdinalIgnoreCase) -and
    [string]::IsNullOrWhiteSpace($Argument)
  $ElectronAction = [string]::Equals($Execute, $ElectronExecute, [StringComparison]::OrdinalIgnoreCase) -and
    [string]::Equals($Argument.Trim().Trim('"'), $ElectronDirectory, [StringComparison]::OrdinalIgnoreCase)
  if (-not ($TauriAction -or $ElectronAction)) {
    throw "Refusing to repair '$TaskName': its action is not this checkout's tray companion."
  }

  return [pscustomobject]@{
    Name = $TaskName
    Sid = $CurrentSid
    Execute = [string]$TaskAction.Execute
    Argument = $Argument
  }
}

function Test-TrayTaskFullControl([string]$TaskName, [string]$SidValue) {
  try {
    $Service = New-Object -ComObject "Schedule.Service"
    $Service.Connect()
    $Registered = $Service.GetFolder("\").GetTask($TaskName)
    $Descriptor = [Security.AccessControl.RawSecurityDescriptor]::new(
      $Registered.GetSecurityDescriptor(7)
    )
    foreach ($Ace in $Descriptor.DiscretionaryAcl) {
      if ($Ace -is [Security.AccessControl.CommonAce] -and
          $Ace.AceQualifier -eq [Security.AccessControl.AceQualifier]::AccessAllowed -and
          $Ace.SecurityIdentifier.Value -eq $SidValue -and
          ($Ace.AccessMask -band 0x1f01ff) -eq 0x1f01ff) {
        return $true
      }
    }
  } catch {
    # A descriptor we cannot inspect is exactly the case the elevated repair
    # is allowed to address after validating the task's principal and action.
  }
  return $false
}

function Repair-TrayTaskPermissions {
  $Validated = Get-ValidatedTrayTask
  if (Test-TrayTaskFullControl $Validated.Name $Validated.Sid) {
    Write-Output "Tray task permissions are already repairable by the current user."
    return
  }

  # The elevated side reads only fixed environment fields, validates the task
  # again to close the UAC race, and changes its DACL through Task Scheduler's
  # supported COM API. The tray process itself remains Interactive/Limited.
  $ElevatedScript = @'
$ErrorActionPreference = "Stop"
function Resolve-RepairSid([string]$Identity) {
  try { return ([Security.Principal.SecurityIdentifier]::new($Identity)).Value }
  catch { return ([Security.Principal.NTAccount]::new($Identity)).Translate([Security.Principal.SecurityIdentifier]).Value }
}
$scheduled = Get-ScheduledTask -TaskName $env:CODEX_ROUTER_TRAY_REPAIR_TASK -ErrorAction Stop
$actions = @($scheduled.Actions)
if ($actions.Count -ne 1) { throw "Tray task action changed before repair." }
$principalSid = Resolve-RepairSid ([string]$scheduled.Principal.UserId)
if ($principalSid -ne $env:CODEX_ROUTER_TRAY_REPAIR_SID -or
    -not [string]::Equals([string]$actions[0].Execute, $env:CODEX_ROUTER_TRAY_REPAIR_EXECUTE, [StringComparison]::OrdinalIgnoreCase) -or
    -not [string]::Equals([string]$actions[0].Arguments, $env:CODEX_ROUTER_TRAY_REPAIR_ARGUMENT, [StringComparison]::Ordinal)) {
  throw "Tray task identity changed before repair."
}
$service = New-Object -ComObject "Schedule.Service"
$service.Connect()
$registered = $service.GetFolder("\").GetTask($env:CODEX_ROUTER_TRAY_REPAIR_TASK)
$descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($registered.GetSecurityDescriptor(7))
$sid = [Security.Principal.SecurityIdentifier]::new($env:CODEX_ROUTER_TRAY_REPAIR_SID)
$fullControl = 0x1f01ff
$hasFullControl = $false
foreach ($ace in $descriptor.DiscretionaryAcl) {
  if ($ace -is [Security.AccessControl.CommonAce] -and
      $ace.AceQualifier -eq [Security.AccessControl.AceQualifier]::AccessAllowed -and
      $ace.SecurityIdentifier.Value -eq $sid.Value -and
      ($ace.AccessMask -band $fullControl) -eq $fullControl) {
    $hasFullControl = $true
    break
  }
}
if (-not $hasFullControl) {
  $newAce = [Security.AccessControl.CommonAce]::new(
    [Security.AccessControl.AceFlags]::None,
    [Security.AccessControl.AceQualifier]::AccessAllowed,
    $fullControl,
    $sid,
    $false,
    $null
  )
  $descriptor.DiscretionaryAcl.InsertAce($descriptor.DiscretionaryAcl.Count, $newAce)
  $sections = [Security.AccessControl.AccessControlSections]::Owner -bor
    [Security.AccessControl.AccessControlSections]::Group -bor
    [Security.AccessControl.AccessControlSections]::Access
  $registered.SetSecurityDescriptor($descriptor.GetSddlForm($sections), 0x10)
}
'@
  $SavedTask = $env:CODEX_ROUTER_TRAY_REPAIR_TASK
  $SavedSid = $env:CODEX_ROUTER_TRAY_REPAIR_SID
  $SavedExecute = $env:CODEX_ROUTER_TRAY_REPAIR_EXECUTE
  $SavedArgument = $env:CODEX_ROUTER_TRAY_REPAIR_ARGUMENT
  try {
    $env:CODEX_ROUTER_TRAY_REPAIR_TASK = $Validated.Name
    $env:CODEX_ROUTER_TRAY_REPAIR_SID = $Validated.Sid
    $env:CODEX_ROUTER_TRAY_REPAIR_EXECUTE = $Validated.Execute
    $env:CODEX_ROUTER_TRAY_REPAIR_ARGUMENT = $Validated.Argument
    $Encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($ElevatedScript))
    $Process = Start-Process -FilePath "powershell.exe" -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList @(
      "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", $Encoded
    )
    if ($Process.ExitCode -ne 0) {
      throw "Elevated tray permission repair failed with exit code $($Process.ExitCode)."
    }
  } finally {
    $env:CODEX_ROUTER_TRAY_REPAIR_TASK = $SavedTask
    $env:CODEX_ROUTER_TRAY_REPAIR_SID = $SavedSid
    $env:CODEX_ROUTER_TRAY_REPAIR_EXECUTE = $SavedExecute
    $env:CODEX_ROUTER_TRAY_REPAIR_ARGUMENT = $SavedArgument
  }
  if (-not (Test-TrayTaskFullControl $Validated.Name $Validated.Sid)) {
    throw "Task Scheduler still denies the current user control of the tray task."
  }
  Write-Output "Tray task permissions repaired; reinstalling the companion."
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
  "enable" { & (Join-Path $Root "install.ps1") -CheckoutInstall -Target $Target @Arguments }
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
  "signed-routing" {
    Invoke-RouterNode "src\control.mjs" (@("signed-routing") + $Arguments)
  }
  "refresh-catalog" { Invoke-RouterNode "src\refresh-catalog.mjs" $Arguments }
  "support-bundle" { Invoke-RouterNode "src\support-bundle.mjs" $Arguments }
  "smoke-test" {
    Invoke-RouterNode "src\smoke-test.mjs" $Arguments
  }
  "start" { Invoke-RouterNode "src\start.mjs" $Arguments }
  "stop" { Invoke-RouterNode "src\service.mjs" @("stop") }
  "test-model" { Invoke-RouterNode "src\compatibility-test.mjs" $Arguments }
  "discover-models" { Invoke-RouterNode "src\model-discovery.mjs" $Arguments }
  "local-mlx" { Invoke-RouterNode "src\local-mlx.mjs" $Arguments }
  "media" { Invoke-RouterNode "src\minimax-media.mjs" $Arguments }
  # The companion with nothing to build and nothing to download. The router is
  # already serving it; this is the one thing that knows the address.
  "panel" { Invoke-RouterNode "src\panel.mjs" $Arguments }
  # The Windows counterpart of ./bin/model-router-tray. Before this, macOS and
  # Linux had one command that built and supervised the companion and Windows
  # had none -- bin/model-router-tray only told you to go read a build script.
  # Build when the sources moved, then hand it to Task Scheduler, which starts
  # it now and again at every logon.
  "tray" {
    $Action = if ($Arguments.Count) { [string]$Arguments[0] } else { "install" }
    if ($Action -notin @("install", "status", "start", "stop", "restart", "uninstall", "rebuild", "repair")) {
      throw "Unknown tray action '$Action'. Choose: install, status, start, stop, restart, uninstall, rebuild, repair."
    }
    if ($Action -eq "repair") {
      Repair-TrayTaskPermissions
      $Action = "install"
    }
    # `rebuild` is `control tray rebuild`'s Windows half: build unconditionally
    # -- bypassing the source-fingerprint skip that `install` uses -- then
    # restart whichever companion Task Scheduler already supervises.
    if ($Action -eq "rebuild") {
      if (Get-Command cargo -ErrorAction SilentlyContinue) {
        & (Join-Path $Root "scripts\build-desktop-tray.ps1") -BinaryOnly
        if ($LASTEXITCODE -ne 0) { throw "Desktop companion build failed." }
        & node (Join-Path $Root "src\install-plan.mjs") record-tray | Out-Null
        if ($LASTEXITCODE -ne 0) {
          Write-Warning "Could not stamp the companion build; the next update will rebuild it."
        }
        Invoke-RouterNode "src\tray-service.mjs" @("install")
      } else {
        Write-Output "Cargo is not on PATH; rebuilding the Electron companion instead."
        & (Join-Path $Root "scripts\build-electron-companion.ps1") | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Electron companion build failed." }
        Invoke-RouterNode "src\tray-service.mjs" @("install-electron")
      }
      Write-Output "Companion rebuilt, installed, and started."
      exit 0
    }
    # Rust is the only prerequisite the Tauri shell adds over what the router
    # install already required. Without it this step used to fail and print an
    # apology, which left the machine with no companion at all; the Electron
    # shell renders the same UI and needs only Node.
    if ($Action -eq "install" -and -not (Get-Command cargo -ErrorAction SilentlyContinue)) {
      Write-Output "Cargo is not on PATH, so the Tauri companion cannot be built."
      Write-Output "Building the Electron companion instead; it needs only Node."
      & (Join-Path $Root "scripts\build-electron-companion.ps1") | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "Electron companion build failed." }
      Invoke-RouterNode "src\tray-service-windows.mjs" @("install-electron")
      Write-Output "Companion installed and started by Task Scheduler; it returns at every logon."
      Write-Output "Windows 11 hides new tray icons: click the ^ chevron by the clock, then drag the icon onto the taskbar to pin it."
      exit 0
    }
    if ($Action -eq "install") {
      $Plan = & node (Join-Path $Root "src\install-plan.mjs") tray-plan
      if ($LASTEXITCODE -ne 0) { throw "Could not read the tray build plan." }
      if ($Plan.Trim() -eq "skip") {
        Write-Output "Companion already built from these sources; skipping the rebuild."
      } else {
        & (Join-Path $Root "scripts\build-desktop-tray.ps1") -BinaryOnly
        if ($LASTEXITCODE -ne 0) { throw "Desktop companion build failed." }
        # Not silenced: without the stamp every later update rebuilds the
        # companion from scratch, which is the cost this step exists to avoid.
        & node (Join-Path $Root "src\install-plan.mjs") record-tray | Out-Null
        if ($LASTEXITCODE -ne 0) {
          Write-Warning "Could not stamp the companion build; the next update will rebuild it."
        }
      }
    }
    Invoke-RouterNode "src\tray-service.mjs" @($Action)
    if ($Action -eq "install") {
      Write-Output "Tray installed and started by Task Scheduler; it returns at every logon."
      Write-Output "Windows 11 hides new tray icons: click the ^ chevron by the clock, then drag the icon onto the taskbar to pin it."
    }
  }
  # The same companion, built with Node instead of Rust. `tray` needs cargo and
  # several minutes of compiling; this needs what the router install already
  # required, so a machine with no Rust toolchain is not left without one.
  "companion" {
    $Action = if ($Arguments.Count) { [string]$Arguments[0] } else { "install" }
    if ($Action -notin @("install", "status", "start", "stop", "restart", "uninstall")) {
      throw "Unknown companion action '$Action'. Choose: install, status, start, stop, restart, uninstall."
    }
    if ($Action -eq "install") {
      & (Join-Path $Root "scripts\build-electron-companion.ps1") | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "Electron companion build failed." }
      Invoke-RouterNode "src\tray-service-windows.mjs" @("install-electron")
      Write-Output "Companion installed and started by Task Scheduler; it returns at every logon."
      Write-Output "Windows 11 hides new tray icons: click the ^ chevron by the clock, then drag the icon onto the taskbar to pin it."
    } else {
      Invoke-RouterNode "src\tray-service.mjs" @($Action)
    }
  }
}

exit 0
