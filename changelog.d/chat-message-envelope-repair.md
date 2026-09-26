- **Codex no longer logs `OutputTextDelta without active item` on routed
  Chat Completions turns that start with reasoning.** LiteLLM's bridge streamed
  the assistant's answer after a reasoning item without opening a message item,
  and on the reasoning item's own output index. OpenRouter hit this on every
  reasoning turn (seen live on `mimo-v2.6-flash` and
  `stealth/space-bunny-alpha`). The final answer still arrived, but Codex had
  no item to attach the deltas to. The message-envelope repair that already
  covered Z.ai now runs on every Chat Completions route. It relays unchanged
  events and invalid UTF-8 byte-for-byte.
