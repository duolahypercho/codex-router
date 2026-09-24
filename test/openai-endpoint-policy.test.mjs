import assert from "node:assert/strict";
import test from "node:test";

import {
  endpointCapabilityError,
  normalizeSupportedEndpoints,
  providerModelEndpoint,
  supportsOpenAIModelEndpoint,
} from "../src/openai-endpoint-policy.mjs";

test("endpoint declarations are closed, deduplicated, and model-scoped", () => {
  assert.deepEqual(
    normalizeSupportedEndpoints(["/chat/completions", "/embeddings", "/embeddings"]),
    ["/chat/completions", "/embeddings"],
  );
  assert.throws(() => normalizeSupportedEndpoints([]), /non-empty array/);
  assert.throws(() => normalizeSupportedEndpoints(["/audio/speech"]), /unsupported endpoint/);
  assert.deepEqual(normalizeSupportedEndpoints(["/decisions"]), ["/decisions"]);
  assert.equal(providerModelEndpoint({}), "/chat/completions");
  assert.equal(providerModelEndpoint({ protocol: "openai" }), "/chat/completions");
  assert.equal(providerModelEndpoint({ protocol: "openai-responses" }), "/responses");
  assert.equal(providerModelEndpoint({ protocol: "openai-decisions" }), "/decisions");
  assert.equal(providerModelEndpoint({ protocol: "anthropic" }), undefined);
  assert.equal(providerModelEndpoint({ protocol: "unknown" }), undefined);
});

test("embeddings require an explicit model declaration", () => {
  const provider = { protocol: "openai" };
  assert.equal(
    supportsOpenAIModelEndpoint("/chat/completions", { model: {}, provider }),
    true,
  );
  assert.equal(
    supportsOpenAIModelEndpoint("/embeddings", { model: {}, provider }),
    false,
  );
  assert.equal(
    supportsOpenAIModelEndpoint("/embeddings", {
      model: { supportedEndpoints: ["/embeddings"] },
      provider,
    }),
    true,
  );
  assert.equal(
    supportsOpenAIModelEndpoint("/chat/completions", {
      model: { supportedEndpoints: ["/embeddings"] },
      provider,
    }),
    false,
  );
  assert.equal(
    supportsOpenAIModelEndpoint("/decisions", {
      model: { supportedEndpoints: ["/decisions"] },
      provider: { protocol: "openai-decisions" },
    }),
    true,
  );
  assert.equal(
    supportsOpenAIModelEndpoint("/decisions", {
      model: {},
      provider: { protocol: "openai-decisions" },
    }),
    true,
  );
  assert.equal(
    supportsOpenAIModelEndpoint("/embeddings", {
      model: { supportedEndpoints: ["/embeddings"] },
      provider: { protocol: "anthropic" },
    }),
    false,
  );
  const error = endpointCapabilityError("/embeddings", { displayName: "Text model" });
  assert.equal(error.status, 400);
  assert.equal(error.code, "unsupported_model_endpoint");
  assert.match(error.message, /Text model/);
});
