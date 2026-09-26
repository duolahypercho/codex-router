const DEFAULT_LOCAL_TIMEOUT_SECONDS = 600;
const TRANSPORT_MARGIN_MS = 60_000;

export function localTimeoutSeconds(environment = process.env) {
  const raw = environment.MODEL_ROUTER_LOCAL_TIMEOUT;
  if (raw === undefined) return DEFAULT_LOCAL_TIMEOUT_SECONDS;
  if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1) {
    throw new Error("MODEL_ROUTER_LOCAL_TIMEOUT must be a positive integer; received " + JSON.stringify(raw));
  }
  return Number(raw);
}

export function localTransportIdleTimeoutMs(environment = process.env) {
  return localTimeoutSeconds(environment) * 1000 + TRANSPORT_MARGIN_MS;
}
