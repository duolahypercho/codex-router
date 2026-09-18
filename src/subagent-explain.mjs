import { existsSync } from "node:fs";
import path from "node:path";

import { routedAgentDefinition } from "./codex-agent-catalog.mjs";
import {
  applyMultiAgentCapabilities,
  readMultiAgentSettings,
  subagentEffort,
} from "./multi-agent-state.mjs";
import { subagentProofSnapshot } from "./subagent-proofs.mjs";
import { VERSION } from "./version.mjs";

// Why a route cannot be spawned as a subagent, answered before anything is
// spent finding out (#804).
//
// The three states a route can be in were each observable only somewhere else:
// selection in `subagents status`, promotion in the published catalog, and the
// agent definition on disk. Nothing joined them, so the question an operator
// actually has -- "can Codex delegate to this model, and if not, what do I
// do?" -- had no answer short of spawning one and reading `codex exited 1`.
//
// This is deliberately read-only and quota-free. Per rule 6 of
// docs/SUBAGENT-CERTIFICATION.md a control must produce the result its label
// implies: `explain` reports, so it promotes nothing and probes nothing.

// Ordered. The first blocker is the one worth acting on -- enabling a provider
// for a model that is also switched off just moves the operator to the next
// refusal, so the fixes are reported as a sequence rather than a set.
export const SUBAGENT_BLOCK_CODES = Object.freeze([
  "unknown_route",
  "provider_disabled",
  "model_hidden",
  "explicitly_off",
  "not_selected",
  "agent_definition_missing",
]);

function blocker(code, summary, fix) {
  return Object.freeze({ code, summary, fix });
}

/**
 * @param slug            the `provider/model` route being asked about
 * @param models          the routed models this install knows (registry + user)
 * @param providerEnabled (providerId) => boolean
 * @param hidden          slugs hidden in the picker
 * @param reasoningLevels the effort ladder this model advertises
 * @param agentsDir       `$CODEX_HOME/agents`
 */
