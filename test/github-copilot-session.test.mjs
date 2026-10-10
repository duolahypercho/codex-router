import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const stateRoot = mkdtempSync(path.join(os.tmpdir(), "copilot-session-test-"));
const savedState = process.env.MODEL_ROUTER_STATE_DIR;
process.env.MODEL_ROUTER_STATE_DIR = stateRoot;
after(() => {
  rmSync(stateRoot, { recursive: true, force: true });
  if (savedState === undefined) delete process.env.MODEL_ROUTER_STATE_DIR;
  else process.env.MODEL_ROUTER_STATE_DIR = savedState;
});

const {
  assertGitHubCopilotCredential,
  copilotApiBaseUrl,
  ensureFreshGitHubCopilotSession,
  githubCopilotCredentialProblem,
  githubCopilotRequestHeaders,
  resetGitHubCopilotSessionForTests,
  resolveGitHubCopilotConfiguration,
} = await import("../src/github-copilot-session.mjs");

function configuration(host, env = {}) {
  return resolveGitHubCopilotConfiguration({ settings: { host }, env });
}

test("Copilot validates once and reuses fresh account routing", async () => {
  resetGitHubCopilotSessionForTests();
  let calls = 0;
  const fetchImpl = async (_url, options) => {
    calls += 1;
    assert.equal(options.headers.Authorization, "Bearer github_pat_TEST_SOURCE_TOKEN");
    assert.equal(options.headers["Editor-Version"], "vscode/1.107.0");
    assert.equal(options.headers["Editor-Plugin-Version"], "copilot-chat/0.35.0");
    assert.match(options.headers["User-Agent"], /^GitHubCopilotChat\/0\.35\.0/);
    assert.equal(options.headers["Accept-Encoding"], "identity");
    assert.equal(options.headers["X-GitHub-Api-Version"], "2025-04-01");
    return new Response(JSON.stringify({
      endpoints: { api: "https://api.individual.githubcopilot.com" },
    }), { status: 200 });
  };

  const first = await ensureFreshGitHubCopilotSession("github_pat_TEST_SOURCE_TOKEN", {
    fetchImpl,
    now: 1_000,
  });
  const second = await ensureFreshGitHubCopilotSession("github_pat_TEST_SOURCE_TOKEN", {
    fetchImpl,
    now: 2_000,
  });

  assert.equal(calls, 1);
  assert.equal(first, second);
  assert.equal(first.token, "github_pat_TEST_SOURCE_TOKEN");
  assert.equal(first.baseUrl, "https://api.individual.githubcopilot.com");
});

test("Copilot account routing is single-flight", async () => {
  resetGitHubCopilotSessionForTests();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return new Response(JSON.stringify({ endpoints: {} }));
  };
  const [first, second] = await Promise.all([
    ensureFreshGitHubCopilotSession("github_pat_TEST_SOURCE", { fetchImpl, now: 1_000 }),
    ensureFreshGitHubCopilotSession("github_pat_TEST_SOURCE", { fetchImpl, now: 1_000 }),
  ]);
  assert.equal(calls, 1);
  assert.equal(first, second);
});

test("Copilot account routing cache is scoped to the exact source token", async () => {
  resetGitHubCopilotSessionForTests();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(JSON.stringify({ endpoints: {} }));
  };
  await ensureFreshGitHubCopilotSession("github_pat_TEST_SOURCE_A", {
    fetchImpl,
    now: 1_000,
  });
  await ensureFreshGitHubCopilotSession("github_pat_TEST_SOURCE_B", {
    fetchImpl,
    now: 2_000,
  });
  assert.equal(calls, 2);
});

test("Copilot account metadata cannot redirect credentials off GitHub", () => {
  assert.equal(
    copilotApiBaseUrl({ endpoints: { api: "https://githubcopilot.com/" } }),
    "https://githubcopilot.com",
  );
  assert.equal(
    copilotApiBaseUrl({ endpoints: { api: "https://api.business.githubcopilot.com/path/" } }),
    "https://api.business.githubcopilot.com/path",
  );
  assert.throws(
    () => copilotApiBaseUrl({ endpoints: { api: "https://attacker.example" } }),
    /invalid Copilot inference endpoint/,
  );
  assert.throws(
    () => copilotApiBaseUrl({ endpoints: { api: "http://api.githubcopilot.com" } }),
    /invalid Copilot inference endpoint/,
  );
});

