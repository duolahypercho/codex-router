import assert from "node:assert/strict";
import test from "node:test";

import * as proto from "../src/devin-proto.mjs";
import { decodeMessage, encodeMessage } from "../src/protobuf-wire.mjs";

// Issue #770. Devin 3000.x answered `invalid_argument` on every model list
// while the router's request encoding still audited clean. The cause was the
// method name: `GetCascadeModelConfigs` is the IDE's, and the shipped CLI --
// whose session this provider reuses -- moved to `GetCliModelConfigs`.
//
// These assertions are literals on purpose. A test that reads the constant it
// is guarding passes through a rename without noticing, which is exactly how
// the drift reached a user.

test("the model list asks for the method the shipped CLI calls", () => {
  assert.equal(proto.GET_CLI_MODEL_CONFIGS, "GetCliModelConfigs");
  assert.equal(proto.SERVICE_PATH, "exa.api_server_pb.ApiServerService");
  assert.equal(
    `${proto.SERVICE_PATH}/${proto.GET_CLI_MODEL_CONFIGS}`,
    "exa.api_server_pb.ApiServerService/GetCliModelConfigs",
  );
  assert.equal(proto.GET_CASCADE_MODEL_CONFIGS, undefined, "the IDE-only method must not come back");
});

test("the turn method is unchanged, because only the model list drifted", () => {
  assert.equal(proto.GET_CHAT_MESSAGE, "GetChatMessage");
});

// Field numbers re-read from Devin 3000.10.31's own generated protobuf-es
// field lists. Pinning the ones the router actually reads or writes means a
// future transcription pass has something to fail against.
test("the field numbers the router depends on match the 3000.x descriptor", () => {
  assert.equal(proto.GET_CLI_MODEL_CONFIGS_REQUEST.metadata.no, 1);
  assert.equal(proto.GET_CLI_MODEL_CONFIGS_RESPONSE.clientModelConfigs.no, 1);
  assert.equal(proto.GET_CLI_MODEL_CONFIGS_RESPONSE.clientModelConfigs.repeated, true);

  assert.equal(proto.METADATA.apiKey.no, 3);
  assert.equal(proto.METADATA.ideName.no, 1);
  assert.equal(proto.METADATA.f.no, 31);

  assert.equal(proto.CLIENT_MODEL_CONFIG.label.no, 1);
  assert.equal(proto.CLIENT_MODEL_CONFIG.disabled.no, 4);
  assert.equal(proto.CLIENT_MODEL_CONFIG.supportsImages.no, 5);
  assert.equal(proto.CLIENT_MODEL_CONFIG.isPremium.no, 7);
  assert.equal(proto.CLIENT_MODEL_CONFIG.isBeta.no, 9);
  assert.equal(proto.CLIENT_MODEL_CONFIG.maxTokens.no, 18);
  assert.equal(proto.CLIENT_MODEL_CONFIG.modelUid.no, 22);
  assert.equal(proto.CLIENT_MODEL_CONFIG.description.no, 27);

  assert.equal(proto.GET_CHAT_MESSAGE_REQUEST.chatModelUid.no, 21);
  assert.equal(proto.GET_CHAT_MESSAGE_REQUEST.executionId.no, 22);
  assert.equal(proto.GET_CHAT_MESSAGE_RESPONSE.deltaToolCalls.no, 6);
  assert.equal(proto.GET_CHAT_MESSAGE_RESPONSE.actualModelUid.no, 23);
});

// The response gained `default_override_model_config` (3) and
// `subagent_default_model_uid` (4). The router reads neither, so the decoder's
// unknown-field skip has to carry them -- otherwise a model list from a real
// account would fail on fields that are none of this provider's business.
test("the new response members decode to nothing instead of failing", () => {
  const withNewMembers = encodeMessage(
    {
      clientModelConfigs: {
        no: 1,
        type: "message",
        message: proto.CLIENT_MODEL_CONFIG,
        repeated: true,
      },
      defaultOverrideModelConfig: { no: 3, type: "message", message: { label: { no: 1, type: "string" } } },
      subagentDefaultModelUid: { no: 4, type: "string" },
    },
    {
      clientModelConfigs: [{ modelUid: "devin-model", label: "Devin Model" }],
      defaultOverrideModelConfig: { label: "override" },
      subagentDefaultModelUid: "some-uid",
    },
  );

  const decoded = decodeMessage(proto.GET_CLI_MODEL_CONFIGS_RESPONSE, withNewMembers);
  assert.equal(decoded.clientModelConfigs.length, 1);
  assert.equal(decoded.clientModelConfigs[0].modelUid, "devin-model");
  assert.equal(decoded.clientModelConfigs[0].label, "Devin Model");
  assert.equal(decoded.subagentDefaultModelUid, undefined);
  assert.equal(decoded.defaultOverrideModelConfig, undefined);
});

// The end-to-end guard: the discovery path `bin/curate-models` drives has to
// reach the renamed method on the wire, not merely import a renamed constant.
test("the discovery model list reaches GetCliModelConfigs on the wire", async () => {
  const { listCascadeModels } = await import("../src/devin-cli-forwarder.mjs");
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), authorization: init?.headers?.authorization });
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => {
        const body = encodeMessage(proto.GET_CLI_MODEL_CONFIGS_RESPONSE, {
          clientModelConfigs: [
            { modelUid: "live-model", label: "Live Model", isPremium: true },
            { modelUid: "off-model", label: "Disabled", disabled: true },
          ],
        });
        return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
      },
    };
  };
  try {
    const models = await listCascadeModels({
      session: { apiKey: "tok", apiServerUrl: "https://cascade.invalid" },
    });
    assert.equal(seen.length, 1);
    assert.equal(
      seen[0].url,
      "https://cascade.invalid/exa.api_server_pb.ApiServerService/GetCliModelConfigs",
    );
    // A disabled entitlement is the account's answer, not a model to offer.
    assert.deepEqual(models.map((model) => model.id), ["live-model"]);
    assert.equal(models[0].premium, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});
