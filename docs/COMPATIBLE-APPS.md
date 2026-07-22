# Compatible apps: T3 Code and opencode

Some apps need no dedicated router target because they either **wrap an official
CLI** the router already integrates, or they **natively accept any
OpenAI-compatible provider**. This guide covers T3 Code and opencode. Nothing
here changes those apps' own subscriptions, history, or settings beyond the
additive model configuration you choose.

## T3 Code

[T3 Code](https://betterstack.com/community/guides/ai/t3-code/) is a GUI that
drives the official coding CLIs (Codex CLI, Claude Code) through adapters rather
than talking to models directly. Because of that, **you integrate the underlying
CLI, and T3 Code inherits the added models** — there is no T3 Code target to
install.

1. Install the target for the CLI T3 Code drives:
   - Codex adapter → install the **codex** target (`./install.sh --target codex --guided`).
   - Claude adapter → install the **claude** target (`./install.sh --target claude --guided`).
2. Fully quit and reopen T3 Code so its adapter reloads the model list.
3. Pick the added model in T3 Code's model selector; project context and thread
   history are preserved by T3 Code as usual.

As T3 Code's Cursor and opencode adapters mature, the corresponding target below
applies the same way.

## opencode

[opencode](https://opencode.ai/docs/providers/) natively supports any
OpenAI-compatible provider, so you point it at the router's OpenAI-compatible
gateway. The **cursor** target's gateway is a general OpenAI Chat Completions
endpoint and serves this purpose directly.

1. Install the cursor target to run the local gateway:
   ```sh
   ./install.sh --target cursor --guided
   ```
2. Get the connection values:
   ```sh
   ./bin/model-router cursor setup
   ```
   which prints the Base URL (`http://127.0.0.1:4104/v1`), the caller key, and the
   gateway model ids.
3. Add a custom provider in opencode's config, for example:
   ```json
   {
     "provider": {
       "codex-router": {
         "npm": "@ai-sdk/openai-compatible",
         "options": { "baseURL": "http://127.0.0.1:4104/v1" },
         "models": { "kimi-api-k3": {}, "deepseek-v4-pro": {} }
       }
     }
   }
   ```
   The model keys must match the gateway model ids from step 2, and the base URL
   must end in `/v1` (not `/v1/chat/completions`).
4. Store the caller key as opencode's credential for this provider (opencode keeps
   credentials separate from config — use its documented credential command).
5. Fully quit and reopen opencode, then verify the provider and models appear.

Your existing opencode providers and models are unaffected; this only adds one
more provider entry.

## Why no dedicated target

Both apps already provide an additive extension point — T3 Code through the CLIs
it wraps, opencode through its custom-provider config. Adding bespoke router
targets would duplicate what they ship. The router's job here is only to expose
the shared provider registry through an endpoint each app already knows how to
consume.
