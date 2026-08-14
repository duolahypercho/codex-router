# Local LLMs through Ollama

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

The **View more** panel includes the complete tag inventories captured from the
official Ollama pages for Gemma 4, Qwen 3.5/3.6, Nemotron 3 Super, Ornith,
Nemotron 3, and Muse Glimmer. That includes quantized, MLX, BF16, and other
published variants—not only the family aliases. Cloud aliases are shown for
completeness but are labelled **cloud only** and cannot be downloaded as local
weights. The manifest is a dated snapshot, so arbitrary Ollama tags and model
URLs remain supported even when a newly published tag has not been added yet.
An installed model's generation speed is measured on demand with the **Speed**
button and reported as tokens/second; unmeasured models never receive a guessed
number.

Every model in the catalog is listed and installable, including ones this
machine is rated too small for. The two shortlists above the catalog—the coding
quick picks and the image readers—are recommendations and only show what fits,
but nothing is ever removed from the catalog itself: a model that will not fit
is labelled **won't fit**, and its button reads **Anyway** and asks for
confirmation before spending the gigabytes. Hiding those entries previously left
them with no install path at all on a small machine.

Useful commands:

```text
./bin/control local-models list --json
./bin/control local-models inspect https://ollama.com/library/gemma4:12b
./bin/control local-models install gemma4:12b --yes
./bin/control local-models install gpt-oss:20b --yes --force
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

## LM Studio

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

Downloads rated too large for the machine are stopped unless `--force` is
present; `--yes` alone does not override the fit check, because consenting to
install Ollama is not the same as consenting to a model that will not run. A
single `install <tag> --yes --force` covers both, so a machine with no Ollama
can still install an oversized model in one command.

Checking a model uses one canonical tag. `devstral` and `devstral:latest` are
the same weights, so checking or unchecking through either spelling affects the
same entry, and selection files written by older versions are normalized on the
next write.
