import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-vertex-"));
process.env.CODEX_HOME = path.join(testRoot, "codex");
process.env.CODEX_ROUTER_STATE_DIR = path.join(testRoot, "state");
process.env.MODEL_ROUTER_VERTEX_STATE = path.join(
  process.env.CODEX_ROUTER_STATE_DIR,
  "vertex-settings.json",
);
process.env.GCLOUD_BIN = path.join(testRoot, "missing-gcloud");
for (const name of [
  "VERTEX_PROJECT_ID",
  "VERTEX_LOCATION",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GCLOUD_PROJECT",
]) {
  delete process.env[name];
}

const {
  VERTEX_STATE_PATH,
  readVertexSettings,
  resolveVertexConfiguration,
  setVertexConfiguration,
} = await import("../src/vertex-state.mjs");
const {
  clearVertexTokenCache,
  resolveVertexAccessToken,
  vertexCredentialStatus,
} = await import("../src/vertex-credentials.mjs");
const {
  credentialStatus,
  credentialPaths,
  resolveProviderCredential,
  writeProviderCredential,
} = await import("../src/provider-credentials.mjs");
const { createSupportBundle } = await import("../src/support-bundle.mjs");
const { PROVIDERS } = await import("../src/model-registry.mjs");
const { configureProvider: configureSharedProvider } = await import("../src/setup-shared.mjs");
const { privateFileIsProtected } = await import("../src/file-security.mjs");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const FIRST_TOKEN = "test-vertex-access-token-one";
const SECOND_TOKEN = "test-vertex-access-token-two";

test.after(() => rmSync(testRoot, { recursive: true, force: true }));

test("Vertex configuration is protected, resolves environment overrides, and stores no token", () => {
  setVertexConfiguration({ projectId: "state-project", location: "europe-west4" });

  assert.deepEqual(readVertexSettings(), {
    version: 1,
    projectId: "state-project",
    location: "europe-west4",
  });
  assert.equal(privateFileIsProtected(VERTEX_STATE_PATH), true);
  assert.doesNotMatch(readFileSync(VERTEX_STATE_PATH, "utf8"), /access-token|refresh-token/i);

  assert.deepEqual(
    resolveVertexConfiguration({
      env: {
        VERTEX_PROJECT_ID: "environment-project",
        VERTEX_LOCATION: "us-central1",
      },
    }),
    {
      configured: true,
      projectId: "environment-project",
      location: "us-central1",
      projectSource: "environment (VERTEX_PROJECT_ID)",
      locationSource: "environment (VERTEX_LOCATION)",
    },
  );
  assert.deepEqual(resolveVertexConfiguration({ env: {} }), {
    configured: true,
    projectId: "state-project",
    location: "europe-west4",
    projectSource: "protected state",
    locationSource: "protected state",
  });
});

test("Vertex credential status is redacted and does not expose the bearer token", () => {
  const resolved = resolveProviderCredential("vertex", {
    resolveAccessToken: () => FIRST_TOKEN,
  });
  assert.deepEqual(resolved, {
    value: FIRST_TOKEN,
    source: "Google Cloud Application Default Credentials (gcloud)",
    persistent: true,
    projectId: "state-project",
    location: "europe-west4",
  });

  const status = credentialStatus("vertex", {
    resolveAccessToken: () => FIRST_TOKEN,
  });

  assert.equal(status.configured, true);
  assert.equal(status.source, "Google Cloud Application Default Credentials (gcloud)");
  assert.equal(status.persistent, true);
  assert.equal(status.projectId, "state-project");
  assert.equal(status.location, "europe-west4");
  assert.equal("value" in status, false);
  assert.doesNotMatch(JSON.stringify(status), new RegExp(FIRST_TOKEN));
});

test("Vertex reports missing gcloud or ADC state without echoing command errors", () => {
  clearVertexTokenCache();
  const commandError = new Error("ADC token contents must never escape");
  commandError.code = "ENOENT";

  const status = vertexCredentialStatus({
    runCommand: () => {
      throw commandError;
    },
  });

  assert.equal(status.configured, false);
  assert.equal(status.reason, "gcloud-not-found");
  assert.match(status.setup, /gcloud/);
  assert.doesNotMatch(JSON.stringify(status), /ADC token contents/);
});

test("Vertex asks gcloud for an Application Default access token", () => {
  clearVertexTokenCache();
  const calls = [];
  const token = resolveVertexAccessToken({
    command: "gcloud-test",
    timeoutMs: 1_234,
    runCommand: (command, args, timeoutMs) => {
      calls.push({ command, args, timeoutMs });
      return FIRST_TOKEN;
    },
  });

  assert.equal(token, FIRST_TOKEN);
  assert.deepEqual(calls, [{
    command: "gcloud-test",
    args: ["auth", "application-default", "print-access-token"],
    timeoutMs: 1_234,
  }]);
});

