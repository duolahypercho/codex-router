- **Generic OpenAI-Responses providers now accept Codex collaboration history.**
  Routed turns and compaction previously forwarded Codex's internal
  `agent_message` item unchanged, so strict Responses-compatible gateways
  rejected delegated-agent conversations with HTTP 400. The router now keeps
  the recovered handoff content but presents it as an ordinary user message at
  the user-registered Responses boundary; built-in provider contracts remain
  unchanged.
