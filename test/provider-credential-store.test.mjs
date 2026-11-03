import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const atomicStateLockModule = new URL("../src/atomic-state-lock.mjs", import.meta.url).href;
const credentialStoreModule = new URL("../src/provider-credential-store.mjs", import.meta.url).href;
const providerCredentialsModule = new URL("../src/provider-credentials.mjs", import.meta.url).href;

const root = mkdtempSync(path.join(os.tmpdir(), "codex-router-credential-store-"));
process.env.CODEX_HOME = path.join(root, "codex");
process.env.CODEX_ROUTER_STATE_DIR = path.join(root, "state");
process.env.MODEL_ROUTER_STATE_DIR = process.env.CODEX_ROUTER_STATE_DIR;
process.env.MODEL_ROUTER_PROVIDER_CREDENTIAL_STORE = path.join(root, "state", "provider-credentials.json");
for (const name of ["DEEPSEEK_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY"]) delete process.env[name];

const {
  addCredentialReference,
  createCredentialReference,
  generatedCredentialId,
  readProviderCredentialStore,
  redactCredentialObject,
  redactCredentialText,
  removeCredentialReference,
  sanitizeCredentialStatus,
  sanitizedCredentialStore,
  writeProviderCredentialStore,
} = await import("../src/provider-credential-store.mjs");
const {
  credentialPaths,
  resolveProviderCredential,
  resolveProviderCredentialReference,
  writeProviderCredential,
} = await import("../src/provider-credentials.mjs");
const { PROVIDERS } = await import("../src/model-registry.mjs");
const { privateFileIsProtected } = await import("../src/file-security.mjs");
const { validateGenericProvider } = await import("../src/generic-provider-state.mjs");

test.after(() => rmSync(root, { recursive: true, force: true }));

function ref(providerId = "deepseek") {
  return { type: "provider-file", providerId, target: "codex" };
}

test("generated credential ids stay valid when raw base64url starts with dash or underscore", () => {
  for (const [firstByte, rawPrefix] of [[0xf8, "-"], [0xfc, "_"]]) {
    const bytes = Buffer.alloc(18);
    bytes[0] = firstByte;
    assert.equal(bytes.toString("base64url")[0], rawPrefix);
    const id = generatedCredentialId(() => bytes);
    assert.equal(id.slice(0, 7), `cred_r${rawPrefix}`);
    assert.equal(validateGenericProvider({
      id: `credential-id-${firstByte}`,
      displayName: "Credential id fixture",
      baseUrl: "https://provider.example.test/v1",
      credentialRef: id,
    }).credentialRef, id);
  }
});

async function holdStateLock(filePath, milliseconds = 350) {
  const script = `
    import { withAtomicStateLock } from ${JSON.stringify(atomicStateLockModule)};
    withAtomicStateLock(process.argv[1], () => {
      process.stdout.write("locked\\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.argv[2]));
    });
  `;
  const child = spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    script,
    filePath,
    String(milliseconds),
  ], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { errors += chunk; });
  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  await new Promise((resolve, reject) => {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("locked\n")) resolve();
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (!output.includes("locked\n")) {
        reject(new Error(`Lock holder exited before acquiring the lock (${code ?? signal}): ${errors}`));
      }
    });
  });
  return { exited, errors: () => errors };
}

test("credential references contain no secret and use protected metadata storage", () => {
  const filePath = path.join(root, "state", "references.json");
  const entry = addCredentialReference(
    {
      providerId: "deepseek",
      kind: "api_key",
      secretRef: ref(),
      label: "Primary DeepSeek",
      account: { alias: "main", plan: "api" },
    },
    filePath,
  );
  assert.match(entry.id, /^cred_[A-Za-z0-9_-]{16,64}$/);
  assert.equal(entry.secretRef.providerId, "deepseek");
  assert.equal(entry.secretRef.target, "codex");
  assert.equal("value" in entry, false);
  assert.equal(privateFileIsProtected(filePath), true);
  if (process.platform !== "win32") assert.equal(statSync(filePath).mode & 0o777, 0o600);
  const raw = readFileSync(filePath, "utf8");
  assert.doesNotMatch(raw, /api[_-]?key\s*[:=]/i);
  assert.deepEqual(sanitizedCredentialStore(filePath).credentials[0], sanitizeCredentialStatus(entry));
  assert.equal(removeCredentialReference(entry.id, filePath), true);
  assert.deepEqual(readProviderCredentialStore(filePath).credentials, []);
});