test("Copilot authentication failures never echo the source token", async () => {
  resetGitHubCopilotSessionForTests();
  await assert.rejects(
    ensureFreshGitHubCopilotSession("github_pat_TEST_SECRET_SOURCE_TOKEN", {
      fetchImpl: async () => new Response("TEST_SECRET_SOURCE_TOKEN", { status: 401 }),
    }),
    (error) => {
      assert.equal(error.status, 503);
      assert.equal(error.providerStatus, 401);
      assert.doesNotMatch(error.message, /TEST_SECRET_SOURCE_TOKEN/);
      return true;
    },
  );
});

test("Copilot rejects classic and malformed tokens before network access", () => {
  assert.match(githubCopilotCredentialProblem("ghp_CLASSIC"), /Classic GitHub PATs/);
  assert.match(githubCopilotCredentialProblem("not-a-token"), /fine-grained GitHub PAT/);
  assert.equal(githubCopilotCredentialProblem("github_pat_FINE_GRAINED"), undefined);
  assert.equal(githubCopilotCredentialProblem("gho_OAUTH"), undefined);
  assert.equal(
    assertGitHubCopilotCredential("  github_pat_FINE_GRAINED  "),
    "github_pat_FINE_GRAINED",
  );
});

test("Copilot request headers classify user, agent, and vision turns", () => {
  const user = githubCopilotRequestHeaders({ input: "hello" }, "TEST_COPILOT_TOKEN");
  assert.equal(user.Authorization, "Bearer TEST_COPILOT_TOKEN");
  assert.equal(user["Copilot-Integration-Id"], "copilot-developer-cli");
  assert.equal(user["X-Initiator"], "user");
  assert.equal(user["X-GitHub-Api-Version"], "2026-06-01");
  assert.equal(user["Copilot-Vision-Request"], undefined);

  const agent = githubCopilotRequestHeaders({
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_image", image_url: "data:image/png;base64,AAA" }],
      },
      { type: "function_call_output", call_id: "call-1", output: "ok" },
    ],
  }, "TEST_COPILOT_TOKEN");
  assert.equal(agent["X-Initiator"], "agent");
  assert.equal(agent["Copilot-Vision-Request"], "true");
});

test("Copilot configuration binds account and inference overrides to the selected tenant", () => {
  const selected = configuration("octocorp.ghe.com");
  assert.equal(selected.userUrl, "https://api.octocorp.ghe.com/copilot_internal/user");
  assert.equal(selected.dashboardUrl, "https://octocorp.ghe.com/settings/copilot");
  assert.equal(Object.isFrozen(selected), true);
  for (const userUrl of ["https://api.github.com/copilot_internal/user", "https://api.othercorp.ghe.com/copilot_internal/user", "http://api.octocorp.ghe.com/copilot_internal/user", "https://user@api.octocorp.ghe.com/copilot_internal/user", "https://api.octocorp.ghe.com:8443/copilot_internal/user", "https://api.octocorp.ghe.com/copilot_internal/user?x=1"]) {
    assert.throws(() => configuration("octocorp.ghe.com", { GITHUB_COPILOT_USER_URL: userUrl }), /must match the selected/);
  }
  for (const baseUrl of ["https://api.individual.githubcopilot.com", "https://copilot-api.othercorp.ghe.com", "http://127.0.0.1:1234", "https://api.octocorp.ghe.com"]) {
    assert.throws(() => configuration("octocorp.ghe.com", { GITHUB_COPILOT_BASE_URL: baseUrl }), /must use a Copilot endpoint/);
  }
  const overridden = configuration("octocorp.ghe.com", { GITHUB_COPILOT_BASE_URL: "https://copilot-api.octocorp.ghe.com/" });
  assert.equal(overridden.baseUrlOverride, "https://copilot-api.octocorp.ghe.com");
  assert.notEqual(overridden.identity, selected.identity);
  const local = configuration("octocorp.ghe.com", {
    GITHUB_COPILOT_USER_URL: "http://127.0.0.1:1234/user",
    GITHUB_COPILOT_BASE_URL: "http://127.0.0.1:1234",
  });
  assert.equal(local.baseUrlOverride, "http://127.0.0.1:1234");
  assert.notEqual(local.identity, selected.identity);
  // The existing public foreground override remains supported.
  assert.equal(configuration("github.com", { GITHUB_COPILOT_BASE_URL: "http://127.0.0.1:1234" }).baseUrlOverride, "http://127.0.0.1:1234");
});

