// The agentic grok-oauth routes receive two small V4A examples on the native
// custom apply_patch description before LiteLLM translates that tool into a
// function.
// LiteLLM 1.96 already copies format.definition into the bridged function
// description (wrapped in a Format fence); this module does not compensate for
// a lost grammar and must not rewrite format or format.definition.

import { isGrokOauthAgenticRoute } from "./grok-oauth-routes.mjs";

// The route this guidance was first proven on, kept as a fixture for tests.
// `shouldGuideGrokApplyPatch` is the gate, and it reads the shared list.
export const GROK_APPLY_PATCH_GUIDANCE_ROUTE = "grok-oauth/grok-4.6";
export const APPLY_PATCH_TOOL_NAME = "apply_patch";

export const GROK_APPLY_PATCH_CREATE_EXAMPLE = [
  "*** Begin Patch",
  "*** Add File: notes.txt",
  "+hello",
  "*** End Patch",
].join("\n");

export const GROK_APPLY_PATCH_UPDATE_EXAMPLE = [
  "*** Begin Patch",
  "*** Update File: notes.txt",
  "@@",
  "-hello",
  "+hello world",
  "*** End Patch",
].join("\n");

export const GROK_APPLY_PATCH_GUIDANCE_MARKER =
  "Do not wrap the payload in markdown fences";

export const GROK_APPLY_PATCH_GUIDANCE = [
  "The apply_patch input is raw V4A text. Use these exact delimiters. Do not wrap the payload in markdown fences or any other wrapper:",
  GROK_APPLY_PATCH_CREATE_EXAMPLE,
  GROK_APPLY_PATCH_UPDATE_EXAMPLE,
].join("\n\n");

export function shouldGuideGrokApplyPatch(route) {
  return isGrokOauthAgenticRoute(route);
}

function isNativeCustomApplyPatch(tool) {
  return tool?.type === "custom" && tool.name === APPLY_PATCH_TOOL_NAME;
}

function alreadyGuided(value) {
  return typeof value === "string" && value.includes(GROK_APPLY_PATCH_GUIDANCE);
}

function appendGuidance(prefix) {
  if (typeof prefix !== "string" || prefix.length === 0) return GROK_APPLY_PATCH_GUIDANCE;
  if (alreadyGuided(prefix)) return prefix;
  return prefix.endsWith("\n")
    ? `${prefix}\n${GROK_APPLY_PATCH_GUIDANCE}`
    : `${prefix}\n\n${GROK_APPLY_PATCH_GUIDANCE}`;
}

function annotateNativeApplyPatch(tool) {
  const originalDescription = typeof tool.description === "string" ? tool.description : "";
  if (alreadyGuided(originalDescription)) return tool;
  return { ...tool, description: appendGuidance(originalDescription) };
}

export function applyGrokApplyPatchGuidance(tools, route) {
  if (!shouldGuideGrokApplyPatch(route) || !Array.isArray(tools)) return tools;
  let changed = false;
  const next = tools.map((tool) => {
    if (!isNativeCustomApplyPatch(tool)) return tool;
    const annotated = annotateNativeApplyPatch(tool);
    if (annotated !== tool) changed = true;
    return annotated;
  });
  return changed ? next : tools;
}
