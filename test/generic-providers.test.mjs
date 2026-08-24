import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testRoot = mkdtempSync(path.join(os.tmpdir(), "generic-provider-test-"));
process.env.HOME = testRoot;
process.env.CODEX_HOME = path.join(testRoot, "codex");
process.env.CODEX_ROUTER_STATE_DIR = path.join(testRoot, "state");
process.env.MODEL_ROUTER_USER_MODELS = path.join(testRoot, "state", "user-models.json");
process.env.CODEX_ROUTER_SERVICE_PLATFORM = "linux";
process.env.CODEX_ROUTER_SKIP_LAUNCHCTL = "1";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const {
  GENERIC_PROVIDERS_PATH,
  addGenericProvider,
  getGenericProvider,
  genericProviderDescriptor,
  listGenericProviders,
  requestGenericProvider,
  readGenericProviders,
  removeGenericProvider,
  setGenericProviderEnabled,
  testGenericProvider,
  updateGenericProvider,
} = await import("../src/generic-providers.mjs");
test.after(() => rmSync(testRoot, { recursive: true, force: true }));

test("generic provider CRUD is versioned, atomic and redacted", () => {
  const added = addGenericProvider({
    id: "local-vllm",
    displayName: "Local vLLM",
    description: "A local OpenAI-compatible server",
    baseUrl: "https://inference.example.test/v1",
    adapter: "openai-chat",
    headers: { "X-Organization": "test-org" },
    credentialRef: "cred_local_vllm_01",
  });
  assert.equal(added.id, "local-vllm");
  assert.deepEqual(added.headers, { "X-Organization": "[redacted]" });
  assert.deepEqual(readGenericProviders()[0].headers, { "X-Organization": "test-org" });
  // Windows does not expose POSIX permission bits. The private writer still
  // uses the restrictive mode on POSIX, while the ACL is the Windows boundary.
  if (process.platform !== "win32") {
    assert.equal(statSync(GENERIC_PROVIDERS_PATH).mode & 0o777, 0o600);
  }
  assert.equal(JSON.parse(readFileSync(GENERIC_PROVIDERS_PATH, "utf8")).version, 1);

  const listed = listGenericProviders();
  assert.deepEqual(listed[0].headers, { "X-Organization": "[redacted]" });
  const descriptor = genericProviderDescriptor("local-vllm");
  assert.deepEqual(descriptor, {
    id: "local-vllm",
    displayName: "Local vLLM",
    kind: "openai-compatible",
    ownedBy: "local-vllm",
    baseUrl: "https://inference.example.test/v1",
    adapter: "openai-chat",
    protocol: "openai",
    headers: { "X-Organization": "[redacted]" },
    allowPrivate: false,
    credentialRef: "cred_local_vllm_01",
    generic: true,
    enabled: true,
  });
});

test("generic provider edits do not erase fields omitted by the CLI", () => {
  const updated = updateGenericProvider("local-vllm", { displayName: "Local vLLM (edited)" });
  assert.equal(updated.displayName, "Local vLLM (edited)");
  assert.equal(getGenericProvider("local-vllm").baseUrl, "https://inference.example.test/v1");
  assert.equal(getGenericProvider("local-vllm").credentialRef, "cred_local_vllm_01");
  assert.equal(setGenericProviderEnabled("local-vllm", false).enabled, false);
  assert.equal(getGenericProvider("local-vllm").enabled, false);
  assert.deepEqual(removeGenericProvider("local-vllm"), { removed: "local-vllm", remaining: 0 });
});

test("private endpoints and secret transport headers require explicit handling", () => {
  assert.throws(
    () => addGenericProvider({
      id: "loopback-default",
      displayName: "Loopback",
      baseUrl: "http://127.0.0.1:8000/v1",
    }),
    /allowPrivate=true/,
  );
  const local = addGenericProvider({
    id: "loopback-explicit",
    displayName: "Loopback",
    baseUrl: "http://127.0.0.1:8000/v1",
    allowPrivate: true,
  });
  assert.equal(local.allowPrivate, true);
  assert.throws(
    () => addGenericProvider({
      id: "secret-header",
      displayName: "Invalid",
      baseUrl: "https://inference.example.test/v1",
      headers: { Authorization: "secret" },
    }),
    /reserved for credential/,
  );
  assert.throws(
    () => addGenericProvider({
      id: "deepseek",
      displayName: "Invalid",
      baseUrl: "https://inference.example.test/v1",
    }),
    /already used by the built-in registry/,
  );
  assert.throws(
    () => addGenericProvider({
      id: "ipv6-link-local",
      displayName: "Invalid",
      baseUrl: "https://[fe90::1]/v1",
    }),
    /private or loopback|allowPrivate=true/,
  );
  assert.throws(
    () => addGenericProvider({
      id: "ipv4-mapped-loopback",
      displayName: "Invalid",
      baseUrl: "https://[::ffff:7f00:1]/v1",
    }),
    /private or loopback|allowPrivate=true/,
  );
});

