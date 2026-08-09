import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { validCallerSecret } from "./caller-auth.mjs";
import { codexAuthStatus, findCodexBinary } from "./codex-binary.mjs";
import { routedCodexAgentStatus } from "./codex-agent-catalog.mjs";
import { privateFileIsProtected } from "./file-security.mjs";
import { grokCliPreflight } from "./grok-cli.mjs";
import { detectLegacyInstallations } from "./legacy-migration.mjs";
import { PROVIDERS } from "./model-registry.mjs";
import { grokOAuthStatus } from "./grok-oauth-status.mjs";
import { kimiOAuthStatus } from "./oauth-status.mjs";
import { readMultiAgentSettings } from "./multi-agent-state.mjs";
import { readHiddenModels } from "./model-picker-state.mjs";
import { serviceFollowsHostApps } from "./presence-state.mjs";
import { waitForRouterHealth } from "./router-health.mjs";
import {
  CALLER_SECRET_PATH,
  CODEX_AGENTS_DIR,
  CONFIG_PATH,
  INTERNAL_SECRET_PATH,
  LITELLM_CONFIG_PATH,
  MERGED_CATALOG_PATH,
  PORTS,
  SOURCE_ROOT,
} from "./paths.mjs";
import { cliSessionDescriptor } from "./cli-session-credential.mjs";
import { credentialStatus } from "./provider-credentials.mjs";
import { providerNeedsCuration } from "./provider-onboarding.mjs";
import { stateOwnershipStatus } from "./state-owner.mjs";
import {
  providerSelectionStatus,
  selectedConfiguredListedModels,
} from "./provider-selection.mjs";
import { resolveVisionEngine } from "./vision-bridge.mjs";
import { readVisionBridgeSettings } from "./vision-bridge-state.mjs";

const checks = [];
const add = (status, name, detail, fix) => checks.push({ status, name, detail, fix });
const jsonOutput = process.argv.includes("--json");

function readableSecret(target, validator) {
  if (!existsSync(target)) return false;
  try {
    return validator(readFileSync(target, "utf8").trim());
  } catch {
    return false;
  }
}

function childJson(script, args = []) {
  return JSON.parse(
    execFileSync(process.execPath, [path.join(SOURCE_ROOT, "src", script), ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }),
  );
}

function repair() {
  const ownership = stateOwnershipStatus();
  if (
    ownership.foreign &&
    !ownership.overridden &&
    ownership.owner &&
    existsSync(path.join(ownership.owner, "src", "doctor.mjs")) &&
    existsSync(path.join(ownership.owner, "bin", "install"))
  ) {
    // A foreign doctor run must not repoint the live installation by accident.
    // The recorded owner still exists, so run the same repair from there; only
    // an explicit override or a fresh install transfers ownership.
    process.stderr.write(
      `codex-router: repairing from the owning checkout ${ownership.owner}\n`,
    );
    const result = spawnSync(
      process.execPath,
      [path.join(ownership.owner, "src", "doctor.mjs"), ...process.argv.slice(2)],
      { cwd: ownership.owner, env: process.env, stdio: "inherit" },
    );
    if (result.error) {
      throw new Error(
        `Could not run doctor from the owning checkout ${ownership.owner}: ${result.error.message}`,
      );
    }
    process.exit(result.status ?? 1);
  }

  const legacy = detectLegacyInstallations();
  if (legacy.unknownConflict) {
    throw new Error(
      `Another router owns ${legacy.config.modelCatalogJson}; repair will not overwrite it.`,
    );
  }
  if (legacy.installations.length && !process.argv.includes("--migrate-known")) {
    throw new Error(
      `A known older router (${legacy.installations.map((item) => item.id).join(", ")}) was found. Re-run with --fix --migrate-known to snapshot and migrate it.`,
    );
  }
  if (legacy.installations.length) {
    childJson("legacy-migration.mjs", ["apply", "--yes"]);
  }
  const repairStdio = jsonOutput ? ["inherit", "ignore", "inherit"] : "inherit";
  // Repair rebuilds dependencies unconditionally: the fingerprints an ordinary
  // install trusts cannot see a corrupted node_modules or virtual environment.
  const result = process.platform === "win32"
    ? spawnSync(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          path.join(SOURCE_ROOT, "install.ps1"),
          "-CheckoutInstall",
          "-ForceDeps",
        ],
        { cwd: SOURCE_ROOT, env: process.env, stdio: repairStdio },
      )
    : spawnSync(path.join(SOURCE_ROOT, "bin", "install"), ["--force-deps"], {
        cwd: SOURCE_ROOT,
        env: process.env,
        stdio: repairStdio,
      });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Repair installer exited with ${result.status}.`);
}

if (process.argv.includes("--help")) {
  process.stdout.write(`Usage: doctor [--json] [--fix [--migrate-known]]

