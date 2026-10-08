import { randomUUID } from "node:crypto";
import { Transform } from "node:stream";

const METADATA = ["provider", "model", "threadId", "parentThreadId", "sessionId", "agentName"];
const STREAM_EVENT_TYPES = new Set([
  "error",
  "response.created", "response.queued", "response.in_progress",
  "response.completed", "response.done", "response.failed", "response.incomplete", "response.error",
  "response.output_item.added", "response.output_item.done",
  "response.content_part.added", "response.content_part.done",
  "response.output_text.delta", "response.output_text.done", "response.output_text.annotation.added",
  "response.refusal.delta", "response.refusal.done",
  "response.reasoning_text.delta", "response.reasoning_text.done",
  "response.reasoning_summary_text.delta", "response.reasoning_summary_text.done",
  "response.reasoning_summary_part.added", "response.reasoning_summary_part.done",
  "response.function_call_arguments.delta", "response.function_call_arguments.done",
  "response.custom_tool_call_input.delta", "response.custom_tool_call_input.done",
]);

// Diagnostics are independent of the tray's expiring presentation records.
// A live request stays live until its handler settles; reading never cancels it.
export function createRequestProgress({ now = Date.now, recentLimit = 128, recentTtlMs = 600_000 } = {}) {
  const active = new Map();
  const recent = [];
  const instanceId = randomUUID();
  let sequence = 0;
  const prune = () => {
    while (recent.length && (recent.length > recentLimit || now() - recent[0].endedAt > recentTtlMs)) {
      recent.shift();
    }
  };
  return {
    begin() {
      const record = {
        requestId: `${instanceId}:${++sequence}`,
        state: "running",
        phase: "unobserved",
        startedAt: now(),
        observationPoint: "router_upstream",
        receivedBytes: 0,
        receivedEvents: 0,
      };
      active.set(record.requestId, record);
      let finished = false;
      const update = (fields) => { if (!finished) Object.assign(record, fields); };
      return {
        requestId: record.requestId,
        setRoute(metadata = {}) {
          for (const key of METADATA) {
            const value = metadata[key];
            if (typeof value === "string" && value.length <= 160) update({ [key]: value });
          }
          if (typeof metadata.isSubagent === "boolean") update({ isSubagent: metadata.isSubagent });
        },
        attempt() {
          if (record.state !== "running") return;
          update({ upstreamAttempts: (record.upstreamAttempts || 0) + 1, phase: "awaiting_upstream", terminalEvent: undefined, terminalStatus: undefined, terminalFailureSeen: undefined });
        },
        headers() {
          update({ lastHeadersAt: now(), ...(record.state === "running" ? { phase: "awaiting_event" } : {}) });
        },
        event(payload) {
          if (!payload || typeof payload !== "object") return;
          const type = payload.type;
          // Metadata-only stream shape for truncated-stream diagnosis
          // (first/last event type, completed seen). Never stores headers,
          // bodies, prompts, tool args, keys, or URLs.
          const safeType = STREAM_EVENT_TYPES.has(type) ? type : undefined;
          let phase;
          if (typeof type === "string" && type.startsWith("response.reasoning")) phase = "reasoning";
          else if (type === "response.output_text.delta") phase = "text";
          else if (type === "response.function_call_arguments.delta" ||
            type === "response.custom_tool_call_input.delta" ||
            ["function_call", "custom_tool_call"].includes(payload.item?.type)) phase = "tool_call";
          else if (["response.completed", "response.failed", "response.incomplete", "error"].includes(type)) phase = "finishing";
          // `response.completed` can carry a failed or incomplete status inside
          // an HTTP 200 stream; the outer event type alone is not success.
          const embeddedStatus = type === "response.completed" ? payload.response?.status : undefined;
          const unsuccessfulCompletion =
            typeof embeddedStatus === "string" && embeddedStatus !== "completed";
          const failed = unsuccessfulCompletion || ["response.failed", "response.incomplete", "error"].includes(type);
          update({
            ...(safeType && !record.firstEventType ? { firstEventType: safeType } : {}),
            ...(safeType ? { lastEventType: safeType } : {}),
            ...(type === "response.completed" && !unsuccessfulCompletion ? { completedSeen: true } : {}),
            ...(failed ? { terminalEvent: type, terminalFailureSeen: true } : {}),
            ...(unsuccessfulCompletion
              ? { terminalStatus: /^[a-z_]{1,32}$/.test(embeddedStatus) ? embeddedStatus : "unknown" }
              : {}),
            lastEventAt: now(),
            receivedEvents: record.receivedEvents + 1,
            ...(record.state === "running" && phase ? { phase } : {}),
          });
        },
        byteObserver() {
          return new Transform({
            transform(chunk, _encoding, callback) {
              update({ lastByteAt: now(), receivedBytes: record.receivedBytes + chunk.length });
              callback(null, chunk);
            },
          });
        },
        cancel(reason) {
          if (record.state !== "running") return;
          if (!["client_disconnected", "execution_deadline"].includes(reason)) return;
          update({ state: "canceling", phase: "canceling", cancelReason: reason, cancelRequestedAt: now() });
        },
        finish(status) {
          if (finished) return;
          const state = status === 0 ? "canceled" : status >= 200 && status < 400 && !record.terminalEvent ? "completed" : "failed";
          update({ state, phase: "settled", status, endedAt: now() });
          finished = true;
          active.delete(record.requestId);
          recent.push({ ...record });
          prune();
        },
      };
    },
    snapshot({ threadId } = {}) {
      prune();
      const matches = (entry) => !threadId || entry.threadId === threadId;
      return {
        version: 1,
        instanceId,
        observedAt: now(),
        // No raw xAI timings, provider-internal retries, or worker lifecycle
        // can be inferred from this local transport observation.
        observationPoint: "router_upstream",
        active: [...active.values()].filter(matches).map((entry) => ({ ...entry })),
        recent: recent.filter(matches).map((entry) => ({ ...entry })),
      };
    },
  };
}
