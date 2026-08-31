import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  authenticatedRoute,
  callerBaseUrl,
  claudeBaseUrl,
  cursorCliBaseUrl,
  geminiBaseUrl,
  isManagedCallerBaseUrl,
  isManagedCodexBaseUrl,
  isManagedClaudeBaseUrl,
  isManagedGeminiBaseUrl,
  redactCallerUrl,
} from "../src/caller-auth.mjs";
import { privateFileIsProtected } from "../src/file-security.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const secretTool = path.join(root, "src", "secret.mjs");
const CALLER_KEY = "test-caller-auth-capability-with-sufficient-length";

test("caller capability helpers accept only the secret-bearing path and redact it", () => {
  const baseUrl = callerBaseUrl(46192, CALLER_KEY);
  assert.equal(
    baseUrl,
    `http://127.0.0.1:46192/_codex-router/${CALLER_KEY}/v1`,
  );
  assert.equal(
    authenticatedRoute(`/_codex-router/${CALLER_KEY}/v1/responses`, CALLER_KEY),
    "/v1/responses",
  );
  assert.equal(
    authenticatedRoute(
      "/_codex-router/wrong-caller-capability-with-sufficient-length/v1/responses",
      CALLER_KEY,
    ),
    undefined,
  );
  assert.equal(authenticatedRoute("/v1/responses", CALLER_KEY), undefined);
  assert.equal(isManagedCallerBaseUrl(baseUrl, 46192), true);
  assert.equal(isManagedCallerBaseUrl(baseUrl), true);
  assert.equal(isManagedCallerBaseUrl(baseUrl, 4102), false);
  assert.equal(isManagedCallerBaseUrl(callerBaseUrl(80, CALLER_KEY), 80), true);
  assert.equal(
    redactCallerUrl(baseUrl),
    "http://127.0.0.1:46192/_codex-router/[REDACTED]/v1",
  );
});

test("managed Codex base accepts secret-bearing and plain authenticated loopback endpoints", () => {
  assert.equal(isManagedCodexBaseUrl(callerBaseUrl(46192, CALLER_KEY), 46192), true);
  assert.equal(isManagedCodexBaseUrl("http://127.0.0.1:46192/v1", 46192), true);
  assert.equal(isManagedCodexBaseUrl("http://127.0.0.1:46192/v1/", 46192), true);
  assert.equal(isManagedCodexBaseUrl("http://127.0.0.1:4102/v1", 46192), false);
  assert.equal(isManagedCodexBaseUrl("https://127.0.0.1:46192/v1", 46192), false);
  assert.equal(isManagedCodexBaseUrl("http://127.0.0.1:46192/gemini", 46192), false);
});

test("caller capability redaction works inside quoted config documents", () => {
  const baseUrl = callerBaseUrl(46192, CALLER_KEY);
  const document = `openai_base_url = ${JSON.stringify(baseUrl)}\n`;
  assert.equal(redactCallerUrl(document), 'openai_base_url = "http://127.0.0.1:46192/_codex-router/[REDACTED]/v1"\n');
});
test("the gemini leaf sits behind the same capability and is redacted with it", () => {
  // Gemini CLI appends `/v1beta/models/...` to whatever base URL it is given,
  // so the capability has to be a path prefix here exactly as it is for `/v1`.
  // A leaf that redaction does not know about is a caller key printed verbatim
  // into doctor output, status output, and support bundles.
  const baseUrl = geminiBaseUrl(46192, CALLER_KEY);
  assert.equal(baseUrl, `http://127.0.0.1:46192/_codex-router/${CALLER_KEY}/gemini`);
  assert.equal(
    authenticatedRoute(
      `/_codex-router/${CALLER_KEY}/gemini/v1beta/models/vendor/model:generateContent`,
      CALLER_KEY,
    ),
    "/gemini/v1beta/models/vendor/model:generateContent",
  );
  assert.equal(
    redactCallerUrl(baseUrl),
    "http://127.0.0.1:46192/_codex-router/[REDACTED]/gemini",
  );
  assert.equal(
    redactCallerUrl(`${baseUrl}/v1beta/models`),
    "http://127.0.0.1:46192/_codex-router/[REDACTED]/gemini/v1beta/models",
  );
  assert.equal(isManagedGeminiBaseUrl(baseUrl, 46192), true);
  assert.equal(isManagedGeminiBaseUrl(baseUrl, 4102), false);
  assert.equal(isManagedGeminiBaseUrl(callerBaseUrl(46192, CALLER_KEY), 46192), false);
  assert.equal(isManagedGeminiBaseUrl(`${baseUrl}?key=x`, 46192), false);
});

