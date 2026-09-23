import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-support-"));
const previousNoDiscovery = process.env.CODEX_ROUTER_NO_DISCOVERY;
process.env.CODEX_HOME = path.join(testRoot, "codex");
process.env.CODEX_ROUTER_STATE_DIR = path.join(testRoot, "state");
process.env.KIMI_CODE_HOME = path.join(testRoot, "kimi-code");
process.env.CODEX_ROUTER_SERVICE_PLATFORM = "linux";
process.env.CODEX_ROUTER_LAUNCH_AGENTS_DIR = path.join(testRoot, "LaunchAgents");
process.env.CODEX_ROUTER_SKIP_LAUNCHCTL = "1";
process.env.XDG_CONFIG_HOME = path.join(testRoot, "xdg");
process.env.CODEX_ROUTER_NO_DISCOVERY = "0";
delete process.env.DEEPSEEK_API_KEY;
delete process.env.CHUTES_API_KEY;
delete process.env.KIMI_API_KEY;
delete process.env.MOONSHOT_API_KEY;

mkdirSync(process.env.CODEX_ROUTER_STATE_DIR, { recursive: true, mode: 0o700 });
const genericHeaderSentinel = "TEST_SUPPORT_GENERIC_HEADER_MUST_NOT_APPEAR";
writeFileSync(
  path.join(process.env.CODEX_ROUTER_STATE_DIR, "generic-providers.json"),
  `${JSON.stringify({
    version: 1,
    providers: [{
      id: "support-generic",
      displayName: "Support Generic",
      baseUrl: "https://support-generic.example.test/v1",
      adapter: "openai-chat",
      headers: { "X-Private-Routing": genericHeaderSentinel },
      allowPrivate: false,
      enabled: true,
    }],
  }, null, 2)}\n`,
  { mode: 0o600 },
);

const {
  createSupportBundle,
  gitCommitForSourceRoot,
  redactSupportBundleObjectForTests,
} = await import("../src/support-bundle.mjs");

test("gitCommit reports only a commit that describes the installed tree", () => {
  const gitRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-git-"));
  const git = (args, cwd) => {
    const result = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git(["init", "-q", "-b", "main", "."], gitRoot);
    git(["config", "user.email", "test@example.test"], gitRoot);
    git(["config", "user.name", "Test"], gitRoot);
    writeFileSync(path.join(gitRoot, "package.json"), "{}\n");
    git(["add", "package.json"], gitRoot);
    git(["commit", "-qm", "init"], gitRoot);
    const head = git(["rev-parse", "HEAD"], gitRoot);

    // A Git checkout is the only install whose HEAD describes the router.
    assert.equal(gitCommitForSourceRoot(gitRoot), head);

    // The Homebrew shape from issue #761: the keg is not a repository, but the
    // Homebrew prefix above it is, so a plain `rev-parse HEAD` would answer
    // with brew.git's commit and misidentify the installed tree.
    const keg = path.join(gitRoot, "Cellar", "codex-router", "0.5.1", "libexec");
    mkdirSync(keg, { recursive: true });
    assert.equal(gitCommitForSourceRoot(keg), null);

    // A tarball outside any repository has no commit to report.
    const tarball = mkdtempSync(path.join(os.tmpdir(), "codex-router-tarball-"));
    try {
      assert.equal(gitCommitForSourceRoot(tarball), null);
    } finally {
      rmSync(tarball, { recursive: true, force: true });
    }
  } finally {
    rmSync(gitRoot, { recursive: true, force: true });
  }
});

