import { selectedListedModels } from "./provider-selection.mjs";

// Claude Desktop only accepts model ids it recognizes as Claude models, so a
// third-party gateway must present the added models under Claude "role" ids and
// map them back to the real upstream. These are the four role slots Claude
// Desktop's third-party schema accepts (each with a labelOverride so the picker
// shows the real model name). This mirrors how cc-switch works.
export const CLAUDE_ROLE_IDS = Object.freeze([
  "claude-sonnet-5",
  "claude-opus-4-8",
  "claude-haiku-4-5",
  "claude-fable-5",
]);

// Deterministically assign selected models to the role slots, highest priority
// first (lower priority number ranks first). Both the config manager and the
// router call this, so they always agree without persisting a mapping.
export function claudeRoleAssignments() {
  const models = [...selectedListedModels()].sort(
    (a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER),
  );
  return models
    .slice(0, CLAUDE_ROLE_IDS.length)
    .map((model, index) => ({ roleId: CLAUDE_ROLE_IDS[index], model }));
}

// Selected models that did not fit into a role slot (Claude Desktop caps at 4).
export function claudeUnmappedModels() {
  const models = [...selectedListedModels()].sort(
    (a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER),
  );
  return models.slice(CLAUDE_ROLE_IDS.length);
}

// Resolve a Claude Desktop role id (or a raw slug, for compatibility) back to
// the registry model it should route to.
export function modelForRoleId(roleId) {
  return claudeRoleAssignments().find((entry) => entry.roleId === roleId)?.model;
}
