import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { assertCallerSecret } from "./caller-auth.mjs";
import {
  CALLER_SECRET_PATH,
  CURSOR_CATALOG_PATH,
  INTERNAL_SECRET_PATH,
  LITELLM_CONFIG_PATH,
  MERGED_CATALOG_PATH,
  PORTS,
  PROVIDER_SELECTION_PATH,
  SOURCE_ROOT,
  STATE_DIR,
  TARGET,
  loopback,
} from "./paths.mjs";
import { SHUTDOWN_DRAIN_MS, SHUTDOWN_FLUSH_MS } from "./http-utils.mjs";
import { waitForHealth as pollHealth } from "./health-probe.mjs";
import { gatewaySupervisorLimits, superviseGateway } from "./gateway-supervisor.mjs";
import { writeLiteLlmConfig } from "./litellm-config.mjs";
import { MODELS } from "./model-registry.mjs";
import { readLocalModelSelection } from "./local-models.mjs";
import { antigravityOAuthStartupState } from "./antigravity-oauth-status.mjs";
import { attemptAntigravityProbePromotionAfterReadiness } from "./antigravity-probe-activation.mjs";
import { spawnableCommand } from "./spawnable-command.mjs";
import { ensureOllamaHeadless } from "./ollama-runtime.mjs";
import { venvRuntimeProblem } from "./venv-runtime.mjs";
import { dependencyRepairHint } from "./dependency-repair.mjs";
import { clearServiceProcessState, writeServiceProcessState } from "./service-process.mjs";
import {
  environmentProxyOptedIn,
  inheritedProxyEnvironment,
  redactProxyCredentials,
} from "./proxy-environment.mjs";
import { antigravityOAuthStatus } from "./antigravity-oauth-status.mjs";
import { cursorTunnelRunSpec } from "./cursor-cloudflare-tunnel.mjs";
import { pruneUnconfiguredProviders } from "./provider-selection.mjs";
import { targetCli } from "./target-integration.mjs";

// Before anything reads the environment or spawns a child. A service manager
// hands this process the proxy the install recorded; a shell hands it whatever
// the shell had, which for a desktop-app-spawned shell is nothing. Restoring
// the recorded values here makes every start path -- managed, foreground, or
// accidental -- reach upstreams the same way, and `commonEnv` below propagates
// them to the router and the forwarders through `process.env`.
const restoredProxy = inheritedProxyEnvironment();
for (const [name, value] of Object.entries(restoredProxy)) {
  process.env[name] = value;
}
// Unconditionally, and never behind MODEL_ROUTER_QUIET: this silently changes
// where every upstream request goes, and the whole reason the original failure
// took so long to find is that nothing near the router ever said which network
// path it was using. A managed start never reaches here -- its environment is
// declared -- so this line appears only on the paths that need it. The
// credential in a proxy URL is stripped; the host and port are the point.
if (Object.keys(restoredProxy).length > 0) {
  const address = restoredProxy.https_proxy ?? restoredProxy.HTTPS_PROXY
    ?? restoredProxy.http_proxy ?? restoredProxy.HTTP_PROXY;
  const shown = redactProxyCredentials({ address }).address;
  console.error(
    "[model-router] no proxy environment was inherited; restored the installed one" +
    `${shown ? ` (${shown})` : ""} from the install manifest.`,
  );
}

const dependencyFix = dependencyRepairHint();

const litellm =
  process.env.MODEL_ROUTER_LITELLM_BIN ||
  (TARGET === "codex"
    ? process.env.CODEX_ROUTER_LITELLM_BIN || process.env.KIMI_LITELLM_BIN
    : undefined) ||
  path.join(
    SOURCE_ROOT,
    ".venv",
    process.platform === "win32" ? "Scripts" : "bin",
    process.platform === "win32" ? "litellm.exe" : "litellm",
  );
if (!existsSync(litellm)) {
  throw new Error(`LiteLLM is not installed at ${litellm}. ${dependencyFix}.`);
}

