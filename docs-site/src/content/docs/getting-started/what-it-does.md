---
title: "What Codex Router does"
description: "External models inside the coding clients you already use."
---
Use Anthropic, Kimi, DeepSeek, xAI, GitHub Copilot, and other external models
inside the Codex App and CLI. One local installation can also serve
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and
[Gemini CLI](https://github.com/google-gemini/gemini-cli), plus Cursor Agent
and Cursor App, Claude Code, and [OpenClaw](https://github.com/openclaw/openclaw).
Your provider
credentials stay on your computer.

## Subscription agent bridges (experimental)

The Harness page also detects three optional, client-owned agent sessions:
Claude Code, Cursor Agent, and Gemini CLI. These are deliberately separate from
the `codex_router/...` model catalog:

- Claude runs through the installed official `claude` process and its existing
  Claude.ai login. A successful `claude auth status` proves login only; the
  account must separately be entitled to use non-interactive/SDK turns. The
  bridge reports Anthropic's refusal verbatim when it is not.
- Cursor Agent runs through its official ACP stdio server (`agent acp`).
- Gemini CLI runs through its official ACP stdio server (`gemini --acp`).

The router never reads or copies those clients' OAuth tokens. It stores only
bounded metadata for sessions created through the bridge: client, session ID,
workspace path, and timestamps. Prompts and transcripts stay out of the bridge
index. File-system and terminal capabilities are not advertised yet, and
permission requests are rejected by default until the Control Center has a
foreground approval surface.

This is not an OpenAI-compatible subscription proxy. In particular, it does
not implement CLIProxyAPI's token-to-model-endpoint behavior and does not add
fake Claude, Cursor, or Gemini subscription models to another client's picker.

Inspect the optional bridges without spending a model request:

```sh
./bin/model-router codex agents status
./bin/model-router codex agents probe anthropic
./bin/model-router codex agents probe cursor
./bin/model-router codex agents probe gemini
```

Run a prompt only when you intend to spend the owning client's quota. Prompt
text is read from stdin so it is absent from the process list:

```sh
printf '%s' 'Explain this repository.' |
  ./bin/model-router codex agents prompt anthropic --cwd "$PWD"
```

The ACP integrations follow the official [Cursor ACP](https://prod.cursor.com/docs/cli/acp)
and [Gemini CLI ACP](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md)
contracts. Direct reuse of Gemini CLI OAuth tokens in third-party software is
not implemented; Google's published [Gemini CLI terms](https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/tos-privacy.md)
explicitly prohibit that access pattern.

Codex Router is an independent community project. It is not affiliated with or
endorsed by OpenAI, GitHub, Anthropic, Moonshot AI, DeepSeek, OpenRouter,
opencode, Google, or the referenced opencodex project.
