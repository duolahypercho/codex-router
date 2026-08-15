import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  LAUNCH_AGENTS_DIR,
  TRAY_APP_BINARY,
  TRAY_APP_PATH,
  TRAY_LAUNCH_AGENT_PATH,
  TRAY_SERVICE_LABEL,
} from "./paths.mjs";

const launchctl = "/bin/launchctl";
const domain = `gui/${process.getuid()}`;
const service = `${domain}/${TRAY_SERVICE_LABEL}`;
const retryWait = new Int32Array(new SharedArrayBuffer(4));

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

// KeepAlive is conditional on purpose. `SuccessfulExit: false` restarts the tray
// when it crashes or is killed, but leaves it down after the Quit menu item
// exits cleanly — an unconditional KeepAlive would make Quit impossible.
//
// `--supervised` marks the launch as launchd's rather than the user's. Opening
// Model Router by hand reveals the menu bar item and starts the router on
// purpose; a login start must not, or follow mode would be overridden every
// time the user logs in. AppDelegate.launchedByUser reads this argument.
function plist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(TRAY_SERVICE_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(TRAY_APP_BINARY)}</string>
    <string>--supervised</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
</dict>
</plist>
`;
}

function run(args, options = {}) {
  return execFileSync(launchctl, args, {
    encoding: "utf8",
    timeout: 15_000,
    stdio: options.quiet ? ["ignore", "ignore", "ignore"] : ["ignore", "pipe", "pipe"],
  });
}

function loaded() {
  try {
    const description = run(["print", service]);
    return /(?:state|path|type) =/.test(description) ? description : undefined;
  } catch {
    return undefined;
  }
}

function bootout() {
  if (!loaded()) return;
  try {
    run(["bootout", service], { quiet: true });
  } catch (error) {
    if (loaded()) throw error;
    return;
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!loaded()) return;
    Atomics.wait(retryWait, 0, 0, 100);
  }
  throw new Error(`Timed out waiting for ${TRAY_SERVICE_LABEL} to stop.`);
}

function writeAgent() {
  mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });
  const temporary = `${TRAY_LAUNCH_AGENT_PATH}.tmp.${process.pid}`;
  writeFileSync(temporary, plist(), { encoding: "utf8", mode: 0o644 });
  chmodSync(temporary, 0o644);
  renameSync(temporary, TRAY_LAUNCH_AGENT_PATH);
}

function bootstrap() {
  run(["enable", service], { quiet: true });
  try {
    run(["bootstrap", domain, TRAY_LAUNCH_AGENT_PATH], { quiet: true });
  } catch (error) {
    // Already bootstrapped is not a failure; anything else is.
    if (!loaded()) throw error;
  }
}

const command = process.argv[2] || "status";
if (!new Set(["install", "uninstall", "start", "stop", "restart", "status", "render"]).has(command)) {
  console.error("Usage: tray-service-macos.mjs install|uninstall|start|stop|restart|status|render");
  process.exit(2);
}

if (command === "render") {
  process.stdout.write(plist());
} else if (command === "status") {
  const description = loaded();
  const installed = existsSync(TRAY_LAUNCH_AGENT_PATH);
  process.stdout.write(
    `${JSON.stringify({
      installed,
      loaded: Boolean(description) && installed,
      appPresent: existsSync(TRAY_APP_BINARY),
      state: description ? description.match(/state = ([^\n]+)/)?.[1]?.trim() || "loaded" : "stopped",
      path: TRAY_LAUNCH_AGENT_PATH,
    })}\n`,
  );
} else if (command === "install") {
  if (!existsSync(TRAY_APP_BINARY)) {
    throw new Error(
      `The tray app is not built at ${TRAY_APP_PATH}. Run ./bin/model-router-tray first.`,
    );
  }
  bootout();
  writeAgent();
  bootstrap();
  process.stdout.write(`${JSON.stringify({ installed: true, path: TRAY_LAUNCH_AGENT_PATH })}\n`);
} else if (command === "uninstall") {
  bootout();
  try {
    run(["disable", service], { quiet: true });
  } catch {
    // Best effort.
  }
  if (existsSync(TRAY_LAUNCH_AGENT_PATH)) unlinkSync(TRAY_LAUNCH_AGENT_PATH);
  process.stdout.write(`${JSON.stringify({ installed: false })}\n`);
} else if (command === "stop") {
  bootout();
  process.stdout.write(`${JSON.stringify({ state: "stopped" })}\n`);
} else if (command === "start") {
  if (!existsSync(TRAY_LAUNCH_AGENT_PATH)) {
    throw new Error(`The tray agent is not installed at ${TRAY_LAUNCH_AGENT_PATH}.`);
  }
  if (!loaded()) bootstrap();
  process.stdout.write(`${JSON.stringify({ state: "running" })}\n`);
} else if (command === "restart") {
  if (loaded()) run(["kickstart", "-k", service], { quiet: true });
  else bootstrap();
  process.stdout.write(`${JSON.stringify({ state: "running" })}\n`);
}
