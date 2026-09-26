- **Grok keeps reasoning through long tool loops.** xAI returns each turn's
  reasoning as an encrypted item that must come back in the next request, and
  the Grok OAuth bridge's Chat hop dropped it. Without it, Grok 4.7 stopped
  reasoning after two or three tool rounds even at `xhigh`, planned in visible
  text instead, and could repeat one progress sentence until someone
  interrupted it. The forwarder now remembers each completed response's
  reasoning and returns it with the matching tool calls. After a restart or an
  eviction it falls back to the old behavior, and
  `CODEX_ROUTER_GROK_REASONING_CARRY=0` turns it off (#888).
