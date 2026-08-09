import assert from "node:assert/strict";
import test from "node:test";

import {
  assertGitHubCopilotCredential,
  copilotApiBaseUrl,
  ensureFreshGitHubCopilotSession,
  githubCopilotCredentialProblem,
  githubCopilotRequestHeaders,
  resetGitHubCopilotSessionForTests,
} from "../src/github-copilot-session.mjs";

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