test("support-bundle keeps --include-logs as a deprecated log-free no-op", () => {
  const entry = fileURLToPath(new URL("../src/support-bundle.mjs", import.meta.url));
  const help = spawnSync(process.execPath, [entry, "--help"], {
    encoding: "utf8",
    env: { ...process.env },
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Log contents are always excluded/);
  assert.doesNotMatch(help.stdout, /include-logs/);

  const compatible = spawnSync(process.execPath, [entry, "--include-logs", "--help"], {
    encoding: "utf8",
    env: { ...process.env },
  });
  assert.equal(compatible.status, 0, compatible.stderr);
  assert.match(compatible.stdout, /Log contents are always excluded/);
  assert.doesNotMatch(compatible.stdout, /include-logs/);
});

test("support bundle structurally redacts even one-character secrets", () => {
  assert.deepEqual(
    redactSupportBundleObjectForTests({
      client_secret: "x",
      accessToken: "a",
      nested: { access_token: "y", "x-api-key": "z" },
      credentialSources: { deepseek: { configured: true } },
    }),
    {
      client_secret: "[REDACTED]",
      accessToken: "[REDACTED]",
      nested: { access_token: "[REDACTED]", "x-api-key": "[REDACTED]" },
      credentialSources: { deepseek: { configured: true } },
    },
  );
});

test("support bundle reports credential presence without including values", async () => {
  const stateDir = process.env.CODEX_ROUTER_STATE_DIR;
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const sentinel = "TEST_SUPPORT_BUNDLE_SECRET_MUST_NOT_APPEAR";
  const chutesSentinel = "TEST_SUPPORT_CHUTES_SECRET_MUST_NOT_APPEAR";
  const copilotSentinel = "github_pat_TEST_SUPPORT_COPILOT_SECRET_MUST_NOT_APPEAR";
  const callerSentinel =
    "TEST_SUPPORT_CALLER_CAPABILITY_MUST_NOT_APPEAR_ANYWHERE";
  const oauthClientId =
    "TEST_SUPPORT_OPERATOR_CLIENT_ID.apps.googleusercontent.com";
  const oauthClientSecret = "TEST_SUPPORT_OPERATOR_CLIENT_SECRET_MUST_NOT_APPEAR";
  const oauthAccessToken = "TEST_SUPPORT_OAUTH_ACCESS_MUST_NOT_APPEAR";
  const oauthRefreshToken = "TEST_SUPPORT_OAUTH_REFRESH_MUST_NOT_APPEAR";
  const rotatedDeletedSecret = "TEST_SUPPORT_ROTATED_DELETED_SECRET_MUST_NOT_APPEAR";
  const poolSentinel = "TEST_SUPPORT_POOL_SECRET_MUST_NOT_APPEAR";
  const credentialIdSentinel = "cred_TEST_SUPPORT_CREDENTIAL_ID_MUST_NOT_APPEAR";
  const sessionIdSentinel = "TEST_SUPPORT_SESSION_ID_MUST_NOT_APPEAR";
  const healthErrorSentinel = "TEST_SUPPORT_HEALTH_ERROR_MUST_NOT_APPEAR";
  process.env.OPENCODE_API_KEY = poolSentinel;
  writeFileSync(path.join(stateDir, "deepseek-api-key.secret"), `${sentinel}\n`, {
    mode: 0o600,
  });
  writeFileSync(path.join(stateDir, "chutes-api-key.secret"), `${chutesSentinel}\n`, {
    mode: 0o600,
  });
  writeFileSync(path.join(stateDir, "github-copilot-token.secret"), `${copilotSentinel}\n`, {
    mode: 0o600,
  });
  writeFileSync(path.join(stateDir, "caller-secret"), `${callerSentinel}\n`, {
    mode: 0o600,
  });
  writeFileSync(
    path.join(stateDir, "antigravity-oauth.json"),
    `${JSON.stringify({
      version: 3,
      managed_by: "codex-router",
      session_generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      client_id: oauthClientId,
      client_secret: oauthClientSecret,
      access_token: oauthAccessToken,
      refresh_token: oauthRefreshToken,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      expires_in: 3600,
      project_id: "support-bundle-managed-project",
      project_source: "managed",
      probe_version: 1,
      probe_verified_at: Date.now(),
      probe_model: "gemini-3.1-pro",
      probe_activation: {
        version: 1,
        state: "pending_activation",
        generation: "66666666-6666-4666-8666-666666666666",
      },
    })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    path.join(stateDir, "router.log"),
    `${oauthClientId} ${oauthClientSecret} ${oauthAccessToken} ${oauthRefreshToken} ${rotatedDeletedSecret}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: ["chutes", "deepseek"] })}\n`,
    { mode: 0o600 },
  );
  const codexHome = process.env.CODEX_HOME;
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(codexHome, "config.toml"),
    `# BEGIN codex-router-managed
openai_base_url = "http://127.0.0.1:4102/_codex-router/${callerSentinel}/v1"
model_catalog_json = ${JSON.stringify(path.join(stateDir, "merged-models.json"))}
# END codex-router-managed
`,
    { mode: 0o600 },
  );
  const { addEnvironmentCredentialToPool } = await import("../src/provider-api-key-control.mjs");
  await addEnvironmentCredentialToPool("opencode-go", "OPENCODE_API_KEY");
  const poolPath = path.join(stateDir, "provider-api-key-pools.json");
  const poolState = JSON.parse(readFileSync(poolPath, "utf8"));
  const providerPool = poolState.providers["opencode-go"];
  const originalId = Object.keys(providerPool.credentials)[0];
  providerPool.credentials[credentialIdSentinel] = {
    ...providerPool.credentials[originalId],
    id: credentialIdSentinel,
    health: { state: "failed", lastError: healthErrorSentinel },
  };
  delete providerPool.credentials[originalId];
  providerPool.sessions[sessionIdSentinel] = {
    credentialId: credentialIdSentinel,
    turns: 1,
    requests: 1,
    boundAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(poolPath, `${JSON.stringify(poolState, null, 2)}\n`, { mode: 0o600 });

  try {
    const result = createSupportBundle({ includeLogs: true });
    const contents = readFileSync(result.path, "utf8");
    const bundle = JSON.parse(contents);
    assert.equal(bundle.credentialSources.deepseek.configured, true);
    assert.equal(bundle.credentialSources.chutes.configured, true);
    assert.equal(bundle.credentialSources["github-copilot"].configured, true);
    assert.equal(bundle.apiKeyPools.providers["opencode-go"].readiness.usable, false);
    assert.deepEqual(bundle.credentialSources["support-generic"], {
      configured: true,
      source: "not required",
      persistent: false,
    });
    assert.doesNotMatch(contents, new RegExp(sentinel));
    assert.doesNotMatch(contents, new RegExp(chutesSentinel));
    assert.doesNotMatch(contents, new RegExp(copilotSentinel));
    assert.doesNotMatch(contents, new RegExp(callerSentinel));
    assert.doesNotMatch(contents, new RegExp(oauthClientId.replaceAll(".", "\\.")));
    assert.doesNotMatch(contents, new RegExp(oauthClientSecret));
    assert.doesNotMatch(contents, new RegExp(oauthAccessToken));
    assert.doesNotMatch(contents, new RegExp(oauthRefreshToken));
    assert.doesNotMatch(contents, new RegExp(rotatedDeletedSecret));
    assert.doesNotMatch(contents, new RegExp(poolSentinel));
    assert.doesNotMatch(contents, new RegExp(credentialIdSentinel));
    assert.doesNotMatch(contents, new RegExp(sessionIdSentinel));
    assert.doesNotMatch(contents, new RegExp(healthErrorSentinel));
    assert.deepEqual(Object.keys(bundle.apiKeyPools.providers["opencode-go"]).sort(), [
      "credentialCount",
      "eligibleCredentialCount",
      "readiness",
      "resolvableCredentialCount",
    ]);
    assert.doesNotMatch(contents, new RegExp(genericHeaderSentinel));
    assert.match(bundle.config.openai_base_url, /\[REDACTED\]/);
    assert.equal(result.includedLogs, false);
    assert.equal("redactedLogTail" in bundle, false);
    assert.match(bundle.privacy, /historical logs cannot be proven/i);

    // In no-discovery mode the bundle must not inspect the OAuth record merely
    // to learn values to redact from an old log. Omitting that arbitrary text
    // is the only safe way to honor both promises.
    process.env.CODEX_ROUTER_NO_DISCOVERY = "1";
    const privateResult = createSupportBundle({ includeLogs: true });
    const privateContents = readFileSync(privateResult.path, "utf8");
    const privateBundle = JSON.parse(privateContents);
    assert.equal(privateResult.includedLogs, false);
    assert.equal("redactedLogTail" in privateBundle, false);
    assert.match(privateBundle.privacy, /historical logs cannot be proven/i);
    assert.doesNotMatch(privateContents, new RegExp(oauthClientId.replaceAll(".", "\\.")));
    assert.doesNotMatch(privateContents, new RegExp(oauthClientSecret));
    assert.doesNotMatch(privateContents, new RegExp(oauthAccessToken));
    assert.doesNotMatch(privateContents, new RegExp(oauthRefreshToken));
    assert.doesNotMatch(privateContents, new RegExp(callerSentinel));
    assert.doesNotMatch(privateContents, new RegExp(sentinel));
    assert.doesNotMatch(privateContents, new RegExp(chutesSentinel));
    assert.doesNotMatch(privateContents, new RegExp(copilotSentinel));

    // Pin the control-flow boundary as well as the serialized outcome: the
    // no-discovery return must stay ahead of the first OAuth-record read. This
    // catches a future refactor that still omits logs but quietly inspects the
    // credential while preparing redaction values.
    const implementation = readFileSync(
      new URL("../src/support-bundle.mjs", import.meta.url),
      "utf8",
    );
    const collector = implementation.indexOf("function knownLocalSecrets()");
    const noDiscoveryGuard = implementation.indexOf(
      'if (discoveryDisabled()) return { status: "disabled", values: [] };',
      collector,
    );
    const oauthRecordRead = implementation.indexOf(
      "privateText(antigravityTokenPath())",
      collector,
    );
    assert.ok(collector >= 0 && noDiscoveryGuard > collector && oauthRecordRead > noDiscoveryGuard);
  } finally {
    delete process.env.OPENCODE_API_KEY;
    if (previousNoDiscovery === undefined) delete process.env.CODEX_ROUTER_NO_DISCOVERY;
    else process.env.CODEX_ROUTER_NO_DISCOVERY = previousNoDiscovery;
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("support bundle omits every historical log source", async (t) => {
  const stateDir = process.env.CODEX_ROUTER_STATE_DIR;
  const logPath = path.join(stateDir, "router.log");
  const previousDiscovery = process.env.CODEX_ROUTER_NO_DISCOVERY;
  process.env.CODEX_ROUTER_NO_DISCOVERY = "0";
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });

  function bundle(label) {
    const result = createSupportBundle({
      includeLogs: true,
      output: path.join(testRoot, `${label}-log-source-bundle.json`),
    });
    return {
      result,
      contents: readFileSync(result.path, "utf8"),
      value: JSON.parse(readFileSync(result.path, "utf8")),
    };
  }

  try {
    await t.test("symbolic link", { skip: process.platform === "win32" }, () => {
      const sentinel = "LOG_SYMLINK_TARGET_MUST_NOT_BE_READ";
      const target = path.join(testRoot, "linked-router-log");
      writeFileSync(target, `${sentinel}\n`, { mode: 0o600 });
      symlinkSync(target, logPath);
      try {
        const output = bundle("symlink");
        assert.equal(output.result.includedLogs, false);
        assert.equal("redactedLogTail" in output.value, false);
        assert.match(output.value.privacy, /historical logs cannot be proven/i);
        assert.doesNotMatch(output.contents, new RegExp(sentinel));
      } finally {
        rmSync(logPath, { force: true });
        rmSync(target, { force: true });
      }
    });

    await t.test("directory", () => {
      mkdirSync(logPath, { mode: 0o700 });
      try {
        const output = bundle("directory");
        assert.equal(output.result.includedLogs, false);
        assert.equal("redactedLogTail" in output.value, false);
        assert.match(output.value.privacy, /historical logs cannot be proven/i);
      } finally {
        rmSync(logPath, { recursive: true, force: true });
      }
    });

    await t.test("oversized regular file", () => {
      const sentinel = "LOG_PREFIX_OUTSIDE_BOUNDED_TAIL_MUST_NOT_APPEAR";
      writeFileSync(
        logPath,
        `${sentinel}\n${"x".repeat(300 * 1024)}\nSAFE_LOG_TAIL_MARKER\n`,
        { mode: 0o600 },
      );
      try {
        const output = bundle("bounded");
        assert.equal(output.result.includedLogs, false);
        assert.equal("redactedLogTail" in output.value, false);
        assert.doesNotMatch(output.contents, /SAFE_LOG_TAIL_MARKER/);
        assert.doesNotMatch(output.contents, new RegExp(sentinel));
      } finally {
        rmSync(logPath, { force: true });
      }
    });
  } finally {
    if (previousDiscovery === undefined) delete process.env.CODEX_ROUTER_NO_DISCOVERY;
    else process.env.CODEX_ROUTER_NO_DISCOVERY = previousDiscovery;
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("support bundle omits logs when the OAuth credential source is unsafe", async (t) => {
  const stateDir = process.env.CODEX_ROUTER_STATE_DIR;
  const oauthPath = path.join(stateDir, "antigravity-oauth.json");
  const logPath = path.join(stateDir, "router.log");
  const previousDiscovery = process.env.CODEX_ROUTER_NO_DISCOVERY;
  process.env.CODEX_ROUTER_NO_DISCOVERY = "0";
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });

  function credential(secret) {
    return `${JSON.stringify({
      version: 3,
      managed_by: "codex-router",
      session_generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      client_id: "support-bundle-unsafe-test.apps.googleusercontent.com",
      client_secret: secret,
      access_token: `access-${secret}`,
      refresh_token: `refresh-${secret}`,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      expires_in: 3600,
    })}\n`;
  }

  function assertLogsOmitted(label, sentinel) {
    writeFileSync(logPath, `arbitrary log value ${sentinel}\n`, { mode: 0o600 });
    const result = createSupportBundle({
      includeLogs: true,
      output: path.join(testRoot, `${label}-bundle.json`),
    });
    const contents = readFileSync(result.path, "utf8");
    const bundle = JSON.parse(contents);
    assert.equal(result.includedLogs, false);
    assert.equal("redactedLogTail" in bundle, false);
    assert.match(bundle.privacy, /historical logs cannot be proven/i);
    assert.doesNotMatch(contents, new RegExp(sentinel));
  }

  function clearOAuthPath() {
    rmSync(oauthPath, { recursive: true, force: true });
  }

  try {
    await t.test("symbolic link", { skip: process.platform === "win32" }, () => {
      const sentinel = "UNRECOGNIZED_SYMLINK_CREDENTIAL_SENTINEL";
      const linkedCredential = path.join(testRoot, "linked-antigravity-oauth.json");
      writeFileSync(linkedCredential, credential(sentinel), { mode: 0o600 });
      symlinkSync(linkedCredential, oauthPath);
      try {
        assertLogsOmitted("symlink", sentinel);
      } finally {
        clearOAuthPath();
        rmSync(linkedCredential, { force: true });
      }
    });

    await t.test("directory", () => {
      const sentinel = "UNRECOGNIZED_DIRECTORY_CREDENTIAL_SENTINEL";
      mkdirSync(oauthPath, { mode: 0o700 });
      try {
        assertLogsOmitted("directory", sentinel);
      } finally {
        clearOAuthPath();
      }
    });

    await t.test("malformed JSON", () => {
      const sentinel = "UNRECOGNIZED_MALFORMED_CREDENTIAL_SENTINEL";
      writeFileSync(oauthPath, `{"client_secret":"${sentinel}"`, { mode: 0o600 });
      try {
        assertLogsOmitted("malformed", sentinel);
      } finally {
        clearOAuthPath();
      }
    });

    await t.test("invalid credential shape", () => {
      const sentinel = "UNRECOGNIZED_INVALID_CREDENTIAL_SENTINEL";
      writeFileSync(oauthPath, `${JSON.stringify({
        version: 2,
        managed_by: "codex-router",
        client_id: "support-bundle-invalid-test.apps.googleusercontent.com",
        client_secret: sentinel,
      })}\n`, { mode: 0o600 });
      try {
        assertLogsOmitted("invalid", sentinel);
      } finally {
        clearOAuthPath();
      }
    });

    await t.test("unreadable regular file", { skip: process.platform === "win32" }, (context) => {
      const sentinel = "UNRECOGNIZED_UNREADABLE_CREDENTIAL_SENTINEL";
      writeFileSync(oauthPath, credential(sentinel), { mode: 0o600 });
      chmodSync(oauthPath, 0o000);
      try {
        try {
          readFileSync(oauthPath, "utf8");
          context.skip("this runtime can read owner-mode-000 files");
          return;
        } catch {
          assertLogsOmitted("unreadable", sentinel);
        }
      } finally {
        chmodSync(oauthPath, 0o600);
        clearOAuthPath();
      }
    });
  } finally {
    if (previousDiscovery === undefined) delete process.env.CODEX_ROUTER_NO_DISCOVERY;
    else process.env.CODEX_ROUTER_NO_DISCOVERY = previousDiscovery;
    rmSync(testRoot, { recursive: true, force: true });
  }
});