test("Vertex access tokens are cached in memory until the refresh window expires", () => {
  clearVertexTokenCache();
  let calls = 0;
  const runCommand = () => {
    calls += 1;
    return calls === 1 ? FIRST_TOKEN : SECOND_TOKEN;
  };

  assert.equal(
    resolveVertexAccessToken({ runCommand, now: 1_000, cacheTtlMs: 100 }),
    FIRST_TOKEN,
  );
  assert.equal(
    resolveVertexAccessToken({ runCommand, now: 1_050, cacheTtlMs: 100 }),
    FIRST_TOKEN,
  );
  assert.equal(calls, 1);
  assert.equal(
    resolveVertexAccessToken({ runCommand, now: 1_100, cacheTtlMs: 100 }),
    SECOND_TOKEN,
  );
  assert.equal(calls, 2);
});

test("Vertex token resolution leaves no transient token file and rejects API-key writes", () => {
  clearVertexTokenCache();
  assert.equal(
    resolveVertexAccessToken({ runCommand: () => FIRST_TOKEN, now: 2_000 }),
    FIRST_TOKEN,
  );

  assert.throws(
    () => writeProviderCredential("vertex", FIRST_TOKEN),
    /does not accept API keys/i,
  );
  assert.equal(existsSync(path.join(process.env.CODEX_ROUTER_STATE_DIR, "vertex-api-key.secret")), false);
  assert.deepEqual(readdirSync(process.env.CODEX_ROUTER_STATE_DIR), ["vertex-settings.json"]);
  assert.doesNotMatch(readFileSync(VERTEX_STATE_PATH, "utf8"), new RegExp(FIRST_TOKEN));
});

test("control configures Vertex project and location without handling a credential", () => {
  clearVertexTokenCache();
  const result = spawnSync(
    process.execPath,
    [path.join(root, "src", "control.mjs"), "vertex", "set", "control-project", "asia-east1"],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_HOME: path.join(testRoot, "codex"),
        MODEL_ROUTER_STATE_DIR: path.join(testRoot, "state"),
        MODEL_ROUTER_VERTEX_STATE: VERTEX_STATE_PATH,
        GCLOUD_BIN: path.join(testRoot, "missing-gcloud"),
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.configuration.projectId, "control-project");
  assert.equal(output.configuration.location, "asia-east1");
  assert.equal(output.credential.configured, false);
  assert.doesNotMatch(result.stdout, /access-token|refresh-token/i);
});

test("provider-key refuses to collect or store a Vertex bearer token", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(root, "src", "provider-key.mjs"), "vertex", "set"],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_HOME: path.join(testRoot, "codex"),
        MODEL_ROUTER_STATE_DIR: path.join(testRoot, "state"),
        MODEL_ROUTER_VERTEX_STATE: VERTEX_STATE_PATH,
      },
      input: `${FIRST_TOKEN}\n`,
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not accept API keys/i);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(FIRST_TOKEN));
});

test("providers enable explains Vertex setup without suggesting an API-key command", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(root, "src", "providers.mjs"), "enable", "vertex"],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_HOME: path.join(testRoot, "codex"),
        MODEL_ROUTER_STATE_DIR: path.join(testRoot, "state"),
        MODEL_ROUTER_VERTEX_STATE: VERTEX_STATE_PATH,
        GCLOUD_BIN: path.join(testRoot, "missing-gcloud"),
      },
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /gcloud auth|application-default/i);
  assert.doesNotMatch(result.stderr, /provider-key vertex set/i);
});

test("control credential rejects Vertex input before reading it as an API key", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(root, "src", "control.mjs"), "credential", "vertex"],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_HOME: path.join(testRoot, "codex"),
        MODEL_ROUTER_STATE_DIR: path.join(testRoot, "state"),
        MODEL_ROUTER_VERTEX_STATE: VERTEX_STATE_PATH,
      },
      input: `${FIRST_TOKEN}\n`,
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not accept API keys/i);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(FIRST_TOKEN));
});

test("credential and support-bundle paths treat Vertex as keyless local auth", () => {
  assert.deepEqual(credentialPaths(PROVIDERS.get("vertex")), []);
  const output = path.join(testRoot, "vertex-support.json");
  const bundle = createSupportBundle({ output });
  assert.equal(bundle.path, output);
  const contents = readFileSync(output, "utf8");
  assert.doesNotMatch(contents, /access-token|refresh-token/i);
  assert.doesNotMatch(contents, /vertex-api-key\.secret/i);
});

test("setup reports the Vertex configuration command instead of opening an API-key prompt", () => {
  assert.throws(
    () => configureSharedProvider(PROVIDERS.get("vertex"), {
      guided: false,
      providerKeyCommand: () => "./bin/provider-key vertex set",
    }),
    /control vertex set|gcloud auth/i,
  );
});

test("doctor reports Vertex configuration and authentication failures without secrets", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(root, "src", "doctor.mjs"), "--json"],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_HOME: path.join(testRoot, "codex"),
        MODEL_ROUTER_STATE_DIR: path.join(testRoot, "state"),
        MODEL_ROUTER_VERTEX_STATE: VERTEX_STATE_PATH,
        GCLOUD_BIN: path.join(testRoot, "missing-gcloud"),
      },
    },
  );

  const output = JSON.parse(result.stdout);
  const check = output.checks.find((entry) => entry.name === "Google Cloud Vertex AI credentials");
  assert.ok(check);
  assert.equal(check.status, "fail");
  assert.match(check.fix, /gcloud|Vertex/i);
  assert.doesNotMatch(result.stdout + result.stderr, /access-token|refresh-token/i);
});
