# Grok Fast

All direct xAI presets advertise the optional `priority` service tier as **Fast**:
Grok OAuth 4.5/4.6/4.7 and Grok API 4.5/4.7.
The normal tier remains the default. This does not change reasoning effort.
Reseller routes retain their provider-specific catalog and request behavior.

After updating Router and republishing its catalog, fully quit and reopen Codex
Desktop: its app-server retains the old static catalog even for new chats.
Select a direct Grok route and use the native Fast control where
the client supports service tiers. Router does not enable Fast globally.
Desktop versions may use generic speed multipliers in their tooltip; those are
not a measurement of Grok throughput. See xAI's [Priority Processing contract](https://docs.x.ai/developers/advanced-api-usage/priority-processing)
for requested versus granted tiers. API-key pricing is not proof of OAuth
subscription billing or account entitlement.

## Transport and measurements

The locked LiteLLM bridge drops the normal Responses `service_tier` argument on
the Chat bridge, so Router copies known values into `extra_body` on direct Grok
routes that advertise Fast. Both OAuth and API forwarders preserve it. A
routed body keeps `service_tier` only when the route serving it advertises that
tier (checked-in or curated `serviceTiers`): a turn that fails over from Grok
to another model, or a compaction for another route, is never sent a
priority request that route did not offer.

The actual tier is taken only from upstream response metadata. Streaming
Chat responses carry a bounded `provider_specific_fields.grok_service_tier`
marker on their finish chunk; a usage-only chunk does not survive the bridge.
Non-streaming responses also carry a private service-tier header. The configured
LiteLLM callback restores metadata from that header for this model group only.
The callback is published privately beside the generated gateway YAML.

Usage rows distinguish `requestedServiceTier`, `serviceTier`, and an optional
`serviceTierUnknown` flag. Missing provider data remains missing. Unknown raw
values are not logged. A provider returning `default` after a `priority` request
is recorded as default. Retry billing is never assigned one attempt's tier;
aggregated attempts omit the actual tier, including a turn the router retried
after an empty completion or a pre-content limit when only one attempt reported
usage. No tier-based cost is calculated here.

## Verification

The local protocol fixture runs an isolated Router, the locked LiteLLM gateway,
the production Grok forwarder, and a synthetic loopback xAI server. No account
credentials or live generation are used:

```sh
node scripts/verify-grok-service-tier.mjs .venv/bin/python
```

On Windows pass `.venv/Scripts/python.exe`. The protocol workflow runs this on
Linux, macOS, and Windows. Cases cover HTTP streaming, HTTP JSON and WebSocket,
grant/fallback/missing/unknown tiers, omitted/default requests, all three OAuth
models, usage privacy, and exact preservation of 1000 text fragments. API
forwarder fixtures cover both API presets and keep other providers unchanged.
This is protocol correctness evidence, not a comparative speed benchmark.

For reasoning preservation and correlated latency stages, see
[Grok request diagnostics](grok-request-diagnostics.md).