// A launcher file that exists on disk is not proof the venv works: an
// interpreter home pointing at a cleared temporary directory (macOS wipes
// /private/tmp, and an installer that recorded a temporary Python as the venv
// home leaves `.venv/bin/python` dangling) makes every spawn fail with ENOENT
// while the launcher itself is still present. Probe the interpreter
// explicitly so a broken venv fails here with a readable message and a fix
// path instead of feeding launchd's restart loop an unreadable crash.
// The probe applies only to the bundled venv: a custom launcher
// (MODEL_ROUTER_LITELLM_BIN or a codex-target alias) may deliberately ship
// without the bundled `.venv`, and CI exercises startup with
// MODEL_ROUTER_LITELLM_BIN=process.execPath on a fresh checkout that has no
// venv at all.
const usesBundledVenv = !process.env.MODEL_ROUTER_LITELLM_BIN &&
  !(TARGET === "codex" &&
    (process.env.CODEX_ROUTER_LITELLM_BIN || process.env.KIMI_LITELLM_BIN));
if (usesBundledVenv) {
  const venvPython = path.join(
    SOURCE_ROOT,
    ".venv",
    process.platform === "win32" ? "Scripts" : "bin",
    process.platform === "win32" ? "python.exe" : "python",
  );
  const venvProblem = venvRuntimeProblem(venvPython);
  if (venvProblem) {
    throw new Error(
      `The LiteLLM virtual environment is broken at ${venvPython} (${venvProblem}). ` +
        `${dependencyFix}.`,
    );
  }
}
if (!existsSync(INTERNAL_SECRET_PATH)) {
  throw new Error(`Internal service key is missing; run ./bin/install.`);
}
if (!existsSync(CALLER_SECRET_PATH)) {
  throw new Error(`Router caller key is missing; run ./bin/install.`);
}
const internalKey = readFileSync(INTERNAL_SECRET_PATH, "utf8").trim();
if (!internalKey) throw new Error("Internal service key is empty.");
const callerKey = assertCallerSecret(
  readFileSync(CALLER_SECRET_PATH, "utf8").trim(),
);
writeLiteLlmConfig();

// Drop enabled providers this build cannot authenticate (missing credential,
// retired/unknown id). Without this, enabled-providers.json accrues dead
// entries and the next turn against them returns provider_api_key_missing
// while the picker can still advertise a stale catalog row. Runs after the
// gateway config write so a prune that rewrites selection cannot race a
// concurrent config reader mid-start; forwarders spawned below see the
// reconciled file.
const prunedProviders = pruneUnconfiguredProviders();
if (prunedProviders.length) {
  console.error(
    `[codex-router] pruned ${prunedProviders.length} provider(s) from ${PROVIDER_SELECTION_PATH}: ${
      prunedProviders.map(({ id, reason }) => `${id} (${reason})`).join(", ")
    }`,
  );
  console.error(
    `[codex-router] restore with: ${targetCli("setup --guided")} or ${targetCli("providers enable <id>")} after storing a credential`,
  );
}

