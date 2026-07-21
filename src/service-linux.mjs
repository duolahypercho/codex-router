import { execFileSync } from "node:child_process";
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

const effectivePlatform = process.env.CODEX_ROUTER_SERVICE_PLATFORM || process.platform;
const command = process.argv[2] || "status";
const UNIT_NAMES = {
  codex: "codex-router.service",
  claude: "codex-router-claude.service",
  cursor: "codex-router-cursor.service",
};
const unitName = UNIT_NAMES[TARGET];
const unitPath = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
  "systemd",
  "user",
  unitName,
);

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
    MODEL_ROUTER_TARGET: TARGET,
    MODEL_ROUTER_STATE_DIR: STATE_DIR,
    MODEL_ROUTER_QUIET: "1",
    MODEL_ROUTER_GATEWAY_PORT: String(PORTS.gateway),
    MODEL_ROUTER_OAUTH_PORT: String(PORTS.oauth),
    MODEL_ROUTER_PORT: String(PORTS.router),
    MODEL_ROUTER_API_PORT: String(PORTS.api),
    CODEX_HOME,
    CODEX_ROUTER_STATE_DIR: STATE_DIR,
    CODEX_ROUTER_QUIET: "1",
    CODEX_ROUTER_GATEWAY_PORT: String(PORTS.gateway),
    CODEX_ROUTER_OAUTH_PORT: String(PORTS.oauth),
    CODEX_ROUTER_PORT: String(PORTS.router),
    CODEX_ROUTER_API_PORT: String(PORTS.api),
    ...(process.env.KIMI_CODE_HOME ? { KIMI_CODE_HOME: process.env.KIMI_CODE_HOME } : {}),
  };
  return `[Unit]
Description=${TARGET_DISPLAY_NAME}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${systemdQuote(SOURCE_ROOT)}
ExecStart=${systemdQuote(process.execPath)} ${systemdQuote(start)}
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

function systemctl(args, options = {}) {
  return execFileSync("systemctl", ["--user", ...args], {
    encoding: "utf8",
    stdio: options.quiet ? ["ignore", "ignore", "ignore"] : ["ignore", "pipe", "pipe"],
  });
}

function writeUnit() {
  mkdirSync(path.dirname(unitPath), { recursive: true, mode: 0o700 });
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const temporary = `${unitPath}.tmp.${process.pid}`;
  writeFileSync(temporary, unit(), { encoding: "utf8", mode: 0o644 });
  chmodSync(temporary, 0o644);
  renameSync(temporary, unitPath);
}

if (!new Set(["install", "uninstall", "start", "stop", "restart", "status", "render"]).has(command)) {
  console.error("Usage: service-linux.mjs install|uninstall|start|stop|restart|status|render");
  process.exit(2);
}

if (command === "render") {
  process.stdout.write(unit());
} else if (command === "install") {
  writeUnit();
  systemctl(["daemon-reload"], { quiet: true });
  systemctl(["enable", "--now", unitName], { quiet: true });
  process.stdout.write(`${JSON.stringify({ installed: true, path: unitPath })}\n`);
} else if (command === "uninstall") {
  try {
    systemctl(["disable", "--now", unitName], { quiet: true });
  } catch {
    // The service may not be installed or running.
  }
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
} else {
  const verb = { start: "start", stop: "stop", restart: "restart" }[command];
  systemctl([verb, unitName], { quiet: true });
  process.stdout.write(`${JSON.stringify({ state: command === "stop" ? "stopped" : "running" })}\n`);
}
