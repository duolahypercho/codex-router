---
title: "Compatible apps"
description: "What each supported client surface can and cannot do."
---
Some apps need no dedicated router integration because they **wrap an official
CLI** the router already integrates. This guide covers T3 Code. Nothing here
changes that app's own subscriptions, history, or settings beyond the additive
model configuration the router owns.

# T3 Code

[T3 Code](https://betterstack.com/community/guides/ai/t3-code/) is a GUI that
drives official coding CLIs through adapters rather
than talking to models directly. Because of that, **you integrate the underlying
CLI, and T3 Code inherits the added models** — there is no T3 Code target to
install.

1. Install the router for the CLI T3 Code drives:
   - Codex adapter → `./install.sh --target codex --guided`.
2. Fully quit and reopen T3 Code so its adapter reloads the model list.
3. Pick the added model in T3 Code's model selector; project context and thread
   history are preserved by T3 Code as usual.

The router's job for T3 Code is only to expose the shared provider registry
through the endpoint the driven CLI already knows how to consume.
