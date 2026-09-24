# v2 agent application: `deepseek/deepseek-v4.1-flash`

## Route

- Routed slug: `deepseek/deepseek-v4.1-flash`
- Upstream model ID: `deepseek-flash` (route config: `gatewayModel = deepseek-v4-1-flash`)
- Provider endpoint: DeepSeek API (origin only; no capability recorded)
- Router version and test date: router 0.5.1, 2026-09-14

## Evidence

Outcome summaries only. No raw prompts, response bodies, encrypted payloads,
API keys, bearer tokens, or caller URLs are recorded here.

| Check | Result | Redacted summary |
| --- | --- | --- |
| Official model identity | passed (local) | The provider's own catalog endpoint (`api.deepseek.com/models`) lists the exact upstream id `deepseek-flash`, which matches this route's `upstreamModel` in `config/deepseek/deepseek-v4.1-flash.json`. The catalog returns two ids in total: `deepseek-flash` and `deepseek-v4-pro`. |
| Streaming Responses | passed (local) | A streamed turn through the installed router completed with status 200 and a terminal completion event on 2026-09-14. |
| Forced function call | passed (local) | A forced shell tool call returned the requested tool name with valid JSON arguments and the exact marker string once. |
| Encrypted relay | pending | Requires a native Codex parent delegating to this route; not possible while the route is v1. |
| Marker-return spawn | pending | Same prerequisite as the encrypted relay check. |
| Same-thread follow-up | pending | Same prerequisite as the encrypted relay check. |

## Limits and reviewer reproduction

This route is currently declared `multiAgentVersion: v1` by the registry, so a
native Codex parent cannot delegate to it. Checks 4-5 therefore cannot be run on
this machine until the route is exposed as a v2 candidate.

Minimal reproduction for a reviewer with a DeepSeek account:

1. Install the router with the DeepSeek provider enabled and this route selected.
2. Run one streamed turn and confirm a normal completion event.
3. Force a single tool call and confirm the requested tool name with valid JSON
   arguments and an exact marker return.
4. Nominate the route for the native collaboration probe, then delegate a child
   from a native Codex parent and confirm the exact marker return.
5. Send a same-thread follow-up to that child and confirm the second marker.

Status stays `draft`; no v2 claim is made by this file.
