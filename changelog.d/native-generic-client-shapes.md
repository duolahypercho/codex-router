- **A generic Responses client can reach native GPT models with a string
  `input` or without `stream: true` (#862).** ChatGPT's backend answered both
  with a bare 400 (`Input must be a list`, `Stream must be set to true`) that
  named neither the model nor the requirement. For a caller whose session the
  router substitutes, a string input is now sent as one user message, and a
  non-streaming request is streamed upstream and folded back into a single JSON
  response. Codex turns, which carry their own credential, are relayed exactly
  as before.
