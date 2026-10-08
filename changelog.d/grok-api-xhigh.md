- **`grok-api/grok-4.7` now receives the `xhigh` effort it advertises.** The
  xAI API forwarder clamped every effort outside low/medium/high to `high`, so
  picking `xhigh` for Grok 4.7 silently ran at `high`. The profile now keeps
  the rungs the model itself declares; Grok 4.5, which stops at `high`, still
  clamps `xhigh` to `high`.