export function explainSubagentRoute({
  slug,
  models = [],
  providerEnabled = () => true,
  hidden = new Set(),
  reasoningLevels = [],
  agentsDir,
  settings = readMultiAgentSettings(),
  proofs = subagentProofSnapshot(),
  routerVersion = VERSION,
} = {}) {
  const route = String(slug || "").trim();
  const blocks = [];
  const notes = [];

  const model = models.find((candidate) => String(candidate?.slug || "") === route);
  if (!model) {
    // Say which half is wrong. A typo and an unloaded user model need
    // different things, and "unknown model slug" says neither.
    const prefix = route.includes("/") ? route.slice(0, route.indexOf("/")) : "";
    const providerKnown = prefix
      ? models.some((candidate) => String(candidate?.provider || "") === prefix)
      : false;
    blocks.push(blocker(
      "unknown_route",
      prefix && providerKnown
        ? `${prefix} is a known provider, but it serves no model called ${route.slice(prefix.length + 1)}.`
        : `${route || "(empty)"} is not a routed model this install knows.`,
      providerKnown
        ? `Run ./bin/curate-models ${prefix} to add it, or ./bin/control subagents status to see the routes you have.`
        : "Run ./bin/model-router codex providers list --json to see the routes you have. A subagent model is a routed provider/model slug, never a native one.",
    ));
    return summarize(route, blocks, notes, { agentName: null, effort: undefined, reasoningLevels });
  }

  const providerId = String(model.provider || "");
  if (!providerEnabled(providerId)) {
    blocks.push(blocker(
      "provider_disabled",
      `${providerId} is not enabled, so nothing routes to ${route} at all.`,
      `Run ./bin/model-router codex providers enable ${providerId}.`,
    ));
  }

  if (hidden.has(route)) {
    // Hidden is checked before selection because it wins over every mode, so
    // reporting "not selected" first would send the operator to a switch that
    // cannot take effect.
    blocks.push(blocker(
      "model_hidden",
      `${route} is hidden in the model picker, and a hidden model is never offered as a subagent.`,
      `Unhide it in the Control Center's model list, or with ./bin/control picker set ${route} show.`,
    ));
  }

  const disabled = new Set(settings.disabled || []);
  if (disabled.has(route)) {
    blocks.push(blocker(
      "explicitly_off",
      `${route} is switched off as a subagent, which beats every mode including "all".`,
      `Run ./bin/control subagents set ${route} on.`,
    ));
  }

  // The one resolver the catalog, the agents directory, and doctor all use, so
  // this answer cannot disagree with what gets published.
  const [resolved] = applyMultiAgentCapabilities([model], settings, {
    hidden,
    proofs,
    routerVersion,
  });
  const eligible = resolved?.multiAgentVersion === "v2";

  if (!eligible && !disabled.has(route) && !hidden.has(route)) {
    blocks.push(blocker(
      "not_selected",
      settings.mode === "proven"
        ? `Subagent mode is "proven", which offers only routes the registry certified, and ${route} is not one of them.`
        : `${route} has not been selected as a subagent.`,
      `Run ./bin/control subagents set ${route} on, then fully quit and reopen Codex.`,
    ));
  }

  const agentName = eligible ? routedAgentDefinition(model).agentName : null;
  if (eligible && agentsDir) {
    const definition = routedAgentDefinition(model);
    if (!existsSync(path.join(agentsDir, definition.fileName))) {
      // Codex spawns by name out of this directory. A route promoted in state
      // with no file on disk is the exact shape of "the switch did nothing".
      blocks.push(blocker(
        "agent_definition_missing",
        `${route} is promoted, but Codex has no agent definition for it to spawn by name.`,
        "Run node src/catalog.mjs to republish, then fully quit and reopen Codex.",
      ));
    }
  }

  const configuredEffort = subagentEffort(route);
  if (configuredEffort && reasoningLevels.length && !reasoningLevels.includes(configuredEffort)) {
    // Not a blocker: the turn still runs, the provider just refuses the rung.
    notes.push({
      code: "effort_unsupported",
      summary: `The subagent effort "${configuredEffort}" is not on this model's ladder (${reasoningLevels.join(", ")}).`,
      fix: `Run ./bin/control subagents effort ${route} default, or pick a level it advertises.`,
    });
  }

  if (eligible) {
    // Where the v2 claim came from decides how much it is worth, and the
    // difference is the whole subject of docs/SUBAGENT-CERTIFICATION.md.
    const proof = proofs?.[route];
    if (model.multiAgentVersion === "v2") {
      notes.push({
        code: "certified_in_registry",
        summary: `${route} ships certified: a reviewed native-collaboration proof for this exact route is checked in.`,
      });
    } else if (proof?.verified) {
      notes.push({
        code: "verified_locally",
        summary: `${route} passed all five collaboration checks on this machine.`,
      });
    } else {
      notes.push({
        code: "selected_not_certified",
        summary:
          `${route} is offered because you selected it, which is a statement of intent rather than `
          + "evidence that it can hold Codex's native child role. Streaming and tool calls do not "
          + "prove delegation works.",
        fix: `To gather that evidence, run ./bin/control subagents certify ${route}. It spends real quota on this route's provider and on a native parent turn.`,
      });
    }
  }

  return summarize(route, blocks, notes, {
    agentName,
    effort: configuredEffort,
    reasoningLevels,
  });
}

function summarize(slug, blocks, notes, { agentName, effort, reasoningLevels }) {
  // Sorted into the documented order rather than discovery order, so the fix
  // an operator is told to do first is the one that unblocks the rest.
  const ordered = [...blocks].sort(
    (a, b) => SUBAGENT_BLOCK_CODES.indexOf(a.code) - SUBAGENT_BLOCK_CODES.indexOf(b.code),
  );
  return {
    slug,
    spawnable: ordered.length === 0,
    agentName: ordered.length === 0 ? agentName : null,
    blockers: ordered,
    notes,
    effort: {
      configured: effort ?? null,
      supported: reasoningLevels,
    },
  };
}

// The same answer as one line of prose, for a terminal. `--json` keeps the
// structure above for the Control Center and for scripts.
export function formatSubagentExplanation(explanation) {
  const lines = [];
  if (explanation.spawnable) {
    lines.push(`${explanation.slug} can be spawned as a subagent (agent name: ${explanation.agentName}).`);
  } else {
    lines.push(`${explanation.slug} cannot be spawned as a subagent.`);
  }
  for (const blocker of explanation.blockers) {
    lines.push(`  - ${blocker.summary}`);
    if (blocker.fix) lines.push(`    ${blocker.fix}`);
  }
  for (const note of explanation.notes) {
    lines.push(`  note: ${note.summary}`);
    if (note.fix) lines.push(`    ${note.fix}`);
  }
  if (explanation.effort.configured) {
    lines.push(`  Child turns run at reasoning effort "${explanation.effort.configured}".`);
  } else if (explanation.spawnable) {
    lines.push("  Child turns use the model's own default reasoning effort "
      + `(set one with ./bin/control subagents effort ${explanation.slug} <level>).`);
  }
  return lines.join("\n");
}
