# OpenCode catalog refresh — 2026-08-21

Primary sources:

- Go documentation and endpoint table: https://opencode.ai/docs/go/
- Go live catalog: https://opencode.ai/zen/go/v1/models
- Zen documentation, endpoint table, free pricing, and deprecations: https://opencode.ai/docs/zen
- Zen live catalog: https://opencode.ai/zen/v1/models
- OpenCode Zen model metadata (`opencode` provider): https://models.dev/api.json

The anonymous `opencode-free` provider remains catalog-only. Its live Zen
catalog currently exposes these nine IDs through the router's documented
`big-pickle` or `-free` filter:

`big-pickle`, `deepseek-v4-flash-free`, `hy3-free`,
`laguna-s-2.1-free`, `mimo-v2.5-free`,
`muse-spark-1.2-contributor-free`, `nemotron-3-ultra-free`,
`nemotron-3.5-lightning-free`, and `x-preview-f-free` (documented by OpenCode
as **Ox Alpha Free**).

Ox Alpha is a stealth model: OpenCode publishes its callable id and display
name but not its maker. The control center therefore uses the OpenCode provider
mark instead of guessing a model-company logo from community speculation.

Zen also remains catalog-only because it is pay-as-you-go and its list changes
without notice. Both catalogs are fetched by `discover-models` / `curate-models`
from their official `/models` endpoints; the repository does not turn their
live contents into an implicit provider selection.

The Zen `/models` records currently contain `id`, `object`, `created`, and
`owned_by` and no context limit for any model — re-verified 2026-08-23 against
`https://opencode.ai/zen/v1/models` (HTTP 200, 64 records). The OpenCode Zen
metadata record publishes `1,048,576` for Muse Contributor Free and
`1,000,000` for Ox Alpha Free. Scripted curation uses those values only for
the two exact ids instead of the generic 131K fallback; if Zen later publishes
a served context limit in `/models`, that live value takes precedence.

Those two numbers are the **free route's** cap, not the underlying model's
nominal window. OpenCode's metadata keys `limit` per free id and publishes a
smaller window whenever the free route is throttled below the paid one:
`deepseek-v4-flash` is `1,000,000` against `deepseek-v4-flash-free`'s
`200,000`, and `minimax-m3` is `512,000` against `minimax-m3-free`'s
`200,000`. Against that baseline, `muse-spark-1.2-contributor-free` matching
its paid twin at `1,048,576` is an affirmative statement that the free route is
not throttled, and `x-preview-f-free` has no paid Ox counterpart anywhere in
the catalog for a model-level figure to have leaked in from — its record is
the only Ox record there is. `curatedSizing` derives `autoCompact` at 0.85,
leaving 157,287 and 150,000 tokens of headroom against each id's published
`131,072` output limit, so compaction fires before a completion can overrun
the declared window. Because these are not conservative defaults, curation
also stores the sourcing in each entry's `description`, the way
`config/zai/coding/glm-5.3.json` records its probe evidence. Neither figure
was confirmed by a live inference probe; no probe was run, because one would
spend the anonymous free quota this catalog documents as revocable.

The other seven anonymous free ids stay on the conservative 131K default even
though OpenCode's metadata sizes them too. That is deliberate scope, not an
oversight: only the two ids this change actually routes were reviewed, and an
understated window costs compaction rather than a failed turn.

The anonymous endpoint table is model-specific:
`muse-spark-1.2-contributor-free` uses `/responses`, while Ox Alpha Free
(`x-preview-f-free`) uses `/chat/completions`. Local OpenCode Free curation
therefore stores only that exact Muse Contributor Free ID on an internal
Responses variant and leaves Ox and every other free ID on the existing Chat
Completions route. The variant accepts no other anonymous model ID and shares
the base provider's selection.

The paid `/zen` catalog and the subscription `/zen/go` catalog are separate
server surfaces with separate billing semantics. This change deliberately does
not add a paid Zen variant or alter the existing Go/Zen selection, routes,
gateway model IDs, or cooldown scopes. Migration of an older Chat-routed free
Muse entry occurs only inside an explicit `curate-models opencode-free` run;
the same run upgrades the exact generic `131072` / `110000` sizing pair on
these two ids while preserving any user-tuned value. Install, update, registry
load, and catalog discovery remain read-only.

The Go documentation names 20 current subscription models. The checked-in
registry contains those exact upstream IDs and uses the endpoint family the
official table specifies (`chat/completions`, `messages`, or `responses`). The
2026-08-21 addition is `muse-spark-1.2-contributor` on Responses.

The live Go `/models` response also contained seven IDs not in the
documentation's current-model list. They are intentionally not advertised as
checked-in Go models:

| Live-only ID | Reason not shipped |
| --- | --- |
| `minimax-m2.5` | The Zen documentation marks it deprecated on 2026-08-05. |
| `kimi-k2.5` | The Zen documentation marks it deprecated on 2026-08-05. |
| `glm-5` | The Zen documentation marks it deprecated on 2026-05-14. |
| `qwen3.5-plus` | Not in the Go documentation's current-model or Go endpoint table. |
| `mimo-v2-pro` | Not in the Go documentation's current-model or Go endpoint table. |
| `mimo-v2-omni` | Not in the Go documentation's current-model or Go endpoint table. |
| `hy3-preview` | Not in the Go documentation's current-model or Go endpoint table. |

A future refresh should update this table if the official current-model list
adopts one of those IDs.

OpenCode's statement that its models work well as coding agents is useful
provider evidence for routing, but it is not the native Codex collaboration
proof required for `multiAgentVersion: "v2"`. Every OpenCode model therefore
stays conservative v1 unless that separate marker-return, encrypted relay, and
same-thread follow-up proof is completed.
