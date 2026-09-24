---
title: "Local models"
description: "Curate and route models served from your own machine."
---
Codex Router treats Ollama as a managed, headless local runtime. The model
files remain in Ollama's store; the router only keeps selection, download
progress, benchmark, and catalog state under `~/.codex/codex-router`.

From the tray, open **Model settings → Local LLMs** and click **Download** on a
suggestion, or paste either form into the tag field:

```text
gemma4:12b
https://ollama.com/library/gemma4:12b
```

The click starts `ollama serve` detached from the UI. If the Ollama CLI is
missing, the router runs the official installer only as part of that explicit
install action (`brew install ollama` when Homebrew is available; otherwise the
official installer with `OLLAMA_NO_START=1` and native administrator
authorization on macOS, PolicyKit or an interactive terminal on Linux, or
WinGet on Windows). It never opens the Ollama chat window. A pull completes in the
background, then a tool-capable model is checked on and published to Codex.
The tray shows a persistent status card immediately—checking fit, preparing
Ollama, pulling layers, and then ready or failed—so a long download never looks
like a dead click.
While a pull or removal is active, that card includes **Cancel**. Cancellation
stops the exact detached worker (including its child process on Windows), clears
the operation card, and leaves the model in its last completed state. The
router keeps a private cancellation marker so a worker that is still unwinding
cannot resurrect its progress.
Repeated clicks or concurrent commands reuse the existing operation; they do
not start a second Ollama pull or removal.

The native macOS tray's **View more** panel and the Windows/Linux panel's
**Discover Ollama** section include the complete tag inventories captured from
the official Ollama pages for Gemma 4, Qwen 3.5/3.6/3.8, Nemotron 3 Super,
Ornith, Nemotron 3, and Muse Glimmer. They also include the Ollama-compatible
Unsloth GGUF variants of GLM-5.3 and GLM-5.3-Flash. That includes quantized,
MLX, BF16, and other published variants—not only the family aliases. Cloud
aliases are shown for completeness but are labelled **cloud only** and cannot
be downloaded as local weights. The manifest is a dated snapshot, so arbitrary
Ollama tags and ollama.com model URLs remain supported even when a newly
published tag has not been added yet.
An installed model's generation speed is measured on demand with the **Speed**
button and reported as tokens/second; unmeasured models never receive a guessed
number.

Every model in the catalog is listed and installable, including ones this
machine is rated too small for. The two shortlists above the catalog—the coding
quick picks and the image readers—are recommendations and only show what fits,
but nothing is ever removed from the catalog itself. A model that will not fit
is labelled **won't fit**; acknowledge **Allow a model larger than the router
recommends for this machine** before selecting it. The install still asks for
confirmation before spending the gigabytes.

Useful commands:

```text
./bin/control local-models list --json
./bin/control local-models inspect https://ollama.com/library/gemma4:12b
./bin/control local-models install gemma4:12b --yes
./bin/control local-models install gpt-oss:20b --yes --force
./bin/control local-models cancel gemma4:12b
./bin/control local-models benchmark gemma4:12b
./bin/control local-models runtime status
./bin/control local-models runtime start
./bin/control local-models runtime update --yes
```

`install` takes two independent consent flags, and they combine:

| Flag | Consents to |
| --- | --- |
| `--yes` | installing and starting Ollama itself, headlessly, when it is missing |
| `--force` | downloading a model rated too large for this machine's memory or disk |

Checking or unchecking a model refreshes the picker and gateway routes and
restarts the router service, so the newly published `local/...` route is served
by the process already running in the background. Foreground/dev routers have
no service to restart; restart them by hand after toggling.

Updating Ollama is explicit. A normal model install reuses the installed
runtime and does not replace it behind the user's back.

# LM Studio

LM Studio is supported as a separate local OpenAI-compatible backend. It can
run alongside Ollama; models use the stable `lmstudio/<model-id>` namespace so
identical model IDs from the two backends remain distinct.

Start LM Studio's local server, enable the provider, and curate the models
reported by its `/v1/models` endpoint:

```text
./bin/model-router codex providers enable lmstudio
./bin/curate-models lmstudio
```

