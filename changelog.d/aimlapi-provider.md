- **AI/ML API is available as an API-key provider.** `aimlapi` ships twelve
  routes (GPT-6.1 Sol, GPT-6 Sol, GPT-6 Luna, Claude Opus 5.5, Claude Sonnet
  5.5, Claude Sonnet 5, Gemini 3.8 Flash, DeepSeek V4.1 Flash, GLM 5.2, Kimi
  K3, Grok 4.7 and Qwen3.7 Max) behind one `AIMLAPI_API_KEY`, with a tray
  icon and a `provider-usage` entry that reads the key's month-to-date spend
  from `GET /v1/key` (a quota card when the key has a spend limit).
