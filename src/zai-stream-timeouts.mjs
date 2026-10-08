// Coding Plan reasoning can pause longer than the prelude hold. Keep its
// post-reasoning idle deadline below the shared transport/client idle bounds;
// changing this deadline must not extend the headers-only prelude or parser.
export const DEFAULT_ZAI_CODING_STREAM_STALL_MS = 180_000;
export const MAX_ZAI_CODING_STREAM_STALL_MS = 240_000;

export function zaiCodingStreamStallMs(environment = process.env) {
  const configured = Number(environment.CODEX_ROUTER_ZAI_CODING_STREAM_STALL_MS);
  return Number.isInteger(configured) &&
    configured > 0 &&
    configured <= MAX_ZAI_CODING_STREAM_STALL_MS
    ? configured
    : DEFAULT_ZAI_CODING_STREAM_STALL_MS;
}

export function serviceZaiCodingStreamEnvironment(environment = process.env) {
  if (!Object.hasOwn(environment, "CODEX_ROUTER_ZAI_CODING_STREAM_STALL_MS")) return {};
  return { CODEX_ROUTER_ZAI_CODING_STREAM_STALL_MS: String(zaiCodingStreamStallMs(environment)) };
}
