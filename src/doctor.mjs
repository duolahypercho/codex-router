import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CONFIG_PATH,
  INTERNAL_SECRET_PATH,
  LITELLM_CONFIG_PATH,
  MERGED_CATALOG_PATH,
  PORTS,
  SERVICE_LABEL,
  loopback,
} from "./paths.mjs";
import { LISTED_MODELS, PROVIDERS } from "./model-registry.mjs";
import { credentialStatus } from "./provider-credentials.mjs";

const checks = [];
const add = (status, name, detail) => checks.push({ status, name, detail });

function codexBinary() {
  const candidates = [
    process.env.CODEX_BIN,
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ].filter(Boolean);
  return candidates.find(existsSync);
}

const [major, minor] = process.versions.node.split(".").map(Number);
add(
  major > 22 || (major === 22 && minor >= 19) ? "ok" : "fail",
  "Node.js",
  `${process.version}; 22.19 or newer required`,
);
add(process.platform === "darwin" ? "ok" : "warn", "Platform", process.platform);

const codex = codexBinary();
add(codex ? "ok" : "fail", "Codex binary", codex || "not found");
add(existsSync(CONFIG_PATH) ? "ok" : "fail", "Codex config", CONFIG_PATH);

let catalogModels = [];
try {
  const catalog = JSON.parse(readFileSync(MERGED_CATALOG_PATH, "utf8"));
  catalogModels = Array.isArray(catalog.models) ? catalog.models : [];
} catch {
  // Reported below.
}
const requiredModels = new Set(LISTED_MODELS.map((model) => model.slug));
const catalogOk = [...requiredModels].every((slug) =>
  catalogModels.some((model) => model.slug === slug),
);
add(
  catalogOk ? "ok" : "fail",
  "Merged catalog",
  catalogOk ? `${requiredModels.size} routed models` : MERGED_CATALOG_PATH,
);
add(
  existsSync(LITELLM_CONFIG_PATH) ? "ok" : "fail",
  "Generated gateway config",
  LITELLM_CONFIG_PATH,
);

const secretMode = existsSync(INTERNAL_SECRET_PATH)
  ? statSync(INTERNAL_SECRET_PATH).mode & 0o777
  : undefined;
add(
  secretMode === 0o600 ? "ok" : "fail",
  "Internal service key",
  secretMode === undefined ? "missing" : `mode ${secretMode.toString(8)}`,
);

const kimiHome = process.env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code");
const credentials = path.join(kimiHome, "credentials", "kimi-code.json");
let oauthValid = false;
try {
  const value = JSON.parse(readFileSync(credentials, "utf8"));
  oauthValid = Boolean(value.access_token && value.refresh_token);
} catch {
  // Optional when an API-key provider is used alone.
}
add(
  oauthValid ? "ok" : "warn",
  "Kimi OAuth",
  oauthValid ? "credential present" : "optional; run `kimi login`",
);

for (const provider of PROVIDERS.values()) {
  if (provider.kind !== "openai-compatible") continue;
  const status = credentialStatus(provider);
  add(
    status.configured ? "ok" : "warn",
    `${provider.displayName} key`,
    status.configured ? status.source : `optional; ${status.setup}`,
  );
}

if (process.platform === "darwin") {
  try {
    const service = execFileSync(
      "/bin/launchctl",
      ["print", `gui/${process.getuid()}/${SERVICE_LABEL}`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const state = service.match(/state = ([^\n]+)/)?.[1]?.trim() || "loaded";
    add(state === "running" ? "ok" : "warn", "Background service", state);
  } catch {
    add("warn", "Background service", "not loaded");
  }
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
  );
} catch {
  add("warn", "Router health", "not running");
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
      visible ? `${requiredModels.size} routed entries visible` : "restart/re-enable required",
    );
  } catch (error) {
    add("warn", "Codex model catalog", error instanceof Error ? error.message : String(error));
  }
}

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify({ checks }, null, 2)}\n`);
} else {
  for (const check of checks) {
    process.stdout.write(`${check.status.toUpperCase().padEnd(5)} ${check.name}: ${check.detail}\n`);
  }
}
if (checks.some((check) => check.status === "fail")) process.exitCode = 1;