Checks the complete Codex Router installation without printing credentials.
--fix reinstalls generated files, configuration, and the background service.
Known older routers are migrated only with the explicit --migrate-known flag.
`);
  process.exit(0);
}

if (process.argv.includes("--fix")) {
  try {
    repair();
    if (!jsonOutput) process.stdout.write("Repair completed; verifying the result.\n\n");
  } catch (error) {
    console.error(`codex-router repair: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

const [major, minor] = process.versions.node.split(".").map(Number);
add(
  major > 22 || (major === 22 && minor >= 19) ? "ok" : "fail",
  "Node.js",
  `${process.version}; 22.19 or newer required`,
  "Install Node.js 24 LTS, then run ./bin/doctor --fix.",
);
add(
  ["darwin", "linux", "win32"].includes(process.platform) ? "ok" : "fail",
  "Platform",
  process.platform,
  "Use macOS, Windows, or Linux with the Codex CLI.",
);

const codex = findCodexBinary();
add(
  codex ? "ok" : "fail",
  "Codex binary",
  codex || "not found",
  "Install Codex or set CODEX_BIN to the Codex CLI binary.",
);
// A Codex binary that cannot be spawned reads as "signed out" everywhere it is
// probed, which silently removes every native model from the picker. Surface it
// as its own failure instead of letting it masquerade as a logged-out session.
const codexAuth = codexAuthStatus();
add(
  codexAuth.reason === "probe-failed" ? "fail" : "ok",
  "Codex sign-in probe",
  codexAuth.reason === "probe-failed"
    ? `could not run ${codexAuth.binary} (${codexAuth.code || "spawn failed"})`
    : codexAuth.reason,
  "Set CODEX_BIN to a Codex CLI Node can spawn; on Windows use the codex.cmd shim, not the extensionless one.",
);
add(
  existsSync(CONFIG_PATH) ? "ok" : "fail",
  "Codex config",
  CONFIG_PATH,
  "Start Codex once, then run ./bin/doctor --fix.",
);
const configMode = existsSync(CONFIG_PATH)
  ? statSync(CONFIG_PATH).mode & 0o777
  : undefined;
const configProtected = privateFileIsProtected(CONFIG_PATH);
add(
  configProtected ? "ok" : "fail",
  "Codex config privacy",
  configMode === undefined
    ? "missing"
    : process.platform === "win32"
      ? "current-user Windows ACL"
      : `mode ${configMode.toString(8)}`,
  "Run ./bin/doctor --fix; the managed router URL contains a local caller capability.",
);

let selection = { providers: [], explicit: false };
let requiredRoutedModels = [];
let requiredModels = new Set();
try {
  selection = providerSelectionStatus();
  requiredRoutedModels = selectedConfiguredListedModels();
  requiredModels = new Set(requiredRoutedModels.map((model) => model.slug));
  add(
    selection.providers.length ? "ok" : "fail",
    "Enabled providers",
    selection.providers.length
      ? `${selection.providers.join(", ")}${selection.explicit ? "" : " (legacy show-all mode)"}`
      : "none",
    "Run ./bin/setup --guided and choose at least one provider.",
  );
  // The router no longer refuses to serve on a selection file it cannot fully
  // resolve, so the damage has to be reported here instead of as a 502.
  if (selection.degraded) {
    add(
      "warn",
      "Provider selection file",
      selection.degraded,
      "Run ./bin/setup --guided, or ./bin/providers enable PROVIDER, to rewrite the selection with this build's provider ids.",
    );
  }
} catch (error) {
  add(
    "fail",
    "Enabled providers",
    error instanceof Error ? error.message : String(error),
    "Run ./bin/setup --guided to replace the invalid provider selection.",
  );
}

