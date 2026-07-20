import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readInstallManifest } from "./install-manifest.mjs";
import { protectPrivateFile } from "./file-security.mjs";
import { detectLegacyInstallations } from "./legacy-migration.mjs";
import { PROVIDERS } from "./model-registry.mjs";
import {
  CONFIG_PATH,
  LOG_PATH,
  SOURCE_ROOT,
  SUPPORT_DIR,
} from "./paths.mjs";
import { credentialStatus } from "./provider-credentials.mjs";
import { providerSelectionStatus } from "./provider-selection.mjs";

function runJson(script, args = []) {
  const result = spawnSync(
    process.execPath,
    [path.join(SOURCE_ROOT, "src", script), ...args],
    { cwd: SOURCE_ROOT, env: process.env, encoding: "utf8" },
  );
  try {
    return JSON.parse(result.stdout || "{}");
  } catch {
    return { error: result.stderr?.trim() || `exited with ${result.status}` };
  }
}

function commandVersion(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function fileMetadata(target) {
  if (!existsSync(target)) return { path: target, exists: false };
  const metadata = statSync(target);
  return {
    path: target,
    exists: true,
    size: metadata.size,
    mode: (metadata.mode & 0o777).toString(8),
    modifiedAt: metadata.mtime.toISOString(),
  };
}

function redactLogs(contents) {
  return contents
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/("(?:api[_-]?key|access[_-]?token|refresh[_-]?token)"\s*:\s*")[^"]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[=:]\s*["']?)[^\s"',}]+/gi, "$1[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_KEY]");
}

function logTail() {
  if (!existsSync(LOG_PATH)) return null;
  const lines = readFileSync(LOG_PATH, "utf8").split(/\r?\n/);
  return redactLogs(lines.slice(-200).join("\n"));
}

function outputOption() {
  const index = process.argv.indexOf("--output");
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error("--output requires a path.");
  return value;
}

export function createSupportBundle(options = {}) {
  const credentialSources = {};
  for (const provider of PROVIDERS.values()) {
    if (provider.kind !== "openai-compatible") continue;
    const status = credentialStatus(provider);
    credentialSources[provider.id] = status.configured
      ? { configured: true, source: status.source, persistent: status.persistent }
      : { configured: false };
  }
  let selection;
  try {
    selection = providerSelectionStatus();
  } catch (error) {
    selection = { error: error instanceof Error ? error.message : String(error) };
  }
  const packageJson = JSON.parse(readFileSync(path.join(SOURCE_ROOT, "package.json"), "utf8"));
  const bundle = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    privacy: options.includeLogs
      ? "Includes a redacted log tail that may still contain prompts or provider responses."
      : "Credential values, prompts, response bodies, and log contents are excluded.",
    runtime: {
      platform: process.platform,
      release: os.release(),
      architecture: process.arch,
      node: process.version,
      packageVersion: packageJson.version,
      gitCommit: commandVersion("git", ["-C", SOURCE_ROOT, "rev-parse", "HEAD"]),
      python: commandVersion(
        path.join(
          SOURCE_ROOT,
          ".venv",
          process.platform === "win32" ? "Scripts" : "bin",
          process.platform === "win32" ? "python.exe" : "python",
        ),
        ["--version"],
      ),
    },
    doctor: runJson("doctor.mjs", ["--json"]),
    config: runJson("config-manager.mjs", ["status"]),
    service: runJson("service.mjs", ["status"]),
    selection,
    credentialSources,
    ownership: detectLegacyInstallations(),
    install: readInstallManifest() || { installed: false },
    files: {
      config: fileMetadata(CONFIG_PATH),
      log: fileMetadata(LOG_PATH),
    },
    ...(options.includeLogs ? { redactedLogTail: logTail() } : {}),
  };

  mkdirSync(SUPPORT_DIR, { recursive: true, mode: 0o700 });
  chmodSync(SUPPORT_DIR, 0o700);
  const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const target = path.resolve(
    options.output || path.join(SUPPORT_DIR, `codex-router-support-${timestamp}.json`),
  );
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, `${JSON.stringify(bundle, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  protectPrivateFile(target);
  return { path: target, includedLogs: Boolean(options.includeLogs) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const known = new Set(["--help", "--include-logs", "--output"]);
    for (let index = 2; index < process.argv.length; index += 1) {
      const argument = process.argv[index];
      if (!known.has(argument)) throw new Error(`Unknown option: ${argument}`);
      if (argument === "--output") index += 1;
    }
    if (process.argv.includes("--help")) {
      process.stdout.write(`Usage: support-bundle [--include-logs] [--output PATH]

Creates a mode-600 JSON diagnostic bundle without credential values.
Logs are excluded by default because they may contain prompts or responses.
`);
    } else {
      const result = createSupportBundle({
        includeLogs: process.argv.includes("--include-logs"),
        output: outputOption(),
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
