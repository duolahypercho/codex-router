"""Preserve Grok forwarder metadata across LiteLLM's non-streaming Chat bridge."""
from litellm.integrations.custom_logger import CustomLogger


class GrokServiceTierCallback(CustomLogger):
    async def async_post_call_success_hook(self, data, user_api_key_dict, response):
        if not str(data.get("model", "")).startswith(("grok-oauth-", "grok-api-")):
            return response
        # The OpenAI adapter retains actual upstream headers in hidden_params;
        # its Responses conversion copies those, but drops Chat service_tier.
        # Never consult request service_tier, credentials, or response text.
        hidden = getattr(response, "_hidden_params", None)
        headers = hidden.get("headers") if isinstance(hidden, dict) else None
        tier = headers.get("x-codex-router-grok-service-tier") if isinstance(headers, dict) else None
        fields = getattr(response, "provider_specific_fields", None)
        fields = dict(fields) if isinstance(fields, dict) else {}
        for name in ("context_input_tokens", "billed_input_tokens", "billed_output_tokens"):
            header = "x-codex-router-grok-" + name.replace("_", "-")
            value = headers.get(header) if isinstance(headers, dict) else None
            if isinstance(value, str) and value.isascii() and value.isdigit() and len(value) <= 10:
                count = int(value)
                if count > 0 or name != "context_input_tokens":
                    fields["grok_" + name] = count
        if tier in ("default", "priority", "unknown"):
            fields["grok_service_tier"] = tier
        response.provider_specific_fields = fields
        if tier in ("default", "priority"):
            response.service_tier = tier
        return response


grok_service_tier_callback = GrokServiceTierCallback()