let catalogModels = [];
try {
  const catalog = JSON.parse(readFileSync(MERGED_CATALOG_PATH, "utf8"));
  catalogModels = Array.isArray(catalog.models) ? catalog.models : [];
} catch {
  // Reported as a failed catalog check below.
}
const catalogOk =
  requiredModels.size > 0 &&
  [...requiredModels].every((slug) => catalogModels.some((model) => model.slug === slug));
add(
  catalogOk ? "ok" : "fail",
  "Merged catalog",
  catalogOk ? `${requiredModels.size} routed models` : MERGED_CATALOG_PATH,
  "Run ./bin/refresh-catalog, or ./bin/doctor --fix if files are missing.",
);
// The catalog tells Codex which models to offer; the gateway config decides
// which it can actually route. When a second checkout writes one of them the
// two drift apart, and Codex forwards the unroutable model upstream, where it
// fails with a confusing account-level error instead of a routing error.
const ownership = stateOwnershipStatus();
add(
  ownership.foreign ? "fail" : "ok",
  "State directory owner",
  ownership.foreign
    ? `owned by ${ownership.owner}, running from ${ownership.current}`
    : ownership.owner || "unowned (first install)",
  "Run router commands from the owning checkout, or reinstall from this one to take ownership.",
);
let unroutable = [];
try {
  const rendered = readFileSync(LITELLM_CONFIG_PATH, "utf8");
  unroutable = requiredRoutedModels
    .filter((model) => !rendered.includes(`model_name: "${model.gatewayModel}"`))
    .map((model) => model.slug);
} catch {
  // The missing-config case is already reported by the gateway config check.
}
add(
  unroutable.length ? "fail" : "ok",
  "Catalog matches gateway routes",
  unroutable.length
    ? `${unroutable.length} offered model(s) have no gateway route: ${unroutable.join(", ")}`
    : `${requiredRoutedModels.length} routed models`,
  "Run ./bin/doctor --fix from the owning checkout, then fully quit and reopen Codex.",
);
// The bridge is opt-in, so "off" is a normal state and reports ok. Enabled
// with no resolvable engine is the broken one: Codex would keep offering the
// paste while nothing could read it, so the catalog drops the advertisement
// and this says why.
const visionSettings = readVisionBridgeSettings();
const visionEngine = resolveVisionEngine(requiredRoutedModels, visionSettings);
if (visionSettings.enabled && !visionEngine) {
  add(
    "warn",
    "Vision bridge",
    visionSettings.engine
      ? `pinned engine ${visionSettings.engine} is not an enabled model that reads images`
      : "enabled, but no enabled provider offers a model that reads images",
    "Enable a provider with a vision model, or run ./bin/model-router codex control vision-bridge engine auto.",
  );
} else if (visionEngine?.local) {
  add(
    "ok",
    "Vision bridge",
    `text-only models read images via a local model (${visionEngine.gatewayModel} at ${visionEngine.baseUrl})`,
    "Make sure the local server is running and the model is pulled, e.g. `ollama pull " +
      `${visionEngine.gatewayModel}\`.`,
  );
} else {
  add(
    "ok",
    "Vision bridge",
    visionEngine ? `text-only models read images via ${visionEngine.slug}` : "off",
    "Run ./bin/model-router codex control vision-bridge on to let text-only models read pasted images.",
  );
}
const agentStatus = routedCodexAgentStatus(requiredRoutedModels);
add(
  agentStatus.ok ? "ok" : "fail",
  "Routed model agents",
  agentStatus.ok
    ? `${agentStatus.current} current definitions in ${CODEX_AGENTS_DIR}`
    : `${agentStatus.current} of ${agentStatus.expected} current definitions in ${CODEX_AGENTS_DIR}`,
  "Run ./bin/doctor --fix, then fully quit Codex, reopen it, and create a new task.",
);
add(
  "ok",
  "Dynamic subagent models",
  (() => {
    const settings = readMultiAgentSettings();
    if (settings.mode === "all") return "all selected models exposed as v2 spawn agents";
    if (settings.mode === "selected") {
      return `${settings.enabled.length} selected model(s) exposed as v2 spawn agents`;
    }
    return "only registry-proven v2 models";
  })(),
  "Run ./bin/multi-agent on to expose every selected model as a subagent.",
);
add(
  "ok",
  "Model picker visibility",
  (() => {
    const hidden = readHiddenModels();
    return hidden.size === 0
      ? "all enabled models visible"
      : `${hidden.size} model(s) hidden from the picker`;
  })(),
  "Change per-model visibility in the desktop Models settings.",
);
add(
  existsSync(LITELLM_CONFIG_PATH) ? "ok" : "fail",
  "Generated gateway config",
  LITELLM_CONFIG_PATH,
  "Run ./bin/doctor --fix.",
);

