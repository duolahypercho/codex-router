import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "provider-pool-service-env-"));
const stateDir = path.join(root, "state");
const credentialStorePath = path.join(stateDir, "provider-credentials.json");
const poolStatePath = path.join(stateDir, "provider-api-key-pools.json");
process.env.MODEL_ROUTER_STATE_DIR = stateDir;
process.env.MODEL_ROUTER_PROVIDER_CREDENTIAL_STORE = credentialStorePath;
process.env.MODEL_ROUTER_API_KEY_POOL_PATH = poolStatePath;

const { addEnvironmentCredentialToPool } = await import("../src/provider-api-key-control.mjs");
const { providerApiKeyServiceEnvironment } = await import(
  "../src/provider-api-key-service-environment.mjs"
);

test.after(() => rmSync(root, { recursive: true, force: true }));

test("managed service receives only registry-allowlisted environment refs present in a pool", async () => {
  await addEnvironmentCredentialToPool("opencode-go", "OPENCODE_API_KEY", {
    credentialStorePath,
    poolStatePath,
  });
  const values = providerApiKeyServiceEnvironment({
    credentialStorePath,
    poolStatePath,
    environment: {
      OPENCODE_API_KEY: "  POOLED_SECRET  ",
      OPENCODE_GO_API_KEY: "UNREFERENCED_PROVIDER_SECRET",
      OPENROUTER_API_KEY: "UNRELATED_SECRET",
    },
  });
  assert.deepEqual(values, { OPENCODE_API_KEY: "  POOLED_SECRET  " });
});

test("missing environment values remain unresolved instead of being invented", () => {
  assert.deepEqual(providerApiKeyServiceEnvironment({
    credentialStorePath,
    poolStatePath,
    environment: {},
  }), {});
});

test("service rendering refuses control characters in a referenced secret", () => {
  assert.throws(
    () => providerApiKeyServiceEnvironment({
      credentialStorePath,
      poolStatePath,
      environment: { OPENCODE_API_KEY: "value\nEnvironment=INJECTED" },
    }),
    /unsupported control characters/,
  );
});

test("discovery-off service rendering does not inspect pooled environment values", async () => {
  await addEnvironmentCredentialToPool("opencode-go", "OPENCODE_API_KEY", { credentialStorePath, poolStatePath });
  const previous = process.env.CODEX_ROUTER_NO_DISCOVERY;
  process.env.CODEX_ROUTER_NO_DISCOVERY = "1";
  let reads = 0;
  try {
    const environment = new Proxy({}, { get() { reads += 1; return "POOLED_SYNTHETIC_SECRET"; } });
    assert.deepEqual(providerApiKeyServiceEnvironment({ credentialStorePath, poolStatePath, environment }), {});
    assert.equal(reads, 0);
  } finally {
    if (previous === undefined) delete process.env.CODEX_ROUTER_NO_DISCOVERY;
    else process.env.CODEX_ROUTER_NO_DISCOVERY = previous;
  }
});
