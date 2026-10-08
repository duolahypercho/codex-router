- **DeepSeek V4 Pro on the direct API can run at Low reasoning.** The route
  advertised only High and Max, so the Codex picker could not select the
  lower-effort rung even though DeepSeek documents low/high/max for the V4 family
  and the router already forwarded `low` unchanged. It now offers Low, High,
  and Max like the V4 Flash routes; High stays the default. `compHash`
  advances so catalog publication updates the entry.
