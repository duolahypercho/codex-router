import { execFileSync } from "node:child_process";
import { rotateLog } from "./log-rotation.mjs";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CODEX_HOME,
  LOG_PATH,
  PORTS,
  SOURCE_ROOT,
  STATE_DIR,
  TARGET,
  TARGET_DISPLAY_NAME,
} from "./paths.mjs";
import { providerApiKeyServiceEnvironment } from "./provider-api-key-service-environment.mjs";
import { serviceProxyEnvironment } from "./proxy-environment.mjs";
import {
  skipServiceManagerCall,
  assertServiceWriteIsolated,
} from "./service-write-guard.mjs";

const effectivePlatform = process.env.CODEX_ROUTER_SERVICE_PLATFORM || process.platform;
const command = process.argv[2] || "status";
const nodeBinary = process.env.CODEX_ROUTER_NODE_BIN || process.execPath;
if (!path.isAbsolute(nodeBinary)) {
  throw new Error("CODEX_ROUTER_NODE_BIN must be an absolute path.");
}
const unitName = "codex-router.service";
const unitPath = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
  "systemd",
  "user",
  unitName,
);

const guardUnitWrite = () => assertServiceWriteIsolated(unitPath, {
  redirected: Boolean(process.env.XDG_CONFIG_HOME),
  label: "systemd unit",
  override: "XDG_CONFIG_HOME",
});

if (effectivePlatform !== "linux" && command !== "render") {
  throw new Error("The systemd service manager runs on Linux only.");
}

function systemdQuote(value) {
  return `"${String(value)
    .replaceAll("%", "%%")
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')}"`;
}

function unit() {
  const start = path.join(SOURCE_ROOT, "src", "start.mjs");
  const environment = {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    MODEL_ROUTER_TARGET: TARGET,
    MODEL_ROUTER_STATE_DIR: STATE_DIR,
    MODEL_ROUTER_QUIET: "1",
    MODEL_ROUTER_GATEWAY_PORT: String(PORTS.gateway),
    MODEL_ROUTER_OAUTH_PORT: String(PORTS.oauth),
    MODEL_ROUTER_PORT: String(PORTS.router),
    MODEL_ROUTER_API_PORT: String(PORTS.api),
    MODEL_ROUTER_GROK_OAUTH_PORT: String(PORTS.grokOauth),
    MODEL_ROUTER_DEVIN_CLI_PORT: String(PORTS.devinCli),
    MODEL_ROUTER_ANTIGRAVITY_OAUTH_PORT: String(PORTS.antigravityOauth),
    CODEX_HOME,
    CODEX_ROUTER_STATE_DIR: STATE_DIR,
    CODEX_ROUTER_QUIET: "1",
    CODEX_ROUTER_GATEWAY_PORT: String(PORTS.gateway),
    CODEX_ROUTER_OAUTH_PORT: String(PORTS.oauth),
    CODEX_ROUTER_PORT: String(PORTS.router),
    CODEX_ROUTER_API_PORT: String(PORTS.api),
    ...(process.env.CODEX_ROUTER_DISABLE_PASSIVE_CATALOG_REFRESH === "1"
      ? { CODEX_ROUTER_DISABLE_PASSIVE_CATALOG_REFRESH: "1" }
      : {}),
    ...serviceProxyEnvironment(),
    ...providerApiKeyServiceEnvironment(),
    ...(process.env.KIMI_CODE_HOME ? { KIMI_CODE_HOME: process.env.KIMI_CODE_HOME } : {}),
    ...(process.env.CODEX_ROUTER_SOURCE_ROOT
      ? { CODEX_ROUTER_SOURCE_ROOT: SOURCE_ROOT }
      : {}),
    ...(process.env.CODEX_ROUTER_NODE_BIN
      ? { CODEX_ROUTER_NODE_BIN: nodeBinary }
      : {}),
    ...(process.env.CODEX_ROUTER_PACKAGE_MANAGER
      ? { CODEX_ROUTER_PACKAGE_MANAGER: process.env.CODEX_ROUTER_PACKAGE_MANAGER }
      : {}),
  };
  return `[Unit]
Description=${TARGET_DISPLAY_NAME}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${String(SOURCE_ROOT).replaceAll("%", "%%")}
ExecStart=${systemdQuote(nodeBinary)} ${systemdQuote(start)}
Restart=always
RestartSec=5
${Object.entries(environment)
  .map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`)
  .join("\n")}