// A checked local model means the operator intends to route through Ollama,
// so keep its daemon available for the gateway. This never installs software
// or pulls a model during service startup; a missing runtime remains a doctor
// warning, while a present runtime is started as a detached, headless server.
if (readLocalModelSelection().enabled.length) {
  try {
    await ensureOllamaHeadless({ install: false });
  } catch (error) {
    console.error(`Local Ollama is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Same rule, one layer up: a curated model is what gives a provider a gateway
// route, so it is also what makes that provider's own forwarder worth a
// process and a port. `writeLiteLlmConfig()` above emits the
// `DEVIN_CLI_FORWARD_BASE_URL` route from this same MODELS array on this same
// boot, so the route and the listener cannot disagree -- no curated Devin
// model means no route to the port and nothing bound to it. Devin ships
// catalog-only (`bin/curate-models devin-cli`), so an operator who never asked
// for it pays nothing: no fourth child, no fourth port, no fourth health wait.
//
// The stored credential is deliberately *not* the gate. Someone who curated a
// model but has not run `devin auth login` should get the forwarder's 401
// naming that command, not a bare connection error from a port nobody is
// listening on.
const devinCliRouted = MODELS.some((model) => model.provider === "devin-cli");
const cursorInstalled = existsSync(CURSOR_CATALOG_PATH);

const commonEnv = {
  MODEL_ROUTER_TARGET: TARGET,
  MODEL_ROUTER_STATE_DIR: STATE_DIR,
  MODEL_ROUTER_CALLER_KEY: callerKey,
  MODEL_ROUTER_INTERNAL_KEY: internalKey,
  MODEL_ROUTER_GATEWAY_BASE_URL: loopback(PORTS.gateway, "/v1"),
  MODEL_ROUTER_OAUTH_HEALTH_URL: loopback(PORTS.oauth, "/health"),
  MODEL_ROUTER_API_HEALTH_URL: loopback(PORTS.api, "/health"),
  MODEL_ROUTER_GATEWAY_HEALTH_URL: loopback(PORTS.gateway, "/health/liveliness"),
  MODEL_ROUTER_GATEWAY_PORT: String(PORTS.gateway),
  // LiteLLM's ollama_chat provider talks to the daemon root, not the
  // OpenAI-compatible /v1 surface the bridge uses for inference.
  MODEL_ROUTER_LOCAL_BASE_URL_ROOT:
    (process.env.MODEL_ROUTER_LOCAL_BASE_URL || "http://127.0.0.1:11434/v1").replace(/\/v1\/?$/, ""),
  MODEL_ROUTER_OAUTH_PORT: String(PORTS.oauth),
  MODEL_ROUTER_API_PORT: String(PORTS.api),
  MODEL_ROUTER_PORT: String(PORTS.router),
  MODEL_ROUTER_GROK_OAUTH_PORT: String(PORTS.grokOauth),
  GROK_OAUTH_FORWARD_BASE_URL: loopback(PORTS.grokOauth, "/v1"),
  MODEL_ROUTER_ANTIGRAVITY_OAUTH_PORT: String(PORTS.antigravityOauth),
  ANTIGRAVITY_OAUTH_FORWARD_BASE_URL: loopback(PORTS.antigravityOauth, "/v1"),
  MODEL_ROUTER_DEVIN_CLI_PORT: String(PORTS.devinCli),
  DEVIN_CLI_FORWARD_BASE_URL: loopback(PORTS.devinCli, "/v1"),
  MODEL_ROUTER_CURSOR_PUBLIC_PORT: String(PORTS.cursorPublic),
  MODEL_ROUTER_QUIET: "1",
  CODEX_ROUTER_CALLER_KEY: callerKey,
  CODEX_ROUTER_INTERNAL_KEY: internalKey,
  KIMI_INTERNAL_KEY: internalKey,
  KIMI_OAUTH_FORWARD_BASE_URL: loopback(PORTS.oauth, "/v1"),
  CODEX_ROUTER_API_FORWARD_BASE_URL: loopback(PORTS.api, "/v1"),
  CODEX_ROUTER_ANTHROPIC_FORWARD_BASE_URL: loopback(PORTS.api),
  CODEX_ROUTER_GATEWAY_BASE_URL: loopback(PORTS.gateway, "/v1"),
  CODEX_ROUTER_OAUTH_HEALTH_URL: loopback(PORTS.oauth, "/health"),
  CODEX_ROUTER_API_HEALTH_URL: loopback(PORTS.api, "/health"),
  CODEX_ROUTER_GATEWAY_HEALTH_URL: loopback(PORTS.gateway, "/health/liveliness"),
  CODEX_ROUTER_CATALOG: MERGED_CATALOG_PATH,
  CODEX_ROUTER_OAUTH_PORT: String(PORTS.oauth),
  CODEX_ROUTER_API_PORT: String(PORTS.api),
  CODEX_ROUTER_GATEWAY_PORT: String(PORTS.gateway),
  CODEX_ROUTER_PORT: String(PORTS.router),
  LITELLM_MASTER_KEY: internalKey,
  LITELLM_LOG: "ERROR",
  LITELLM_TELEMETRY: "False",
  NO_COLOR: "1",
  // LiteLLM prints Unicode banners at startup; on a non-UTF-8 Windows code page
  // (e.g. cp1252) that raises UnicodeEncodeError and the child never comes up.
  PYTHONIOENCODING: "utf-8",
  PYTHONUTF8: "1",
  // `--use-env-proxy` is a process argument, not an inherited environment
  // variable. Preserve its positive decision for the Node forwarders this
  // process launches; NODE_OPTIONS and NODE_USE_ENV_PROXY already inherit via
  // process.env.
  ...(environmentProxyOptedIn() ? { NODE_USE_ENV_PROXY: "1" } : {}),
};

const children = [];
let shuttingDown = false;

// Every child goes through `spawnableCommand` for the one case that needs it:
// a Windows `.cmd`/`.bat` launcher, which Node has refused to spawn without a
// shell since the CVE-2024-27980 fix and answers with a bare EINVAL. The
// installer produces `litellm.exe`, so the shipped path is untouched
// pass-through -- but `MODEL_ROUTER_LITELLM_BIN` and `CODEX_ROUTER_LITELLM_BIN`
// are operator-set, and a batch wrapper there used to take the whole service
// down before it spawned anything, with an error naming neither the file nor
// the reason. Our own Node children resolve to `process.execPath`, so they are
// pass-through on every platform.
function run(command, args, extraEnv = {}) {
  const spawnable = spawnableCommand(command, args);
  const child = spawn(spawnable.command, spawnable.args, {
    cwd: SOURCE_ROOT,
    env: { ...process.env, ...commonEnv, ...extraEnv },
    stdio: "inherit",
    ...spawnable.options,
  });
  children.push(child);
  return child;
}

function waitForExit(child, label) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ label, code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ label, code, signal }));
  });
}

// The probe loop lives in src/health-probe.mjs so it can be tested directly;
// importing this file starts the whole service pipeline.
function waitForHealth(label, url, headers = {}, timeoutMs = 30_000, expectedService, child) {
  return pollHealth({
    label,
    url,
    headers,
    timeoutMs,
    expectedService,
    child,
    isShuttingDown: () => shuttingDown,
  });
}

// Each child answers SIGTERM by draining what is in flight for up to
// SHUTDOWN_DRAIN_MS and then ending those responses cleanly, so this backstop
// has to outlast that. It used to fire at three seconds flat, which killed a
// router still holding a streaming turn open -- and a SIGKILLed socket is an
// RST, which Codex reports as `error decoding response body` rather than as
// the restart it was. Derive the deadline from the drain so the two cannot
// drift apart; the margin covers the exit itself.
const SIGKILL_AFTER_MS = SHUTDOWN_DRAIN_MS + SHUTDOWN_FLUSH_MS + 2_000;

function stopChildren() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
  setTimeout(() => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, SIGKILL_AFTER_MS).unref();
}

const FRONTEND = { script: "router.mjs", service: "codex-router", label: "Codex router" };
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, stopChildren);

async function main() {
  // These forwarders use separate ports and do not depend on one another.
  // Start all of them before waiting so a cold service does not pay their
  // startup times one after another.
  const kimiForwarder = run(process.execPath, [path.join(SOURCE_ROOT, "src", "oauth-forwarder.mjs")]);
  const api = run(process.execPath, [path.join(SOURCE_ROOT, "src", "api-forwarder.mjs")]);
  const grokForwarder = run(process.execPath, [path.join(SOURCE_ROOT, "src", "grok-oauth-forwarder.mjs")]);
  // An unverified account has no routable Antigravity model. A successful
  // probe writes a nonpublishable pending generation, which is the sole
  // exception to the active-proof gate: startup may boot and health-check its
  // forwarder, then atomically promote that exact generation only after the
  // whole local stack is ready. An unrelated listener on this otherwise-unused
  // port therefore cannot take down an account that has never passed proof.
  const antigravityStartup = antigravityOAuthStartupState();
  const antigravityForwarder = antigravityStartup.startForwarder
    ? run(process.execPath, [path.join(SOURCE_ROOT, "src", "antigravity-oauth-forwarder.mjs")])
    : undefined;
  const devinForwarder = devinCliRouted
    ? run(process.execPath, [path.join(SOURCE_ROOT, "src", "devin-cli-forwarder.mjs")])
    : undefined;
  await Promise.all([
    waitForHealth(
      "OAuth forwarder",
      loopback(PORTS.oauth, "/health"),
      { Authorization: `Bearer ${internalKey}` },
      30_000,
      undefined,
      kimiForwarder,
    ),
    waitForHealth(
      "API forwarder",
      loopback(PORTS.api, "/health"),
      { Authorization: `Bearer ${internalKey}` },
      30_000,
      undefined,
      api,
    ),
    waitForHealth(
      "Grok OAuth forwarder",
      loopback(PORTS.grokOauth, "/health"),
      { Authorization: `Bearer ${internalKey}` },
      30_000,
      undefined,
      grokForwarder,
    ),
    ...(antigravityForwarder
      ? [
        waitForHealth(
          "Antigravity OAuth forwarder",
          loopback(PORTS.antigravityOauth, "/health"),
          { Authorization: `Bearer ${internalKey}` },
          30_000,
          undefined,
          antigravityForwarder,
        ),
      ]
      : []),
    // Spread rather than a conditional inside the wait: an unrouted Devin adds
    // no entry at all, so it cannot add latency. A routed one is waited on
    // exactly as the other three are, and a forwarder that cannot bind still
    // aborts startup by name instead of being skipped quietly.
    ...(devinForwarder
      ? [
        waitForHealth(
          "Devin CLI forwarder",
          loopback(PORTS.devinCli, "/health"),
          { Authorization: `Bearer ${internalKey}` },
          30_000,
          undefined,
          devinForwarder,
        ),
      ]
      : []),
  ]);

  const startGateway = () =>
    run(litellm, [
      "--config",
      LITELLM_CONFIG_PATH,
      "--host",
      "127.0.0.1",
      "--port",
      String(PORTS.gateway),
    ]);
  // LiteLLM cold starts can take minutes when launchd starves the job under
  // system load; killing it mid-import restarts the import from scratch and
  // the service loops forever, so wait long enough for a starved import.
  const gatewayHealthy = (child) =>
    waitForHealth(
      "LiteLLM gateway",
      loopback(PORTS.gateway, "/health/liveliness"),
      { Authorization: `Bearer ${internalKey}` },
      300_000,
      undefined,
      child,
    );
  const gateway = startGateway();
  await gatewayHealthy(gateway);

  const frontend = FRONTEND;
  const frontendService = frontend.service;
  const router = run(process.execPath, [path.join(SOURCE_ROOT, "src", frontend.script)]);
  await waitForHealth(
    frontend.label,
    loopback(PORTS.router, "/health"),
    {},
    30_000,
    frontendService,
    router,
  );

  // After router is healthy, check for native catalog drift in background.
  // If Codex updated models_cache.json (new native model), republish automatically.
  // This runs async without blocking further startup or waiting for user commands.
  import("./native-catalog-drift.mjs")
    .then(({ republishOnNativeDrift }) => republishOnNativeDrift())
    .catch((error) => {
      console.error(`[codex-router] Native drift check failed: ${error.message}`);
    });

  if (antigravityStartup.pendingActivationGeneration) {
    const promoted = await attemptAntigravityProbePromotionAfterReadiness({
      generation: antigravityStartup.pendingActivationGeneration,
      sessionGeneration: antigravityStartup.pendingSessionGeneration,
      children,
    });
    if (!promoted) {
      // Never log the generation or any credential material. A concurrent
      // replacement/disconnect, a newer probe, or a child death all leave the
      // pending proof nonpublishable; the service can still serve every other
      // provider while the initiating command reports that exact activation
      // was not confirmed.
      console.error(
        "[codex-router] Antigravity live-proof activation was superseded or startup lost a child; the route remains disabled.",
      );
    }
  }
  const cursorEdge = cursorInstalled
    ? run(process.execPath, [path.join(SOURCE_ROOT, "src", "cursor-public-edge.mjs")])
    : undefined;
  if (cursorEdge) {
    await waitForHealth(
      "Cursor public edge",
      loopback(PORTS.cursorPublic, "/health"),
      {},
      30_000,
      "codex-router-cursor-edge",
      cursorEdge,
    );
  }
  // Cursor App sends BYOK requests from Cursor's backend, so its loopback edge
  // is paired with a user-owned named tunnel when one has been provisioned.
  // The generated ingress points only at port 4214 and ends in a 404 catch-all.
  const cursorTunnelSpec = cursorEdge ? cursorTunnelRunSpec() : undefined;
  const cursorTunnel = cursorTunnelSpec
    ? run(cursorTunnelSpec.command, cursorTunnelSpec.args)
    : undefined;

  console.error(`[${frontendService}] ready (authenticated loopback endpoint)`);
  // Only the gateway is supervised. The forwarders and the router are ours and
  // are restarted by rebuilding the whole service; the gateway is a third-party
  // Python process that can end itself on a single bad upstream response
  // (issue #261, a 429 raised out of LiteLLM's exception mapping), and taking
  // the router down with it turned one failed request into a dead session.
  const result = await Promise.race([
    waitForExit(kimiForwarder, "OAuth forwarder"),
    waitForExit(api, "API forwarder"),
    waitForExit(grokForwarder, "Grok OAuth forwarder"),
    ...(antigravityForwarder
      ? [waitForExit(antigravityForwarder, "Antigravity OAuth forwarder")]
      : []),
    // Only when it is actually running. A forwarder of ours that dies is a bug
    // report, and the rule above is that the service exits so the OS supervisor
    // rebuilds it -- leaving this one out of the race would instead strand a
    // Devin user on connection errors with nothing to notice them. An install
    // that never spawned it adds no entry, so this cannot end anyone else's
    // session.
    ...(devinForwarder ? [waitForExit(devinForwarder, "Devin CLI forwarder")] : []),
    ...(cursorEdge ? [waitForExit(cursorEdge, "Cursor public edge")] : []),
    ...(cursorTunnel ? [waitForExit(cursorTunnel, "Cursor named tunnel")] : []),
    superviseGateway({
      label: "LiteLLM gateway",
      child: gateway,
      start: startGateway,
      waitForExit,
      waitForHealth: gatewayHealthy,
      isShuttingDown: () => shuttingDown,
      log: (message) => console.error(`[${frontendService}] ${message}`),
      ...gatewaySupervisorLimits(),
    }),
    waitForExit(router, frontend.label),
  ]);
  if (!shuttingDown) {
    console.error(
      `[${frontendService}] ${result.label} exited (code=${String(result.code)}, signal=${String(result.signal)}).`,
    );
  }
  return result.code || 0;
}

let exitCode = 0;
let serviceProcessRecorded = false;
try {
  // Task Scheduler can report its wscript host as stopped while the detached
  // cmd/node descendants still own every router port. Record the verified
  // start.mjs identity so the Windows service manager can terminate that tree
  // before it launches a replacement. Other platforms keep their native
  // supervisor semantics and do not need this marker.
  if (process.platform === "win32") {
    writeServiceProcessState();
    serviceProcessRecorded = true;
  }
  exitCode = await main();
} catch (error) {
  if (!shuttingDown) {
    const reason = (error instanceof Error && error.message) || String(error);
    console.error(`[model-router] startup failed: ${reason}; inspect the service logs above for details.`);
    exitCode = 1;
  }
} finally {
  stopChildren();
  await Promise.all(children.map((child) => waitForExit(child, "child")));
  if (serviceProcessRecorded) {
    try {
      clearServiceProcessState();
    } catch {
      // A stale record is harmless after the root and its children are gone;
      // the next Windows stop re-validates identity before it can signal one.
    }
  }
}
// All children have exited, so let Node drain its own child-process bookkeeping
// before terminating. A synchronous process.exit() here races libuv's Windows
// async-handle close path and can abort with UV_HANDLE_CLOSING after a child
// fails during startup (for example, an EADDRINUSE forwarder).
process.exitCode = exitCode;
