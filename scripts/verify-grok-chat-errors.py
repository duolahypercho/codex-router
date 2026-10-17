"""Offline proof: actual OpenAI SDK -> locked LiteLLM Responses iterator.

stdin is the synthetic SSE body captured from the local forwarder regression.
MockTransport supplies that body; neither an OAuth session nor a provider is used.
The legacy flat envelope is a negative control, not a second supported format.
"""
import asyncio
import importlib.metadata
import json
import sys

import httpx
import litellm
from litellm.exceptions import MidStreamFallbackError
from openai import AsyncOpenAI
from litellm.responses.litellm_completion_transformation.streaming_iterator import (
    LiteLLMCompletionStreamingIterator,
)

assert importlib.metadata.version("litellm") == "1.96.2"
assert importlib.metadata.version("openai") == "2.53.0"
litellm.suppress_debug_info = True


async def consume(body):
    requests = []

    async def serve(request):
        requests.append(request)
        assert str(request.url).startswith("http://offline-fixture.invalid/")
        return httpx.Response(
            200, headers={"Content-Type": "text/event-stream"},
            content=body.encode(), request=request,
        )

    client = AsyncOpenAI(
        api_key="synthetic-offline-key", base_url="http://offline-fixture.invalid/",
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(serve)),
    )
    kinds = []
    failure = None
    try:
        wrapper = await litellm.acompletion(
            model="openai/offline-fixture", messages=[{"role": "user", "content": "fixture"}],
            stream=True, api_key="synthetic-offline-key", client=client,
        )
        iterator = LiteLLMCompletionStreamingIterator(
            model="offline-fixture", litellm_custom_stream_wrapper=wrapper,
            request_input="fixture", responses_api_request={"stream": True},
            custom_llm_provider="openai",
        )
        try:
            async for chunk in iterator:
                kinds.append(str(chunk.type))
        except Exception as error:
            failure = error
        assert len(requests) == 1, "a committed stream failure must not retry"
        assert any("OUTPUT_TEXT_DELTA" in kind for kind in kinds)
        assert not any("RESPONSE_COMPLETED" in kind for kind in kinds)
        return failure
    finally:
        await client.close()


async def main():
    current = sys.stdin.read()
    error_frames = [json.loads(line[6:]) for line in current.splitlines()
                    if line.startswith("data: ") and line != "data: [DONE]"]
    errors = [frame for frame in error_frames if "error" in frame]
    assert len(errors) == 1
    envelope = errors[0]
    assert envelope["error"]["code"] == "local_router_stream_failed"
    assert "[DONE]" not in current
    legacy = current.replace(
        json.dumps(envelope, separators=(",", ":")),
        json.dumps({**envelope["error"], "type": "error"}, separators=(",", ":")),
    )
    assert legacy != current, "negative control must use the old flat envelope"
    old_failure = await consume(legacy)
    assert isinstance(old_failure, IndexError), type(old_failure).__name__
    failure = await consume(current)
    assert isinstance(failure, MidStreamFallbackError), type(failure).__name__
    assert envelope["error"]["message"] in str(failure)
    print("PASS: legacy flat envelope reproduces IndexError; nested Chat error propagates as a failure without retry or completion")


asyncio.run(main())
