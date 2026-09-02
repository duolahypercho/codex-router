import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  controlCenterBinary,
  controlCenterLaunch,
  desktopTrayBinary,
  electronBinary,
  isRecognizedControlCenterAction,
  legacyCompanionActions,
  preferredCompanionBinary,
  recognizedLegacyCompanionAction,
} from "../src/tray-install.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the packaged Control Center resolves per platform", () => {
  assert.equal(
    controlCenterBinary("win32", "/checkout"),
    path.join("/checkout", "apps", "control-center", "release", "win-unpacked", "Codex Router.exe"),
  );
  assert.equal(
    controlCenterBinary("linux", "/checkout"),
    path.join("/checkout", "apps", "control-center", "release", "linux-unpacked", "codex-router-control-center"),
  );
  assert.equal(controlCenterBinary("darwin", "/checkout"), undefined);
});

test("the canonical companion never falls back to a legacy shell", () => {
  const expected = controlCenterBinary("win32", "/checkout");
  assert.equal(preferredCompanionBinary("win32", "/checkout", () => true), expected);
  assert.equal(preferredCompanionBinary("win32", "/checkout", () => false), expected);
  assert.notEqual(expected, desktopTrayBinary("win32", "/checkout"));
  assert.notEqual(expected, electronBinary("win32", "/checkout"));
});

test("legacy migration identities preserve the Electron dependency action", () => {
  assert.deepEqual(legacyCompanionActions("linux", "/checkout"), [
    {
      kind: "tauri",
      execute: path.join("/checkout", "apps", "desktop", "src-tauri", "target", "release", "codex-router-desktop"),
      argument: "",
    },
    {
      kind: "electron",
      execute: path.join("/checkout", "apps", "electron", "node_modules", "electron", "dist", "electron"),
      argument: path.join("/checkout", "apps", "electron"),
    },
  ]);
  assert.deepEqual(recognizedLegacyCompanionAction({
    execute: "C:\\Users\\A User\\AppData\\Local\\codex-router\\apps\\electron\\node_modules\\electron\\dist\\electron.exe",
    argument: '"C:\\Users\\A User\\AppData\\Local\\codex-router\\apps\\electron"',
  }), {
    kind: "electron",
    execute: "C:\\Users\\A User\\AppData\\Local\\codex-router\\apps\\electron\\node_modules\\electron\\dist\\electron.exe",
    argument: "C:\\Users\\A User\\AppData\\Local\\codex-router\\apps\\electron",
  });
  assert.equal(recognizedLegacyCompanionAction({
    execute: "C:\\other\\apps\\electron\\node_modules\\electron\\dist\\electron.exe",
    argument: '"C:\\different\\apps\\electron"',
  }), undefined);
});

test("the supervised launch starts one packaged app in tray-only mode", () => {
  const launch = controlCenterLaunch("win32", "C:\\Program Files\\codex-router");
  assert.equal(launch.execute, controlCenterBinary("win32", "C:\\Program Files\\codex-router"));
  assert.equal(launch.argument, "--tray-only");
  assert.equal(controlCenterLaunch("darwin", "/checkout"), undefined);
});

test("a stable-checkout Windows task is recognized for graceful update drain", () => {
  assert.equal(
    isRecognizedControlCenterAction({
      execute: "C:\\Users\\A User\\AppData\\Local\\codex-router\\apps\\control-center\\release\\win-unpacked\\Codex Router.exe",
      argument: " --tray-only ",
    }),
    true,
  );
  assert.equal(
    isRecognizedControlCenterAction({
      execute: "C:\\Users\\A User\\AppData\\Local\\codex-router\\apps\\desktop\\Codex Router.exe",
      argument: "--tray-only",
    }),
    false,
  );
  assert.equal(
    isRecognizedControlCenterAction({
      execute: "C:\\Users\\A User\\AppData\\Local\\codex-router\\apps\\control-center\\release\\win-unpacked\\Codex Router.exe",
      argument: "--different-mode",
    }),
    false,
  );
});

test("the Windows supervisor renders the unified action", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(root, "src", "tray-service-windows.mjs"), "render-task"],
    { encoding: "utf8", env: { ...process.env, CODEX_ROUTER_SERVICE_PLATFORM: "win32" } },
  );
  assert.equal(result.status, 0, result.stderr);
  const action = JSON.parse(result.stdout);
  assert.ok(action.execute.endsWith("Codex Router.exe"), action.execute);
  assert.equal(action.argument, "--tray-only");
});

