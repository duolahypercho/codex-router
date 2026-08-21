# Local LiteLLM patches

## litellm-responses-stream-usage.patch

`LiteLLMCompletionStreamingIterator` (the Responses -> Chat Completions
bridge) never copies the upstream chat-stream usage chunk into the final
`response.completed` event, so clients receive `input_tokens: 0` whenever
the provider reports usage only on that chunk.

The patch captures `chunk.usage` in both the sync and async iteration
loops and applies it to the assembled model response before the
completed event is emitted.

Apply after dependency installation:

```sh
patch -d .venv/lib/python3.12/site-packages \
  -p3 < patches/litellm-responses-stream-usage.patch
```

Note: `bin/install --force-deps` and `model-router codex doctor --fix`
rebuild the venv, which reverts this patch; re-apply it afterwards.
