// xAI returns each turn's reasoning as an opaque `encrypted_content` item, and
// Grok keeps reasoning across a tool loop only when that item comes back in the
// next request. The Chat Completions hop through LiteLLM cannot carry it, so
// without this store every later turn arrives with no reasoning history, and
// grok-4.7 stops reasoning after two or three tool rounds.
//
// The forwarder remembers the certified reasoning items of a completed
// response under the call IDs of the tool calls that response made. Those IDs
// return verbatim in the next Chat request, so the items can be put back in
// front of the same calls. A miss (restart, eviction, rewritten history) falls
// back to the previous behavior; nothing is invented.
export const REASONING_CARRY_DEFAULTS = Object.freeze({
  maxEntries: 4_096,
  ttlMs: 6 * 60 * 60_000,
});

export function reasoningCarryEnabled(env = process.env) {
  return env.CODEX_ROUTER_GROK_REASONING_CARRY !== "0";
}

// Encrypted reasoning belongs to the model that produced it. Codex can switch
// Grok models mid-thread without changing the conversation's first messages, so
// the store scope includes the model: a turn on another model misses and sends
// no reasoning rather than replaying bytes that model never produced.
export function reasoningCarryScope(conversationKey, model) {
  if (!conversationKey) return undefined;
  return `${typeof model === "string" ? model : ""}\0${conversationKey}`;
}

export function certifiedReasoningItems(items) {
  return (items || [])
    .filter((item) => item?.type === "reasoning" && typeof item.encrypted_content === "string" && item.encrypted_content)
    .map((item) => ({
      type: "reasoning",
      id: item.id,
      summary: Array.isArray(item.summary) ? item.summary : [],
      encrypted_content: item.encrypted_content,
    }));
}

export function createReasoningCarryStore(options = {}) {
  const o = { ...REASONING_CARRY_DEFAULTS, ...options };
  const entries = new Map();
  const counters = { stored: 0, hits: 0, misses: 0, evicted: 0 };
  const key = (sessionId, callId) => `${sessionId}\0${callId}`;
  const prune = (now) => {
    for (const [k, v] of entries) {
      if (entries.size <= o.maxEntries && v.expiresAt > now) break;
      entries.delete(k);
      counters.evicted++;
    }
  };
  return {
    remember(sessionId, callIds, reasoningItems, now = Date.now()) {
      if (!sessionId || !reasoningItems?.length) return;
      const anchor = (callIds || []).find(Boolean);
      if (!anchor) return;
      const k = key(sessionId, anchor);
      entries.delete(k);
      entries.set(k, { items: reasoningItems, expiresAt: now + o.ttlMs });
      counters.stored++;
      prune(now);
    },
    recall(sessionId, callIds, now = Date.now()) {
      const anchor = (callIds || []).find(Boolean);
      if (!sessionId || !anchor) return undefined;
      const entry = entries.get(key(sessionId, anchor));
      if (!entry || entry.expiresAt <= now) {
        counters.misses++;
        return undefined;
      }
      counters.hits++;
      return entry.items;
    },
    stats() {
      return { entries: entries.size, ...counters };
    },
  };
}
