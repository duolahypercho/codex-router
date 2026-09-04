import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const STANDARD_XCODE_DEVELOPER_DIRS = [
  "/Applications/Xcode.app/Contents/Developer",
  "/Applications/Xcode-beta.app/Contents/Developer",
];

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function selectFullXcodeDeveloperDir({
  explicitDeveloperDir,
  activeDeveloperDir,
  standardDeveloperDirs = STANDARD_XCODE_DEVELOPER_DIRS,
  isUsable,
}) {
  if (typeof isUsable !== "function") throw new TypeError("isUsable must be a function.");

  const explicit = nonEmpty(explicitDeveloperDir);
  if (explicit) {
    if (isUsable(explicit)) {
      return { developerDir: explicit, source: "environment", activeDeveloperDir };
    }
    throw new Error(
      `DEVELOPER_DIR points to ${JSON.stringify(explicit)}, but that developer directory does not provide xcodebuild. ` +
        "The macOS companion requires the full Xcode app; the standalone Command Line Tools cannot build " +
        "the SwiftUI macro and WidgetKit targets.",
    );
  }

  const active = nonEmpty(activeDeveloperDir);
  for (const developerDir of unique([active, ...standardDeveloperDirs.map(nonEmpty)])) {
    if (isUsable(developerDir)) {
      return {
        developerDir,
        source: developerDir === active ? "active" : "standard-location",
        activeDeveloperDir: active,
      };
    }
  }

  throw new Error(
    "No usable full Xcode installation was selected or found at /Applications/Xcode.app or " +
      "/Applications/Xcode-beta.app. The standalone Command Line Tools cannot build the SwiftUI macro " +
      "and WidgetKit targets. Select Xcode in Xcode > Settings > Locations > Command Line Tools, or retry " +
      'with env DEVELOPER_DIR="/path/to/Xcode.app/Contents/Developer" ./bin/model-router-tray.',
  );
}

function selectedDeveloperDir() {
  const result = spawnSync("/usr/bin/xcode-select", ["--print-path"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? nonEmpty(result.stdout) : undefined;
}

function providesXcodebuild(developerDir) {
  const result = spawnSync("/usr/bin/xcrun", ["--find", "xcodebuild"], {
    env: { ...process.env, DEVELOPER_DIR: developerDir },
    stdio: "ignore",
  });
  return !result.error && result.status === 0;
}

export function resolveFullXcodeDeveloperDir({ environment = process.env } = {}) {
  return selectFullXcodeDeveloperDir({
    explicitDeveloperDir: environment.DEVELOPER_DIR,
    activeDeveloperDir: selectedDeveloperDir(),
    isUsable: providesXcodebuild,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const selection = resolveFullXcodeDeveloperDir();
    if (selection.source === "standard-location") {
      const active = selection.activeDeveloperDir
        ? `Active developer directory ${selection.activeDeveloperDir} is not full Xcode; `
        : "No active full Xcode developer directory was found; ";
      process.stderr.write(
        `codex-router: ${active}using ${selection.developerDir} for this build only.\n`,
      );
    }
    process.stdout.write(`${selection.developerDir}\n`);
  } catch (error) {
    process.stderr.write(`codex-router: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
