import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { trayBundleDir } from "./tray-install.mjs";

const supportedTargets = new Set(["codex", "dsh", "gemini"]);

export const TARGET = process.env.MODEL_ROUTER_TARGET || "codex";
if (!supportedTargets.has(TARGET)) {
  throw new Error(
    `MODEL_ROUTER_TARGET must be one of: ${[...supportedTargets].join(", ")}.`,
  );
}

// The router *plane* -- service, ports, gateway, secrets, credentials, provider
// selection -- is one installation shared by every client integration, so the
// two targets are not two routers. `TARGET` selects which client's
// configuration this command writes; it must never fork the state directory or
// the service, or a user who installs both would be asked for every API key
// twice and would run two gateways against one set of provider quotas.
//
// A handful of environment aliases (`CODEX_ROUTER_*`, `KIMI_*`) are keyed on
// the plane rather than on the client, because they name the service's own
// process. They stay on `codex` whichever integration is being installed.
export const ROUTER_PLANE_TARGET = "codex";

const TARGET_DISPLAY_NAMES = Object.freeze({
  dsh: "DeepSeek Harness Router",
  gemini: "Gemini CLI Router",
  codex: "Codex Router",
});
export const TARGET_DISPLAY_NAME = TARGET_DISPLAY_NAMES[TARGET] || TARGET_DISPLAY_NAMES.codex;
const configuredSourceRoot = process.env.CODEX_ROUTER_SOURCE_ROOT;
if (configuredSourceRoot && !path.isAbsolute(configuredSourceRoot)) {
  throw new Error("CODEX_ROUTER_SOURCE_ROOT must be an absolute path.");
}
// Package managers install each release into a versioned prefix and expose a
// stable `opt` symlink. Persisting the versioned path in launchd/systemd makes
// the service disappear on the next package cleanup, so packaged launchers may
// explicitly provide that stable root. Checkout installs keep deriving it from
// this module's location exactly as before.
export const SOURCE_ROOT = configuredSourceRoot
  ? path.normalize(configuredSourceRoot)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CODEX_HOME =
  process.env.CODEX_HOME || path.join(os.homedir(), ".codex");

// DeepSeek Harness reads its own home from `$DSH_HOME`, defaulting to `~/.dsh`
// (`dsh-settings-file` and `dsh-credentials-local` both resolve it that way).
// Match that resolution exactly rather than hardcoding the default, or a user
// who moved their harness home gets a settings document nothing reads.
export const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
// The hot-reloaded user settings document. `dsh-settings-file` mounts it by
// default and publishes external edits, which is why the router can add its
// provider route without asking anyone to restart the harness.
export const DSH_SETTINGS_PATH =
  process.env.MODEL_ROUTER_DSH_SETTINGS || path.join(DSH_HOME, "settings.yaml");
// The managed credential document. `apiKeyEnv` in the settings document is a
// *reference*; this file is where the referenced value lives, which is what
// keeps the caller key out of the settings document itself.
export const DSH_CREDENTIALS_PATH =
  process.env.MODEL_ROUTER_DSH_CREDENTIALS || path.join(DSH_HOME, ".credentials.yaml");