The default endpoint is `http://127.0.0.1:1234/v1`. Override it with
`MODEL_ROUTER_LMSTUDIO_BASE_URL`. LM Studio models use the generic Chat
Completions path; Ollama continues using its native route and context handling.

The desktop companion and browser panel list the models LM Studio is currently
serving under Local LLMs, and checking one publishes it to the picker without
the interactive terminal:

```text
./bin/control local-models list            # includes the LM Studio section
./bin/control local-models lmstudio-set <model-id> on|off
```

Both doors write the same user-model overlay, so a model curated in the
terminal can be unchecked in the panel and vice versa. Loading and unloading
the weights stays in LM Studio; the checkbox only controls whether the model
is offered in the picker.

## Qwen3.8 27B Uncensored MLX

The supported one-command path installs the 4-bit MLX weights from
`orcarouter/Qwen3.8-27B-Uncensored-MLX`, loads them into LM Studio with a stable
API identifier and a 32,768-token context, starts the loopback-only server, and
publishes `lmstudio/qwen38-27b-uncensored-mlx` to Codex:

```text
./bin/control local-models mlx-install --yes   # detached one-click UI path
./bin/control local-models mlx-status
./bin/control local-models mlx-cancel

./bin/model-router codex local-mlx install --yes
./bin/local-mlx status
```

The native macOS tray and Electron control center expose the detached path as
an **Install and add to Codex** button. That click is explicit consent to fetch
and run the official per-user LM Studio/llmster and `uv` installers when either
prerequisite is missing, download about 15 GB of weights, and publish the
verified route. Both surfaces poll the same private operation record, show each
phase, allow cancellation and retry, and refuse to overlap an Ollama model
mutation. MLX installation is offered only on Apple Silicon Macs; the backend
enforces the same restriction before it downloads or executes anything.

You can also supply the repository URL explicitly:

```text
./bin/model-router codex local-mlx install \
  https://huggingface.co/orcarouter/Qwen3.8-27B-Uncensored-MLX --yes
```

The upstream repository contains separate nested `2-bit/`, `4-bit/`, `6-bit/`,
and `8-bit/` trees. The command deliberately downloads only `4-bit/**` with the
official Hugging Face CLI run through `uvx`, stores it under the router's private
state directory, and gives LM Studio that exact directory. It does not use the
router's universal Python lock. The direct `bin/local-mlx` CLI expects `lms`
and `uvx` to exist and stops with their official installation locations when
they do not. The tray/control-center path may install those two official
prerequisites only after the operator clicks the consent-bearing install
button; tokens are never accepted by either UI.

A 27B model at 4-bit is a sensible fit for a 64 GB Apple Silicon machine; the
weights, runtime, 32K KV cache, Codex prompt, and normal application headroom
all share unified memory. Smaller-memory machines may load it with heavy memory
pressure or fail LM Studio's resource guardrails.

This is an uncensored/abliterated community model. Treat its output as
untrusted: it may ignore safety constraints, produce offensive material, or
confidently suggest destructive code. Keep LM Studio bound to `127.0.0.1` and
review every proposed command or patch before running it.

If Hugging Face reports that the repository is missing, private, or gated,
authenticate with the official Hugging Face CLI used by this command, then
retry. The router never asks for, reads, copies, logs, or forwards your Hugging
Face token.

After installation, fully quit every Codex window and process, reopen Codex,
create a new task, and select `lmstudio/qwen38-27b-uncensored-mlx`. Model size
and a tool template do not prove that it can reliably drive a coding agent. Run
the real Codex agent check, which uses a scratch workspace and requires two
successful tool-using runs:

```text
node src/agent-check.mjs lmstudio/qwen38-27b-uncensored-mlx
```

Only a `2/2` agent verdict should be treated as evidence that this model can
operate Codex tools consistently.

Downloads rated too large for the machine are stopped unless `--force` is
present; `--yes` alone does not override the fit check, because consenting to
install Ollama is not the same as consenting to a model that will not run. A
single `install <tag> --yes --force` covers both, so a machine with no Ollama
can still install an oversized model in one command.

Checking a model uses one canonical tag. `devstral` and `devstral:latest` are
the same weights, so checking or unchecking through either spelling affects the
same entry, and selection files written by older versions are normalized on the
next write.