const secretMode = existsSync(INTERNAL_SECRET_PATH)
  ? statSync(INTERNAL_SECRET_PATH).mode & 0o777
  : undefined;
const internalSecretValid = readableSecret(
  INTERNAL_SECRET_PATH,
  (value) => /^[A-Za-z0-9_-]{32,}$/.test(value),
);
const secretProtected =
  internalSecretValid && privateFileIsProtected(INTERNAL_SECRET_PATH);
add(
  secretProtected ? "ok" : "fail",
  "Internal service key",
  secretMode === undefined
    ? "missing"
    : !internalSecretValid
      ? "invalid"
      : process.platform === "win32"
        ? "current-user Windows ACL"
        : `mode ${secretMode.toString(8)}`,
  "Run ./bin/doctor --fix; this key is generated locally and is not a provider key.",
);

const callerSecretMode = existsSync(CALLER_SECRET_PATH)
  ? statSync(CALLER_SECRET_PATH).mode & 0o777
  : undefined;
const callerSecretValid = readableSecret(CALLER_SECRET_PATH, validCallerSecret);
const callerSecretProtected =
  callerSecretValid && privateFileIsProtected(CALLER_SECRET_PATH);
add(
  callerSecretProtected ? "ok" : "fail",
  "Router caller key",
  callerSecretMode === undefined
    ? "missing"
    : !callerSecretValid
      ? "invalid"
      : process.platform === "win32"
        ? "current-user Windows ACL"
        : `mode ${callerSecretMode.toString(8)}`,
  "Run ./bin/doctor --fix; this capability is generated locally and is not a provider key.",
);

const oauth = kimiOAuthStatus();
add(
  oauth.configured ? "ok" : selection.providers.includes("kimi-oauth") ? "fail" : "warn",
  "Kimi OAuth",
  oauth.configured ? "credential present" : `not configured; ${oauth.setup}`,
  "Run kimi login, then rerun the doctor.",
);
const grokOauth = grokOAuthStatus();
const grokCli = grokCliPreflight();
const grokOauthReady = grokOauth.configured && grokCli.runnable;
add(
  grokOauthReady ? "ok" : selection.providers.includes("grok-oauth") ? "fail" : "warn",
  "Grok OAuth",
  !grokCli.runnable
    ? grokCli.detail
    : grokOauth.configured
      ? grokOauth.source
      : `not configured; ${grokOauth.setup}`,
  !grokCli.runnable ? grokCli.fix : "Run grok login, then rerun the doctor.",
);

for (const provider of PROVIDERS.values()) {
  if (provider.kind !== "openai-compatible") continue;
  const status = credentialStatus(provider, { persistent: true });
  const session = cliSessionDescriptor(provider);
  add(
    status.configured ? "ok" : selection.providers.includes(provider.id) ? "fail" : "warn",
    `${provider.displayName} key`,
    status.configured ? status.source : "not configured",
    session
      ? `Run ${session.loginCommand}, or ./bin/provider-key ${provider.id} set.`
      : `Run ./bin/provider-key ${provider.id} set.`,
  );
  // A credential that resolves says nothing about whether the account's plan
  // may use the API. Only warn once the provider is actually selected, so the
  // doctor does not lecture about providers nobody enabled.
  if (provider.planNote && selection.providers.includes(provider.id)) {
    add("warn", `${provider.displayName} plan`, provider.planNote, "Check the plan on the provider's billing page.");
  }
  // A working key on a catalog-only provider still shows an empty picker until
  // its models are curated, and nothing else says so after the key is stored.
  // Anyone who set a key before that hint existed can only find out here.
  if (status.configured && providerNeedsCuration(provider.id)) {
    add(
      "warn",
      `${provider.displayName} models`,
      "key stored but no models curated; the picker stays empty",
      `Run ./bin/curate-models ${provider.id} in an interactive terminal.`,
    );
  }
}

