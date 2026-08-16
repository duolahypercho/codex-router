# Verifying the Devin CLI provider (`bin/devin-probe`)

This page is for someone who has a Devin account and is willing to spend about
five minutes and a few cents of ACU credit settling a question no maintainer of
this repository can answer.

You do not need to know this codebase. You will not install the router, start a
service, change any configuration, or hand over a credential. The probe reads
the session file the official Devin CLI already wrote, talks to Cognition
directly, prints a checklist, and exits.

## Why this needs you

The Devin CLI provider drives Cognition's models over **Cascade**, a Connect RPC
surface Cognition has not documented. Everything the provider knows about that
surface — the protobuf field numbers, the service path, the authorization
header, the stream framing — was transcribed out of the shipped `devin` binary.
It has never spoken to Cognition's backend.

The unit tests prove the translation is self-consistent. They cannot prove the
upstream agrees with it. One run of this probe against a real account does.

## What it costs

| Command | Cost |
| --- | --- |
| `./bin/devin-probe` | Nothing. Reads your session file, re-reads the request the router would send, and asks your account which models it may run. |
| `./bin/devin-probe --live` | One short turn. Output is capped at 64 tokens. |
| `./bin/devin-probe --live --tools` | The same one short turn, with a tool call forced. |

`--live` is the only flag that spends anything, and the turn it runs is capped
by `--max-tokens` (default 64) and abandoned after `--timeout` seconds
(default 90). Nothing else in the probe reaches a billable endpoint.

## Before you start

You need the official CLI installed and signed in:

```sh
curl -fsSL https://cli.devin.ai/install.sh | bash   # or: brew install --cask devin-cli
devin auth login
```

You also need Node.js 22.19 or newer (`node --version`).

## Run it

```sh
git clone https://github.com/duolahypercho/codex-router
cd codex-router
git fetch origin feat/devin-cli-provider feat/issue-270-devin-probe-hardening
git checkout feat/devin-cli-provider
git merge --no-edit origin/feat/issue-270-devin-probe-hardening
npm install

./bin/devin-probe                  # free
./bin/devin-probe --live --tools   # one short turn of ACU credit
```

If the merge reports a conflict in `src/devin-cli-probe.mjs`, take this
branch's version and continue — it is the newer probe:

```sh
git checkout --theirs src/devin-cli-probe.mjs && git add src/devin-cli-probe.mjs && git commit --no-edit
```

Once both branches have landed on `main`, the two `git fetch`/`git merge` lines
above are unnecessary; a plain checkout of `main` is enough.

Add `--model <uid>` to test a specific model from the list the free run printed.
`--json` prints the same checklist as machine-readable JSON.

## Reading the output

Every assumption gets its own line. `PASS` and `FAIL` are the ones that matter;
`INFO` lines are context, and `SKIP` means a check was not attempted.

A healthy `--live --tools` run looks like this:

```text
PASS  devin cli session: read from ~/.local/share/devin/credentials.toml
INFO  cascade host: server.codeium.com
PASS  request encoding: 11 field(s) written, 321 bytes, all on their declared wire types
PASS  model list: 6 enabled model(s) decoded, each with a model_uid
INFO  entitlement flags: 4 premium, 1 beta, 1 standard
INFO  model: swe-1  (premium)
INFO  live response: http=200 content-type=application/connect+proto
PASS  stream framing: 4 message frame(s) read from the response body
PASS  frame compression: no frame carried the compressed flag
PASS  end-of-stream terminator: clean terminator, no error carried
PASS  turn produced output: 13 content char(s), 11 reasoning char(s), 1 tool call(s)
INFO  stop reason: upstream stop reason 10
PASS  usage accounting: prompt 120, completion 9
PASS  served model: upstream confirmed swe-1
PASS  tool calls decoded: 1 tool call(s): ping
PASS  tool call ids: every tool call carried an id the forwarder can key on
PASS  tool call arguments: every tool call carried parseable JSON arguments
PASS  transport replay: the shipped transport reproduced all 4 message(s) from the captured bytes

VERDICT PASS — 13 pass, 0 fail, 0 warn, 0 skipped
```

The last line is the summary. `PASS` means every assumption held.
`PARTIAL` means everything attempted held but something was skipped — a free run
always ends `PARTIAL`, because it never tried a turn. `FAIL` means at least one
assumption is wrong, and `INCONCLUSIVE` means the run never reached anything
worth reporting.

## What each failure means

Failures carry an `observed:` line with the value that actually came back, and
usually a `fix:` line. Those two lines are the useful part — please include them.

