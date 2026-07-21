import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { validCallerSecret } from "./caller-auth.mjs";
import { findCodexBinary } from "./codex-binary.mjs";
import { privateFileIsProtected } from "./file-security.mjs";
import { detectLegacyInstallations } from "./legacy-migration.mjs";
import { PROVIDERS } from "./model-registry.mjs";
import { grokOAuthStatus } from "./grok-oauth-status.mjs";
import { kimiOAuthStatus } from "./oauth-status.mjs";
import {
  CALLER_SECRET_PATH,
  CONFIG_PATH,
  INTERNAL_SECRET_PATH,
  LITELLM_CONFIG_PATH,
  MERGED_CATALOG_PATH,
  PORTS,
  SOURCE_ROOT,
  loopback,
} from "./paths.mjs";
import { credentialStatus } from "./provider-credentials.mjs";
import {
  providerSelectionStatus,
  selectedListedModels,
} from "./provider-selection.mjs";

const checks = [];
const add = (status, name, detail, fix) => checks.push({ status, name, detail, fix });
const jsonOutput = process.argv.includes("--json");

function readableSecret(target, validator) {
  if (!existsSync(target)) return false;
  try {
    return validator(readFileSync(target, "utf8").trim());
  } catch {
    return false;
  }
}

function childJson(script, args = []) {
  return JSON.parse(
    execFileSync(process.execPath, [path.join(SOURCE_ROOT, "src", script), ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }),
  );
}

function repair() {
  const legacy = detectLegacyInstallations();
  if (legacy.unknownConflict) {
    throw new Error(
      `Another router owns ${legacy.config.modelCatalogJson}; repair will not overwrite it.`,
    );
  }
  if (legacy.installations.length && !process.argv.includes("--migrate-known")) {
    throw new Error(
      `A known older router (${legacy.installations.map((item) => item.id).join(", ")}) was found. Re-run with --fix --migrate-known to snapshot and migrate it.`,
    );
  }
  if (legacy.installations.length) {
    childJson("legacy-migration.mjs", ["apply", "--yes"]);
  }
  const repairStdio = jsonOutput ? ["inherit", "ignore", "inherit"] : "inherit";
  const result = process.platform === "win32"
    ? spawnSync(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          path.join(SOURCE_ROOT, "install.ps1"),
          "-CheckoutInstall",
        ],
        { cwd: SOURCE_ROOT, env: process.env, stdio: repairStdio },
      )
    : spawnSync(path.join(SOURCE_ROOT, "bin", "install"), [], {
        cwd: SOURCE_ROOT,
        env: process.env,
        stdio: repairStdio,
      });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Repair installer exited with ${result.status}.`);
}

if (process.argv.includes("--help")) {
  process.stdout.write(`Usage: doctor [--json] [--fix [--migrate-known]]

Checks the complete Codex Router installation without printing credentials.
--fix reinstalls generated files, configuration, and the background service.
Known older routers are migrated only with the explicit --migrate-known flag.
`);
  process.exit(0);
}

if (process.argv.includes("--fix")) {
  try {
    repair();
    if (!jsonOutput) process.stdout.write("Repair completed; verifying the result.\n\n");
  } catch (error) {
    console.error(`codex-router repair: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

const [major, minor] = process.versions.node.split(".").map(Number);
add(
  major > 22 || (major === 22 && minor >= 19) ? "ok" : "fail",
  "Node.js",
  `${process.version}; 22.19 or newer required`,
  "Install Node.js 24 LTS, then run ./bin/doctor --fix.",
);
add(
  ["darwin", "linux", "win32"].includes(process.platform) ? "ok" : "fail",
  "Platform",
  process.platform,
  "Use macOS, Windows, or Linux with the Codex CLI.",
);

const codex = findCodexBinary();
add(
  codex ? "ok" : "fail",
  "Codex binary",
  codex || "not found",
  "Install Codex or set CODEX_BIN to the Codex CLI binary.",
);
add(
  existsSync(CONFIG_PATH) ? "ok" : "fail",
  "Codex config",
  CONFIG_PATH,
  "Start Codex once, then run ./bin/doctor --fix.",
);
const configMode = existsSync(CONFIG_PATH)
  ? statSync(CONFIG_PATH).mode & 0o777
  : undefined;
