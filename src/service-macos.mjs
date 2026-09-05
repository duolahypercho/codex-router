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
import path from "node:path";

import {
  CODEX_HOME,
  LAUNCH_AGENT_PATH,
  LOG_PATH,
  PORTS,
  SERVICE_LABEL,
  SOURCE_ROOT,
  STATE_DIR,
  TARGET,
} from "./paths.mjs";
import { providerApiKeyServiceEnvironment } from "./provider-api-key-service-environment.mjs";
import { serviceProxyEnvironment } from "./proxy-environment.mjs";
import {
  skipServiceManagerCall,
  assertServiceWriteIsolated,
} from "./service-write-guard.mjs";

// Only this platform's own module can reach this machine's service manager.
// Run anywhere else -- the cross-platform render tests drive all three modules
// on one host -- launchctl is absent or a test's own stub.
const HOST_MANAGED = process.platform === "darwin";

// Reads stay live. Skipping `print` as well made `loaded()` answer "nothing is
// there" for every caller, which changed what the doctor reports about the
// service and, through it, what else the doctor goes on to do -- CI caught
// that as two unrelated Windows tests failing on their own cleanup. Only the
// verbs that change launchd's registration are skipped.
const MUTATING_VERBS = new Set(["bootout", "bootstrap", "disable", "enable", "kickstart"]);

