- **Four OpenCode Go models can now be curated.** `curate-models opencode-go`
  refused `gpt-6-luna`, `claude-haiku-5-5`, `minimax-m3.1-flash` and
  `kimi-k3.1-pro` because the router had not recorded which wire each speaks.
  OpenCode Go's catalog names exactly one per model, so they now route to
  Responses, Messages, Chat Completions and Chat Completions respectively. Each
  is an explicit entry: `minimax-m3` stays on Messages while
  `minimax-m3.1-flash` is Chat, so a family prefix would misroute one of them.
