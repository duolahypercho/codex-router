- **A screenshot-heavy conversation can no longer stall on a provider's image
  ceiling.** The 20MB / 128K-token image budget only ran on ordinary routed
  turns, so a conversation that reached auto-compaction sent every image it
  held to the summarizer. On OpenRouter that failed with `413 Downloaded image
  content cannot exceed 30MB`, and because Codex retries compaction before each
  following turn, the session could never take another turn. Every
  provider-bound request (turns, failover hops, compaction) now goes through
  one reduction step that applies the budget, and a provider that still
  refuses the image content is sent the same request again with half the
  images, oldest first, up to twice. The newest two images are always kept,
  each resend is logged, and the image counts are recorded on the usage event.
