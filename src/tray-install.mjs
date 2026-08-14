import path from "node:path";

// Pure decision helpers for offering the desktop/menu-bar companion during
// guided setup. Kept free of process state so the flag/platform matrix is
// unit-testable; setup.mjs owns the actual build and launch.

const TRAY_PLATFORMS = new Set(["darwin", "linux", "win32"]);

export function trayDecision({ platform, withTray, noTray, guided }) {
  if (noTray) return "skip";
  // Windows was excluded here while it had no tray build, which left the
  // installer silently skipping the one platform whose tray has to be built by
  // hand -- so nothing ever appeared and nothing said why.
  if (!TRAY_PLATFORMS.has(platform)) return "skip";
  if (withTray) return "install";
  return guided ? "ask" : "skip";
}

// The Tauri companion's release binary, which Windows and Linux share. macOS
// builds a Swift app bundle instead and is served by TRAY_APP_BINARY.
export function desktopTrayBinary(platform, sourceRoot) {
  if (platform !== "win32" && platform !== "linux") return undefined;
  return path.join(
    sourceRoot,
    "apps",
    "desktop",
    "src-tauri",
    "target",
    "release",
    platform === "win32" ? "codex-router-desktop.exe" : "codex-router-desktop",
  );
}

// The Electron companion, which exists because the Tauri one needs a Rust
// toolchain: the heaviest prerequisite in the project, asked of someone who
// only wants to see the panel. This shell needs Node, which the router install
// has already guaranteed, so a machine with no cargo can still end up with a
// working companion instead of a printed apology.
export function electronAppDir(sourceRoot) {
  return path.join(sourceRoot, "apps", "electron");
}

// npm's own layout, not a build output: `electron` ships the runtime as a
// dependency and there is nothing to compile. The binary's presence is the
// only proof the install actually completed -- see electronInstallIsComplete.
export function electronBinary(platform, sourceRoot) {
  if (platform !== "win32" && platform !== "linux") return undefined;
  return path.join(
    electronAppDir(sourceRoot),
    "node_modules",
    "electron",
    "dist",
    platform === "win32" ? "electron.exe" : "electron",
  );
}

// npm 11 blocks install scripts by default, and electron downloads its runtime
// from one. So `npm ci` exits 0, reports no error, and leaves node_modules/
// electron without a dist/ -- the app then fails to launch with nothing
// pointing at the cause. Presence of the binary is the only honest check.
export function electronInstallIsComplete(platform, sourceRoot, exists) {
  const binary = electronBinary(platform, sourceRoot);
  return Boolean(binary) && exists(binary);
}

// Electron is a runtime plus an app directory, so unlike the Tauri binary it
// cannot be launched by path alone. The argument is pre-quoted because its
// consumer is a Task Scheduler action, and the checkout path routinely
// contains a space.
export function electronLaunch(platform, sourceRoot) {
  const execute = electronBinary(platform, sourceRoot);
  if (!execute) return undefined;
  return { execute, argument: `"${electronAppDir(sourceRoot)}"` };
}

// Which companion a machine would actually run: the Tauri binary when it has
// been built, the Electron runtime otherwise. Pure, so the supervisor's status
// output and its start guard share one answer instead of each deriving its
// own -- status naming a Tauri binary that is not installed, while the Electron
// one is what Task Scheduler starts, is exactly that drift.
export function preferredCompanionBinary(platform, sourceRoot, exists) {
  const tauri = desktopTrayBinary(platform, sourceRoot);
  if (tauri && exists(tauri)) return tauri;
  const electron = electronBinary(platform, sourceRoot);
  if (electron && exists(electron)) return electron;
  return tauri;
}

export function trayBundleDir(platform, home) {
  if (platform !== "darwin") return undefined;
  // Always a macOS path, so use POSIX joins — path.join would emit backslashes
  // when this code runs on a Windows host (e.g. CI), producing a wrong bundle
  // path and breaking the test cross-platform.
  return path.posix.join(home, "Applications", "Model Router.app");
}
