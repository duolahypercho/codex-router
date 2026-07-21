import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Cross-target control plane for a tray/UI (e.g. the pane fork). It reports, for
// every target, which registry models exist and whether each is enabled — the
// data a model-toggle UI needs. Read-only for now; toggle/apply comes next.

const TARGETS = ["codex", "claude", "cursor"];
const args = process.argv.slice(2);
const asJson = args.includes("--json");

// Probe mode: run per-target (with MODEL_ROUTER_TARGET set) and emit that
// target's slice. Kept in one file that re-spawns itself so paths.mjs resolves
// each target's own state directory.
if (args.includes("--probe")) {
  const { TARGET, PROVIDER_SELECTION_PATH } = await import("./paths.mjs");
  const { readProviderSelection } = await import("./provider-selection.mjs");
  const { LISTED_MODELS } = await import("./model-registry.mjs");

  const roleBySlug = {};
  if (TARGET === "claude") {
    const { claudeRoleAssignments } = await import("./claude-role-map.mjs");
    for (const { roleId, model } of claudeRoleAssignments()) roleBySlug[model.slug] = roleId;
  }

  const enabledProviders = readProviderSelection();
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
      enabledProviders,
      models,
    }),
  );
  process.exit(0);
}

const self = fileURLToPath(import.meta.url);
const targets = {};
for (const target of TARGETS) {
  const result = spawnSync(process.execPath, [self, "--probe"], {
    env: { ...process.env, MODEL_ROUTER_TARGET: target },
    encoding: "utf8",
  });
  if (result.status === 0) {
    try {
      targets[target] = JSON.parse(result.stdout);
    } catch {
      targets[target] = { target, error: "probe returned invalid JSON" };
    }
  } else {
    targets[target] = { target, error: (result.stderr || "").trim() || "probe failed" };
  }
}

if (asJson) {
  process.stdout.write(`${JSON.stringify({ targets }, null, 2)}\n`);
} else {
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