const configProtected = privateFileIsProtected(CONFIG_PATH);
add(
  configProtected ? "ok" : "fail",
  "Codex config privacy",
  configMode === undefined
    ? "missing"
    : process.platform === "win32"
      ? "current-user Windows ACL"
      : `mode ${configMode.toString(8)}`,
  "Run ./bin/doctor --fix; the managed router URL contains a local caller capability.",
);

let selection = { providers: [], explicit: false };
let requiredModels = new Set();
try {
  selection = providerSelectionStatus();
  requiredModels = new Set(selectedListedModels().map((model) => model.slug));
  add(
    selection.providers.length ? "ok" : "fail",
    "Enabled providers",
    selection.providers.length
      ? `${selection.providers.join(", ")}${selection.explicit ? "" : " (legacy show-all mode)"}`
      : "none",
    "Run ./bin/setup --guided and choose at least one provider.",
  );
} catch (error) {
  add(
    "fail",
    "Enabled providers",
    error instanceof Error ? error.message : String(error),
    "Run ./bin/setup --guided to replace the invalid provider selection.",
  );
}

let catalogModels = [];
try {
  const catalog = JSON.parse(readFileSync(MERGED_CATALOG_PATH, "utf8"));
  catalogModels = Array.isArray(catalog.models) ? catalog.models : [];
} catch {
  // Reported as a failed catalog check below.
}
const catalogOk =
  requiredModels.size > 0 &&
  [...requiredModels].every((slug) => catalogModels.some((model) => model.slug === slug));
add(
  catalogOk ? "ok" : "fail",
  "Merged catalog",
  catalogOk ? `${requiredModels.size} routed models` : MERGED_CATALOG_PATH,
  "Run ./bin/refresh-catalog, or ./bin/doctor --fix if files are missing.",
);
add(
  existsSync(LITELLM_CONFIG_PATH) ? "ok" : "fail",
  "Generated gateway config",
  LITELLM_CONFIG_PATH,
  "Run ./bin/doctor --fix.",
);

const secretMode = existsSync(INTERNAL_SECRET_PATH)
  ? statSync(INTERNAL_SECRET_PATH).mode & 0o777
  : undefined;
const internalSecretValid = readableSecret(
  INTERNAL_SECRET_PATH,
  (value) => /^[A-Za-z0-9_-]{32,}$/.test(value),
);
const secretProtected =
  internalSecretValid && privateFileIsProtected(INTERNAL_SECRET_PATH);
add(
  secretProtected ? "ok" : "fail",
  "Internal service key",
  secretMode === undefined
    ? "missing"
    : !internalSecretValid
      ? "invalid"
      : process.platform === "win32"
        ? "current-user Windows ACL"
        : `mode ${secretMode.toString(8)}`,
  "Run ./bin/doctor --fix; this key is generated locally and is not a provider key.",
);

const callerSecretMode = existsSync(CALLER_SECRET_PATH)
  ? statSync(CALLER_SECRET_PATH).mode & 0o777
  : undefined;
const callerSecretValid = readableSecret(CALLER_SECRET_PATH, validCallerSecret);
const callerSecretProtected =
  callerSecretValid && privateFileIsProtected(CALLER_SECRET_PATH);
add(
  callerSecretProtected ? "ok" : "fail",
  "Router caller key",
  callerSecretMode === undefined
    ? "missing"
    : !callerSecretValid
      ? "invalid"
      : process.platform === "win32"
        ? "current-user Windows ACL"
        : `mode ${callerSecretMode.toString(8)}`,
  "Run ./bin/doctor --fix; this capability is generated locally and is not a provider key.",
);

const oauth = kimiOAuthStatus();
add(
  oauth.configured ? "ok" : selection.providers.includes("kimi-oauth") ? "fail" : "warn",
  "Kimi OAuth",
  oauth.configured ? "credential present" : `not configured; ${oauth.setup}`,
  "Run kimi login, then rerun the doctor.",
);
const grokOauth = grokOAuthStatus();
add(
  grokOauth.configured ? "ok" : selection.providers.includes("grok-oauth") ? "fail" : "warn",
  "Grok OAuth",
  grokOauth.configured ? grokOauth.source : `not configured; ${grokOauth.setup}`,
  "Run grok login, then rerun the doctor.",
);