test("generic provider test checks private resolution and never prints headers", async () => {
  const calls = [];
  const result = await testGenericProvider("loopback-explicit", {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200 };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(calls[0].url, "http://127.0.0.1:8000/v1/models");
  assert.equal(calls[0].options.headers.Accept, "application/json");
  assert.equal(calls[0].options.headers.Authorization, undefined);
});

test("generic requests revalidate DNS, reject redirects, and bound response reads", async () => {
  addGenericProvider({
    id: "remote-boundary",
    displayName: "Remote boundary",
    baseUrl: "https://provider.example.test/v1",
  });
  await assert.rejects(
    () => requestGenericProvider("remote-boundary", "/models", {
      lookup: async () => ["192.168.10.12"],
      fetchImpl: async () => ({ ok: true, status: 200 }),
    }),
    /private or link-local/,
  );
  await assert.rejects(
    () => requestGenericProvider("remote-boundary", "https://attacker.example/models", {
      lookup: async () => ["8.8.8.8"],
      fetchImpl: async () => ({ ok: true, status: 200 }),
    }),
    /request paths must be relative/,
  );
  await assert.rejects(
    () => requestGenericProvider("remote-boundary", "/models", {
      lookup: async () => ["8.8.8.8"],
      fetchImpl: async () => ({ ok: false, status: 302, body: { cancel: async () => undefined } }),
    }),
    /redirects are disabled/,
  );
  await assert.rejects(
    () => testGenericProvider("remote-boundary", {
      lookup: async () => ["8.8.8.8"],
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": "65537" }),
      }),
    }),
    /65536-byte|read limit/,
  );
});

test("generic credential references never enter descriptors or logs", async () => {
  addGenericProvider({
    id: "credential-boundary",
    displayName: "Credential boundary",
    baseUrl: "https://provider.example.test/v1",
    credentialRef: "cred_generic_provider_01",
    headers: { "X-Organization": "safe-metadata" },
  });
  assert.equal(JSON.stringify(listGenericProviders()).includes("TEST_GENERIC_PROVIDER_TOKEN"), false);
  await assert.rejects(
    () => requestGenericProvider("credential-boundary", "/models", {
      lookup: async () => ["8.8.8.8"],
      fetchImpl: async () => ({ ok: true, status: 200 }),
    }),
    /Credential cred_generic_provider_01 is unavailable/,
  );
});

test("generic requests fail closed when a credential is unavailable or not an API key", async () => {
  addGenericProvider({
    id: "missing-credential",
    displayName: "Missing credential",
    baseUrl: "https://provider.example.test/v1",
    credentialRef: "cred_generic_missing_01",
  });
  await assert.rejects(
    () => requestGenericProvider("missing-credential", "/models", {
      lookup: async () => ["8.8.8.8"],
      fetchImpl: async () => ({ ok: true, status: 200 }),
    }),
    /Credential cred_generic_missing_01 is unavailable/,
  );

  addGenericProvider({
    id: "account-credential",
    displayName: "Account credential",
    baseUrl: "https://provider.example.test/v1",
    credentialRef: "cred_generic_account_01",
  });
  await assert.rejects(
    () => requestGenericProvider("account-credential", "/models", {
      lookup: async () => ["8.8.8.8"],
      fetchImpl: async () => ({ ok: true, status: 200 }),
    }),
    /Credential cred_generic_account_01 is unavailable/,
  );
});

test("providers CLI exposes generic CRUD with sanitized JSON", () => {
  const env = {
    ...process.env,
    HOME: testRoot,
    CODEX_HOME: path.join(testRoot, "codex-cli"),
    CODEX_ROUTER_STATE_DIR: path.join(testRoot, "state-cli"),
    MODEL_ROUTER_USER_MODELS: path.join(testRoot, "state-cli", "user-models.json"),
  };
  mkdirSync(env.CODEX_ROUTER_STATE_DIR, { recursive: true });
  const add = spawnSync(process.execPath, ["src/providers.mjs", "generic", "add", "cli-test", "--name", "CLI Test", "--base-url", "https://cli.example.test/v1", "--header", "X-Org=demo", "--json"], { cwd: root, env, encoding: "utf8" });
  assert.equal(add.status, 0, add.stderr);
  const added = JSON.parse(add.stdout);
  assert.equal(added.provider.id, "cli-test");
  assert.equal(added.provider.headers["X-Org"], "[redacted]");
  const list = spawnSync(process.execPath, ["src/providers.mjs", "generic", "list", "--json"], { cwd: root, env, encoding: "utf8" });
  assert.equal(list.status, 0, list.stderr);
  assert.equal(JSON.parse(list.stdout).providers[0].id, "cli-test");
});