try {
  const config = childJson("config-manager.mjs", ["status"]);
  add(
    config.mode === "router" ? "ok" : "fail",
    "Codex routing config",
    config.mode,
    "Run ./bin/enable or ./bin/doctor --fix.",
  );
  const providerModeOk = config.login_free
    ? config.login_free_managed
    : !config.provider_mode_state_present;
  add(
    providerModeOk ? "ok" : "fail",
    "Codex login mode",
    config.login_free
      ? config.login_free_managed
        ? "external providers; OpenAI login not required"
        : "unmanaged custom provider"
      : config.provider_mode_state_present
        ? "stale provider-mode restore state"
        : "OpenAI login available",
    "Use the tray toggle to switch modes, or run ./bin/doctor --fix.",
  );
} catch (error) {
  add(
    "fail",
    "Codex routing config",
    error instanceof Error ? error.message : String(error),
    "Inspect ~/.codex/config.toml, then run ./bin/doctor --fix.",
  );
}

const legacy = detectLegacyInstallations();
add(
  legacy.unknownConflict ? "fail" : legacy.installations.length ? "fail" : "ok",
  "Router ownership",
  legacy.unknownConflict
    ? `unknown catalog: ${legacy.config.modelCatalogJson}`
    : legacy.installations.length
      ? `older router: ${legacy.installations.map((item) => item.id).join(", ")}`
      : "no conflicting router detected",
  legacy.installations.length
    ? "Run ./bin/doctor --fix --migrate-known."
    : "Disable the other router manually; Codex Router will not overwrite it.",
);

// When the tray follows the desktop apps it stops the service as soon as Codex
// and ChatGPT are both closed. That is the resting state, not a fault, so it
// must not read as a failure: a `fail` here sets the exit code and sends the
// tray's Fix button down the full repair path for a router that is off on
// purpose.
const followsHostApps = serviceFollowsHostApps();
let serviceLoaded = false;
let serviceStoppedByDesign = false;
try {
  const service = childJson("service.mjs", ["status"]);
  serviceLoaded = Boolean(service.loaded);
  serviceStoppedByDesign = !serviceLoaded && followsHostApps;
  add(
    serviceLoaded ? "ok" : serviceStoppedByDesign ? "warn" : "fail",
    "Background service",
    serviceStoppedByDesign
      ? "stopped; following Codex (open Codex or ChatGPT to start it)"
      : service.state || "stopped",
    "Run ./bin/enable or ./bin/doctor --fix.",
  );
} catch (error) {
  add(
    "fail",
    "Background service",
    error instanceof Error ? error.message : "not available",
    "Run ./bin/doctor --fix.",
  );
}

const health = await waitForRouterHealth({ timeoutMs: serviceLoaded ? 30_000 : 2_000 });
add(
  health.ok ? "ok" : serviceStoppedByDesign ? "warn" : "fail",
  "Router health",
  health.ok
    ? `version ${health.payload.version}`
    : serviceStoppedByDesign
      ? "not serving; the background service is following Codex"
      : `not ready on 127.0.0.1:${PORTS.router} after ${serviceLoaded ? 30 : 2} seconds; ${health.error}`,
  "Run ./bin/doctor --fix. If it still fails, create a support bundle.",
);

if (codex && catalogOk) {
  try {
    const parsed = JSON.parse(
      execFileSync(codex, ["debug", "models"], {
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 32 * 1024 * 1024,
      }),
    );
    const slugs = new Set((parsed.models || []).map((model) => model.slug));
    const visible = [...requiredModels].every((slug) => slugs.has(slug));
    add(
      visible ? "ok" : "fail",
      "Codex model catalog",
      visible ? `${requiredModels.size} routed entries visible` : "startup catalog is stale",
      "Fully quit Codex, reopen it, and create a new task.",
    );
  } catch (error) {
    add(
      "warn",
      "Codex model catalog",
      error instanceof Error ? error.message : String(error),
      "Set CODEX_BIN if Codex is installed in a nonstandard location.",
    );
  }
}

if (jsonOutput) {
  process.stdout.write(`${JSON.stringify({ ok: !checks.some((check) => check.status === "fail"), checks }, null, 2)}\n`);
} else {
  for (const check of checks) {
    process.stdout.write(`${check.status.toUpperCase().padEnd(5)} ${check.name}: ${check.detail}\n`);
    if (check.status === "fail" && check.fix) process.stdout.write(`      Fix: ${check.fix}\n`);
  }
}
if (checks.some((check) => check.status === "fail")) process.exitCode = 1;
