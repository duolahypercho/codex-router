- **Compaction no longer dies on gateways that refuse non-streaming requests.**
  The compaction summarizer was sent with `stream: false`, and some generic
  OpenAI-Responses gateways reject that with `400 Stream must be set to true`;
  because Codex retries compaction before each following turn, a conversation
  could never take another turn once its context filled. Compaction on generic
  providers now streams like ordinary turns, the terminal `response.completed`
  event is unwrapped into the same response shape the non-streaming path
  parsed, and a gateway that ends the stream without a terminal event gets its
  answer rebuilt from the accumulated output-text deltas plus the last-seen
  usage. A failed or incomplete terminal is classified as a failed attempt and
  flows through the same failover, cooldown, and metering handling as any
  other upstream rejection.
