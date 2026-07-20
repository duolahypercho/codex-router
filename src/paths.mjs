import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SOURCE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const CODEX_HOME =
  process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
export const STATE_DIR =
  process.env.CODEX_ROUTER_STATE_DIR ||
  process.env.KIMI_CODEX_STATE_DIR ||
  path.join(CODEX_HOME, "codex-router");
export const LEGACY_STATE_DIR = path.join(CODEX_HOME, "kimi-router");
export const CONFIG_PATH = path.join(CODEX_HOME, "config.toml");
export const NATIVE_CATALOG_PATH = path.join(STATE_DIR, "native-models.json");
export const MERGED_CATALOG_PATH = path.join(STATE_DIR, "merged-models.json");
export const LITELLM_CONFIG_PATH = path.join(STATE_DIR, "litellm.yaml");
export const INTERNAL_SECRET_PATH = path.join(STATE_DIR, "internal-secret");
export const LOG_PATH = path.join(STATE_DIR, "router.log");
export const BACKUP_PATH = path.join(CODEX_HOME, "config.toml.pre-codex-router");
export const SERVICE_LABEL = "io.github.codex-router";
export const LEGACY_SERVICE_LABEL = "io.github.kimi-codex-router";
export const LAUNCH_AGENT_PATH = path.join(
  os.homedir(),
  "Library",
  "LaunchAgents",
  `${SERVICE_LABEL}.plist`,
);

function port(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be a TCP port between 1 and 65535.`);
  }
  return value;
}

export const PORTS = {
  gateway: port("CODEX_ROUTER_GATEWAY_PORT", process.env.KIMI_GATEWAY_PORT || 4100),
  oauth: port("CODEX_ROUTER_OAUTH_PORT", process.env.KIMI_OAUTH_FORWARD_PORT || 4101),
  router: port("CODEX_ROUTER_PORT", process.env.KIMI_ROUTER_PORT || 4102),
  api: port("CODEX_ROUTER_API_PORT", process.env.KIMI_API_FORWARD_PORT || 4103),
};

export function loopback(portNumber, suffix = "") {
  return `http://127.0.0.1:${portNumber}${suffix}`;
}
