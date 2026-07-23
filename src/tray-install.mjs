import path from "node:path";

// Pure decision helpers for offering the desktop/menu-bar companion during
// guided setup. Kept free of process state so the flag/platform matrix is
// unit-testable; setup.mjs owns the actual build and launch.

export function trayDecision({ platform, withTray, noTray, guided }) {
  if (noTray) return "skip";
  if (platform !== "darwin" && platform !== "linux") return "skip";
  if (withTray) return "install";
  return guided ? "ask" : "skip";
}

export function trayBundleDir(platform, home) {
  if (platform !== "darwin") return undefined;
  return path.join(home, "Applications", "Model Router.app");
}
