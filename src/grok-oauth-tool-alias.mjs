import { isGrokOauthAgenticModel } from "./grok-oauth-routes.mjs";

export const CODEX_VIEW_IMAGE_TOOL = "view_image";
export const GROK_VIEW_IMAGE_TOOL = "inspect_image";

export function shouldAliasViewImageForGrok(chat) {
  // The agentic Grok OAuth models stop without a call when xAI receives this
  // function under the native Codex name, even when tool_choice is required. A
  // dedicated alias selects normally; keep the rewrite request-scoped so a real
  // client tool already named inspect_image retains its own identity.
  if (!isGrokOauthAgenticModel(chat?.model)) return false;
  const names = new Set(
    (Array.isArray(chat?.tools) ? chat.tools : [])
      .filter((tool) => tool?.type === "function")
      .map((tool) => tool.function?.name)
      .filter(Boolean),
  );
  return names.has(CODEX_VIEW_IMAGE_TOOL) && !names.has(GROK_VIEW_IMAGE_TOOL);
}

export function toolNameForGrok(name, { viewImageAlias = false } = {}) {
  return viewImageAlias && name === CODEX_VIEW_IMAGE_TOOL
    ? GROK_VIEW_IMAGE_TOOL
    : name;
}

export function toolNameForCodex(name, { viewImageAlias = false } = {}) {
  return viewImageAlias && name === GROK_VIEW_IMAGE_TOOL
    ? CODEX_VIEW_IMAGE_TOOL
    : name;
}
