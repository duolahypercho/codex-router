"""Close acquired Chat-to-Responses streams when the gateway cancels a turn.

LiteLLM 1.96.2's outer iterator owns cleanup, but its completion bridge lacks
aclose. Delegate to the existing CustomStreamWrapper: it clears the acquired
stream before awaiting and shields SDK HTTP-stream closure from ASGI task-group
cancellation. No response bytes, retry policy, or upstream request are changed.
"""
from importlib.metadata import version

from litellm.integrations.custom_logger import CustomLogger
from litellm.responses.litellm_completion_transformation.streaming_iterator import (
    LiteLLMCompletionStreamingIterator,
)


async def _close_completion_bridge(self):
    await self.litellm_custom_stream_wrapper.aclose()


def install_stream_cleanup():
    # A future upstream or operator-supplied method keeps ownership of cleanup.
    if hasattr(LiteLLMCompletionStreamingIterator, "aclose"):
        return False
    if version("litellm") != "1.96.2":
        raise RuntimeError(
            "Review stream cleanup compatibility before upgrading LiteLLM."
        )
    LiteLLMCompletionStreamingIterator.aclose = _close_completion_bridge
    return True


install_stream_cleanup()
# LiteLLM loads this repository module through its normal callback configuration.
# The callback has no hooks; only the narrow missing-method compatibility above
# runs, once at import. Existing callbacks retain their original behavior.
stream_cleanup_callback = CustomLogger()
