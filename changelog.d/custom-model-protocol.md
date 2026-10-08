- **Custom models can select their own API protocol.** Set `endpoint.protocol`
  to `openai`, `anthropic`, or `openai-responses`; omitting it keeps Chat
  Completions. Registry endpoint validation, gateway configuration, and the API
  forwarder now use that model's protocol while retaining per-model credentials.
