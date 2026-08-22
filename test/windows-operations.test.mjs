import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readScript = (name) => readFileSync(path.join(root, name), "utf8");

test("the Windows operational scripts parse in Windows PowerShell", { skip: process.platform !== "win32" }, () => {
  for (const name of ["install.ps1", "deploy-codex-router.ps1", "restart-codex-router.ps1"]) {
    const target = path.join(root, name).replaceAll("'", "''");
    const check = [
      "$tokens = $null; $errors = $null",
      `[System.Management.Automation.Language.Parser]::ParseFile('${target}', [ref]$tokens, [ref]$errors) | Out-Null`,
      "if ($errors.Count) { $errors | ForEach-Object { $_.Message }; exit 1 }",
    ].join("; ");
    execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", check], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
  }
});

test("the Windows restart helper uses the supported service transaction", () => {
  const source = readScript("restart-codex-router.ps1");
  assert.match(source, /\$env:LOCALAPPDATA/);
  assert.match(source, /\$routerRoot\s*=\s*\[IO\.Path\]::GetFullPath\(\$InstallDir\)/);
  assert.match(source, /src\\service\.mjs"\) restart/);
  assert.match(source, /\$RestartExitCode\s*=\s*\$LASTEXITCODE/);
  assert.match(source, /if \(\$RestartExitCode -ne 0\)/);
  assert.doesNotMatch(source, /codex-router\.ps1"\) codex restart/);
  assert.doesNotMatch(source, /control\.mjs.*service.*restart/);
  assert.doesNotMatch(source, /Split-Path -Parent \$MyInvocation\.MyCommand\.Path/);
});

test("the local deploy helper copies source without purging target-only files", () => {
  const source = readScript("deploy-codex-router.ps1");
  assert.match(source, /Test-NestedDirectory \$sourceDir \$installDir/);
  assert.match(source, /Test-NestedDirectory \$installDir \$sourceDir/);
  assert.match(source, /"\/E"/);
  assert.doesNotMatch(source, /"\/(?:MIR|PURGE)"/);
  assert.match(source, /\.codex-router-deploy-manifest\.json/);
  assert.match(source, /Resolve-ManagedTargetFile/);
  assert.match(source, /Remove-Item -LiteralPath \$Target -Force/);
  assert.match(source, /ReparsePoint/);
  for (const directory of [".git", ".venv", "node_modules", "target", "dist", "release"]) {
    assert.match(source, new RegExp(`"${directory.replace(".", "\\.")}"`));
  }
  assert.match(source, /\$CopyExitCode\s*=\s*\$LASTEXITCODE/);
  assert.match(source, /if \(\$CopyExitCode -gt 7\)/);
});

test("deploy runs the installed canonical transaction and doctor without replacing selection", () => {
  const source = readScript("deploy-codex-router.ps1");
  assert.match(
    source,
    /Join-Path \$installDir "install\.ps1"\) -CheckoutInstall -Target codex/,
  );
  assert.doesNotMatch(source, /-Providers\b/);
  assert.match(source, /src\\doctor\.mjs/);
  assert.match(source, /\$DoctorExitCode\s*=\s*\$LASTEXITCODE/);
  assert.match(source, /if \(\$DoctorExitCode -ne 0\)/);
  assert.doesNotMatch(source, /src\\catalog\.mjs/);
  assert.doesNotMatch(source, /src\\litellm-config\.mjs/);
  assert.doesNotMatch(source, /control\.mjs.*service.*restart/);
});

test("deploy and install preserve the existing tray opt-in", () => {
  const deploy = readScript("deploy-codex-router.ps1");
  const install = readScript("install.ps1");

  assert.match(deploy, /\$TrayWasInstalled\s*=\s*\(Get-TrayStatus\)\.installed -eq \$true/);
  const trayGate = deploy.indexOf("if ($TrayWasInstalled)");
  const trayStop = deploy.indexOf('src\\tray-service.mjs") stop', trayGate);
  const trayInstall = deploy.indexOf('codex-router.ps1") tray install', trayStop);
  const trayVerify = deploy.indexOf("$TrayStatus = Get-TrayStatus", trayInstall);
  const success = deploy.indexOf("Codex Router published, installed, and verified.");
  assert.ok(trayGate >= 0 && trayStop > trayGate, "an opted-in tray must be stopped before refresh");
  assert.ok(trayInstall > trayStop, "the stopped tray must be refreshed through the installed wrapper");
  assert.ok(trayVerify > trayInstall, "tray status must be read after the strict refresh");
  assert.ok(success > trayVerify, "deployment success must follow tray verification");
  assert.match(deploy, /powershell\.exe[^\n]+codex-router\.ps1"\) tray install/);
  assert.match(deploy, /\$env:MODEL_ROUTER_TARGET\s*=\s*"codex"/);
  assert.match(deploy, /\$env:MODEL_ROUTER_TARGET\s*=\s*\$SavedRouterTarget/);
  assert.match(deploy, /\$TrayInstallExitCode\s*=\s*\$LASTEXITCODE/);
  assert.match(deploy, /if \(\$TrayInstallExitCode -ne 0\)[\s\S]*?throw/);
  assert.match(deploy, /-not \$TrayStatus\.installed[\s\S]*?-not \$TrayStatus\.loaded[\s\S]*?-not \$TrayStatus\.appPresent/);
  assert.match(deploy, /codex-router-desktop\.exe/);
  assert.match(deploy, /electron\.exe/);
  assert.match(deploy, /\[string\]::Equals\([\s\S]*?\$RegisteredTrayPath[\s\S]*?\$ExpectedTrayPath/);
  assert.doesNotMatch(deploy, /tray-service\.mjs"\) restart/);

  const status = install.indexOf("$TrayWasInstalled = (Get-InstallerStateField");
  const health = install.indexOf("src/wait-health.mjs");
  const refresh = install.indexOf("codex-router.ps1\") tray install");
  assert.ok(status >= 0 && status < health, "tray presence must be captured before installation");
  assert.ok(refresh > health, "an existing tray is refreshed only after router health");
  assert.match(install, /if \(\$TrayWasInstalled\) \{/);
  assert.match(install, /\$env:MODEL_ROUTER_TARGET\s*=\s*"codex"/);
  assert.match(install, /\$env:MODEL_ROUTER_TARGET\s*=\s*\$SavedRouterTarget/);
  assert.match(install, /\$TrayExitCode\s*=\s*\$LASTEXITCODE/);
  assert.match(install, /Desktop companion refresh failed[\s\S]*the router is installed/);
  assert.match(install, /codex-router\.ps1 tray repair/);
});

test("Windows refreshes managed Codex skills as a best-effort post-install step", () => {
  const install = readScript("install.ps1");
  const health = install.indexOf("src/wait-health.mjs");
  const skills = install.indexOf("src/skills-install.mjs install");
  assert.ok(skills > health, "skills must run after the healthy service transaction");
  assert.match(install, /if \(\$Target -eq "codex"\) \{/);
  assert.match(install, /\$SkillsExitCode\s*=\s*\$LASTEXITCODE/);
  assert.match(install, /Managed Codex skills could not be refreshed[\s\S]*the router is installed/);
});
