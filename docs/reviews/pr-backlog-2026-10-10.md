# PR backlog review, 2026-10-10

Compared all nine open PRs with main `b7c2e371e10a86c335f101b9b385be9cfeeca38c`.
Reviewed incoming hunks, consumers, failure paths and the adapted implementation.
The installed router and its unrelated work were not changed.

| PR | Decision and resulting behavior |
| --- | --- |
| [#999](https://github.com/duolahypercho/codex-router/pull/999) | Adapt. Optional GLM-5.3 prose repetition detection cancels upstream and emits one terminal error without replay. No checked-in route enables the heuristic. Structured/tool/reasoning output is excluded; the existing input goal guard remains. |
| [#997](https://github.com/duolahypercho/codex-router/pull/997) | Adapt. Align Devin metadata and share tool-call accumulation between forwarder and probe. Unnamed fragments append; repeated named snapshots emit only their new suffix. Incompatible snapshots fail instead of duplicating arguments. |
| [#979](https://github.com/duolahypercho/codex-router/pull/979) | Adapt after repairing handshake verification, cancellation, stream settlement, pool ownership, credential affinity and late-frame poisoning. Pool full normalized Responses requests behind the canonical pipeline. Native transport remains opt-in; fallback occurs before sending only. |
| [#976](https://github.com/duolahypercho/codex-router/pull/976) | Adapt as catalog-only AIML integration. Filter chat-completion records for both identities and metadata, including duplicate IDs. Use local measured traffic and a dashboard link. Omit commercial attribution, unverified presets and the incompatible quota parser. |
| [#967](https://github.com/duolahypercho/codex-router/pull/967) | Reject the direct edge relay. It bypasses canonical model/tool/image processing and loses connection-local continuation affinity. The accepted transport reuses connections; it does not claim incremental payload optimization. |
| [#920](https://github.com/duolahypercho/codex-router/pull/920) | Adopt scoped Claude model/effort controls with pre-spawn validation and an offline replay utility. Prompts stay on stdin and permission/tool defaults stay intact. Historical replay results do not establish current live dispatch or subscription savings. |
| [#897](https://github.com/duolahypercho/codex-router/pull/897) | Adapt route-local standalone search, behavior template and existing instruction overlay. Retain the 400K compaction threshold and v2 hash; omit unsupported threshold increases and shared-overlay changes. |
| [#856](https://github.com/duolahypercho/codex-router/pull/856) | Adapt the remaining timeout defect: an inconclusive typed venv probe proceeds to bounded actual readiness. Real interpreter failure remains fatal. Existing configurable budgets supersede blanket increases; do not relax ACL failures or exceed restart ownership barriers. |
| [#749](https://github.com/duolahypercho/codex-router/pull/749) | Prepare a safe download path but keep it disabled until a verified Developer ID Team ID is pinned in code. Pin the official repository, reject ambiguous checksums and escaping links, verify signatures before metadata, preserve staging, bound subprocesses and clean temporary files. Missing assets/source mismatch fall back to local builds. The original branch's unpinned signer, repository override, symlink handling and release coupling are not accepted. |

## Verification

Implementation preceded one final test-authoring phase. Contributor tests were
adapted in that phase, and one new combined E2E entrypoint runs the accepted
scenarios through real router/forwarder/CLI processes and independent local
protocol peers:

```sh
node --test --test-timeout=300000 test/pr-backlog-e2e.test.mjs
npm run check
npm test
```

The E2E checks streaming/nonstreaming parity, tool arguments, public HTTP and
WebSocket routing, pre-send fallback, post-send failure without duplicate
generation, malformed handshakes/metadata, queued/connecting cancellation,
old signals and late frames after reuse, bounded pools and slow readers,
startup timeout continuation and failure accounting, and installer integrity,
trust ordering, fallback and cleanup. Fixtures use isolated state and no paid
provider requests. Apple signing/network services are mocked for installer
flow tests; archive extraction is real on macOS.

Final command results are recorded in the integrating PR. The untouched-main
baseline had 5,195 tests: 5,153 passed, 39 skipped and three failures in the
installed-Codex login-free app-server test (the parent and two version subtests
observed two requests instead of one). Keep this environmental baseline
separate from regressions introduced by this change.

## Evidence boundaries

- No public project signer was available. macOS download exits with local-build
  fallback before networking; signed release production and Xcode-free
  installation are not established. Configure and verify the signer and release
  credentials, then exercise a real signed universal bundle before activation.
- Local native Swift testing is blocked by Command Line Tools lacking the
  `Testing` module; no full Xcode installation was found. Hosted macOS CI is
  required for native build/test evidence.
- Paid AIML/Devin/native-provider inference, live desktop deferred-tool replay
  and native Windows execution were not performed locally.
- Repetition detection is an opt-in heuristic and may reject intentional
  repeated prose. It stays disabled by default.
- Generic routes configured for WebSocket conservatively disable empty-result
  repair even when a turn falls back to HTTP. This avoids ambiguous replay.
- AIML's [official model-list documentation](https://docs.aimlapi.com/api-references/service-endpoints/complete-model-list)
  identifies `/v1/models` as canonical (`/models` is an alias); ordinary base URL
  handling is retained. Public catalog metadata is not live inference proof.
