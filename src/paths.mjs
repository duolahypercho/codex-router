import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const supportedTargets = new Set(["codex", "claude", "cursor"]);

export const TARGET = process.env.MODEL_ROUTER_TARGET || "codex";
if (!supportedTargets.has(TARGET)) {
  throw new Error(
    `MODEL_ROUTER_TARGET must be one of: ${[...supportedTargets].join(", ")}.`,
  );
}

const TARGET_DISPLAY_NAMES = {
  codex: "Codex Router",
  claude: "Claude Router",
  cursor: "Cursor Router",
};
export const TARGET_DISPLAY_NAME = TARGET_DISPLAY_NAMES[TARGET];
export const SOURCE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const CODEX_HOME =
  process.env.CODEX_HOME || path.join(os.homedir(), ".codex");

function defaultManagedStateDir(targetName) {
  return process.platform === "win32"
    ? path.join(
        process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
        "model-router",
        targetName,
      )
    : path.join(
        process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"),
        "model-router",
        targetName,
      );
}

function managedStateDir() {
  if (TARGET === "claude") {
    return process.env.CLAUDE_ROUTER_STATE_DIR || defaultManagedStateDir("claude");
  }
  if (TARGET === "cursor") {
    return process.env.CURSOR_ROUTER_STATE_DIR || defaultManagedStateDir("cursor");
  }
  return (
    process.env.CODEX_ROUTER_STATE_DIR ||
    process.env.KIMI_CODEX_STATE_DIR ||
    path.join(CODEX_HOME, "codex-router")
  );
}

export const STATE_DIR = process.env.MODEL_ROUTER_STATE_DIR || managedStateDir();
export const LEGACY_STATE_DIR = path.join(CODEX_HOME, "kimi-router");
export const CONFIG_PATH = path.join(CODEX_HOME, "config.toml");
export const NATIVE_CATALOG_PATH = path.join(STATE_DIR, "native-models.json");
export const MERGED_CATALOG_PATH = path.join(STATE_DIR, "merged-models.json");
export const LITELLM_CONFIG_PATH = path.join(STATE_DIR, "litellm.yaml");
export const INTERNAL_SECRET_PATH = path.join(STATE_DIR, "internal-secret");
export const CALLER_SECRET_PATH = path.join(STATE_DIR, "caller-secret");
export const PROVIDER_SELECTION_PATH = path.join(STATE_DIR, "enabled-providers.json");
export const INSTALL_MANIFEST_PATH = path.join(STATE_DIR, "install-manifest.json");
export const MIGRATIONS_DIR = path.join(STATE_DIR, "migrations");
export const SUPPORT_DIR = path.join(STATE_DIR, "support");
export const LOG_PATH = path.join(STATE_DIR, "router.log");
export const BACKUP_PATH = path.join(CODEX_HOME, "config.toml.pre-codex-router");
const SERVICE_LABELS = {
  codex: "io.github.codex-router",
  claude: "io.github.codex-router.claude",
  cursor: "io.github.codex-router.cursor",
};
export const SERVICE_LABEL = SERVICE_LABELS[TARGET];
export const LEGACY_SERVICE_LABEL = "io.github.kimi-codex-router";
export const PROTOTYPE_SERVICE_LABEL = "com.ziwenxu.kimi-codex-proxy";
export const LEGACY_STATE_DIRS = Object.freeze(
  TARGET === "codex"
    ? [LEGACY_STATE_DIR, path.join(CODEX_HOME, "kimi-proxy")]
    : [],
);
export const LAUNCH_AGENTS_DIR =
  process.env.MODEL_ROUTER_LAUNCH_AGENTS_DIR ||
  process.env.CODEX_ROUTER_LAUNCH_AGENTS_DIR ||
  path.join(os.homedir(), "Library", "LaunchAgents");
export const LAUNCH_AGENT_PATH = path.join(LAUNCH_AGENTS_DIR, `${SERVICE_LABEL}.plist`);

export const CLAUDE_CONFIG_LIBRARY_DIR =
  process.env.CLAUDE_ROUTER_CONFIG_LIBRARY ||
  (process.platform === "win32"
    ? path.join(
        process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
        "Claude-3p",
        "configLibrary",
      )
    : process.platform === "darwin"
      ? path.join(
          os.homedir(),
          "Library",
          "Application Support",
          "Claude-3p",
          "configLibrary",
        )
      : path.join(
          process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
          "Claude-3p",
          "configLibrary",
        ));
export const CLAUDE_CONFIG_META_PATH = path.join(CLAUDE_CONFIG_LIBRARY_DIR, "_meta.json");
export const CLAUDE_CONFIG_STATE_PATH = path.join(STATE_DIR, "claude-config-state.json");
export const CLAUDE_CONFIG_BACKUP_PATH = path.join(
  STATE_DIR,
  "claude-config-meta.pre-router.json",
);

function port(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be a TCP port between 1 and 65535.`);
  }
  return value;
}

const TARGET_PORT_DEFAULTS = {
  codex: { gateway: 4100, oauth: 4101, router: 4102, api: 4103 },
  claude: { gateway: 4111, oauth: 4112, router: 4110, api: 4113 },
  cursor: { gateway: 4105, oauth: 4106, router: 4104, api: 4107 },
};
const targetPortDefaults = TARGET_PORT_DEFAULTS[TARGET];

export const PORTS = {
  gateway: port(
    "MODEL_ROUTER_GATEWAY_PORT",
    (TARGET === "codex"
      ? process.env.CODEX_ROUTER_GATEWAY_PORT || process.env.KIMI_GATEWAY_PORT
      : undefined) ||
      targetPortDefaults.gateway,
  ),
  oauth: port(
    "MODEL_ROUTER_OAUTH_PORT",
    (TARGET === "codex"
      ? process.env.CODEX_ROUTER_OAUTH_PORT || process.env.KIMI_OAUTH_FORWARD_PORT
      : undefined) ||
      targetPortDefaults.oauth,
  ),
  router: port(
    "MODEL_ROUTER_PORT",
    (TARGET === "codex"
      ? process.env.CODEX_ROUTER_PORT || process.env.KIMI_ROUTER_PORT
      : undefined) ||
      targetPortDefaults.router,
  ),
  api: port(
    "MODEL_ROUTER_API_PORT",
    (TARGET === "codex"
      ? process.env.CODEX_ROUTER_API_PORT || process.env.KIMI_API_FORWARD_PORT
      : undefined) ||
      targetPortDefaults.api,
  ),
};

export function loopback(portNumber, suffix = "") {
  return `http://127.0.0.1:${portNumber}${suffix}`;
}
