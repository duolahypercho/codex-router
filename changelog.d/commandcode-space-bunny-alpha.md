- **Space Bunny Alpha is available through Command Code.** The provider catalog
  advertises `stealth/space-bunny-alpha`; Codex Router exposes it as
  `commandcode/stealth/space-bunny-alpha` with text and image input, a 1M-token
  context, and verified medium/max reasoning effort.

  The model was initially curated as text-only. A live probe against the
  Command Code endpoint confirmed it accepts image input, so it is declared
  `["text", "image"]` and can be pinned as a vision engine. The identical model
  on OpenRouter already declared both modalities.