test("compatibility build entrypoints package the full Control Center", () => {
  for (const file of ["build-electron-companion.ps1", "build-electron-companion.sh"]) {
    const script = readFileSync(path.join(root, "scripts", file), "utf8");
    assert.match(script, /apps[\\/]control-center|apps\\control-center/);
    assert.match(script, /electron-builder/);
    assert.match(script, /npm run check/);
    assert.match(script, /npm test/);
    assert.match(script, /router-root/);
    assert.doesNotMatch(script, /Get-Command cargo|command -v cargo/);
    assert.doesNotMatch(script, /apps[\\/]electron/);
  }
});

test("Control Center packaging runs npm from its project directory", () => {
  const shell = readFileSync(path.join(root, "scripts", "build-electron-companion.sh"), "utf8");
  const macos = readFileSync(path.join(root, "scripts", "build-macos-tray-app.sh"), "utf8");
  const windows = readFileSync(path.join(root, "scripts", "build-electron-companion.ps1"), "utf8");
  assert.match(shell, /\(\s*\n\s*cd "\$app_dir"\s*\n\s*npm ci/);
  assert.match(macos, /\(\s*\n\s*cd "\$control_center_dir"\s*\n\s*npm ci/);
  assert.match(windows, /Push-Location \$App[\s\S]*?& npm ci/);
  assert.doesNotMatch(shell, /npm (?:ci|run|test).*--prefix/);
  assert.doesNotMatch(macos, /npm (?:ci|run|test).*--prefix/);
  assert.doesNotMatch(windows, /npm (?:ci|run|test).*--prefix/);
});

test("the Linux packager can stage without touching the live package", () => {
  const scriptPath = path.join(root, "scripts", "build-electron-companion.sh");
  const script = readFileSync(scriptPath, "utf8");
  const syntax = spawnSync("sh", ["-n", scriptPath], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.match(script, /--stage-only DESTINATION/);
  assert.match(script, /if \[ "\$build_mode" = stage-only \]/);
  assert.match(script, /Refusing to overwrite staged Control Center destination/);
  assert.match(script, /control_center_root_is_safe\(\)/);
  assert.match(script, /release_root_is_safe\(\)[\s\S]*! -L "\$release_dir"/);
  assert.match(script, /Refusing an unsafe Control Center release directory/);
  assert.match(script, /Refusing a linked live Control Center package/);
  const stageBranch = script.indexOf('if [ "$build_mode" = stage-only ]');
  const liveMove = script.indexOf('mv "$target_dir" "$backup_dir"');
  assert.ok(stageBranch >= 0 && liveMove > stageBranch, "stage-only must return before the live-package transaction");
  assert.match(script.slice(stageBranch, liveMove), /mv "\$staged_dir" "\$stage_destination"[\s\S]*exit 0/);
  assert.match(script, /trap cleanup EXIT/);
  assert.doesNotMatch(script, /trap cleanup EXIT HUP INT TERM/);
  assert.match(
    script,
    /if \[ -d "\$backup_dir" \] \|\| \[ -L "\$backup_dir" \]; then[\s\S]*Refusing Control Center rollback from a linked backup[\s\S]*release_root_is_safe[\s\S]*mv "\$backup_dir" "\$target_dir"/,
  );
});

test("the Windows packager can retain an exact rollback package for its caller", () => {
  const script = readFileSync(path.join(root, "scripts", "build-electron-companion.ps1"), "utf8");
  assert.match(script, /\[string\]\$BackupDirectory/);
  assert.match(script, /\[switch\]\$KeepPrevious/);
  assert.match(script, /KeepPrevious requires an explicit -BackupDirectory/);
  assert.match(script, /Push-Location -LiteralPath \$App/);
  assert.match(
    script,
    /Push-Location -LiteralPath \$App[\s\S]*electron-builder\.cmd[\s\S]*Pop-Location/,
  );
  assert.match(script, /\.win-unpacked\.previous-/);
  assert.match(script, /Refusing to overwrite an existing Control Center backup/);
  assert.match(script, /if \(\$PreviousMoved -and -not \$KeepPrevious\)/);
  assert.match(script, /if \(\(Test-Path -LiteralPath \$BackupDirectory\) -and\s+-not \(Test-Path -LiteralPath \$TargetDirectory\)\)/);
  assert.doesNotMatch(script, /Test-Path \$(?:StagedBinary|TargetDirectory|StagingRoot)/);
  assert.match(script, /function Assert-ControlCenterBuildPath/);
  for (const label of ["release directory", "live package", "rollback package", "staging directory"]) {
    assert.match(script, new RegExp(`Assert-ControlCenterBuildPath \\$[A-Za-z]+ "${label}"`));
  }
  const cleanup = script.slice(script.indexOf("} finally {"));
  assert.ok(
    cleanup.indexOf('Assert-ControlCenterBuildPath $StagingRoot "staging directory"')
      < cleanup.indexOf("Remove-Item -LiteralPath $StagingRoot"),
    "cleanup must reject a staging reparse point before recursive removal",
  );
});

test("platform launchers never choose Tauri by toolchain availability", () => {
  const windows = readFileSync(path.join(root, "codex-router.ps1"), "utf8");
  const linux = readFileSync(path.join(root, "bin", "model-router-tray"), "utf8");
  assert.match(windows, /build-electron-companion\.ps1/);
  assert.match(linux, /build-electron-companion\.sh/);
  assert.doesNotMatch(windows.slice(windows.indexOf('"tray" {')), /Get-Command cargo/);
  assert.doesNotMatch(linux, /command -v cargo|build-desktop-tray/);
});

test("Linux rebuilds use exact process identity and recover from package failure", () => {
  const scriptPath = path.join(root, "bin", "model-router-tray");
  const linux = readFileSync(path.join(root, "bin", "model-router-tray"), "utf8");
  const syntax = spawnSync("sh", ["-n", scriptPath], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.match(linux, /pid_has_base_identity\(\)[\s\S]*\/proc\/\$candidate_pid\/exe/);
  assert.match(linux, /pid_start_identity\(\)[\s\S]*\/proc\/\$candidate_pid\/stat[\s\S]*print \$20/);
  assert.match(linux, /pid_has_exact_argv\(\)[\s\S]*argument_count[\s\S]*actual_argument/);
  assert.match(linux, /pid_is_legacy_tauri\(\)[\s\S]*legacy_tauri_binary/);
  assert.match(linux, /pid_is_legacy_electron\(\)[\s\S]*legacy_electron_app/);
  assert.doesNotMatch(linux, /pgrep -f "\$binary_path"/);
  assert.match(linux, /build-electron-companion\.sh" --stage-only "\$staged_dir"/);
  assert.match(linux, /query_control_center[\s\S]*--query-lifecycle/);
  assert.match(linux, /cleanup_linux[\s\S]*recover_linux_transaction/);
  assert.match(linux, /pid_running[\s\S]*kill -0/);
  assert.match(linux, /queried_running[\s\S]*queried_ready/);
  assert.match(linux, /transaction_dir=.*\.linux-control-center-transaction/);
  assert.match(linux, /write_phase\(\)[\s\S]*phase\.next/);
  assert.match(linux, /replacement-ready\|committed/);
  assert.match(linux, /nohup env -u ELECTRON_RUN_AS_NODE "\$start_binary"/);
  assert.match(linux, /queried_pid" -eq "\$new_pid/);
  assert.match(linux, /launch_mode" = interactive.*prior_visible" -eq 1/);
  assert.match(linux, /restart_recorded_processes\(\)[\s\S]*start_control_center "\$binary_path"/);
  const stage = linux.indexOf('build-electron-companion.sh" --stage-only "$staged_dir"');
  const capture = linux.indexOf("detect_running_companions", stage);
  const drain = linux.indexOf("stop_recorded_processes", capture);
  const swap = linux.indexOf('durable_linux_move "$staged_dir" "$target_dir"');
  const ready = linux.indexOf('[ "$queried_ready" -eq 1 ]', swap);
  const commit = linux.indexOf("write_phase committed", ready);
  const precommitCompleteness = linux.lastIndexOf('sync_linux_package "$target_dir"', commit);
  const destructiveCompleteness = linux.indexOf('linux_package_complete "$target_dir"', commit);
  const cleanup = linux.indexOf('durable_linux_remove "$transaction_dir"', destructiveCompleteness);
  const stamp = linux.indexOf('install-plan.mjs" record-tray', commit);
  assert.ok(stage >= 0 && capture > stage && drain > capture && swap > drain, "build/capture/drain/swap order must be transactional");
  assert.ok(ready > swap && commit > ready && stamp > commit, "package and stamp must remain rollback-safe until exact readiness");
  assert.ok(precommitCompleteness > ready && precommitCompleteness < commit,
    "the live package must be complete before its committed marker");
  assert.ok(destructiveCompleteness > commit && cleanup > destructiveCompleteness,
    "the live package must be revalidated immediately before rollback cleanup");
  assert.match(linux, /linux_package_complete\(\)[\s\S]*app\.asar[\s\S]*! -L[\s\S]*-s/);
  assert.ok(linux.indexOf("remove_obsolete_linux_tauri", commit) > commit);
  assert.match(linux, /remove_obsolete_linux_tauri\(\)[\s\S]*legacy_directory[\s\S]*! -L[\s\S]*legacy_tauri_binary[\s\S]*! -L/);
  assert.doesNotMatch(linux, /rm -f[\s\S]{0,160}apps\/electron\/node_modules\/electron\/dist\/electron/);
  assert.match(linux, /prepare_linux_release_root\(\)[\s\S]*validate_linux_release_root/);
  assert.match(linux, /validate_linux_release_root\(\)[\s\S]*pwd -P[\s\S]*control_center_real\/release/);
  assert.match(linux, /sync_linux_entries\(\)[\s\S]*O_NOFOLLOW[\s\S]*fsyncSync/);
  const phaseWrite = linux.slice(linux.indexOf("write_phase()"), linux.indexOf("validate_transaction_tree()"));
  assert.match(phaseWrite, /sync_linux_entries "\$next_phase_file"[\s\S]*durable_linux_move "\$next_phase_file" "\$phase_file"/);
  assert.ok(
    linux.indexOf('sync_linux_package "$target_dir"') < commit,
    "the ready package data and directories must be durable before commit",
  );
});

test("Linux lifecycle owners cannot be stale PIDs or Electron Node helpers", () => {
  const linux = readFileSync(path.join(root, "bin", "model-router-tray"), "utf8");
  const identity = linux.match(/pid_has_base_identity\(\) \{[\s\S]*?\n    \}/)?.[0] || "";
  assert.match(identity, /\/proc\/\$candidate_pid\/status/);
  assert.match(identity, /candidate_uid[\s\S]*current_uid/);
  assert.match(identity, /readlink "\/proc\/\$candidate_pid\/exe"/);
  assert.match(identity, /actual_binary[\s\S]*expected_binary/);
  assert.match(linux, /capture_record_start\(\)[\s\S]*capture_before[\s\S]*capture_after/);
  assert.match(linux, /capture_record_start tauri[\s\S]*pid_is_legacy_tauri[\s\S]*identity changed/);
  assert.match(linux, /capture_record_start electron[\s\S]*pid_is_legacy_electron[\s\S]*identity changed/);
  assert.match(linux, /record_matches_bound_identity\(\)[\s\S]*bound_start[\s\S]*current_start/);
  assert.match(linux, /candidate_pid" = "\$lifecycle_pid"[\s\S]*record_matches_bound_identity canonical/);
  assert.match(linux, /pid_is_electron_gui\(\)[\s\S]*\^ELECTRON_RUN_AS_NODE=/);
  assert.match(linux, /queried_running" -eq 1[\s\S]{0,180}pid_is_control_center_gui "\$queried_pid" "\$binary_path"/);
  assert.match(linux, /queried_pid" -eq "\$new_pid"[\s\S]{0,180}pid_is_control_center_gui "\$queried_pid" "\$binary_path"/);
  const exactStop = linux.match(/stop_exact_record\(\) \{[\s\S]*?\n    \}/)?.[0] || "";
  assert.match(exactStop, /record_matches_bound_identity[\s\S]*kill -TERM/);
  assert.match(exactStop, /record_matches_bound_identity[\s\S]*kill -KILL/);
  assert.doesNotMatch(linux, /stop_exact_record canonical/);
  assert.match(linux, /no verifiable lifecycle owner[\s\S]*It was not force-stopped/);
  assert.match(linux, /appeared after lifecycle capture[\s\S]*It was not force-stopped/);
  assert.match(linux, /validate_transaction_tree\(\)[\s\S]*current_uid/);
});

function makeLinuxRecoveryFixture({ phase, hadPrevious, target, backup }) {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "router-linux-recovery-"));
  mkdirSync(path.join(fixture, "bin"), { recursive: true });
  mkdirSync(path.join(fixture, "scripts"), { recursive: true });
  mkdirSync(path.join(fixture, "tools"), { recursive: true });
  const launcher = path.join(fixture, "bin", "model-router-tray");
  writeFileSync(launcher, readFileSync(path.join(root, "bin", "model-router-tray"), "utf8"));
  chmodSync(launcher, 0o700);
  const builder = path.join(fixture, "scripts", "build-electron-companion.sh");
  writeFileSync(builder, "#!/bin/sh\nexit 42\n");
  chmodSync(builder, 0o700);
  const uname = path.join(fixture, "tools", "uname");
  writeFileSync(uname, "#!/bin/sh\nprintf 'Linux\\n'\n");
  chmodSync(uname, 0o700);
  const release = path.join(fixture, "apps", "control-center", "release");
  const transaction = path.join(release, ".linux-control-center-transaction");
  mkdirSync(transaction, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(transaction, "phase"), `${phase}\n`, { mode: 0o600 });
  writeFileSync(path.join(transaction, "had-previous"), `${hadPrevious ? 1 : 0}\n`, { mode: 0o600 });
  writeFileSync(path.join(transaction, "restart-records"), "", { mode: 0o600 });
  if (target) {
    mkdirSync(path.join(release, "linux-unpacked"), { recursive: true });
    writeFileSync(path.join(release, "linux-unpacked", "identity"), target);
  }
  if (backup) {
    mkdirSync(path.join(transaction, "previous"), { recursive: true });
    writeFileSync(path.join(transaction, "previous", "identity"), backup);
  }
  return { fixture, launcher, release, transaction };
}

test("Linux recovery restores an uncommitted replacement before the next build", {
  skip: process.platform === "win32",
}, () => {
  const item = makeLinuxRecoveryFixture({
    phase: "replacement-installed",
    hadPrevious: true,
    target: "new",
    backup: "old",
  });
  try {
    const result = spawnSync("sh", [item.launcher, "--tray-only"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${path.join(item.fixture, "tools")}:${process.env.PATH}` },
    });
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(path.join(item.release, "linux-unpacked", "identity"), "utf8"), "old");
    assert.equal(existsSync(item.transaction), false);
  } finally {
    rmSync(item.fixture, { recursive: true, force: true });
  }
});

test("Linux recovery refuses ambiguous live and pre-replacement packages", {
  skip: process.platform === "win32",
}, () => {
  const item = makeLinuxRecoveryFixture({
    phase: "previous-moved",
    hadPrevious: true,
    target: "unknown-live",
    backup: "old",
  });
  try {
    const result = spawnSync("sh", [item.launcher, "--tray-only"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${path.join(item.fixture, "tools")}:${process.env.PATH}` },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /recovery was refused/);
    assert.equal(readFileSync(path.join(item.release, "linux-unpacked", "identity"), "utf8"), "unknown-live");
    assert.equal(readFileSync(path.join(item.transaction, "previous", "identity"), "utf8"), "old");
  } finally {
    rmSync(item.fixture, { recursive: true, force: true });
  }
});

test("Linux refuses a linked release root before build or recovery mutation", {
  skip: process.platform === "win32",
}, () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "router-linux-linked-release-"));
  const external = mkdtempSync(path.join(os.tmpdir(), "router-linux-linked-release-external-"));
  try {
    mkdirSync(path.join(fixture, "bin"), { recursive: true });
    mkdirSync(path.join(fixture, "scripts"), { recursive: true });
    mkdirSync(path.join(fixture, "tools"), { recursive: true });
    mkdirSync(path.join(fixture, "apps", "control-center"), { recursive: true });
    const launcher = path.join(fixture, "bin", "model-router-tray");
    writeFileSync(launcher, readFileSync(path.join(root, "bin", "model-router-tray"), "utf8"));
    chmodSync(launcher, 0o700);
    const builderMarker = path.join(external, "builder-ran");
    const builder = path.join(fixture, "scripts", "build-electron-companion.sh");
    writeFileSync(builder, `#!/bin/sh\nprintf ran >${JSON.stringify(builderMarker)}\nexit 42\n`);
    chmodSync(builder, 0o700);
    const uname = path.join(fixture, "tools", "uname");
    writeFileSync(uname, "#!/bin/sh\nprintf 'Linux\\n'\n");
    chmodSync(uname, 0o700);
    writeFileSync(path.join(external, "sentinel"), "outside");
    symlinkSync(external, path.join(fixture, "apps", "control-center", "release"), "dir");

    const result = spawnSync("sh", [launcher, "--tray-only"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${path.join(fixture, "tools")}:${process.env.PATH}` },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unsafe Linux Control Center release directory/);
    assert.equal(readFileSync(path.join(external, "sentinel"), "utf8"), "outside");
    assert.equal(existsSync(builderMarker), false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});

test("Linux committed recovery preserves rollback around an empty packaged archive", {
  skip: process.platform === "win32",
}, () => {
  const item = makeLinuxRecoveryFixture({
    phase: "committed",
    hadPrevious: true,
    target: "new",
    backup: "old",
  });
  try {
    const target = path.join(item.release, "linux-unpacked");
    const binary = path.join(target, "codex-router-control-center");
    mkdirSync(path.join(target, "resources"), { recursive: true });
    writeFileSync(binary, "binary");
    chmodSync(binary, 0o700);
    writeFileSync(path.join(target, "resources", "app.asar"), "");
    const result = spawnSync("sh", [item.launcher, "--tray-only"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${path.join(item.fixture, "tools")}:${process.env.PATH}` },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /package is incomplete or linked/);
    assert.equal(existsSync(item.transaction), true);
    assert.equal(readFileSync(path.join(item.transaction, "previous", "identity"), "utf8"), "old");
  } finally {
    rmSync(item.fixture, { recursive: true, force: true });
  }
});

test("Linux refuses an exact canonical GUI when its lifecycle cannot be verified", {
  skip: process.platform !== "linux",
}, (context) => {
  if (spawnSync("cc", ["--version"], { stdio: "ignore" }).status !== 0) {
    context.skip("a C compiler is unavailable for the exact /proc executable fixture");
    return;
  }
  const fixture = mkdtempSync(path.join(os.tmpdir(), "router-linux-lifecycle-refusal-"));
  let running;
  try {
    const source = path.join(fixture, "control-center.c");
    const helper = path.join(fixture, "control-center-helper");
    writeFileSync(source, [
      "#include <string.h>",
      "#include <unistd.h>",
      "int main(int argc, char **argv) {",
      "  if (argc == 1 || (argc == 2 && strcmp(argv[1], \"--tray-only\") == 0)) { for (;;) pause(); }",
      "  return 2;",
      "}",
      "",
    ].join("\n"));
    const compiled = spawnSync("cc", [source, "-o", helper], { encoding: "utf8" });
    assert.equal(compiled.status, 0, compiled.stderr);

    mkdirSync(path.join(fixture, "bin"), { recursive: true });
    mkdirSync(path.join(fixture, "scripts"), { recursive: true });
    mkdirSync(path.join(fixture, "tools"), { recursive: true });
    const launcher = path.join(fixture, "bin", "model-router-tray");
    writeFileSync(launcher, readFileSync(path.join(root, "bin", "model-router-tray"), "utf8"));
    chmodSync(launcher, 0o700);
    const builder = path.join(fixture, "scripts", "build-electron-companion.sh");
    writeFileSync(builder, [
      "#!/bin/sh",
      "set -eu",
      "mkdir -p \"$2/resources\"",
      "cp \"$ROUTER_TEST_HELPER\" \"$2/codex-router-control-center\"",
      "chmod 700 \"$2/codex-router-control-center\"",
      "printf archive >\"$2/resources/app.asar\"",
      "",
    ].join("\n"));
    chmodSync(builder, 0o700);
    const uname = path.join(fixture, "tools", "uname");
    writeFileSync(uname, "#!/bin/sh\nprintf 'Linux\\n'\n");
    chmodSync(uname, 0o700);

    const target = path.join(fixture, "apps", "control-center", "release", "linux-unpacked");
    mkdirSync(path.join(target, "resources"), { recursive: true });
    const binary = path.join(target, "codex-router-control-center");
    writeFileSync(binary, readFileSync(helper));
    chmodSync(binary, 0o700);
    writeFileSync(path.join(target, "resources", "app.asar"), "archive");
    const guiEnvironment = { ...process.env };
    delete guiEnvironment.ELECTRON_RUN_AS_NODE;
    running = spawn(binary, [], { stdio: "ignore", env: guiEnvironment });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    process.kill(running.pid, 0);

    const result = spawnSync("sh", [launcher, "--tray-only"], {
      encoding: "utf8",
      timeout: 15_000,
      env: {
        ...process.env,
        PATH: `${path.join(fixture, "tools")}:${process.env.PATH}`,
        ROUTER_TEST_HELPER: helper,
      },
    });
    assert.notEqual(result.status, 0);
    assert.equal(result.signal, null, result.error?.message);
    assert.match(result.stderr, /no verifiable lifecycle owner/);
    assert.match(result.stderr, /It was not force-stopped/);
    process.kill(running.pid, 0);
  } finally {
    if (running?.pid) {
      try { process.kill(running.pid, "SIGKILL"); } catch { /* already exited */ }
    }
    rmSync(fixture, { recursive: true, force: true });
  }
});