// Gemini CLI resolves its own home as `GEMINI_CLI_HOME` or the user's home, and
// then `.gemini` inside it (`homedir()` in @google/gemini-cli-core's paths
// util, plus its `GEMINI_DIR` constant). Match that resolution exactly rather
// than hardcoding the default, or a user who moved theirs gets a document
// nothing reads.
export const GEMINI_HOME = path.join(
  process.env.GEMINI_CLI_HOME || os.homedir(),
  ".gemini",
);
// The only document this integration writes. Gemini CLI loads it at startup for
// `GOOGLE_GEMINI_BASE_URL`, `GEMINI_API_KEY`, and `GEMINI_MODEL` -- which is the
// whole integration, so its `settings.json` is never touched. It holds the
// caller key, so it is written 0600 under a 0700 directory.
export const GEMINI_ENV_PATH =
  process.env.MODEL_ROUTER_GEMINI_ENV || path.join(GEMINI_HOME, ".env");

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
export const MODELS_CACHE_PATH = path.join(CODEX_HOME, "models_cache.json");
export const CODEX_AGENTS_DIR = path.join(CODEX_HOME, "agents");
export const NATIVE_CATALOG_PATH = path.join(STATE_DIR, "native-models.json");
export const NATIVE_CATALOG_SOURCE_PATH = path.join(
  STATE_DIR,
  "native-catalog-source.json",
);
export const MERGED_CATALOG_PATH = path.join(STATE_DIR, "merged-models.json");
// What the last dsh publish actually wrote. The settings document is the
// user's and is hot-reloaded by anything else that edits it, so drift is
// detected against this snapshot rather than by re-deriving what "should" be
// there and trusting the answer.
export const DSH_CATALOG_PATH = path.join(STATE_DIR, "dsh-models.json");
// The same marker for the Gemini integration: what the last publish wrote, so
// drift is detected against a snapshot rather than by re-deriving what should
// be there and trusting the answer. Its presence is what says the integration
// is installed.
export const GEMINI_CATALOG_PATH = path.join(STATE_DIR, "gemini-models.json");
export const NATIVE_ALIAS_PATH = path.join(STATE_DIR, "native-aliases.json");
export const ANNOUNCED_MODELS_PATH = path.join(STATE_DIR, "announced-models.json");
export const LITELLM_CONFIG_PATH = path.join(STATE_DIR, "litellm.yaml");
export const INTERNAL_SECRET_PATH = path.join(STATE_DIR, "internal-secret");
export const CALLER_SECRET_PATH = path.join(STATE_DIR, "caller-secret");
export const CODEX_PROVIDER_MODE_PATH = path.join(STATE_DIR, "codex-provider-mode.json");
export const SIGNED_PROVIDER_MODE_PATH = path.join(STATE_DIR, "signed-provider-mode.json");
// An opt-in routed default for signed-in Codex. The router owns this small
// state file, while Codex continues to own the actual config document.
export const CODEX_DEFAULT_MODEL_PATH = path.join(STATE_DIR, "codex-default-model.json");
export const PROVIDER_SELECTION_PATH = path.join(STATE_DIR, "enabled-providers.json");
export const DISCOVERY_MODE_PATH = path.join(STATE_DIR, "discovery-mode.json");
// Explicit, shared-plane consent for letting router-authenticated local clients
// use the ChatGPT session owned by this user's Codex installation. The file
// carries no credential; its presence records only the user's authorization.
export const NATIVE_SESSION_CONSENT_PATH = path.join(
  STATE_DIR,
  "native-session-consent.json",
);
// The last model list each provider published for itself. It is a convenience
// cache for the curation surfaces, never an authority: what is registered
// locally is always recomputed from the live registry.
export const PROVIDER_CATALOG_CACHE_PATH = path.join(STATE_DIR, "provider-catalog-cache.json");
export const INSTALL_MANIFEST_PATH = path.join(STATE_DIR, "install-manifest.json");
export const SKILL_OWNERSHIP_PATH = path.join(STATE_DIR, "managed-skills.json");
export const MIGRATIONS_DIR = path.join(STATE_DIR, "migrations");
// Account-pool policy contains only opaque account ids and routing metadata;
// native OAuth credentials stay owned by the Codex login implementation.
export const CHATGPT_ACCOUNT_POOL_PATH =
  process.env.MODEL_ROUTER_CHATGPT_ACCOUNT_POOL ||
  path.join(STATE_DIR, "chatgpt-account-pool.json");
