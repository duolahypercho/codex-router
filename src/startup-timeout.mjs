// Startup-only timeout allowances for slow hosts. Keep each ceiling at the
// largest previously selected allowance and do not let service rendering
// change a consumer's shipped default when an override is absent.
const STARTUP_TIMEOUT_MAX_MS = Object.freeze({
  CODEX_ROUTER_VENV_PROBE_TIMEOUT_MS: 300_000,
  CODEX_ROUTER_VENV_PROBE_RETRY_TIMEOUT_MS: 300_000,
  CODEX_ROUTER_WINDOWS_PROCESS_PROBE_TIMEOUT_MS: 900_000,
  CODEX_ROUTER_WINDOWS_PRIVATE_SYNC_TIMEOUT_MS: 900_000,
  CODEX_ROUTER_STARTUP_HEALTH_TIMEOUT_MS: 300_000,
  CODEX_ROUTER_GATEWAY_HEALTH_TIMEOUT_MS: 900_000,
});

// These knobs cover process-start and boot-health waits only — never API
// request, inference, retry, gateway-liveness, or steady-state timeouts.
export function startupTimeoutMs(name, fallbackMs, env = process.env) {
  const raw = env?.[name];
  if (raw === undefined || raw === null) return fallbackMs;
  const maxMs = STARTUP_TIMEOUT_MAX_MS[name];
  if (maxMs === undefined) return fallbackMs;
  const value = String(raw).trim();
  if (!/^\d+$/.test(value)) return fallbackMs;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maxMs) return fallbackMs;
  return parsed;
}

// Service definitions carry only valid operator-supplied overrides. In
// particular, omitting an override leaves the consumer's shipped default in
// effect instead of baking a VDI-specific allowance into every installation.
export function serviceStartupTimeoutEnvironment(environment = process.env) {
  const overrides = {};
  for (const name of Object.keys(STARTUP_TIMEOUT_MAX_MS)) {
    if (!Object.hasOwn(environment ?? {}, name)) continue;
    const milliseconds = startupTimeoutMs(name, undefined, environment);
    if (milliseconds !== undefined) overrides[name] = String(milliseconds);
  }
  return overrides;
}

export function runtimeChildEnvironment(env) {
  return clearStartupTimeouts({ ...env });
}

export function clearStartupTimeouts(env) {
  // Windows preserves environment-key spelling even though lookup is
  // case-insensitive. A spread copy is a plain object, so remove every
  // spelling before it becomes a runtime child's native environment.
  for (const name of Object.keys(env)) {
    if (Object.hasOwn(STARTUP_TIMEOUT_MAX_MS, name.toUpperCase())) delete env[name];
  }
  return env;
}