for (const provider of PROVIDERS.values()) {
  if (provider.kind !== "openai-compatible") continue;
  const status = credentialStatus(provider, { persistent: true });
  add(
    status.configured ? "ok" : selection.providers.includes(provider.id) ? "fail" : "warn",
    `${provider.displayName} key`,
    status.configured ? status.source : "not configured",
    `Run ./bin/provider-key ${provider.id} set.`,
  );
}

try {
  const config = childJson("config-manager.mjs", ["status"]);
  add(
    config.mode === "router" ? "ok" : "fail",
    "Codex routing config",
    config.mode,
    "Run ./bin/enable or ./bin/doctor --fix.",
  );
} catch (error) {
  add(
    "fail",
    "Codex routing config",
    error instanceof Error ? error.message : String(error),
    "Inspect ~/.codex/config.toml, then run ./bin/doctor --fix.",
  );
}

const legacy = detectLegacyInstallations();
add(
  legacy.unknownConflict ? "fail" : legacy.installations.length ? "fail" : "ok",
  "Router ownership",
  legacy.unknownConflict
    ? `unknown catalog: ${legacy.config.modelCatalogJson}`
    : legacy.installations.length
      ? `older router: ${legacy.installations.map((item) => item.id).join(", ")}`
      : "no conflicting router detected",
  legacy.installations.length
    ? "Run ./bin/doctor --fix --migrate-known."
    : "Disable the other router manually; Codex Router will not overwrite it.",
);

try {
  const service = childJson("service.mjs", ["status"]);
  add(
    service.loaded ? "ok" : "fail",
    "Background service",
    service.state || "stopped",
    "Run ./bin/enable or ./bin/doctor --fix.",
  );
} catch (error) {
  add(
    "fail",
    "Background service",
    error instanceof Error ? error.message : "not available",
    "Run ./bin/doctor --fix.",
  );
}

try {
  const response = await fetch(loopback(PORTS.router, "/health"), {
    signal: AbortSignal.timeout(2_000),
  });
  const payload = await response.json().catch(() => ({}));
  const healthy = response.ok && payload.service === "codex-router";
  add(
    healthy ? "ok" : "fail",
    "Router health",
    healthy ? `version ${payload.version}` : `unexpected service or HTTP ${response.status}`,
    "Run ./bin/doctor --fix. If it still fails, create a support bundle.",
  );
} catch {
  add(
    "fail",
    "Router health",
    `not reachable on 127.0.0.1:${PORTS.router}`,
    "Run ./bin/doctor --fix, then inspect the support bundle if needed.",
  );
}

if (codex && catalogOk) {
  try {
    const parsed = JSON.parse(
      execFileSync(codex, ["debug", "models"], {
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 32 * 1024 * 1024,
      }),
    );
    const slugs = new Set((parsed.models || []).map((model) => model.slug));
    const visible = [...requiredModels].every((slug) => slugs.has(slug));
    add(
      visible ? "ok" : "fail",
      "Codex model catalog",
      visible ? `${requiredModels.size} routed entries visible` : "startup catalog is stale",
      "Fully quit Codex, reopen it, and create a new task.",
    );
  } catch (error) {
    add(
      "warn",
      "Codex model catalog",
      error instanceof Error ? error.message : String(error),
      "Set CODEX_BIN if Codex is installed in a nonstandard location.",
    );
  }
}

if (jsonOutput) {
  process.stdout.write(`${JSON.stringify({ ok: !checks.some((check) => check.status === "fail"), checks }, null, 2)}\n`);
} else {
  for (const check of checks) {
    process.stdout.write(`${check.status.toUpperCase().padEnd(5)} ${check.name}: ${check.detail}\n`);
    if (check.status === "fail" && check.fix) process.stdout.write(`      Fix: ${check.fix}\n`);
  }
}
if (checks.some((check) => check.status === "fail")) process.exitCode = 1;
