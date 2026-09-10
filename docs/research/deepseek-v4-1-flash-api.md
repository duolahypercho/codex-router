# DeepSeek V4.1 Flash direct API — 2026-09-10

## Sources

- DeepSeek model-list contract: https://api-docs.deepseek.com/api/list-models/
- DeepSeek API quick start: https://api-docs.deepseek.com/
- DeepSeek model details and pricing: https://api-docs.deepseek.com/quick_start/pricing/
- DeepSeek Responses API integration: https://api-docs.deepseek.com/quick_start/agent_integrations/codex/
- DeepSeek API change log: https://api-docs.deepseek.com/updates/

## Findings

The configured DeepSeek API account's live `/models` response included the
model ID `deepseek-flash` on 2026-09-10. The public documentation currently
describes the same V4 Flash API family as `deepseek-v4-flash`; the existing
`deepseek/deepseek-v4-flash` route is therefore preserved rather than renamed.
This fragment adds only the live ID and does not infer a second provider or
replace the documented route.

DeepSeek documents an OpenAI-compatible base URL at
`https://api.deepseek.com`, Responses API support, tool calls, and a V4 Flash
context/output envelope of 1M/384K. The live `deepseek-flash` catalog record
does not expose capability metadata, so the checked-in route deliberately uses
conservative text-only 131,072-token sizing and reserves 21,072 tokens for
output compaction instead of copying undocumented limits onto the new ID.

The exact route was exercised through the router with the stored provider
credential and failover disabled. Basic response, streaming, forced tool
call, stateless tool-result replay, and compaction all returned HTTP 200.
Thinking mode was also probed: its stateless tool-result replay returned HTTP
400 because the upstream required `reasoning_content` to be echoed. The route
therefore uses the existing `deepseek-nonthinking` request profile and exposes
only the `minimal` effort. No image input, standalone search, native v2
subagent certification, or reasoning-summary capability is claimed.

The filename `deepseek-v4.1-flash.json` sorts after the existing
`deepseek-v4-*` fragments. That preserves the established login-free fallback
on `deepseek/deepseek-v4-flash` while making the live `deepseek-flash` ID
available as a separate picker entry.
