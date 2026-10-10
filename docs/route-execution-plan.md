# Selected-route execution plans

`createExecutionPlan` compiles an already loaded registry and explicit selection
into an immutable set of services, a gateway requirement and a deterministic
route fingerprint. The pure compiler does not import credentials, discovery,
the registry or process management.

Use the registry's `providerForModel` resolver so per-model endpoints and the
verified DeepSeek Responses override take precedence over container defaults.
Include selected hidden callable models and enabled generic descriptors; picker
visibility and credential readiness do not determine request dependencies.
Missing credentials must leave the selected error-reporting listener available.

The transport mapping is:

| Route | Required downstream services |
| --- | --- |
| Unregistered native GPT | None |
| HTTP or WebSocket Responses provider | API forwarder |
| Chat, Messages or Vertex translation | API forwarder and gateway |
| Supported OAuth provider | Its OAuth listener and gateway |
| Native Ollama adapter | Ollama listener and gateway |

The fingerprint covers allowed routing, preparation and client-capability
metadata independent of input/key order. It excludes credential/header values,
URL user information, query strings and fragments. It is a registry/selection
identity, not a digest of live secrets, environment overrides or independently
stored Vertex/overlay state. A pending Antigravity proof adds its readiness
listener without changing the fingerprint of requestable routes.

The read-only dependency query is available from the checkout:

```sh
node src/runtime-dependency-requirements.mjs
node src/runtime-dependency-requirements.mjs --gateway-required
```

The first prints selected services and gateway necessity as JSON, including an
exact pending proof's readiness exception. The second prints `required` or
`unused` and skips pending-proof credential inspection.

The mapping describes the intended direct-forwarder execution boundary;
this query is not an inventory of the currently running stack.

This additive API/query does not yet change service startup, installer
provisioning, Router dispatch, health reporting or client publication. Each
consumer can adopt the shared decision in its own independently reviewed PR.