const command = process.argv[2] || "status";
const effectivePlatform = process.env.CODEX_ROUTER_SERVICE_PLATFORM || process.platform;
if (effectivePlatform !== "darwin" && command !== "render") {
  throw new Error("The launchd service manager runs on macOS only.");
}
const userId = typeof process.getuid === "function" ? process.getuid() : 501;
const domain = `gui/${userId}`;
const service = `${domain}/${SERVICE_LABEL}`;
const launchctl = "/bin/launchctl";
const launchctlRetryWait = new Int32Array(new SharedArrayBuffer(4));
const nodeBinary = process.env.CODEX_ROUTER_NODE_BIN || process.execPath;
if (!path.isAbsolute(nodeBinary)) {
  throw new Error("CODEX_ROUTER_NODE_BIN must be an absolute path.");
}

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
    KIMI_CODEX_STATE_DIR: STATE_DIR,
    CODEX_ROUTER_QUIET: "1",
    KIMI_PROXY_QUIET: "1",
    CODEX_ROUTER_GATEWAY_PORT: String(PORTS.gateway),
    CODEX_ROUTER_OAUTH_PORT: String(PORTS.oauth),
    CODEX_ROUTER_PORT: String(PORTS.router),
    CODEX_ROUTER_API_PORT: String(PORTS.api),
    ...(process.env.CODEX_ROUTER_DISABLE_PASSIVE_CATALOG_REFRESH === "1"
      ? { CODEX_ROUTER_DISABLE_PASSIVE_CATALOG_REFRESH: "1" }
      : {}),
    ...serviceProxyEnvironment(),
    ...providerApiKeyServiceEnvironment(),
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
  if (process.env.KIMI_CODE_HOME) values.KIMI_CODE_HOME = process.env.KIMI_CODE_HOME;
  return Object.entries(values)
    .map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`)
    .join("\n");
}

function plist() {
  const start = path.join(SOURCE_ROOT, "src", "start.mjs");
  // Background starved LiteLLM to ~4% CPU (fb40f8c). Adaptive was meant to
  // boost under load, but it only does so on XPC transactions; this job is
  // localhost HTTP, so Adaptive stays at Background. Node forwarders then miss
  // the 30s OAuth health budget, KeepAlive crash-loops, and tray Update /
  // doctor --fix wait 300s on /health. Standard is a normal user-agent class.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(SERVICE_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(nodeBinary)}</string>
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
  <string>Standard</string>
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
  if (MUTATING_VERBS.has(args[0]) && skipServiceManagerCall({ hostManaged: HOST_MANAGED })) {
    return "";
  }
  return execFileSync(launchctl, args, {
    encoding: "utf8",
    timeout: 15_000,
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
  // Before `loaded`, not after: the loop below polls until the job is gone,
  // and the job it would see is this machine's own.
  if (skipServiceManagerCall({ hostManaged: HOST_MANAGED })) return;
  const description = loaded(targetService);
  if (!description) return;
  try {
    run(["bootout", targetService], { quiet: true });
  } catch (error) {
    if (loaded(targetService)) throw error;
    return;
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!loaded(targetService)) return;
    Atomics.wait(launchctlRetryWait, 0, 0, 100);
  }
  if (loaded(targetService)) {
    throw new Error(`Timed out waiting for ${targetService} to stop.`);
  }
}

const guardPlistWrite = () => assertServiceWriteIsolated(LAUNCH_AGENT_PATH, {
  redirected: Boolean(
    process.env.MODEL_ROUTER_LAUNCH_AGENTS_DIR || process.env.CODEX_ROUTER_LAUNCH_AGENTS_DIR,
  ),
  label: "LaunchAgent",
  override: "MODEL_ROUTER_LAUNCH_AGENTS_DIR",
});

function writePlist() {
  guardPlistWrite();
  mkdirSync(path.dirname(LAUNCH_AGENT_PATH), { recursive: true });
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const temporary = `${LAUNCH_AGENT_PATH}.tmp.${process.pid}`;
  // Proxy URLs may carry credentials, so the generated plist is private just
  // like the state it launches with.
  writeFileSync(temporary, plist(), { encoding: "utf8", mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, LAUNCH_AGENT_PATH);
}

function bootstrap() {
  if (skipServiceManagerCall({ hostManaged: HOST_MANAGED })) return;
  if (!existsSync(LAUNCH_AGENT_PATH)) {
    throw new Error(`LaunchAgent is not installed at ${LAUNCH_AGENT_PATH}.`);
  }
  run(["enable", service], { quiet: true });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      run(["bootstrap", domain, LAUNCH_AGENT_PATH], { quiet: true });
      return;
    } catch (error) {
      const description = loaded();
      if (description && !/state = SIGTERM/.test(description)) return;
      if (error?.status !== 5 || attempt === 19) throw error;
      Atomics.wait(launchctlRetryWait, 0, 0, 100);
    }
  }
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
  // Before anything, including the bootout below: an install that is going to
  // be refused for writing outside its fixture must not first unload the
  // machine's running service. writePlist re-checks; the guard is a pure
  // predicate.
  guardPlistWrite();
  bootout();
  // Only safe here. launchd opens StandardOutPath before it execs the service,
  // so a rotation performed by the started process renames a file the process
  // already holds a descriptor on: it keeps appending to the renamed inode and
  // the log grows exactly as before, just under a different name. Between
  // bootout and bootstrap nothing holds it and the next start creates a fresh
  // file. Failures are ignored -- housekeeping must not block an install.
  rotateLog(LOG_PATH);
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
  // Removal damages the machine exactly as a write does: the observed failure
  // included a test deleting the real LaunchAgent outright.
  guardPlistWrite();
  if (existsSync(LAUNCH_AGENT_PATH)) unlinkSync(LAUNCH_AGENT_PATH);
  process.stdout.write(`${JSON.stringify({ installed: false })}\n`);
} else if (command === "stop") {
  bootout();
  process.stdout.write(`${JSON.stringify({ state: "stopped" })}\n`);
} else if (command === "start") {
  if (!loaded()) bootstrap();
  process.stdout.write(`${JSON.stringify({ state: "running" })}\n`);
} else if (command === "restart") {
  if (loaded()) {
    run(["kickstart", "-k", service], { quiet: true });
  } else {
    bootstrap();
  }
  process.stdout.write(`${JSON.stringify({ state: "running" })}\n`);
}
