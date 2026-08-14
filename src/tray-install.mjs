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

export function trayBundleDir(platform, home) {
  if (platform !== "darwin") return undefined;
  // Always a macOS path, so use POSIX joins — path.join would emit backslashes
  // when this code runs on a Windows host (e.g. CI), producing a wrong bundle
  // path and breaking the test cross-platform.
  return path.posix.join(home, "Applications", "Model Router.app");
}
