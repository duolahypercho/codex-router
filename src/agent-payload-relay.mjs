// The relay is a new, ordinary Responses request. Caller turn affinity and
// response dialect headers belong to the original Codex request, not this one.
export function agentRelayHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).filter(([name]) =>
    ["authorization", "chatgpt-account-id", "content-type", "accept-encoding"].includes(name.toLowerCase())));
}

export const AGENT_PAYLOAD_RELAY_TOOL = "relay_external_agent_payload";
const FAILURES = {
  rate_limited: [429, "ERR_NATIVE_AGENT_RELAY_RATE_LIMITED", "is rate limited"],
  unauthorized: [401, "ERR_NATIVE_AGENT_RELAY_UNAUTHORIZED", "requires refreshed authentication"],
  upstream_failed: [502, "ERR_NATIVE_AGENT_RELAY_UPSTREAM_FAILED", "failed upstream"],
  incomplete: [502, "ERR_NATIVE_AGENT_RELAY_INCOMPLETE", "ended before completion"],
  invalid_stream: [502, "ERR_NATIVE_AGENT_RELAY_INVALID_STREAM", "returned an invalid response stream"],
  invalid_arguments: [502, "ERR_NATIVE_AGENT_RELAY_INVALID_ARGUMENTS", "returned invalid task arguments"],
  missing_payload: [502, "ERR_NATIVE_AGENT_RELAY_MISSING_PAYLOAD", "omitted the task payload"],
  conflicting_arguments: [502, "ERR_NATIVE_AGENT_RELAY_CONFLICTING_ARGUMENTS", "returned conflicting task arguments"],
  ambiguous_payload: [502, "ERR_NATIVE_AGENT_RELAY_AMBIGUOUS_PAYLOAD", "returned multiple task payloads"],
};
export function agentRelayError(kind) {
  const [status, code, message] = FAILURES[kind] || FAILURES.upstream_failed;
  return Object.assign(new Error(`Native collaboration payload relay ${message}.`), { status, code });
}
function upstreamFailure(event) {
  const code = event?.response?.error?.code ?? event?.error?.code ?? event?.code;
  if (["rate_limit_exceeded", "usage_limit_reached", "insufficient_quota"].includes(code)) return agentRelayError("rate_limited");
  if (["invalid_api_key", "invalid_authentication", "authentication_error", "token_expired"].includes(code)) return agentRelayError("unauthorized");
  return agentRelayError("upstream_failed");
}
function argumentsPayload(value) {
  let args;
  try { args = typeof value === "string" ? JSON.parse(value) : value; } catch { throw agentRelayError("invalid_arguments"); }
  if (!args || typeof args !== "object" || Array.isArray(args) ||
      Object.keys(args).length !== 1 || typeof args.payload !== "string") throw agentRelayError("invalid_arguments");
  return args.payload;
}

// Inspect the entire bounded response before accepting any task. An arguments
// delta is not successful completion, and a later failed terminal wins over a
// plausible earlier payload. Never echo provider error text or task contents.
export function parseAgentRelayResponse(bytes, contentType = "") {
  const text = bytes.toString("utf8");
  const sse = String(contentType || "").toLowerCase().includes("text/event-stream") || /^(?:event|data):/m.test(text);
  if (!sse) {
    let body;
    try { body = JSON.parse(text); } catch { throw agentRelayError("invalid_stream"); }
    if (body?.error) throw upstreamFailure(body);
    body = body?.response || body;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw agentRelayError("invalid_stream");
    if (body.error || body.status === "failed") throw upstreamFailure(body);
    if (body.status !== "completed") throw agentRelayError("incomplete");
    if (!Array.isArray(body.output)) throw agentRelayError("invalid_stream");
    const calls = body.output.filter(i => i?.type === "function_call" && i.name === AGENT_PAYLOAD_RELAY_TOOL);
    if (calls.length !== 1) throw agentRelayError(calls.length ? "ambiguous_payload" : "missing_payload");
    return argumentsPayload(calls[0].arguments);
  }
  const calls = new Map();
  let completed = false;
  const snapshot = (call, argumentsText) => {
    if (typeof argumentsText !== "string") throw agentRelayError("invalid_arguments");
    if (!argumentsText.startsWith(call.arguments || "")) throw agentRelayError("conflicting_arguments");
    call.arguments = argumentsText;
  };
  const remember = item => {
    if (item?.type !== "function_call" || item.name !== AGENT_PAYLOAD_RELAY_TOOL) return;
    const key = item.id || item.call_id;
    if (!key) throw agentRelayError("invalid_stream");
    const previous = calls.get(key);
    const call = { ...previous, ...item, arguments: previous?.arguments || "" };
    if (item.arguments !== undefined) snapshot(call, item.arguments);
    calls.set(key, call);
  };
  for (const block of text.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const data = lines.filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n").trim();
    if (!data || data === "[DONE]") continue;
    let event;
    try { event = JSON.parse(data); } catch { throw agentRelayError("invalid_stream"); }
    if (!event || typeof event !== "object" || Array.isArray(event)) throw agentRelayError("invalid_stream");
    const type = event.type || lines.find(l => l.startsWith("event:"))?.slice(6).trim();
    if (type === "error" || type === "response.failed" || event.response?.status === "failed") throw upstreamFailure(event);
    if (type === "response.incomplete" || event.response?.status === "incomplete") throw agentRelayError("incomplete");
    if (["response.output_item.added", "response.output_item.done"].includes(type)) remember(event.item);
    if (["response.function_call_arguments.delta", "response.function_call_arguments.done"].includes(type)) {
      const call = [...calls.values()].find(i => event.item_id === i.id || event.call_id && event.call_id === i.call_id);
      if (call && type === "response.function_call_arguments.done") snapshot(call, event.arguments);
      else if (call) {
        if (typeof event.delta !== "string") throw agentRelayError("invalid_arguments");
        call.arguments += event.delta;
      }
    }
    if (type === "response.completed") {
      if (event.response?.status !== undefined && event.response.status !== "completed") throw agentRelayError("incomplete");
      completed = true;
      if (event.response?.output !== undefined && !Array.isArray(event.response.output)) throw agentRelayError("invalid_stream");
      for (const item of event.response?.output || []) remember(item);
    }
  }
  if (!completed) throw agentRelayError("incomplete");
  if (calls.size !== 1) throw agentRelayError(calls.size ? "ambiguous_payload" : "missing_payload");
  return argumentsPayload([...calls.values()][0].arguments);
}
