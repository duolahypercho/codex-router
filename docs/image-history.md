# Image history in Responses requests

Codex replays inline image data with later turns. Its context gauge measures
model tokens, while the router's body limits measure serialized bytes. A long
visual session can therefore exceed the old 128 MiB ingress limit while its
model context gauge remains low.

Responses HTTP bodies are now parsed incrementally. The existing image budget
replaces already-consumed image parts with explicit text receipts. A model
action after an image establishes that it has been consumed. All images after
the latest model action remain intact, including multi-image tool results.
Their resolution, bytes and detail setting are preserved. The original client
history and local image files are not edited.

The same protection applies to native GPT, routed providers, retries and
WebSocket continuation history. Image reductions are logged by count and byte
savings; image contents and source paths are never logged.

Resource limits remain finite:

- Incoming and decoded image histories: at most 2 GiB, processed as streams.
- Retained JSON request: the existing 128 MiB uncompressed / 256 MiB decoded
  compressed defaults or their explicit overrides.
- Temporary assembly: at most twice the retained limit, so an old image group
  can be classified after the following model action.
- A single JSON string: at most the retained limit.
- An oversized current image batch or oversized text request fails with 413;
  current evidence is never silently removed to make such a request fit.

The client can reload an older image using its retained file/tool reference if
it needs to inspect that image again. Text, tool identifiers, calls and non-image
parts remain in order. This does not change model/provider selection or require
a scheduled/manual compaction between ordinary image batches.

Regression checks: `node --test test/responses-request-body.test.mjs` and the
native image-history integration case in `test/routing.test.mjs`.
