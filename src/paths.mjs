import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { trayBundleDir } from "./tray-install.mjs";

const supportedTargets = new Set(["codex"]);

export const TARGET = process.env.MODEL_ROUTER_TARGET || "codex";
if (!supportedTargets.has(TARGET)) {
  throw new Error(
    `MODEL_ROUTER_TARGET must be one of: ${[...supportedTargets].join(", ")}.`,
  );
}

export const TARGET_DISPLAY_NAME = "Codex Router";
export const SOURCE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const CODEX_HOME =
  process.env.CODEX_HOME || path.join(os.homedir(), ".codex");

function managedStateDir() {
  return (
    process.env.CODEX_ROUTER_STATE_DIR ||
    process.env.KIMI_CODEX_STATE_DIR ||
    path.join(CODEX_HOME, "codex-router")
  );
}

export const STATE_DIR = process.env.MODEL_ROUTER_STATE_DIR || managedStateDir();
export const LEGACY_STATE_DIR = path.join(CODEX_HOME, "kimi-router");
export const CONFIG_PATH = path.join(CODEX_HOME, "config.toml");
export const CODEX_AGENTS_DIR = path.join(CODEX_HOME, "agents");
export const NATIVE_CATALOG_PATH = path.join(STATE_DIR, "native-models.json");
export const MERGED_CATALOG_PATH = path.join(STATE_DIR, "merged-models.json");
export const NATIVE_ALIAS_PATH =
  process.env.MODEL_ROUTER_NATIVE_ALIAS_STATE ||
  path.join(STATE_DIR, "native-aliases.json");
export const SIGNED_COEXISTENCE_PATH =
  process.env.MODEL_ROUTER_SIGNED_COEXISTENCE_STATE ||
  path.join(STATE_DIR, "signed-coexistence.json");
export const ANNOUNCED_MODELS_PATH = path.join(STATE_DIR, "announced-models.json");
export const LITELLM_CONFIG_PATH = path.join(STATE_DIR, "litellm.yaml");
export const INTERNAL_SECRET_PATH = path.join(STATE_DIR, "internal-secret");
export const CALLER_SECRET_PATH = path.join(STATE_DIR, "caller-secret");
export const CODEX_PROVIDER_MODE_PATH = path.join(STATE_DIR, "codex-provider-mode.json");
export const PROVIDER_SELECTION_PATH = path.join(STATE_DIR, "enabled-providers.json");
export const INSTALL_MANIFEST_PATH = path.join(STATE_DIR, "install-manifest.json");
export const MIGRATIONS_DIR = path.join(STATE_DIR, "migrations");
export const SUPPORT_DIR = path.join(STATE_DIR, "support");
export const LOG_PATH = path.join(STATE_DIR, "router.log");
export const BACKUP_PATH = path.join(CODEX_HOME, "config.toml.pre-codex-router");
export const SERVICE_LABEL = "io.github.codex-router";
export const LEGACY_SERVICE_LABEL = "io.github.kimi-codex-router";
export const PROTOTYPE_SERVICE_LABEL = "com.ziwenxu.kimi-codex-proxy";
export const LEGACY_STATE_DIRS = Object.freeze([
  LEGACY_STATE_DIR,
  path.join(CODEX_HOME, "kimi-proxy"),
]);
export const LAUNCH_AGENTS_DIR =
  process.env.MODEL_ROUTER_LAUNCH_AGENTS_DIR ||
  process.env.CODEX_ROUTER_LAUNCH_AGENTS_DIR ||
  path.join(os.homedir(), "Library", "LaunchAgents");
export const LAUNCH_AGENT_PATH = path.join(LAUNCH_AGENTS_DIR, `${SERVICE_LABEL}.plist`);
// The tray runs under its own agent rather than a login item: launchd is the
// only thing that brings it back when it exits, and a login item only fires at
// login. Both are registered by the installer so the companion is supervised
// from the moment it is set up.
export const TRAY_SERVICE_LABEL = `${SERVICE_LABEL}.tray`;
export const TRAY_LAUNCH_AGENT_PATH = path.join(
  LAUNCH_AGENTS_DIR,
  `${TRAY_SERVICE_LABEL}.plist`,
);
// One companion per user, not one per checkout. Building into the repository
// gave every clone its own bundle and left launchd pointing at whichever one
// installed last; ~/Applications is also a LaunchServices location, so the app
// resolves by name and can be found and quit like any other. This constant and
// scripts/build-macos-tray-app.sh's default must name the same directory.
export const TRAY_APP_PATH =
  trayBundleDir("darwin", os.homedir()) ?? path.join(os.homedir(), "Applications", "Model Router.app");
export const LEGACY_TRAY_APP_PATH = path.join(SOURCE_ROOT, "dist", "Model Router.app");
export const TRAY_APP_BINARY = path.join(TRAY_APP_PATH, "Contents", "MacOS", "ModelRouterTray");

function port(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be a TCP port between 1 and 65535.`);
  }
  return value;
}

// gateway/oauth/router/api are the original four; grokOauth is a fifth
// forwarder port for the Grok OAuth provider.
export const PORTS = {
  gateway: port(
    "MODEL_ROUTER_GATEWAY_PORT",
    process.env.CODEX_ROUTER_GATEWAY_PORT || process.env.KIMI_GATEWAY_PORT || 4100,
  ),
  oauth: port(
    "MODEL_ROUTER_OAUTH_PORT",
    process.env.CODEX_ROUTER_OAUTH_PORT || process.env.KIMI_OAUTH_FORWARD_PORT || 4101,
  ),
  router: port(
    "MODEL_ROUTER_PORT",
    process.env.CODEX_ROUTER_PORT || process.env.KIMI_ROUTER_PORT || 4102,
  ),
  api: port(
    "MODEL_ROUTER_API_PORT",
    process.env.CODEX_ROUTER_API_PORT || process.env.KIMI_API_FORWARD_PORT || 4103,
  ),
  grokOauth: port("MODEL_ROUTER_GROK_OAUTH_PORT", 4108),
};

export function loopback(portNumber, suffix = "") {
  return `http://127.0.0.1:${portNumber}${suffix}`;
}