test("the Claude gateway leaf sits behind and redacts the same capability", () => {
  const baseUrl = claudeBaseUrl(46192, CALLER_KEY);
  assert.equal(baseUrl, `http://127.0.0.1:46192/_codex-router/${CALLER_KEY}/anthropic`);
  assert.equal(isManagedClaudeBaseUrl(baseUrl, 46192), true);
  assert.equal(isManagedClaudeBaseUrl(baseUrl, 4102), false);
  assert.equal(
    redactCallerUrl(`${baseUrl}/v1/messages`),
    "http://127.0.0.1:46192/_codex-router/[REDACTED]/anthropic/v1/messages",
  );
});

test("Cursor Agent uses the capability root and it is redacted", () => {
  const baseUrl = cursorCliBaseUrl(46192, CALLER_KEY);
  assert.equal(baseUrl, `http://127.0.0.1:46192/_codex-router/${CALLER_KEY}`);
  assert.equal(redactCallerUrl(baseUrl), "http://127.0.0.1:46192/_codex-router/[REDACTED]");
  assert.equal(
    authenticatedRoute(`/_codex-router/${CALLER_KEY}/agent.v1.AgentService/RunSSE`, CALLER_KEY),
    "/agent.v1.AgentService/RunSSE",
  );
});

test("secret setup creates stable, separate, current-user-only keys", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-secrets-"));
  const codexHome = path.join(testRoot, "codex");
  const stateDir = path.join(testRoot, "state");
  const env = {
    ...process.env,
    CODEX_HOME: codexHome,
    CODEX_ROUTER_STATE_DIR: stateDir,
  };

  try {
    const first = JSON.parse(
      execFileSync(process.execPath, [secretTool, "ensure"], {
        cwd: root,
        env,
        encoding: "utf8",
      }),
    );
    const internalPath = path.join(stateDir, "internal-secret");
    const callerPath = path.join(stateDir, "caller-secret");
    const cursorPublicPath = path.join(stateDir, "cursor-public-secret");
    const internal = readFileSync(internalPath, "utf8").trim();
    const caller = readFileSync(callerPath, "utf8").trim();
    const cursorPublic = readFileSync(cursorPublicPath, "utf8").trim();
    assert.equal(first.present, true);
    assert.equal(first.internal.present, true);
    assert.equal(first.caller.present, true);
    assert.equal(first.cursorPublic.present, true);
    assert.notEqual(internal, caller);
    assert.notEqual(cursorPublic, caller);
    assert.match(internal, /^[A-Za-z0-9_-]{64}$/);
    assert.match(caller, /^[A-Za-z0-9_-]{64}$/);
    assert.match(cursorPublic, /^[A-Za-z0-9_-]{64}$/);
    assert.equal(privateFileIsProtected(internalPath), true);
    assert.equal(privateFileIsProtected(callerPath), true);
    assert.equal(privateFileIsProtected(cursorPublicPath), true);

    execFileSync(process.execPath, [secretTool, "ensure"], {
      cwd: root,
      env,
      stdio: "ignore",
    });
    assert.equal(readFileSync(internalPath, "utf8").trim(), internal);
    assert.equal(readFileSync(callerPath, "utf8").trim(), caller);
    assert.equal(readFileSync(cursorPublicPath, "utf8").trim(), cursorPublic);

    writeFileSync(callerPath, "invalid\n", { mode: 0o600 });
    execFileSync(process.execPath, [secretTool, "ensure"], {
      cwd: root,
      env,
      stdio: "ignore",
    });
    const repairedCaller = readFileSync(callerPath, "utf8").trim();
    assert.notEqual(repairedCaller, "invalid");
    assert.match(repairedCaller, /^[A-Za-z0-9_-]{64}$/);
    assert.equal(readFileSync(internalPath, "utf8").trim(), internal);
    assert.equal(privateFileIsProtected(callerPath), true);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});