| Line | What it means |
| --- | --- |
| `FAIL devin cli session` | The probe could not read `credentials.toml`. Run `devin auth login` again. Nothing was sent. |
| `FAIL request encoding` | A defect in this repository's own encoder, found before anything was sent. Nothing to do with your account. |
| `FAIL model list … connect-code=unauthenticated` | Either your session expired, or the `Basic <token>-<token>` authorization scheme this build sends is wrong. Both are worth knowing. |
| `FAIL model list … connect-code=unimplemented` | The service path or method name is wrong. Not your account's fault. |
| `FAIL model list: the account advertised no usable model` | The response arrived but nothing in it decoded to a model. If the `observed:` line names `UNKNOWN` fields, the field numbers have moved. If it says the response decoded to nothing, your plan may entitle no Cascade model. |
| `FAIL live turn … connect-code=invalid_argument` | The request shape is wrong. The upstream's message usually names the offending field — paste it verbatim, it is the single most useful thing in this document. |
| `FAIL live turn … connect-code=permission_denied` or `failed_precondition` | Often a team setting (`disable_cascade`, `allowed_model_uids`) rather than a bug. Please say which plan you are on. |
| `FAIL stream framing` | The upstream accepted the request and then sent no message frame. |
| `FAIL frame compression` | The upstream compressed the stream even though both the probe and the transport ask for `connect-accept-encoding: identity`. This transport cannot decompress; it refuses such a frame outright (`devin_compressed_frame`), so every turn would fail loudly rather than answer. Say which encoding the upstream used. |
| `FAIL stream completeness` | The connection died part-way through a frame. |
| `FAIL end-of-stream terminator` | A Connect stream reports failure *inside* its last frame, after HTTP 200 has already been sent. This line is that failure. |
| `FAIL turn produced output` | Frames arrived and decoded to no text, no reasoning and no tool call. Check the `field census` line for `UNKNOWN` entries. |
| **`FAIL tool calls decoded: … dropped on the wire, not declined by the model`** | The most important failure here. The upstream said it made a function call and this build decoded none, which means tool calls are being lost in translation. Codex drives every turn through tool calls, so this decides whether the provider is usable at all. |
| `FAIL tool calls decoded: … the model declined a forced tool choice` | The transport is fine; this model would not call a tool when told to. Worth trying another `--model` before concluding anything. |
| `FAIL tool call ids` | Tool calls arrived without ids. The forwarder keys restatements by id, so without them a restated call would be dispatched twice. |
| `FAIL transport replay` | The bytes the upstream sent are read differently by the client the router actually runs than by the probe's own reader. A bug in this repository. |

## What to paste back

At the end of a text run the probe prints a fenced block beginning
` ```text `. **Copy that whole block, fences included, into
[issue #270](https://github.com/duolahypercho/codex-router/issues/270).** It
carries the checklist plus your Node version, platform and `devin` CLI version,
which is what makes the result reproducible.

Also worth adding in your own words:

1. **Your plan type** — Core, Team, or Enterprise. `allowed_model_uids` and
   `disable_cascade` are team settings that can refuse the whole thing.
2. **Whether the model list looks right** to you, compared with what the Devin
   CLI or IDE offers you.
3. Anything the probe printed that surprised you.

A failure is as useful as a success. The `observed:` lines are what tell us
which assumption was wrong.

## What the probe does and does not print

Its output is written to be pasted in public, so:

- It never prints your API token.
- It folds your home directory back to `~`.
- It prints the Cascade **host** only, never a full URL with a path.
- It records protobuf field numbers and byte counts, never field contents —
  the exception is `model said:`, which echoes the first 200 characters of the
  fixed test prompt's answer, and the tool-call arguments, which are `{"value":1}`
  from the probe's own tool.

It reads `credentials.toml` and never writes, moves, copies or deletes it.

## For maintainers

The probe is deliberately split so that most of it is testable without an
account:

| File | Role |
| --- | --- |
| `src/protobuf-audit.mjs` | Reads protobuf bytes without a schema and classifies every field against one. This is what makes a renumbered field loud instead of silent. |
| `src/connect-stream-audit.mjs` | Connect envelope framing, the compression flag, the end-of-stream terminator, and the full Connect code → HTTP status table. |
| `src/probe-report.mjs` | The PASS/FAIL checklist, the verdict, and the paste block. |
| `src/devin-probe-checks.mjs` | Every judgement the probe makes, as pure functions over plain observations. |
| `src/devin-cli-probe.mjs` | The I/O: reads the session, fetches, frames, and hands observations to the above. |

`test/devin-cli-probe.test.mjs` runs the whole probe against a fabricated
provider and a fabricated upstream, including the dropped-tool-call case, so the
wiring is exercised in CI on machines with no Devin account and no provider
sources.