// Each ChatGPT subscription account gets its own Codex home.  The home keeps
// the OAuth refresh state under Codex's normal ownership boundary instead of
// copying a token into the router's pool metadata.  The account id is always
// validated before it is appended to this directory.
export const CHATGPT_ACCOUNT_HOMES_DIR =
  process.env.MODEL_ROUTER_CHATGPT_ACCOUNT_HOMES ||
  path.join(STATE_DIR, "chatgpt-accounts");
export const CHATGPT_PROFILE_SWITCH_PATH = path.join(STATE_DIR, "chatgpt-profile-switch.json");
export const SUPPORT_DIR = path.join(STATE_DIR, "support");
export const LOG_PATH = path.join(STATE_DIR, "router.log");
export const SERVICE_PROCESS_STATE_PATH = path.join(STATE_DIR, "service-process.json");
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
  trayBundleDir("darwin", os.homedir()) ?? path.join(os.homedir(), "Applications", "Codex Router.app");
// The previous unified native host used this visible name. It is migration
// evidence only: launch, status, and new packages must resolve TRAY_APP_PATH.
export const LEGACY_USER_TRAY_APP_PATH = path.join(
  os.homedir(),
  "Applications",
  "Model Router.app",
);
export const LEGACY_TRAY_APP_PATH = path.join(SOURCE_ROOT, "dist", "Model Router.app");
export const TRAY_APP_BINARY = path.join(TRAY_APP_PATH, "Contents", "MacOS", "ModelRouterTray");
// Task Scheduler names the tray separately from the router's own task so
// stopping one never takes the other down.
export const TRAY_TASK_NAME = "Codex Router Tray";

function port(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be a TCP port between 1 and 65535.`);
  }
  return value;
}

// Keep the defaults in an unassigned IANA range. 4101-4104 are the registered
// BrlAPI ports on Linux; binding an HTTP service there makes xbrlapi wait for a
// protocol response during GNOME login. gateway/oauth/router/api are the
// original four; the remaining entries are dedicated provider forwarders.
export const DEFAULT_PORTS = Object.freeze({
  gateway: 4200,
  oauth: 4201,
  router: 4202,
  api: 4203,
  grokOauth: 4208,
  devinCli: 4210,
  antigravityOauth: 4212,
});

// Ports used before the BrlAPI-safe defaults shipped. They remain recognized
// by config migration, but are never selected unless an operator explicitly
// sets one of the environment variables below.
export const LEGACY_PORTS = Object.freeze({
  gateway: 4100,
  oauth: 4101,
  router: 4102,
  api: 4103,
  grokOauth: 4108,
});

export const PORTS = {
  gateway: port(
    "MODEL_ROUTER_GATEWAY_PORT",
    process.env.CODEX_ROUTER_GATEWAY_PORT || process.env.KIMI_GATEWAY_PORT || DEFAULT_PORTS.gateway,
  ),
  oauth: port(
    "MODEL_ROUTER_OAUTH_PORT",
    process.env.CODEX_ROUTER_OAUTH_PORT || process.env.KIMI_OAUTH_FORWARD_PORT || DEFAULT_PORTS.oauth,
  ),
  router: port(
    "MODEL_ROUTER_PORT",
    process.env.CODEX_ROUTER_PORT || process.env.KIMI_ROUTER_PORT || DEFAULT_PORTS.router,
  ),
  api: port(
    "MODEL_ROUTER_API_PORT",
    process.env.CODEX_ROUTER_API_PORT || process.env.KIMI_API_FORWARD_PORT || DEFAULT_PORTS.api,
  ),
  grokOauth: port("MODEL_ROUTER_GROK_OAUTH_PORT", DEFAULT_PORTS.grokOauth),
  devinCli: port("MODEL_ROUTER_DEVIN_CLI_PORT", DEFAULT_PORTS.devinCli),
  antigravityOauth: port("MODEL_ROUTER_ANTIGRAVITY_OAUTH_PORT", DEFAULT_PORTS.antigravityOauth),
};

export function loopback(portNumber, suffix = "") {
  return `http://127.0.0.1:${portNumber}${suffix}`;
}