test("Copilot enterprise inference requires a same-tenant API or proxy endpoint", () => {
  const selected = configuration("octocorp.ghe.com");
  for (const host of ["copilot-api.octocorp.ghe.com", "copilot-proxy.octocorp.ghe.com"]) {
    assert.equal(copilotApiBaseUrl({ endpoints: { api: `https://${host}/` } }, undefined, selected), `https://${host}`);
  }
  assert.throws(() => copilotApiBaseUrl({ endpoints: {} }, undefined, selected), /no Copilot inference endpoint/);
  for (const endpoint of ["https://api.individual.githubcopilot.com", "https://copilot-api.othercorp.ghe.com", "https://copilot-api.octocorp.ghe.com.example", "https://api.octocorp.ghe.com", "http://copilot-api.octocorp.ghe.com", "https://user@copilot-api.octocorp.ghe.com", "https://copilot-api.octocorp.ghe.com:8443", "https://copilot-api.octocorp.ghe.com/?x=1", "https://copilot-api.octocorp.ghe.com/#x"]) {
    assert.throws(() => copilotApiBaseUrl({ endpoints: { api: endpoint } }, undefined, selected), /invalid Copilot inference endpoint/);
  }
});

test("Copilot sessions and pending requests are isolated by host and force refresh keeps its snapshot", async () => {
  resetGitHubCopilotSessionForTests();
  const firstConfiguration = configuration("octocorp.ghe.com");
  const otherConfiguration = configuration("othercorp.ghe.com");
  const calls = [];
  let releaseFirst;
  const waitFirst = new Promise((resolve) => { releaseFirst = resolve; });
  const fetchImpl = async (url, options) => {
    calls.push(String(url));
    assert.equal(options.redirect, "error");
    const host = url.hostname.slice(4);
    if (host === "octocorp.ghe.com" && calls.length === 1) await waitFirst;
    return new Response(JSON.stringify({ endpoints: { api: `https://copilot-api.${host}` } }));
  };
  const token = "github_pat_TEST_SAME_TOKEN";
  const first = ensureFreshGitHubCopilotSession(token, { configuration: firstConfiguration, fetchImpl, now: 1000 });
  const other = await ensureFreshGitHubCopilotSession(token, { configuration: otherConfiguration, fetchImpl, now: 1000 });
  assert.equal(other.baseUrl, "https://copilot-api.othercorp.ghe.com");
  releaseFirst();
  assert.equal((await first).baseUrl, "https://copilot-api.octocorp.ghe.com");
  const refreshed = await ensureFreshGitHubCopilotSession(token, { configuration: otherConfiguration, fetchImpl, force: true, now: 2000 });
  const cached = await ensureFreshGitHubCopilotSession(token, { configuration: otherConfiguration, fetchImpl, now: 2001 });
  assert.equal(refreshed, cached);
  assert.deepEqual(calls, [firstConfiguration.userUrl, otherConfiguration.userUrl, otherConfiguration.userUrl]);
});

test("Copilot invalid saved host settings stop account networking", async () => {
  const file = path.join(stateRoot, "github-copilot-settings.json");
  writeFileSync(file, "{");
  let calls = 0;
  try {
    await assert.rejects(ensureFreshGitHubCopilotSession("github_pat_TEST_SOURCE", {
      fetchImpl: async () => { calls += 1; throw new Error("must not fetch"); },
    }), /settings are invalid or unreadable/);
    assert.equal(calls, 0);
  } finally {
    rmSync(file);
  }
});

test("Copilot settled session cache misses on a different host without forced refresh", async () => {
  resetGitHubCopilotSessionForTests();
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ endpoints: { api: `https://copilot-api.${url.hostname.slice(4)}` } }));
  };
  const token = "github_pat_TEST_SAME_TOKEN";
  const first = await ensureFreshGitHubCopilotSession(token, { configuration: configuration("octocorp.ghe.com"), fetchImpl, now: 1000 });
  const other = await ensureFreshGitHubCopilotSession(token, { configuration: configuration("othercorp.ghe.com"), fetchImpl, now: 1001 });
  assert.equal(first.baseUrl, "https://copilot-api.octocorp.ghe.com");
  assert.equal(other.baseUrl, "https://copilot-api.othercorp.ghe.com");
  assert.equal(calls.length, 2);
});
