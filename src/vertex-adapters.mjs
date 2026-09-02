// Vertex Model Garden exposes more than one wire contract. Keep the adapter
// registry explicit: a discovered model is not publishable merely because it
// has a name; it must name one of these complete request/response routes.

function pathSegment(value, label) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || /[\u0000-\u001f\u007f/?#\\]/.test(normalized)) {
    throw new Error(`Vertex ${label} must be a safe path segment.`);
  }
  return normalized;
}

function publisherFor(model, fallback) {
  return pathSegment(model?.vertexPublisher || model?.publisher || fallback, "publisher");
}

function modelFor(model) {
  return pathSegment(model?.upstreamModel, "model");
}

const ADAPTER_DEFINITIONS = {
  "vertex-anthropic-messages": {
    route: "/messages",
    liteLlmProtocol: "anthropic",
    liteLlmBaseEnv: "CODEX_ROUTER_ANTHROPIC_FORWARD_BASE_URL",
    requestProfile: "anthropic-reasoning",
    normalizeBody(payload) {
      const { model: _model, ...body } = payload;
      body.anthropic_version = "vertex-2023-10-16";
      return body;
    },
    targetPath({ model, body }) {
      const method = body.stream === true ? "streamRawPredict" : "rawPredict";
      return `/publishers/${publisherFor(model, "anthropic")}/models/${modelFor(model)}:${method}`;
    },
  },
  "vertex-openai-chat": {
    route: "/chat/completions",
    liteLlmProtocol: "openai",
    liteLlmBaseEnv: "CODEX_ROUTER_API_FORWARD_BASE_URL",
    normalizeBody(payload) {
      // The Model Garden id is unqualified, while Vertex's OpenAI-compatible
      // endpoint addresses Google publisher models as `google/<model>`.
      return {
        ...payload,
        model: `google/${pathSegment(payload.model, "model")}`,
      };
    },
    targetPath() {
      return "/endpoints/openapi/chat/completions";
    },
  },
};

export const VERTEX_ADAPTERS = Object.freeze(
  Object.fromEntries(
    Object.entries(ADAPTER_DEFINITIONS).map(([name, adapter]) => [name, Object.freeze(adapter)]),
  ),
);

export const IMPLEMENTED_VERTEX_ADAPTERS = Object.freeze(Object.keys(VERTEX_ADAPTERS));

export function vertexAdapterForModel(model, provider) {
  if (provider?.protocol !== "vertex") return undefined;
  return Object.hasOwn(VERTEX_ADAPTERS, model?.adapter)
    ? VERTEX_ADAPTERS[model.adapter]
    : undefined;
}
