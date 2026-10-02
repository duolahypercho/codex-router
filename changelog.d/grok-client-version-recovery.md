- **Grok OAuth recovers from failed CLI version probes.** Read the installed
  CLI version lazily with the shared cross-platform launcher, cache successful
  probes briefly, and retry failed probes on the next request. Never send the
  Router version as the Grok CLI version: this caused persistent HTTP 426
  refusals after a transient startup failure. Unavailable CLI versions now
  produce an actionable local error before contacting xAI.
