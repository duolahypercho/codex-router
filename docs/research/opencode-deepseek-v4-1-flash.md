# DeepSeek V4.1 Flash on OpenCode Go

Verified 2026-09-10:

- OpenCode's [Go endpoint table](https://opencode.ai/docs/go/#endpoints) names `deepseek-flash` as DeepSeek V4.1 Flash and routes it to `/zen/go/v1/chat/completions`. This is a separate ID from `deepseek-v4-flash`.
- Read-only `node src/model-discovery.mjs opencode-go` returned the new ID.
- The `opencode-go.models.deepseek-flash` record in [models.dev](https://models.dev/api.json) publishes text/image input, tool calls, interleaved `reasoning_content`, low/high/max effort, a 1,000,000-token context and a 384,000-token output limit. Auto-compaction at 600,000 reserves 400,000 tokens; copying V4 Flash's 900,000 threshold would not reserve the documented output limit.
- A live Chat Completions request at low effort with `tool_choice: required` returned HTTP 400: thinking mode does not support that choice. The same probe with `auto` returned HTTP 200 and a `probe` tool call with the requested `{"value":"ok"}` arguments. The model therefore uses the existing model-scoped `auto-tool-choice` profile.

- A live image-input request using the repository's synthetic invoice fixture returned HTTP 200 and the exact invoice number `INV-7734-QX`.
- Live streaming requests at both high and max effort returned HTTP 200 and the requested response marker. Together with the low-effort tool and image probes, all three advertised effort values were accepted.

Native Codex collaboration certification is not claimed; the entry omits `multiAgentVersion: v2`. Existing V4 Flash remains available. No service lifecycle change is needed to develop or run the isolated regression tests.