StandardOutput=append:${String(LOG_PATH).replaceAll("%", "%%")}
StandardError=append:${String(LOG_PATH).replaceAll("%", "%%")}

[Install]
WantedBy=default.target
`;
}

// Only this platform's own module can reach this machine's service manager.
// Run anywhere else -- the cross-platform render tests drive all three modules
// on one host -- systemctl is absent or a test's own stub.
const HOST_MANAGED = process.platform === "linux";

// The write guard covers the unit file, but a test cannot redirect systemd:
// XDG_CONFIG_HOME moves where the unit is written, not where the running
// systemd looks for it, so `enable --now codex-router.service` from an
// otherwise isolated test acts on the developer's own unit. Same failure the
// launchd module already skips, same shape.
//
// Reads stay live. `status` has to keep answering whether the unit is really
// active, or the doctor reasons from a state the skip invented.
const MUTATING_VERBS = new Set([
  "daemon-reload",
  "disable",
  "enable",
  "restart",
  "start",
  "stop",
]);

function systemctl(args, options = {}) {
  if (MUTATING_VERBS.has(args[0]) && skipServiceManagerCall({ hostManaged: HOST_MANAGED })) {
    return "";
  }
  return execFileSync("systemctl", ["--user", ...args], {
    encoding: "utf8",
    stdio: options.quiet ? ["ignore", "ignore", "ignore"] : ["ignore", "pipe", "pipe"],
  });
}

function writeUnit() {
  mkdirSync(path.dirname(unitPath), { recursive: true, mode: 0o700 });
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const temporary = `${unitPath}.tmp.${process.pid}`;
  // Proxy URLs may carry credentials, so the generated unit is private just
  // like the state it launches with.
  guardUnitWrite();
  writeFileSync(temporary, unit(), { encoding: "utf8", mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, unitPath);
}

if (!new Set(["install", "uninstall", "start", "stop", "restart", "status", "render", "restart-count"]).has(command)) {
  console.error("Usage: service-linux.mjs install|uninstall|start|stop|restart|status|render|restart-count");
  process.exit(2);
}

if (command === "render") {
  process.stdout.write(unit());
} else if (command === "install") {
  writeUnit();
  systemctl(["daemon-reload"], { quiet: true });
  // systemd's append: opens the log before the service runs, so the started
  // process cannot rotate a file it already holds open. Stop first, rotate
  // while nothing holds it, then start: enable --now on an already-running
  // unit would otherwise leave the old descriptor on the renamed inode.
  systemctl(["stop", unitName], { quiet: true });
  rotateLog(LOG_PATH);
  systemctl(["enable", "--now", unitName], { quiet: true });
  process.stdout.write(`${JSON.stringify({ installed: true, path: unitPath })}\n`);
} else if (command === "uninstall") {
  try {
    systemctl(["disable", "--now", unitName], { quiet: true });
  } catch {
    // The service may not be installed or running.
  }
  guardUnitWrite();
  if (existsSync(unitPath)) unlinkSync(unitPath);
  try {
    systemctl(["daemon-reload"], { quiet: true });
  } catch {
    // Best effort when no user systemd session exists.
  }
  process.stdout.write(`${JSON.stringify({ installed: false })}\n`);
} else if (command === "status") {
  let state = "stopped";
  try {
    state = systemctl(["is-active", unitName]).trim();
  } catch {
    // Inactive services return non-zero.
  }
  process.stdout.write(
    `${JSON.stringify({ installed: existsSync(unitPath), loaded: state === "active", state })}\n`,
  );
} else if (command === "restart-count") {
  // The automatic-restart counter systemd tracks for the unit. It is what
  // moves during a crash loop -- with Restart=always the unit state cycles
  // back to "active" after every crash -- and it is compared against the
  // value at wait start, so residue from before this install only ever
  // understates the loop. A unit systemd does not know reports no count.
  let restarts = null;
  try {
    const parsed = Number.parseInt(
      systemctl(["show", unitName, "--property=NRestarts", "--value"]).trim(),
      10,
    );
    if (Number.isSafeInteger(parsed) && parsed >= 0) restarts = parsed;
  } catch {
    // No user systemd session, or the unit is not loaded.
  }
  process.stdout.write(`${JSON.stringify({ restarts })}\n`);
} else {
  const verb = { start: "start", stop: "stop", restart: "restart" }[command];
  systemctl([verb, unitName], { quiet: true });
  process.stdout.write(`${JSON.stringify({ state: command === "stop" ? "stopped" : "running" })}\n`);
}
