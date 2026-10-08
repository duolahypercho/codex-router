- **Responses-native providers get their reasoning back as reasoning, not as
  visible text (#840).** On `openai-responses` routes — generic providers and
  built-in ones such as Meta and GitHub Copilot — the Chat Completions
  reasoning carry still ran: reasoning before a tool call was replaced by an
  assistant `output_text` message, and reasoning before an answer was also
  prepended to that answer. A thinking model read its own past progress notes
  as things it had said and repeated them. The carry now runs only on Chat
  Completions routes; Responses routes receive reasoning items unchanged.
