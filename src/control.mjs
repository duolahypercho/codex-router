import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Cross-target control plane for a tray/UI (e.g. the planned pane fork). It
// reads which registry models are enabled per target and toggles them. Toggling
// only rewrites each target's provider selection; making it live is a separate
// explicit `apply`, so a toggle never silently restarts a running target.

const TARGETS = ["codex", "claude", "cursor"];
const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), "..");
const args = process.argv.slice(2);

function targetIsActive(target) {
  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, "src", "service.mjs"), "status"], {
    env: { ...process.env, MODEL_ROUTER_TARGET: target },
    encoding: "utf8",
  });
  try {
    const status = JSON.parse(result.stdout);
    return Boolean(status.installed || status.loaded);
  } catch {
    return false;
  }
}

function optionValue(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

// --- per-target probes (run with MODEL_ROUTER_TARGET set) -------------------

async function emitProbe() {
  const { TARGET, PROVIDER_SELECTION_PATH } = await import("./paths.mjs");
  const { readProviderSelection } = await import("./provider-selection.mjs");
  const { LISTED_MODELS } = await import("./model-registry.mjs");

  const roleBySlug = {};
  if (TARGET === "claude") {
    const { claudeRoleAssignments } = await import("./claude-role-map.mjs");
    for (const { roleId, model } of claudeRoleAssignments()) roleBySlug[model.slug] = roleId;
  }

  const enabledProviders = readProviderSelection();
  const usageEvents = TARGET === "codex"
    ? (await import("./usage-events.mjs")).recentUsageEvents()
    : [];
  const models = LISTED_MODELS.map((model) => ({
    slug: model.slug,
    displayName: model.displayName,
    provider: model.provider,
    gatewayModel: model.gatewayModel,
    enabled: enabledProviders.includes(model.provider),
    ...(roleBySlug[model.slug] ? { claudeRole: roleBySlug[model.slug] } : {}),
  }));

  process.stdout.write(
    JSON.stringify({
      target: TARGET,
      configured: existsSync(PROVIDER_SELECTION_PATH),
      active: targetIsActive(TARGET),
      enabledProviders,
      models,
      ...(TARGET === "codex" ? { usageEvents } : {}),
    }),
  );
}

async function emitProbeSet(provider, desired) {
  const { TARGET } = await import("./paths.mjs");
  const { readProviderSelection, writeProviderSelection } = await import("./provider-selection.mjs");
  const { PROVIDERS } = await import("./model-registry.mjs");
  if (!PROVIDERS.has(provider)) throw new Error(`Unknown provider: ${provider}`);
  if (desired !== "on" && desired !== "off") throw new Error("state must be on or off");

  const current = readProviderSelection();
  const next =
    desired === "on"
      ? current.includes(provider)
        ? current
        : [...current, provider]
      : current.filter((id) => id !== provider);
  writeProviderSelection(next);
  process.stdout.write(JSON.stringify({ target: TARGET, enabledProviders: next }));
}

// --- aggregate over all targets --------------------------------------------

function probeTargets() {
  const targets = {};
  for (const target of TARGETS) {
    const result = spawnSync(process.execPath, [SELF, "--probe"], {
      env: { ...process.env, MODEL_ROUTER_TARGET: target },
      encoding: "utf8",
    });
    try {
      targets[target] = result.status === 0 ? JSON.parse(result.stdout) : { target, error: (result.stderr || "").trim() || "probe failed" };
    } catch {
      targets[target] = { target, error: "probe returned invalid JSON" };
    }
  }
  return targets;
}

function printOverview(asJson) {
  const targets = probeTargets();
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ targets }, null, 2)}\n`);
    return;
  }
  for (const target of TARGETS) {
    const slice = targets[target];
    if (slice.error) {
      process.stdout.write(`\n${target}: ${slice.error}\n`);
      continue;
    }
    process.stdout.write(`\n${target}${slice.configured ? "" : " (not set up)"}:\n`);
    for (const model of slice.models) {
      const mark = model.enabled ? "x" : " ";
      const role = model.claudeRole ? ` -> ${model.claudeRole}` : "";
      process.stdout.write(`  [${mark}] ${model.displayName}${role}\n`);
    }
  }
}

function runSet(provider, desired) {
  const requested = optionValue("--targets");
  const selected = requested ? requested.split(",").map((value) => value.trim()) : TARGETS;
  for (const target of selected) {
    if (!TARGETS.includes(target)) throw new Error(`Unknown target: ${target}`);
    const result = spawnSync(process.execPath, [SELF, "--probe-set", provider, desired], {
      env: { ...process.env, MODEL_ROUTER_TARGET: target },
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(`${target}: ${(result.stderr || "").trim() || "toggle failed"}`);
    }
  }
  process.stderr.write(
    `Set ${provider} ${desired} for: ${selected.join(", ")}. Run \`bin/control apply\` to make it live.\n`,
  );
  printOverview(args.includes("--json"));
}

// Re-apply pending selection changes, but only to targets that are already
// active (installed service). Never installs a target that isn't set up.
function runApply() {
  const requested = optionValue("--targets");
  const selected = requested ? requested.split(",").map((value) => value.trim()) : TARGETS;
  const applied = [];
  const skipped = [];
  for (const target of selected) {
    if (!TARGETS.includes(target)) throw new Error(`Unknown target: ${target}`);
    if (!targetIsActive(target)) {
      skipped.push(target);
      continue;
    }
    const result = spawnSync(path.join(REPO_ROOT, "bin", "enable"), [], {
      env: { ...process.env, MODEL_ROUTER_TARGET: target },
      stdio: "inherit",
    });
    if (result.status !== 0) throw new Error(`${target}: apply failed`);
    applied.push(target);
  }
  process.stderr.write(
    `Applied: ${applied.join(", ") || "none"}. Skipped (not active): ${skipped.join(", ") || "none"}.\n`,
  );
}

async function printAccountUsage() {
  const { readCodexAccountUsage } = await import("./codex-account-usage.mjs");
  process.stdout.write(`${JSON.stringify(await readCodexAccountUsage(), null, 2)}\n`);
}

// --- dispatch ---------------------------------------------------------------

if (args.includes("--probe")) {
  await emitProbe();
} else if (args[0] === "--probe-set") {
  await emitProbeSet(args[1], args[2]);
} else if (args[0] === "set") {
  if (!args[1] || !args[2]) throw new Error("Usage: control set <provider> <on|off> [--targets ...]");
  runSet(args[1], args[2]);
} else if (args[0] === "apply") {
  runApply();
} else if (args[0] === "account") {
  await printAccountUsage();
} else {
  printOverview(args.includes("--json"));
}
