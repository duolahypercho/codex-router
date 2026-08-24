import assert from "node:assert/strict";
import test from "node:test";

import {
  PROVIDER_PRESET_SCHEMA_VERSION,
  validateProviderPresetContract,
} from "../src/provider-preset-contract.mjs";

const publicPreset = {
  id: "example-api",
  displayName: "Example API",
  protocol: "openai-chat",
  baseUrl: "https://api.example.test/v1",
  discoveryPath: "/v1/models",
  auth: { mode: "credential-ref", credentialRef: "cred_example-key" },
};

test("validates a credential-referenced public endpoint without claiming runtime support", () => {
  const preset = validateProviderPresetContract(publicPreset, {
    knownProviderIds: ["openrouter"],
  });
  assert.equal(preset.schemaVersion, PROVIDER_PRESET_SCHEMA_VERSION);
  assert.equal(preset.baseUrl, "https://api.example.test/v1");
  assert.deepEqual(preset.auth, {
    mode: "credential-ref",
    credentialRef: "cred_example-key",
  });
  assert.equal(Object.isFrozen(preset), true);
  assert.equal(Object.isFrozen(preset.auth), true);
});

test("allows an explicitly private, keyless endpoint only with a safe path", () => {
  const preset = validateProviderPresetContract({
    id: "local-vllm",
    displayName: "Local vLLM",
    protocol: "openai-chat",
    baseUrl: "http://127.0.0.1:8000/v1",
    allowPrivate: true,
    discoveryPath: "/v1/models",
    auth: { mode: "none" },
  });
  assert.equal(preset.allowPrivate, true);
  assert.deepEqual(preset.auth, { mode: "none" });
});

test("fails closed for unsafe endpoints and path patterns", () => {
  assert.throws(
    () => validateProviderPresetContract({ ...publicPreset, baseUrl: "http://api.example.test/v1" }),
    /plain HTTP/,
  );
  assert.throws(
    () => validateProviderPresetContract({ ...publicPreset, baseUrl: "http://127.0.0.1:8000/v1" }),
    /allowPrivate=true/,
  );
  assert.throws(
    () => validateProviderPresetContract({ ...publicPreset, allowPrivate: true, baseUrl: "https://api.example.test/v1?key=secret" }),
    /credentials, query strings, fragments/,
  );
  assert.throws(
    () => validateProviderPresetContract({ ...publicPreset, discoveryPath: "/v1/../admin" }),
    /traversal/,
  );
  assert.throws(
    () => validateProviderPresetContract({ ...publicPreset, discoveryPath: "//evil.example/models" }),
    /absolute path/,
  );
});

test("rejects raw credentials, malformed references, and unauthenticated public endpoints", () => {
  assert.throws(
    () => validateProviderPresetContract({ ...publicPreset, auth: { mode: "credential-ref", credentialRef: "sk-secret" } }),
    /opaque credential reference/,
  );
  assert.throws(
    () => validateProviderPresetContract({ ...publicPreset, auth: { mode: "environment", environment: "api_key" } }),
    /uppercase environment variable/,
  );
  assert.throws(
    () => validateProviderPresetContract({ ...publicPreset, auth: { mode: "none" } }),
    /only allowed for private endpoints/,
  );
});

test("rejects capability and runtime fields until a proven caller exists", () => {
  for (const field of ["capabilities", "retry", "enabled", "headers", "models"]) {
    assert.throws(
      () => validateProviderPresetContract({ ...publicPreset, [field]: {} }),
      new RegExp(`preset\\.${field} is not allowed`),
    );
  }
  assert.throws(
    () => validateProviderPresetContract({ ...publicPreset, id: "openrouter" }, { knownProviderIds: ["openrouter"] }),
    /already used by the registry/,
  );
});