test("credential metadata parsing fails closed for unknown or secret-bearing fields", () => {
  assert.throws(
    () => createCredentialReference({
      providerId: "deepseek",
      kind: "api_key",
      secretRef: ref(),
      apiKey: "TEST_DO_NOT_STORE",
    }),
    /secret field apiKey/,
  );
  assert.throws(
    () => createCredentialReference({
      providerId: "deepseek",
      kind: "api_key",
      secretRef: { ...ref(), name: "NOT_ALLOWED" },
    }),
    /provider-file secretRef cannot include service or name/,
  );
  assert.throws(
    () => createCredentialReference({
      providerId: "deepseek",
      kind: "api_key",
      secretRef: { type: "environment", providerId: "deepseek", target: "codex", name: "UNRELATED_SECRET" },
    }),
    /not configured for this provider/,
  );
  assert.throws(
    () => writeProviderCredentialStore({ credentials: [], accessToken: "TEST_STORE_SECRET" }, path.join(root, "state", "unsafe.json")),
    /secret field accessToken/,
  );
  const unsupported = path.join(root, "state", "unsupported.json");
  for (const schemaVersion of [1, 3]) {
    writeFileSync(unsupported, `${JSON.stringify({ schemaVersion, credentials: [] })}\n`);
    assert.deepEqual(readProviderCredentialStore(unsupported).credentials, []);
    assert.throws(
      () => writeProviderCredentialStore({ schemaVersion, credentials: [] }, unsupported),
      /Unsupported provider credential store schema/,
    );
  }
});

test("redaction covers headers, URLs, errors, nested objects, and known secrets", () => {
  const text = [
    "Authorization: Bearer TEST_BEARER_TOKEN",
    "X-Api-Key: TEST_HEADER_KEY",
    "https://user:password@example.test/v1?api_key=QUERY_SECRET",
    "{\"access_token\":\"JSON_SECRET\",\"message\":\"TEST_KNOWN_SECRET\"}",
    "sk-test_secret_value",
  ].join(" ");
  const redacted = redactCredentialText(text, ["TEST_KNOWN_SECRET"]);
  assert.doesNotMatch(redacted, /TEST_BEARER_TOKEN|TEST_HEADER_KEY|password|QUERY_SECRET|JSON_SECRET|TEST_KNOWN_SECRET|sk-test_secret_value/);
  const object = redactCredentialObject({
    headers: { Authorization: "Bearer TEST_HEADER_SECRET", "X-Api-Key": "TEST_API_SECRET" },
    nested: { refreshToken: "TEST_REFRESH_SECRET", message: "TEST_KNOWN_SECRET" },
  }, ["TEST_KNOWN_SECRET"]);
  assert.equal(object.headers.Authorization, "[REDACTED]");
  assert.equal(object.headers["X-Api-Key"], "[REDACTED]");
  assert.equal(object.nested.refreshToken, "[REDACTED]");
  assert.equal(object.nested.message, "[REDACTED]");
});

test("credential writes and resolution do not traverse symlinked paths", () => {
  assert.throws(
    () => writeProviderCredentialStore({ credentials: [] }, path.join(root, "outside", "store.json")),
    /inside the router state directory/,
  );
  const outside = path.join(root, "outside-credential-state");
  const linkedDirectory = path.join(root, "state", "linked-directory");
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, linkedDirectory, "dir");
  assert.throws(
    () => writeProviderCredentialStore(
      { credentials: [] },
      path.join(linkedDirectory, "store.json"),
    ),
    /symbolic link/,
  );

  const providerPath = writeProviderCredential("deepseek", "TEST_SYMLINK_RESOLUTION_SECRET");
  const external = path.join(root, "outside-resolution-secret.txt");
  writeFileSync(external, "TEST_SYMLINK_RESOLUTION_SECRET\n", { mode: 0o600 });
  unlinkSync(providerPath);
  symlinkSync(external, providerPath);
  assert.equal(resolveProviderCredential("deepseek"), undefined);
});

