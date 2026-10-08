---
title: "Adding providers and models"
description: "Extend the checked-in registry."
---
The [`config/`](config/) registry tree is the validated registry for
provider metadata, picker entries, upstream IDs, API protocols, context limits, request
profiles, modalities, and credential sources. Tested OpenAI-compatible and
Anthropic API providers share one credential-isolating forwarder and appear
in the Codex picker after compatibility tests pass.

Discovery does not publish every upstream model blindly:

```sh
./bin/discover-models deepseek
./bin/test-model 'deepseek/deepseek-v4-pro' --live --yes
```

New models should remain unlisted until official capabilities and live text,
streaming, image-input, tool-call, and context behavior are verified. See
[Development](/reference/development/) for the registry contract.

## Chat models and tool APIs

The **Models** page adds conversational models to Codex. Selecting one changes
the assistant that handles the chat. Decisions, embeddings and other tool APIs
need a client that calls their own endpoint. Adding a similarly named chat model
does not activate that client.

For example, the hidden `openrouter-decisions/jev-latest` route accepts
structured requests at the Router's local `/v1/decisions` endpoint after
OpenRouter is connected. The [`typesafe/jev-router`](https://openrouter.ai/typesafe/jev-router)
entry in OpenRouter's chat
catalogue is a separate conversational route. A Jev output-pruning client must
call the Decisions endpoint itself, ask a bounded question about the current
tool output and keep the original output recoverable. The Router does not
install a Codex tool-output hook when a model is added to the picker.

If the Router becomes unreachable after setup, open **Status → Service health**
and use **Fix**, then check health again. This repairs and restarts the installed
Router and can interrupt routed chats. Choose a known working chat model after
recovery. Fix does not turn on tool integrations.
