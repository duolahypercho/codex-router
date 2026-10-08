// Dependency-free on purpose: `upstream-retry.mjs` derives its retry budget
// from this bound, and guided setup loads that module (through the provider
// key pool) before `npm ci` has installed undici. Importing the bound from
// `fetch-transport.mjs` would pull undici in at module load and crash a fresh
// checkout with ERR_MODULE_NOT_FOUND. Keep this file free of npm imports.
//
// A connect attempt is the one upstream failure a retry can always absorb:
// nothing was sent, so replaying the request cannot execute anything twice.
// Undici's 10s default outran the pre-retry budget in `upstream-retry.mjs`,
// which made the connect codes in its retryable set structurally unreachable
// -- the attempt had already spent the budget by the time it failed, so every
// network blip reached Codex as a 502. One incident on 2026-09-21 logged 454
// connect timeouts and zero connect retries, on two machines.
//
// Bound the connect phase below that budget instead, and race the resolved
// addresses rather than serializing one dead anycast IP in front of a healthy
// one. `CODEX_ROUTER_CONNECT_TIMEOUT_MS` overrides the bound; keep it small,
// because the retry budget is derived from it (see `upstream-retry.mjs`).
export const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;
export const MIN_CONNECT_TIMEOUT_MS = 500;
export const MAX_CONNECT_TIMEOUT_MS = 30_000;

export function connectTimeoutMs(environment = process.env) {
  const raw = Number(environment.CODEX_ROUTER_CONNECT_TIMEOUT_MS);
  if (!Number.isFinite(raw)) return DEFAULT_CONNECT_TIMEOUT_MS;
  return Math.min(
    MAX_CONNECT_TIMEOUT_MS,
    Math.max(MIN_CONNECT_TIMEOUT_MS, Math.floor(raw)),
  );
}
