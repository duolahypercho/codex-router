import { isUtf8 } from "node:buffer";
import {
  GROK_STRUCTURED_PATCH_CODEC,
  MAX_STRUCTURED_PATCH_BYTES,
} from "./grok-structured-patch.mjs";
import { isGrokOauthAgenticRoute } from "./grok-oauth-routes.mjs";

export const GROK_PATCH_HOOK_VERSION = 1;
export const GROK_PATCH_HOOK_PREFIX = "CODEX_ROUTER_STRUCTURED_PATCH_V1\n";
export const GROK_PATCH_HOOK_HEADER = "x-codex-router-patch-hook";
export const GROK_PATCH_HOOK_CAPABILITY = "structured-patch-v1";

export function grokPatchHookEnabled(route, headers, environment = process.env, endpointCapability) {
  return isGrokOauthAgenticRoute(route) &&
    environment.CODEX_ROUTER_GROK_PATCH_HOOK === "1" &&
    (headers?.[GROK_PATCH_HOOK_HEADER] === GROK_PATCH_HOOK_CAPABILITY ||
     endpointCapability === GROK_PATCH_HOOK_CAPABILITY);
}

function boundedArguments(input) {
  if (typeof input !== "string") throw new TypeError("patch hook arguments must be a string");
  const bytes = Buffer.from(input, "utf8");
  if (bytes.length > MAX_STRUCTURED_PATCH_BYTES || !isUtf8(bytes) || bytes.toString("utf8") !== input) {
    throw new TypeError("patch hook arguments exceed the bound or contain invalid Unicode");
  }
  return input;
}

export const GROK_PATCH_HOOK_CODEC = {
  ...GROK_STRUCTURED_PATCH_CODEC,
  version: GROK_PATCH_HOOK_VERSION,
  preserveRawArguments: true,
  decodeArguments(argumentsText) {
    return GROK_PATCH_HOOK_PREFIX + boundedArguments(argumentsText);
  },
  encodeHistoryInput(input) {
    if (!input.startsWith(GROK_PATCH_HOOK_PREFIX)) return undefined;
    return boundedArguments(input.slice(GROK_PATCH_HOOK_PREFIX.length));
  },
};