test("credential references are router-plane- and provider-bound at resolution time", () => {
  const providerPath = writeProviderCredential("deepseek", "TEST_BOUND_SECRET");
  const configured = resolveProviderCredentialReference("deepseek", ref());
  assert.equal(configured?.value, "TEST_BOUND_SECRET");
  assert.equal(resolveProviderCredentialReference("deepseek", { ...ref(), target: "gemini" }), undefined);
  assert.equal(resolveProviderCredentialReference("openrouter", ref("deepseek")), undefined);
  assert.equal(resolveProviderCredentialReference("deepseek", { ...ref(), path: "/tmp/outside" }), undefined);
  assert.equal(resolveProviderCredentialReference("deepseek", {
    type: "environment",
    providerId: "deepseek",
    target: "codex",
    name: "UNRELATED_SECRET",
  }), undefined);
  assert.equal(resolveProviderCredentialReference("deepseek", {
    type: "keychain",
    providerId: "deepseek",
    target: "codex",
    service: "arbitrary-service",
  }), undefined);

  const external = path.join(root, "outside-secret.txt");
  writeFileSync(external, "TEST_SYMLINK_SECRET\n", { mode: 0o600 });
  rmSync(providerPath);
  symlinkSync(external, providerPath);
  assert.equal(resolveProviderCredentialReference("deepseek", ref()), undefined);
  assert.deepEqual(credentialPaths(PROVIDERS.get("deepseek")).filter((candidate) => candidate === providerPath), [providerPath]);
});

test("credential references written by every client resolve through the shared router plane", () => {
  writeProviderCredential("deepseek", "TEST_SHARED_PLANE_SECRET");
  const storePath = path.join(root, "state", "cross-target-references.json");
  const script = `
    const { addCredentialReference } = await import(${JSON.stringify(credentialStoreModule)});
    const { resolveProviderCredentialReference } = await import(${JSON.stringify(providerCredentialsModule)});
    const client = process.env.MODEL_ROUTER_TARGET;
    const entry = addCredentialReference({
      id: \`cred_cross_target_\${client}_123456\`,
      providerId: "deepseek",
      kind: "api_key",
      secretRef: { type: "provider-file", providerId: "deepseek" },
    });
    const credential = resolveProviderCredentialReference("deepseek", entry.secretRef);
    process.stdout.write(JSON.stringify({
      client,
      referenceTarget: entry.secretRef.target,
      resolved: credential?.value === "TEST_SHARED_PLANE_SECRET",
    }));
  `;
  for (const client of ["codex", "dsh", "gemini", "cursor", "claude", "openclaw"]) {
    const result = JSON.parse(execFileSync(process.execPath, [
      "--input-type=module",
      "--eval",
      script,
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        MODEL_ROUTER_TARGET: client,
        MODEL_ROUTER_PROVIDER_CREDENTIAL_STORE: storePath,
      },
    }));
    assert.deepEqual(result, {
      client,
      referenceTarget: "codex",
      resolved: true,
    });
  }
  const stored = JSON.parse(readFileSync(storePath, "utf8"));
  assert.equal(stored.credentials.length, 6);
  assert.deepEqual(new Set(stored.credentials.map((entry) => entry.secretRef.target)), new Set(["codex"]));
});

test("credential reference add and remove wait for concurrent state transactions", async () => {
  const filePath = path.join(root, "state", "concurrent-references.json");
  const id = "cred_concurrent_write_123456";
  const input = {
    id,
    providerId: "deepseek",
    kind: "api_key",
    secretRef: ref(),
  };

  const addHolder = await holdStateLock(filePath);
  const addStarted = Date.now();
  addCredentialReference(input, filePath);
  const addElapsed = Date.now() - addStarted;
  const addExit = await addHolder.exited;
  assert.equal(addExit.code, 0, addHolder.errors());
  assert.ok(addElapsed >= 200, `add bypassed the state lock (${addElapsed}ms)`);

  const removeHolder = await holdStateLock(filePath);
  const removeStarted = Date.now();
  assert.equal(removeCredentialReference(id, filePath), true);
  const removeElapsed = Date.now() - removeStarted;
  const removeExit = await removeHolder.exited;
  assert.equal(removeExit.code, 0, removeHolder.errors());
  assert.ok(removeElapsed >= 200, `remove bypassed the state lock (${removeElapsed}ms)`);
  assert.deepEqual(readProviderCredentialStore(filePath).credentials, []);
});
