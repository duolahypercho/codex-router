import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  CODEX_HOME,
  LAUNCH_AGENT_PATH,
  LOG_PATH,
  PORTS,
  SERVICE_LABEL,
  SOURCE_ROOT,
  STATE_DIR,
} from "./paths.mjs";

const command = process.argv[2] || "status";
const effectivePlatform = process.env.CODEX_ROUTER_SERVICE_PLATFORM || process.platform;
if (effectivePlatform !== "darwin" && command !== "render") {
  throw new Error("The launchd service manager runs on macOS only.");
}
const userId = typeof process.getuid === "function" ? process.getuid() : 501;
const domain = `gui/${userId}`;
const service = `${domain}/${SERVICE_LABEL}`;
const launchctl = "/bin/launchctl";

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function environmentEntries() {
  const values = {
    CODEX_HOME,
    CODEX_ROUTER_STATE_DIR: STATE_DIR,
    KIMI_CODEX_STATE_DIR: STATE_DIR,
    CODEX_ROUTER_QUIET: "1",
    KIMI_PROXY_QUIET: "1",
    CODEX_ROUTER_GATEWAY_PORT: String(PORTS.gateway),
    CODEX_ROUTER_OAUTH_PORT: String(PORTS.oauth),
    CODEX_ROUTER_PORT: String(PORTS.router),
    CODEX_ROUTER_API_PORT: String(PORTS.api),
  };
  if (process.env.KIMI_CODE_HOME) values.KIMI_CODE_HOME = process.env.KIMI_CODE_HOME;
  return Object.entries(values)
    .map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`)
    .join("\n");
}

function plist() {
  const start = path.join(SOURCE_ROOT, "src", "start.mjs");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(SERVICE_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(start)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(SOURCE_ROOT)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${environmentEntries()}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xml(LOG_PATH)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(LOG_PATH)}</string>
</dict>
</plist>
`;
}

function run(args, options = {}) {
  return execFileSync(launchctl, args, {
    encoding: "utf8",
    stdio: options.quiet
      ? ["ignore", "ignore", "ignore"]
      : ["ignore", "pipe", "pipe"],
  });
}

function loaded(targetService = service) {
  try {
    const description = run(["print", targetService]);
    return /(?:state|path|type) =/.test(description) ? description : undefined;
  } catch {
    return undefined;
  }
}

function bootout(targetService = service) {
  const description = loaded(targetService);
  if (!description || /state = (?:SIGTERM|exited|stopped)/i.test(description)) return;
  try {
    run(["bootout", targetService], { quiet: true });
  } catch {
    // The process may already have exited.
  }
}

function writePlist() {
  mkdirSync(path.dirname(LAUNCH_AGENT_PATH), { recursive: true });
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const temporary = `${LAUNCH_AGENT_PATH}.tmp.${process.pid}`;
  writeFileSync(temporary, plist(), { encoding: "utf8", mode: 0o644 });
  chmodSync(temporary, 0o644);
  renameSync(temporary, LAUNCH_AGENT_PATH);
}

function bootstrap() {
  if (!existsSync(LAUNCH_AGENT_PATH)) {
    throw new Error(`LaunchAgent is not installed at ${LAUNCH_AGENT_PATH}.`);
  }
  run(["enable", service], { quiet: true });
  run(["bootstrap", domain, LAUNCH_AGENT_PATH], { quiet: true });
}

if (!new Set(["install", "uninstall", "start", "stop", "restart", "status", "render"]).has(command)) {
  console.error("Usage: service-macos.mjs install|uninstall|start|stop|restart|status|render");
  process.exit(2);
}

if (command === "render") {
  process.stdout.write(plist());
} else if (command === "status") {
  const description = loaded();
  const installed = existsSync(LAUNCH_AGENT_PATH);
  const isLoaded = Boolean(description) && installed;
  const state = isLoaded
    ? description?.match(/state = ([^\n]+)/)?.[1]?.trim() || "loaded"
    : "stopped";
  process.stdout.write(
    `${JSON.stringify({
      installed,
      loaded: isLoaded,
      state,
    })}\n`,
  );
} else if (command === "install") {
  bootout();
  writePlist();
  bootstrap();
  process.stdout.write(`${JSON.stringify({ installed: true, path: LAUNCH_AGENT_PATH })}\n`);
} else if (command === "uninstall") {
  bootout();
  try {
    run(["disable", service], { quiet: true });
  } catch {
    // Best effort.
  }
  if (existsSync(LAUNCH_AGENT_PATH)) unlinkSync(LAUNCH_AGENT_PATH);
  process.stdout.write(`${JSON.stringify({ installed: false })}\n`);
} else if (command === "stop") {
  bootout();
  process.stdout.write(`${JSON.stringify({ state: "stopped" })}\n`);
} else if (command === "start") {
  if (!loaded()) bootstrap();
  process.stdout.write(`${JSON.stringify({ state: "running" })}\n`);
} else if (command === "restart") {
  bootout();
  bootstrap();
  process.stdout.write(`${JSON.stringify({ state: "running" })}\n`);
}
