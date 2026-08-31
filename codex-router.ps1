$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$Target = if ($env:MODEL_ROUTER_TARGET) { $env:MODEL_ROUTER_TARGET } else { "codex" }
if ($Target -notin @("codex", "dsh", "gemini", "cursor", "claude")) {
  throw "MODEL_ROUTER_TARGET must be codex, dsh, gemini, cursor, or claude."
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
  "setup", "install", "doctor", "status", "providers", "provider-key", "caller-key", "key-pool", "search-sidecar", "enable",
  "disable", "chatgpt-session", "skills", "uninstall", "update", "rollback", "support-bundle",
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

function Remove-TargetIntegration {
  switch ($Target) {
    "dsh" { Invoke-RouterNode "src\dsh-config-manager.mjs" @("uninstall") }
    "gemini" { Invoke-RouterNode "src\gemini-config-manager.mjs" @("uninstall") }
    "cursor" { Invoke-RouterNode "src\cursor-config-manager.mjs" @("uninstall") }
    "claude" { Invoke-RouterNode "src\claude-code-config-manager.mjs" @("uninstall") }
    default { Invoke-RouterNode "src\config-manager.mjs" @("disable") }
  }
  $Remaining = [string](& node (Join-Path $Root "src\target-integration.mjs") "installed-targets")
  if ($LASTEXITCODE -ne 0) { throw "Could not determine which router clients remain installed." }
  if ([string]::IsNullOrWhiteSpace($Remaining)) {
    Invoke-RouterNode "src\service.mjs" @("uninstall")
  } elseif ($Target -eq "cursor") {
    # Restart the shared service without Cursor's publication marker so its
    # separately tunneled public-edge child is retired immediately.
    Invoke-RouterNode "src\service.mjs" @("install")
  }
}

function Open-ControlCenterWindow {
  $Binary = Join-Path $Root "apps\control-center\release\win-unpacked\Codex Router.exe"
  if (-not (Test-Path -LiteralPath $Binary -PathType Leaf)) {
    throw "The unified Control Center is not built at $Binary."
  }
  # Do not let a wrapper from one checkout open a different checkout's task.
  # The supervisor validates the registered executable and --tray-only action
  # against this exact canonical package before a secondary launch can signal
  # it through Electron's single-instance channel.
  Invoke-RouterNode "src\tray-service.mjs" @("validate")
  # Task Scheduler owns the primary tray-only process. A normal secondary
  # launch hands off to that process and asks it to show the one shared window.
  $HadElectronRunAsNode = Test-Path Env:ELECTRON_RUN_AS_NODE
  $PreviousElectronRunAsNode = $env:ELECTRON_RUN_AS_NODE
  try {
    # This wrapper can itself be reached through Electron's Node mode. A direct
    # GUI secondary must not inherit that switch or it will run as a Node child
    # instead of signalling the tray-owned Electron primary.
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    $Request = Start-Process -FilePath $Binary -PassThru
  } finally {
    if ($HadElectronRunAsNode) {
      Set-Item Env:ELECTRON_RUN_AS_NODE $PreviousElectronRunAsNode
    }
  }
  if (-not $Request.WaitForExit(15000)) {
    Stop-Process -Id $Request.Id -Force -ErrorAction SilentlyContinue
    throw "The Control Center did not accept the window-open request."
  }
  if ($Request.ExitCode -ne 0) {
    throw "The Control Center window-open request exited with status $($Request.ExitCode)."
  }
}

function Get-ControlCenterUpdateLayout {
  $AppDirectory = Join-Path $Root "apps\control-center"
  $ReleaseDirectory = Join-Path $AppDirectory "release"
  return [pscustomobject]@{
    ReleaseDirectory = $ReleaseDirectory
    TargetDirectory = (Join-Path $ReleaseDirectory "win-unpacked")
    BackupDirectory = (Join-Path $ReleaseDirectory ".win-unpacked.previous-transaction")
    JournalPath = (Join-Path $ReleaseDirectory ".win-control-center-transaction.json")
  }
}

function Assert-ControlCenterTransactionPath([string]$Target, [string]$Label, [string]$Kind = "Any") {
  if (-not (Test-Path -LiteralPath $Target)) { return }
  $Item = Get-Item -LiteralPath $Target -Force -ErrorAction Stop
  if (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Control Center recovery was refused: $Label is a reparse point at $Target."
  }
  if ($Kind -eq "Directory" -and -not $Item.PSIsContainer) {
    throw "Control Center recovery was refused: $Label is not a directory at $Target."
  }
  if ($Kind -eq "File" -and $Item.PSIsContainer) {
    throw "Control Center recovery was refused: $Label is not a file at $Target."
  }
}

function Replace-ControlCenterTransactionJournal([string]$Temporary, [string]$JournalPath) {
  # Prefer the atomic NTFS replacement. Some Windows PowerShell/.NET hosts have
  # nevertheless rejected valid journal paths here with ArgumentException, so
  # retain a recoverable same-volume fallback for that compatibility case.
  try {
    [IO.File]::Replace($Temporary, $JournalPath, $null)
    return
  } catch [ArgumentException] {
    $FallbackBackup = $JournalPath + ".replace-backup-" + [Guid]::NewGuid().ToString("N")
    Move-Item -LiteralPath $JournalPath -Destination $FallbackBackup -ErrorAction Stop
    try {
      Move-Item -LiteralPath $Temporary -Destination $JournalPath -ErrorAction Stop
    } catch {
      $ReplacementFailure = $_
      try {
        Move-Item -LiteralPath $FallbackBackup -Destination $JournalPath -ErrorAction Stop
      } catch {
        throw "Could not replace the Control Center transaction journal and could not restore its prior copy. $($_.Exception.Message)"
      }
      throw $ReplacementFailure
    }
    try {
      Remove-Item -LiteralPath $FallbackBackup -Force -ErrorAction Stop
    } catch {
      # The new journal is already durable. A protected stale backup is safer
      # than reporting a failed transaction after the replacement succeeded.
      Write-Warning "Control Center transaction journal was replaced, but its stale fallback backup could not be removed: $FallbackBackup"
    }
  }
}

function Get-ControlCenterTaskSddl([string]$TaskName) {
  $Service = New-Object -ComObject "Schedule.Service"
  $Service.Connect()
  return [string]($Service.GetFolder("\").GetTask($TaskName).GetSecurityDescriptor(7))
}

function Get-ControlCenterTaskSnapshot {
  try {
    $Validated = Get-ValidatedTrayTask
  } catch {
    if ($_.FullyQualifiedErrorId -like "CmdletizationQuery_NotFound_TaskName,*") {
      return [pscustomobject]@{
        Installed = $false
        WasRunning = $false
        Xml = $null
        Sddl = $null
        Execute = $null
        Argument = $null
        Sid = $null
      }
    }
    throw
  }

  $Xml = [string](Export-ScheduledTask -TaskName $Validated.Name -ErrorAction Stop)
  if ([string]::IsNullOrWhiteSpace($Xml)) {
    throw "Task Scheduler returned an empty export for '$($Validated.Name)'."
  }
  $Verified = Get-ValidatedTrayTask
  if (-not [string]::Equals($Verified.Execute, $Validated.Execute, [StringComparison]::OrdinalIgnoreCase) -or
      -not [string]::Equals($Verified.Argument, $Validated.Argument, [StringComparison]::Ordinal) -or
      $Verified.Sid -ne $Validated.Sid) {
    throw "Refusing to snapshot '$($Validated.Name)': its identity changed during export."
  }
  return [pscustomobject]@{
    Installed = $true
    WasRunning = ($Validated.State -eq "Running")
    Xml = $Xml
    Sddl = (Get-ControlCenterTaskSddl $Validated.Name)
    Execute = $Validated.Execute
    Argument = $Validated.Argument
    Sid = $Validated.Sid
  }
}

function Write-ControlCenterTransactionJournal($Transaction, [string]$Phase) {
  if ($Phase -notin @("prepared", "package-replaced", "replacement-ready", "recovering", "committed")) {
    throw "Refusing to write an unknown Control Center transaction phase '$Phase'."
  }
  [void][IO.Directory]::CreateDirectory($Transaction.ReleaseDirectory)
  Assert-ControlCenterTransactionPath $Transaction.ReleaseDirectory "release directory" "Directory"
  Assert-ControlCenterTransactionPath $Transaction.JournalPath "transaction journal" "File"
  $Document = [ordered]@{
    version = 1
    phase = $Phase
    hadPackage = [bool]$Transaction.HadPackage
    task = [ordered]@{
      installed = [bool]$Transaction.TaskSnapshot.Installed
      wasRunning = [bool]$Transaction.TaskSnapshot.WasRunning
      xml = $Transaction.TaskSnapshot.Xml
      sddl = $Transaction.TaskSnapshot.Sddl
    }
  }
  $Payload = ($Document | ConvertTo-Json -Depth 5 -Compress) + "`n"
  $Temporary = $Transaction.JournalPath + ".tmp-" + [Guid]::NewGuid().ToString("N")
  try {
    $Bytes = [Text.UTF8Encoding]::new($false).GetBytes($Payload)
    $Stream = [IO.FileStream]::new(
      $Temporary,
      [IO.FileMode]::CreateNew,
      [IO.FileAccess]::Write,
      [IO.FileShare]::None,
      4096,
      [IO.FileOptions]::WriteThrough
    )
    try {
      $Stream.Write($Bytes, 0, $Bytes.Length)
      $Stream.Flush($true)
    } finally {
      $Stream.Dispose()
    }
    Assert-ControlCenterTransactionPath $Temporary "temporary transaction journal" "File"
    if ([IO.File]::Exists($Transaction.JournalPath)) {
      Assert-ControlCenterTransactionPath $Transaction.JournalPath "transaction journal" "File"
      Replace-ControlCenterTransactionJournal $Temporary $Transaction.JournalPath
    } else {
      [IO.File]::Move($Temporary, $Transaction.JournalPath)
    }
  } finally {
    if ([IO.File]::Exists($Temporary)) {
      Assert-ControlCenterTransactionPath $Temporary "temporary transaction journal" "File"
      [IO.File]::Delete($Temporary)
    }
  }
  $Transaction.Phase = $Phase
}

function Read-ControlCenterTransactionJournal($Layout) {
  Assert-ControlCenterTransactionPath $Layout.JournalPath "transaction journal" "File"
  try {
    $Document = [IO.File]::ReadAllText($Layout.JournalPath) | ConvertFrom-Json
  } catch {
    throw "Control Center recovery was refused: the transaction journal is unreadable or malformed. $($_.Exception.Message)"
  }
  if ($Document.version -ne 1 -or
      $Document.phase -notin @("prepared", "package-replaced", "replacement-ready", "recovering", "committed") -or
      $Document.hadPackage -isnot [bool] -or
      $null -eq $Document.task -or
      $Document.task.installed -isnot [bool] -or
      $Document.task.wasRunning -isnot [bool]) {
    throw "Control Center recovery was refused: the transaction journal has an invalid schema."
  }
  if ($Document.task.installed) {
    if ([string]::IsNullOrWhiteSpace([string]$Document.task.xml) -or
        [string]::IsNullOrWhiteSpace([string]$Document.task.sddl)) {
      throw "Control Center recovery was refused: the prior task snapshot is incomplete."
    }
    [void](Read-ControlCenterTaskIdentityFromXml ([string]$Document.task.xml))
    try {
      [void][Security.AccessControl.RawSecurityDescriptor]::new([string]$Document.task.sddl)
    } catch {
      throw "Control Center recovery was refused: the prior task security descriptor is invalid."
    }
  } elseif ($Document.task.wasRunning -or
            $null -ne $Document.task.xml -or
            $null -ne $Document.task.sddl) {
    throw "Control Center recovery was refused: an absent prior task has contradictory state."
  }
  $SnapshotXml = $null
  $SnapshotSddl = $null
  if ($Document.task.installed) {
    $SnapshotXml = [string]$Document.task.xml
    $SnapshotSddl = [string]$Document.task.sddl
  }
  return [pscustomobject]@{
    ReleaseDirectory = $Layout.ReleaseDirectory
    TargetDirectory = $Layout.TargetDirectory
    BackupDirectory = $Layout.BackupDirectory
    JournalPath = $Layout.JournalPath
    HadPackage = [bool]$Document.hadPackage
    Phase = [string]$Document.phase
    TaskSnapshot = [pscustomobject]@{
      Installed = [bool]$Document.task.installed
      WasRunning = [bool]$Document.task.wasRunning
      Xml = $SnapshotXml
      Sddl = $SnapshotSddl
    }
  }
}

function Get-ControlCenterBackupOrphans($Layout) {
  if (-not (Test-Path -LiteralPath $Layout.ReleaseDirectory -PathType Container)) { return @() }
  return @(Get-ChildItem -LiteralPath $Layout.ReleaseDirectory -Force -Filter ".win-unpacked.previous-*")
}

function Remove-ControlCenterJournalTemps($Layout) {
  if (-not (Test-Path -LiteralPath $Layout.ReleaseDirectory -PathType Container)) { return }
  foreach ($Temporary in @(Get-ChildItem -LiteralPath $Layout.ReleaseDirectory -File -Force -Filter ".win-control-center-transaction.json.tmp-*")) {
    Assert-ControlCenterTransactionPath $Temporary.FullName "temporary transaction journal" "File"
    Remove-Item -LiteralPath $Temporary.FullName -Force
  }
}

function Assert-ControlCenterRecoveryState($Transaction) {
  Assert-ControlCenterTransactionPath $Transaction.TargetDirectory "live package" "Directory"
  Assert-ControlCenterTransactionPath $Transaction.BackupDirectory "rollback package" "Directory"
  $HasTarget = Test-Path -LiteralPath $Transaction.TargetDirectory -PathType Container
  $HasBackup = Test-Path -LiteralPath $Transaction.BackupDirectory -PathType Container
  if ($Transaction.Phase -eq "committed") {
    Assert-ControlCenterPackageComplete $Transaction
    return
  }
  if ($Transaction.HadPackage) {
    if ($Transaction.Phase -in @("package-replaced", "replacement-ready") -and -not $HasBackup) {
      throw "Control Center recovery was refused: the prior package backup is missing after replacement."
    }
    if (-not $HasTarget -and -not $HasBackup) {
      throw "Control Center recovery was refused: neither the live nor prior package exists."
    }
  } elseif ($HasBackup) {
    throw "Control Center recovery was refused: a first-install journal unexpectedly has a prior package backup."
  }
}

function Assert-ControlCenterPackageComplete($Transaction) {
  Assert-ControlCenterTransactionPath $Transaction.ReleaseDirectory "release directory" "Directory"
  Assert-ControlCenterTransactionPath $Transaction.TargetDirectory "live package" "Directory"
  $Resources = Join-Path $Transaction.TargetDirectory "resources"
  Assert-ControlCenterTransactionPath $Resources "packaged resources directory" "Directory"
  $Binary = Join-Path $Transaction.TargetDirectory "Codex Router.exe"
  $Archive = Join-Path $Resources "app.asar"
  foreach ($Artifact in @(
    [pscustomobject]@{ Path = $Binary; Label = "packaged executable" },
    [pscustomobject]@{ Path = $Archive; Label = "packaged app archive" }
  )) {
    Assert-ControlCenterTransactionPath $Artifact.Path $Artifact.Label "File"
    if (-not (Test-Path -LiteralPath $Artifact.Path -PathType Leaf) -or
        (Get-Item -LiteralPath $Artifact.Path -Force -ErrorAction Stop).Length -le 0) {
      throw "Control Center recovery was refused: the $($Artifact.Label) is missing or empty at $($Artifact.Path)."
    }
  }
}

function Restore-ControlCenterReplacement($Transaction) {
  # The builder swaps only these two validated paths. Keep the old package
  # untouched until the supervisor has proved the replacement ready; if that
  # proof fails, put the exact old directory back before restarting it.
  Assert-ControlCenterTransactionPath $Transaction.ReleaseDirectory "release directory" "Directory"
  if (Test-Path -LiteralPath $Transaction.BackupDirectory -PathType Container) {
    Assert-ControlCenterTransactionPath $Transaction.BackupDirectory "rollback package" "Directory"
    if (Test-Path -LiteralPath $Transaction.TargetDirectory) {
      Assert-ControlCenterTransactionPath $Transaction.TargetDirectory "live package" "Directory"
      Remove-Item -LiteralPath $Transaction.TargetDirectory -Recurse -Force
    }
    Move-Item -LiteralPath $Transaction.BackupDirectory -Destination $Transaction.TargetDirectory
  } elseif (-not $Transaction.HadPackage -and (Test-Path -LiteralPath $Transaction.TargetDirectory)) {
    # A first install has nothing to restore. Remove the failed replacement so
    # its registered path cannot masquerade as an installed, working app.
    Assert-ControlCenterTransactionPath $Transaction.TargetDirectory "failed first-install package" "Directory"
    Remove-Item -LiteralPath $Transaction.TargetDirectory -Recurse -Force
  }
}

function Restore-ControlCenterTaskSnapshot($TaskSnapshot) {
  $TaskName = "Codex Router Tray"
  if (-not $TaskSnapshot.Installed) {
    try {
      Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
    } catch {
      if ($_.FullyQualifiedErrorId -notlike "CmdletizationQuery_NotFound_TaskName,*") { throw }
    }
    return
  }

  $Expected = Read-ControlCenterTaskIdentityFromXml ([string]$TaskSnapshot.Xml)
  Register-ScheduledTask -TaskName $TaskName -Xml ([string]$TaskSnapshot.Xml) -Force -ErrorAction Stop | Out-Null
  $Service = New-Object -ComObject "Schedule.Service"
  $Service.Connect()
  $Registered = $Service.GetFolder("\").GetTask($TaskName)
  # 0x10 prevents Task Scheduler from adding a new principal ACE. The exported
  # XML restores every task setting/trigger/action; this restores the exact
  # owner/group/DACL that accompanied it.
  $Registered.SetSecurityDescriptor([string]$TaskSnapshot.Sddl, 0x10)
  $Restored = Get-ValidatedTrayTask
  if (-not [string]::Equals($Restored.Execute, $Expected.Execute, [StringComparison]::OrdinalIgnoreCase) -or
      -not [string]::Equals($Restored.Argument, $Expected.Argument, [StringComparison]::Ordinal) -or
      $Restored.Sid -ne $Expected.Sid) {
    throw "The prior tray task did not retain its exact action and principal after restoration."
  }
  $ExpectedDescriptor = [Security.AccessControl.RawSecurityDescriptor]::new([string]$TaskSnapshot.Sddl)
  $ActualDescriptor = [Security.AccessControl.RawSecurityDescriptor]::new((Get-ControlCenterTaskSddl $TaskName))
  $Sections = [Security.AccessControl.AccessControlSections]::Owner -bor
    [Security.AccessControl.AccessControlSections]::Group -bor
    [Security.AccessControl.AccessControlSections]::Access
  if ($ActualDescriptor.GetSddlForm($Sections) -ne $ExpectedDescriptor.GetSddlForm($Sections)) {
    throw "The prior tray task security descriptor did not survive restoration."
  }
  if ($TaskSnapshot.WasRunning) {
    Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $Deadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
      $State = (Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop).State.ToString()
      if ($State -eq "Running") { return }
      Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $Deadline)
    throw "The restored prior tray task did not return to its running state."
  }
}

function Recover-ControlCenterUpdateTransaction {
  $Layout = Get-ControlCenterUpdateLayout
  Assert-ControlCenterTransactionPath $Layout.ReleaseDirectory "release directory" "Directory"
  Assert-ControlCenterTransactionPath $Layout.TargetDirectory "live package" "Directory"
  Assert-ControlCenterTransactionPath $Layout.BackupDirectory "rollback package" "Directory"
  Remove-ControlCenterJournalTemps $Layout
  $JournalExists = Test-Path -LiteralPath $Layout.JournalPath
  if ($JournalExists) {
    Assert-ControlCenterTransactionPath $Layout.JournalPath "transaction journal" "File"
  }
  $Orphans = Get-ControlCenterBackupOrphans $Layout
  if (-not $JournalExists) {
    if ($Orphans.Count -gt 0) {
      throw "Control Center recovery was refused: a rollback package exists without its transaction journal: $($Orphans.FullName -join ', ')"
    }
    return $false
  }
  $Unexpected = @($Orphans | Where-Object {
    -not [string]::Equals($_.FullName, $Layout.BackupDirectory, [StringComparison]::OrdinalIgnoreCase)
  })
  if ($Unexpected.Count -gt 0) {
    throw "Control Center recovery was refused: unexpected rollback packages coexist with the journal: $($Unexpected.FullName -join ', ')"
  }

  $Transaction = Read-ControlCenterTransactionJournal $Layout
  Assert-ControlCenterRecoveryState $Transaction
  if ($Transaction.Phase -eq "committed") {
    if (Test-Path -LiteralPath $Transaction.BackupDirectory -PathType Container) {
      Assert-ControlCenterTransactionPath $Transaction.BackupDirectory "committed rollback package" "Directory"
      Remove-Item -LiteralPath $Transaction.BackupDirectory -Recurse -Force
    }
    Assert-ControlCenterTransactionPath $Transaction.JournalPath "committed transaction journal" "File"
    Remove-Item -LiteralPath $Transaction.JournalPath -Force
    return $true
  }

  # Refuse an unrelated named task before stopping or deleting anything. A
  # recognized current/legacy task can be stopped and then replaced with the
  # exact pre-transaction export below.
  $CurrentTask = Get-ControlCenterTaskSnapshot
  if ($CurrentTask.Installed) {
    $CanonicalExecute = Join-Path $Transaction.TargetDirectory "Codex Router.exe"
    $MatchesReplacement = Test-SameControlCenterTaskAction `
      $CurrentTask.Execute $CurrentTask.Argument $CanonicalExecute "--tray-only"
    $MatchesPrior = $false
    $MatchesRecoveringPrior = $false
    if ($Transaction.TaskSnapshot.Installed) {
      $Prior = Read-ControlCenterTaskIdentityFromXml ([string]$Transaction.TaskSnapshot.Xml)
      $MatchesPriorDocument = (Test-SameControlCenterTaskAction `
        $CurrentTask.Execute $CurrentTask.Argument $Prior.Execute $Prior.Argument) -and
        [string]::Equals($CurrentTask.Xml, $Transaction.TaskSnapshot.Xml, [StringComparison]::Ordinal)
      $MatchesPrior = $MatchesPriorDocument -and
        (Test-SameControlCenterTaskSddl $CurrentTask.Sddl $Transaction.TaskSnapshot.Sddl)
      # Register-ScheduledTask publishes the prior XML before its exact SDDL is
      # restored. If that second step fails, the durable recovering phase plus
      # the byte-identical prior XML/action proves this is our own partial
      # restore and lets the next mutation retry it idempotently. No other phase
      # accepts a changed task security descriptor.
      $MatchesRecoveringPrior = $Transaction.Phase -eq "recovering" -and $MatchesPriorDocument
    }
    if (-not $MatchesReplacement -and -not $MatchesPrior -and -not $MatchesRecoveringPrior) {
      throw "Control Center recovery was refused: the named Scheduled Task changed after the transaction began."
    }
  }
  Write-ControlCenterTransactionJournal $Transaction "recovering"
  Invoke-RouterNode "src\tray-service.mjs" @("stop")
  Restore-ControlCenterReplacement $Transaction
  Restore-ControlCenterTaskSnapshot $Transaction.TaskSnapshot
  Assert-ControlCenterTransactionPath $Transaction.JournalPath "recovered transaction journal" "File"
  Remove-Item -LiteralPath $Transaction.JournalPath -Force
  return $true
}

function New-ControlCenterUpdateTransaction {
  [void](Recover-ControlCenterUpdateTransaction)
  $Layout = Get-ControlCenterUpdateLayout
  $Orphans = Get-ControlCenterBackupOrphans $Layout
  if ($Orphans.Count -gt 0) {
    throw "Refusing to begin a Control Center update while rollback packages remain: $($Orphans.FullName -join ', ')"
  }
  $Transaction = [pscustomobject]@{
    ReleaseDirectory = $Layout.ReleaseDirectory
    TargetDirectory = $Layout.TargetDirectory
    BackupDirectory = $Layout.BackupDirectory
    JournalPath = $Layout.JournalPath
    HadPackage = (Test-Path -LiteralPath $Layout.TargetDirectory -PathType Container)
    Phase = "prepared"
    TaskSnapshot = (Get-ControlCenterTaskSnapshot)
  }
  Write-ControlCenterTransactionJournal $Transaction "prepared"
  return $Transaction
}

function Build-ControlCenterReplacement($Transaction) {
  & (Join-Path $Root "scripts\build-electron-companion.ps1") `
    -BackupDirectory $Transaction.BackupDirectory -KeepPrevious | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Control Center build failed." }
  Write-ControlCenterTransactionJournal $Transaction "package-replaced"
}

function Complete-ControlCenterReplacement($Transaction) {
  # A readiness response is necessary but not sufficient at the commit point:
  # re-prove the package tree while rollback is still possible. If this fails,
  # the caller sees an update failure and the uncommitted journal restores the
  # exact prior task and package.
  Assert-ControlCenterTransactionPath $Transaction.ReleaseDirectory "release directory" "Directory"
  Assert-ControlCenterRecoveryState $Transaction
  Assert-ControlCenterPackageComplete $Transaction
  Write-ControlCenterTransactionJournal $Transaction "committed"
  try {
    Assert-ControlCenterTransactionPath $Transaction.ReleaseDirectory "release directory" "Directory"
    # Re-prove the exact live package before discarding its rollback copy. A
    # replacement or reparse race after the ready handshake must leave both the
    # committed journal and backup intact for explicit recovery.
    Assert-ControlCenterRecoveryState $Transaction
    if (Test-Path -LiteralPath $Transaction.BackupDirectory -PathType Container) {
      Assert-ControlCenterTransactionPath $Transaction.BackupDirectory "committed rollback package" "Directory"
      Remove-Item -LiteralPath $Transaction.BackupDirectory -Recurse -Force
    }
    Assert-ControlCenterTransactionPath $Transaction.JournalPath "committed transaction journal" "File"
    Remove-Item -LiteralPath $Transaction.JournalPath -Force
  } catch {
    # The committed target is already ready. Keep the committed journal so the
    # next tray transaction can validate the live package and finish cleanup.
    Write-Warning "The Control Center is ready, but its committed transaction cleanup is pending: $($_.Exception.Message)"
  }
}

function Undo-ControlCenterReplacement($Transaction, [bool]$WasRunning, [string]$Label) {
  [void](Recover-ControlCenterUpdateTransaction)
  if ($Transaction.TaskSnapshot.Installed -and $Transaction.TaskSnapshot.WasRunning) {
    Write-Warning "$Label; the exact previous companion package and Scheduled Task were restored and restarted."
  } else {
    Write-Warning "$Label; the exact previous package and Scheduled Task state were restored."
  }
}

function Record-ControlCenterBuild {
  # Record only after Task Scheduler and the app-ready handshake accept the new
  # package. Until then the old fingerprint remains the authoritative stamp,
  # so rollback never has to reconstruct or approximate it.
  & node (Join-Path $Root "src\install-plan.mjs") record-tray | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "Could not stamp the companion build; the next update will rebuild it."
  }
}

function Get-ObsoleteTauriExecutableForRemoval {
  # apps\desktop is intentionally no longer tracked. Treat every surviving
  # component as hostile migration residue: a junction at any ancestor could
  # otherwise turn a successful update into deletion outside this checkout.
  $Cursor = $Root
  foreach ($Segment in @("apps", "desktop", "src-tauri", "target", "release")) {
    $Cursor = Join-Path $Cursor $Segment
    if (-not (Test-Path -LiteralPath $Cursor)) { return $null }
    Assert-ControlCenterTransactionPath $Cursor "obsolete Tauri path component" "Directory"
  }
  $LegacyBinary = Join-Path $Cursor "codex-router-desktop.exe"
  if (-not (Test-Path -LiteralPath $LegacyBinary)) { return $null }
  Assert-ControlCenterTransactionPath $LegacyBinary "obsolete Tauri executable" "File"
  return $LegacyBinary
}

function Get-ControlCenterLifecycle {
  try {
    $Document = (& node (Join-Path $Root "src\tray-service.mjs") lifecycle | Out-String)
    if ($LASTEXITCODE -ne 0) { return $null }
    $Lifecycle = $Document | ConvertFrom-Json
    if ($Lifecycle.version -ne 1 -or
        $Lifecycle.running -isnot [bool] -or
        $Lifecycle.ready -isnot [bool] -or
        $Lifecycle.visible -isnot [bool]) {
      return $null
    }
    return $Lifecycle
  } catch {
    return $null
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

function Test-RecognizedControlCenterTaskAction([string]$Execute, [string]$Argument) {
  try {
    $ExpandedExecute = [IO.Path]::GetFullPath(
      [Environment]::ExpandEnvironmentVariables($Execute)
    )
  } catch {
    return $false
  }
  $TauriAction = $ExpandedExecute.EndsWith(
    "apps\desktop\src-tauri\target\release\codex-router-desktop.exe",
    [StringComparison]::OrdinalIgnoreCase
  ) -and [string]::IsNullOrWhiteSpace($Argument)
  $ElectronAction = $ExpandedExecute.EndsWith(
    "apps\electron\node_modules\electron\dist\electron.exe",
    [StringComparison]::OrdinalIgnoreCase
  ) -and (
    $Argument.Trim().Trim('"').EndsWith(
      "apps\electron",
      [StringComparison]::OrdinalIgnoreCase
    )
  )
  $ControlCenterAction = $ExpandedExecute.EndsWith(
    "apps\control-center\release\win-unpacked\Codex Router.exe",
    [StringComparison]::OrdinalIgnoreCase
  ) -and $Argument.Trim() -eq "--tray-only"
  return $ControlCenterAction -or $TauriAction -or $ElectronAction
}

function Test-SameControlCenterTaskAction(
  [string]$LeftExecute,
  [string]$LeftArgument,
  [string]$RightExecute,
  [string]$RightArgument
) {
  try {
    $LeftPath = [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($LeftExecute))
    $RightPath = [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($RightExecute))
    return [string]::Equals($LeftPath, $RightPath, [StringComparison]::OrdinalIgnoreCase) -and
      [string]::Equals($LeftArgument, $RightArgument, [StringComparison]::Ordinal)
  } catch {
    return $false
  }
}

function Test-SameControlCenterTaskSddl([string]$Left, [string]$Right) {
  try {
    $LeftDescriptor = [Security.AccessControl.RawSecurityDescriptor]::new($Left)
    $RightDescriptor = [Security.AccessControl.RawSecurityDescriptor]::new($Right)
    $Sections = [Security.AccessControl.AccessControlSections]::Owner -bor
      [Security.AccessControl.AccessControlSections]::Group -bor
      [Security.AccessControl.AccessControlSections]::Access
    return $LeftDescriptor.GetSddlForm($Sections) -eq $RightDescriptor.GetSddlForm($Sections)
  } catch {
    return $false
  }
}

function Read-ControlCenterTaskIdentityFromXml([string]$TaskXml) {
  try {
    $Document = [xml]$TaskXml
    $Namespace = [Xml.XmlNamespaceManager]::new($Document.NameTable)
    $Namespace.AddNamespace("task", $Document.DocumentElement.NamespaceURI)
    $Actions = @($Document.SelectNodes("/task:Task/task:Actions/*", $Namespace))
    if ($Actions.Count -ne 1 -or $Actions[0].LocalName -ne "Exec") {
      throw "the export does not contain one Exec action"
    }
    $CommandNode = $Actions[0].SelectSingleNode("task:Command", $Namespace)
    $ArgumentNode = $Actions[0].SelectSingleNode("task:Arguments", $Namespace)
    $Principals = @($Document.SelectNodes("/task:Task/task:Principals/task:Principal", $Namespace))
    if ($null -eq $CommandNode -or $Principals.Count -ne 1) {
      throw "the export does not contain one command and principal"
    }
    $UserNode = $Principals[0].SelectSingleNode("task:UserId", $Namespace)
    $LogonNode = $Principals[0].SelectSingleNode("task:LogonType", $Namespace)
    if ($null -eq $UserNode -or $null -eq $LogonNode -or $LogonNode.InnerText -ne "InteractiveToken") {
      throw "the export is not an interactive user task"
    }
    $Execute = [string]$CommandNode.InnerText
    $Argument = if ($null -eq $ArgumentNode) { "" } else { [string]$ArgumentNode.InnerText }
    $CurrentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $PrincipalSid = Resolve-AccountSid ([string]$UserNode.InnerText)
    if ($PrincipalSid -ne $CurrentSid) {
      throw "the export principal is not the current user"
    }
    if (-not (Test-RecognizedControlCenterTaskAction $Execute $Argument)) {
      throw "the export action is not a recognized Codex Router Control Center"
    }
    return [pscustomobject]@{
      Execute = $Execute
      Argument = $Argument
      Sid = $PrincipalSid
    }
  } catch {
    throw "Control Center recovery was refused: the prior task XML is invalid: $($_.Exception.Message)"
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
  $Argument = [string]$TaskAction.Arguments

  # A task registered by an installed copy (%LOCALAPPDATA%\codex-router) points
  # at that root, while `tray repair` is often run from a developer checkout's
  # $PSScriptRoot. Requiring the action to equal *this* checkout would reject
  # exactly the person reaching for repair. So the action is recognized by the
  # *shape* of a real companion -- the unified Control Center or either legacy
  # shell during migration -- rather than by which root registered it.
  # The principal/interactive/single-action checks above still stop repair of an
  # arbitrary scheduled task.
  if (-not (Test-RecognizedControlCenterTaskAction ([string]$TaskAction.Execute) $Argument)) {
    throw "Refusing to repair '$TaskName': its action is not a recognized Codex Router Control Center."
  }

  return [pscustomobject]@{
    Name = $TaskName
    Sid = $CurrentSid
    Execute = [string]$TaskAction.Execute
    Argument = $Argument
    State = $Task.State.ToString()
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

  # The validated values are the only data the elevated side needs, but they
  # cannot cross the UAC boundary: Start-Process -Verb RunAs goes through
  # ShellExecuteEx -> AppInfo -> CreateProcessAsUser, which rebuilds the child
  # environment from the elevated token, so `$env:CODEX_ROUTER_TRAY_REPAIR_*`
  # would be empty inside the elevated process. Instead the four values are
  # embedded as literals in the -EncodedCommand payload, and the elevated side
  # re-reads the task and compares its principal and action against them --
  # the same TOCTOU closure as before, with no process-environment handoff.
  # The repository-recognized legacy Tauri action deliberately has no argv.
  # Its empty Argument is part of the exact identity, not a missing validation
  # field; the elevated side still compares that empty string byte-for-byte.
  foreach ($Field in "Name", "Sid", "Execute") {
    if ([string]::IsNullOrWhiteSpace([string]$Validated.$Field)) {
      throw "Refusing to repair the tray task: validated $Field is empty."
    }
  }
  $ElevatedScript = @'
$ErrorActionPreference = "Stop"
function Resolve-RepairSid([string]$Identity) {
  try { return ([Security.Principal.SecurityIdentifier]::new($Identity)).Value }
  catch { return ([Security.Principal.NTAccount]::new($Identity)).Translate([Security.Principal.SecurityIdentifier]).Value }
}
$scheduled = Get-ScheduledTask -TaskName __TRAY_TASK__ -ErrorAction Stop
$actions = @($scheduled.Actions)
if ($actions.Count -ne 1) { throw "Tray task action changed before repair." }
$principalSid = Resolve-RepairSid ([string]$scheduled.Principal.UserId)
if ($principalSid -ne __TRAY_SID__ -or
    -not [string]::Equals([string]$actions[0].Execute, __TRAY_EXECUTE__, [StringComparison]::OrdinalIgnoreCase) -or
    -not [string]::Equals([string]$actions[0].Arguments, __TRAY_ARGUMENT__, [StringComparison]::Ordinal)) {
  throw "Tray task identity changed before repair."
}
$service = New-Object -ComObject "Schedule.Service"
$service.Connect()
$registered = $service.GetFolder("\").GetTask(__TRAY_TASK__)
$descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($registered.GetSecurityDescriptor(7))
$sid = [Security.Principal.SecurityIdentifier]::new(__TRAY_SID__)
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
  # `Replace` substitutes only after the single-quoted here-string is
  # assembled, so the embedded script's own `$...` stays verbatim; each value
  # is wrapped in single quotes (doubling any embedded quote) so it becomes a
  # string literal in the payload, never executable text.
  function ConvertTo-RepairLiteral([string]$Value) {
    return "'" + $Value.Replace("'", "''") + "'"
  }
  $ElevatedScript = $ElevatedScript.Replace(
    "__TRAY_TASK__", (ConvertTo-RepairLiteral ([string]$Validated.Name)))
  $ElevatedScript = $ElevatedScript.Replace(
    "__TRAY_SID__", (ConvertTo-RepairLiteral ([string]$Validated.Sid)))
  $ElevatedScript = $ElevatedScript.Replace(
    "__TRAY_EXECUTE__", (ConvertTo-RepairLiteral ([string]$Validated.Execute)))
  $ElevatedScript = $ElevatedScript.Replace(
    "__TRAY_ARGUMENT__", (ConvertTo-RepairLiteral ([string]$Validated.Argument)))

  # Name the host absolutely because -Verb RunAs forces ShellExecuteEx, whose
  # search order includes the current working directory and every PATH entry;
  # an unelevated attacker who can drop a powershell.exe there would otherwise
  # get it launched behind the UAC prompt, fully elevated. Pin the working
  # directory to SystemRoot so the elevated child runs from a directory no
  # attacker can write.
  $ElevatedPowerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  if (-not (Test-Path -LiteralPath $ElevatedPowerShell -PathType Leaf)) {
    throw "Cannot locate the elevated PowerShell host at $ElevatedPowerShell."
  }
  $Encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($ElevatedScript))
  $Process = Start-Process -FilePath $ElevatedPowerShell -Verb RunAs -Wait -PassThru -WindowStyle Hidden -WorkingDirectory $env:SystemRoot -ArgumentList @(
    "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", $Encoded
  )
  if ($Process.ExitCode -ne 0) {
    throw "Elevated tray permission repair failed with exit code $($Process.ExitCode)."
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
  "caller-key" { Invoke-RouterNode "src\caller-key.mjs" $Arguments }
  "key-pool" { Invoke-RouterNode "src\control.mjs" (@("key-pool") + $Arguments) }
  "search-sidecar" { Invoke-RouterNode "src\search-sidecar-control.mjs" $Arguments }
  "chatgpt-session" { Invoke-RouterNode "src\chatgpt-session.mjs" $Arguments }
  "skills" { Invoke-RouterNode "src\skills-install.mjs" $Arguments }
  # `bin/install` accepts --prepare-only/--migrate-known/--force-deps, so the
  # Windows wrapper has to pass the equivalent switches through instead of
  # dropping them; `./model-router.ps1 codex install -ForceDeps` was silently
  # running a plain install.
  "install" { & (Join-Path $Root "install.ps1") -CheckoutInstall -Target $Target @Arguments }
  "enable" { & (Join-Path $Root "install.ps1") -CheckoutInstall -Target $Target @Arguments }
  "disable" {
    Remove-TargetIntegration
  }
  "uninstall" {
    Remove-TargetIntegration
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
  "start" {
    if ($Arguments.Count -eq 0) {
      Invoke-RouterNode "src\service.mjs" @("start")
    } elseif ($Arguments.Count -eq 1 -and [string]$Arguments[0] -eq "--foreground") {
      Invoke-RouterNode "src\foreground-start.mjs" @()
    } else {
      throw "Usage: codex-router.ps1 start [--foreground]."
    }
  }
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
    if (($Arguments -contains "--tray-only") -and ($Arguments -contains "--preserve-window")) {
      throw "Choose only one tray launch mode: --tray-only or --preserve-window."
    }
    $TrayLaunchMode = if ($Arguments -contains "--tray-only") {
      "tray-only"
    } elseif ($Arguments -contains "--preserve-window") {
      "preserve-window"
    } else {
      "interactive"
    }
    if ($Action -notin @("install", "refresh", "status", "start", "stop", "restart", "uninstall", "rebuild", "repair")) {
      throw "Unknown tray action '$Action'. Choose: install, refresh, status, start, stop, restart, uninstall, rebuild, repair."
    }
    # A durable interrupted replacement is reconciled before any later
    # mutation. Status remains read-only; its next mutating follow-up performs
    # the recovery rather than surprising a capability probe with writes.
    if ($Action -ne "status") {
      [void](Recover-ControlCenterUpdateTransaction)
    }
    if ($Action -eq "repair") {
      Write-Output "Repairing the tray task's permissions. If repair is needed, the companion will then be rebuilt or reinstalled (a small step), re-registered, and started by Task Scheduler at every logon."
      Repair-TrayTaskPermissions
      $Action = "install"
    }
    $OpenAfterAction = $false
    $PreviousLifecycle = $null
    if ($Action -in @("install", "refresh", "start", "restart", "rebuild")) {
      $PreviousLifecycle = Get-ControlCenterLifecycle
      if ($TrayLaunchMode -eq "interactive") {
        $OpenAfterAction = $true
      } elseif ($TrayLaunchMode -eq "preserve-window") {
        # Capture visibility before stop/drain. The packaged query is read-only
        # and does not acquire Electron's single-instance lock or open a window.
        $OpenAfterAction = $null -ne $PreviousLifecycle -and
          $PreviousLifecycle.running -eq $true -and
          $PreviousLifecycle.visible -eq $true
      }
    }
    # `rebuild` is `control tray rebuild`'s Windows half: build unconditionally
    # -- bypassing the source-fingerprint skip that `install` uses -- then
    # restart whichever companion Task Scheduler already supervises.
    if ($Action -eq "rebuild") {
      # A running Control Center keeps its packaged executable open, and
      # Windows refuses to overwrite a file another process holds. Building in
      # place over a live tray fails every time, leaving the old companion in
      # place (or broken). So a rebuild stops the supervised task before it
      # builds, and restores the previous instance best-effort if the build or
      # install afterwards fails.
      $TrayWasRunning = $null -ne $PreviousLifecycle -and $PreviousLifecycle.running -eq $true
      try {
        $TrayState = (& node (Join-Path $Root "src\tray-service.mjs") status | Out-String)
        if ($LASTEXITCODE -eq 0) {
          $TrayWasRunning = $TrayWasRunning -or (($TrayState | ConvertFrom-Json).loaded -eq $true)
        }
      } catch {
        # An unreadable status is not a reason to build over a running tray;
        # stopping first is safe either way. Preserve lifecycle evidence that
        # the previous app was running so rollback still restarts it.
      }
      $Transaction = New-ControlCenterUpdateTransaction
      try {
        # `stop` is a no-op for an absent or idle task, but it waits for an
        # exact manually launched primary too before the package is swapped.
        Invoke-RouterNode "src\tray-service.mjs" @("stop")
        Build-ControlCenterReplacement $Transaction
        Invoke-RouterNode "src\tray-service.mjs" @("install")
        Write-ControlCenterTransactionJournal $Transaction "replacement-ready"
        Complete-ControlCenterReplacement $Transaction
        Record-ControlCenterBuild
      } catch {
        $ReplacementFailure = $_
        try {
          Undo-ControlCenterReplacement $Transaction $TrayWasRunning "Companion rebuild failed"
          if ($OpenAfterAction -and $Transaction.HadPackage -and $TrayWasRunning) {
            Open-ControlCenterWindow
          }
        } catch {
          throw "Companion rebuild failed ($($ReplacementFailure.Exception.Message)) and rollback failed: $($_.Exception.Message)"
        }
        throw $ReplacementFailure
      }
      if ($OpenAfterAction) { Open-ControlCenterWindow }
      Write-Output "Companion rebuilt, installed, and started."
      exit 0
    }
    $RefreshOnly = $Action -eq "refresh"
    $ActionHandled = $false
    if ($Action -in @("install", "refresh")) {
      $Plan = & node (Join-Path $Root "src\install-plan.mjs") tray-plan
      if ($LASTEXITCODE -ne 0) { throw "Could not read the tray build plan." }
      if ($Plan.Trim() -eq "skip") {
        Write-Output "Control Center already built from these sources; skipping the rebuild."
        if ($RefreshOnly) { exit 0 }
        # Even without a package swap, install may migrate an exact legacy task
        # or repair the canonical registration. Snapshot and journal that task
        # before Register-ScheduledTask replaces it so a DACL/start/readiness
        # failure restores the byte-exact XML, SDDL, and running state.
        $Transaction = New-ControlCenterUpdateTransaction
        try {
          Invoke-RouterNode "src\tray-service.mjs" @("install")
          Complete-ControlCenterReplacement $Transaction
        } catch {
          $RegistrationFailure = $_
          try {
            Undo-ControlCenterReplacement $Transaction $false "Companion registration failed"
          } catch {
            throw "Companion registration failed ($($RegistrationFailure.Exception.Message)) and rollback failed: $($_.Exception.Message)"
          }
          throw $RegistrationFailure
        }
        $ActionHandled = $true
      } else {
        $TrayWasRunning = $Plan.Trim() -eq "rebuild"
        if ($TrayWasRunning) {
          try {
            $TrayState = (& node (Join-Path $Root "src\tray-service.mjs") status | Out-String)
            if ($LASTEXITCODE -eq 0) {
              $TrayWasRunning = ($null -ne $PreviousLifecycle -and $PreviousLifecycle.running -eq $true) -or
                (($TrayState | ConvertFrom-Json).loaded -eq $true)
            }
          } catch {
            # Keep the conservative true value. Restarting an idle registered
            # task is safer than leaving a previously running app stopped.
          }
        }
        $Transaction = New-ControlCenterUpdateTransaction
        try {
          # A previous Control Center may hold files in win-unpacked open. Ask
          # it to drain mutations and exit before the staged package is swapped.
          if ($Plan.Trim() -eq "rebuild") {
            Invoke-RouterNode "src\tray-service.mjs" @("stop")
          }
          Build-ControlCenterReplacement $Transaction
          # A refresh becomes an install only after tray-plan proves the
          # package stale. This is the detached half of UI self-repair: the
          # installer cannot synchronously stop the Control Center that called
          # it, but the post-mutation refresh safely can.
          Invoke-RouterNode "src\tray-service.mjs" @("install")
          Write-ControlCenterTransactionJournal $Transaction "replacement-ready"
          Complete-ControlCenterReplacement $Transaction
          Record-ControlCenterBuild
        } catch {
          $ReplacementFailure = $_
          try {
            Undo-ControlCenterReplacement $Transaction $TrayWasRunning "Companion update failed"
            if ($OpenAfterAction -and $Transaction.HadPackage -and $TrayWasRunning) {
              Open-ControlCenterWindow
            }
          } catch {
            throw "Companion update failed ($($ReplacementFailure.Exception.Message)) and rollback failed: $($_.Exception.Message)"
          }
          throw $ReplacementFailure
        }
        $ActionHandled = $true
      }
    }
    if (-not $ActionHandled) {
      Invoke-RouterNode "src\tray-service.mjs" @($Action)
    }
    if ($OpenAfterAction -and $Action -in @("install", "refresh", "start", "restart")) {
      Open-ControlCenterWindow
    }
    if ($Action -in @("install", "refresh")) {
      # The old Tauri binary was a standalone competing app. Any surviving
      # apps\electron runtime is legacy process evidence, not a second app to
      # launch or an update target.
      try {
        $LegacyBinary = Get-ObsoleteTauriExecutableForRemoval
        if ($null -ne $LegacyBinary) {
          Remove-Item -LiteralPath $LegacyBinary -Force
          Write-Output "Removed superseded desktop executable: $LegacyBinary"
        }
      } catch {
        Write-Warning "The unified Control Center is installed, but the superseded Tauri path was unsafe or could not be removed: $($_.Exception.Message)"
      }
      Write-Output "Tray installed and started by Task Scheduler; it returns at every logon."
      Write-Output "Windows 11 hides new tray icons: click the ^ chevron by the clock, then drag the icon onto the taskbar to pin it."
    }
  }
  # Compatibility spelling retained for one migration release. It delegates
  # to the same build and Task Scheduler transaction, never a second app.
  "companion" {
    $Action = if ($Arguments.Count) { [string]$Arguments[0] } else { "install" }
    if ($Action -notin @("install", "status", "start", "stop", "restart", "uninstall")) {
      throw "Unknown companion action '$Action'. Choose: install, status, start, stop, restart, uninstall."
    }
    Write-Warning "'companion' is now an alias of the unified 'tray' command."
    & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath tray $Action
    exit $LASTEXITCODE
  }
}

exit 0
