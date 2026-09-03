import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  discoverAntigravityProject,
  ensureAntigravityProject,
  invalidateAntigravityProjectCache,
  loadAntigravityProject,
} from "../src/antigravity-project.mjs";
import {
  readAntigravityToken,
  removeAntigravityToken,
  setAntigravityTokenPathForTests,
} from "../src/antigravity-oauth-session.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function waitForFile(target, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(target)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${target}`);
}

function startProjectWorker(args) {
  const child = spawn(
    process.execPath,
    [path.join(ROOT, "test", "fixtures", "antigravity-project-worker.mjs"), ...args],
    {
      cwd: ROOT,
      env: { ...process.env, CODEX_ROUTER_NO_DISCOVERY: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return { child, stdout: () => stdout, stderr: () => stderr };
}

async function finishProjectWorker(worker) {
  const code = worker.child.exitCode ?? await new Promise((resolve, reject) => {
    worker.child.once("error", reject);
    worker.child.once("exit", resolve);
  });
  assert.equal(code, 0, worker.stderr());
  return JSON.parse(worker.stdout());
}

async function withToken(token, run) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "antigravity-project-"));
  const tokenPath = path.join(directory, "token.json");
  const write = (value) => writeFileSync(tokenPath, JSON.stringify(value), { mode: 0o600 });
  write(token);
  const previousDiscovery = process.env.CODEX_ROUTER_NO_DISCOVERY;
  setAntigravityTokenPathForTests(tokenPath);
  process.env.CODEX_ROUTER_NO_DISCOVERY = "0";
  invalidateAntigravityProjectCache();
  try {
    return await run(write, tokenPath);
  } finally {
    invalidateAntigravityProjectCache();
    setAntigravityTokenPathForTests(undefined);
    if (previousDiscovery === undefined) delete process.env.CODEX_ROUTER_NO_DISCOVERY;
    else process.env.CODEX_ROUTER_NO_DISCOVERY = previousDiscovery;
    rmSync(directory, { recursive: true, force: true });
  }
}

function baseToken(overrides = {}) {
  return {
    version: 3,
    managed_by: "codex-router",
    session_generation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    client_id: "operator-owned.apps.googleusercontent.com",
    client_secret: "test-client-secret",
    access_token: "access",
    refresh_token: "refresh",
    expires_at: 2_000_000_000,
    expires_in: 3600,
    project_id: "",
    ...overrides,
  };
}

test("loads project metadata from daily before production with current headers", async () => {
  const calls = [];
  const payload = await loadAntigravityProject("access", {
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (calls.length === 1) return new Response("busy", { status: 503 });
      return new Response(JSON.stringify({ cloudaicompanionProject: "managed" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  assert.equal(payload.cloudaicompanionProject, "managed");
  assert.match(calls[0].url, /^https:\/\/daily-cloudcode-pa\.googleapis\.com/);
  assert.match(calls[1].url, /^https:\/\/cloudcode-pa\.googleapis\.com/);
  assert.deepEqual(calls[0].options.headers, {
    "User-Agent": `codex-router (os_type=${process.platform === "win32" ? "windows" : process.platform}; arch=${process.arch === "x64" ? "amd64" : process.arch === "ia32" ? "386" : process.arch})`,
    Authorization: "Bearer access",
    "Content-Type": "application/json",
    "Accept-Encoding": "gzip",
  });
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    metadata: {},
  });
  assert.equal(calls[0].options.headers["Client-Metadata"], undefined);
  assert.equal(calls[0].options.headers["X-Goog-Api-Client"], undefined);
});

test("bootstrap fails closed on auth errors, server errors, and malformed success bodies", async () => {
  for (const replies of [
    [new Response("denied", { status: 401 }), new Response("denied", { status: 403 })],
    [new Response("busy", { status: 500 }), new Response("not-json", { status: 200 })],
  ]) {
    let index = 0;
    await assert.rejects(
      loadAntigravityProject("access", {
        fetchImpl: async () => replies[index++],
      }),
      { code: "project_bootstrap_failed" },
    );
    assert.equal(index, 2);
  }
});

test("a 403 SERVICE_DISABLED body appears in the operator-visible error (issue #566)", async () => {
  const serviceDisabledBody = JSON.stringify({
    error: {
      code: 403,
      status: "PERMISSION_DENIED",
      message: "Cloud Code Private API has not been used in project 123456789012...",
      details: [{ reason: "SERVICE_DISABLED", metadata: { service: "cloudcode-pa.googleapis.com" } }],
    },
  });
  let caughtError;
  try {
    await loadAntigravityProject("access", {
      fetchImpl: async () => new Response(serviceDisabledBody, { status: 403 }),
    });
    assert.fail("should have thrown");
  } catch (error) {
    caughtError = error;
  }
  assert.equal(caughtError.code, "project_bootstrap_failed");
  // The parsed body must reach the operator, not only HTTP 403
  assert.match(caughtError.message, /not allowlisted/);
  assert.match(caughtError.message, /cloudcode-pa\.googleapis\.com/);
  assert.match(caughtError.message, /private Google API/);
  assert.match(caughtError.message, /sign-in succeeded/);
});

test("project provisioning requires an explicitly advertised tier", async () => {
  let onboardCalls = 0;
  await assert.rejects(
    discoverAntigravityProject("access", {
      allowOnboard: true,
      fetchImpl: async (url) => {
        if (String(url).includes("onboardUser")) onboardCalls += 1;
        return new Response("{}", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    }),
    { code: "project_provisioning_not_advertised" },
  );
  assert.equal(onboardCalls, 0);
});

test("selects the default allowed tier and retries onboarding on production first", async () => {
  const calls = [];
  const delays = [];
  const context = await discoverAntigravityProject("access", {
    allowOnboard: true,
    attempts: 3,
    retryDelayMs: 7,
    delayImpl: async (milliseconds) => delays.push(milliseconds),
    now: () => 1234,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) });
      if (String(url).includes("loadCodeAssist")) {
        return new Response(JSON.stringify({
          allowedTiers: [
            { id: "first-tier" },
            { id: "pro-tier", isDefault: true },
          ],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const onboardCalls = calls.filter((call) => call.url.includes("onboardUser")).length;
      return new Response(JSON.stringify(
        onboardCalls === 1
          ? { done: false }
          : { done: true, response: { cloudaicompanionProject: { id: "provisioned" } } },
      ), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  const onboard = calls.filter((call) => call.url.includes("onboardUser"));
  assert.equal(onboard.length, 2);
  assert.match(onboard[0].url, /^https:\/\/cloudcode-pa\.googleapis\.com/);
  assert.deepEqual(onboard[0].body, { tierId: "pro-tier" });
  assert.deepEqual(delays, [7]);
  assert.deepEqual(context, {
    projectId: "provisioned",
    source: "managed",
    tierId: "pro-tier",
    checkedAt: 1234,
  });
});

test("fails fast when no managed project is discoverable on the request path", async () => {
  await withToken(
    baseToken({ project_id: "" }),
    async () => {
      let calls = 0;
      await assert.rejects(
        ensureAntigravityProject(readAntigravityToken(), {
          now: () => 10_000,
          attempts: 2,
          delayImpl: async () => {},
          fetchImpl: async () => {
            calls += 1;
            return new Response(JSON.stringify({
              cloudaicompanionProject: "",
            }), { status: 200, headers: { "Content-Type": "application/json" } });
          },
        }),
        { code: "project_required" },
      );
      // The request path must not silently route through a shared fallback.
      assert.equal(calls, 1);
    },
  );
});

test("does not persist a fallback project when discovery fails", async () => {
  await withToken(baseToken(), async (_write, tokenPath) => {
    let calls = 0;
    const options = {
      now: () => 20_000,
      attempts: 1,
      delayImpl: async () => {},
      fetchImpl: async () => {
        calls += 1;
        return new Response("{}", {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      },
    };
    await assert.rejects(
      ensureAntigravityProject(readAntigravityToken(), options),
      { code: "project_bootstrap_failed" },
    );
    const raw = JSON.parse(readFileSync(tokenPath, "utf8"));
    assert.equal(raw.project_id, "");
    assert.equal(raw.project_source, undefined);
    assert.equal(raw.project_checked_at, undefined);
  });
});

test("deduplicates concurrent discovery for the same account", async () => {
  await withToken(baseToken(), async () => {
    let calls = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const fetchImpl = async () => {
      calls += 1;
      await gate;
      return new Response(JSON.stringify({ cloudaicompanionProject: "managed" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const session = readAntigravityToken();
    const first = ensureAntigravityProject(session, { fetchImpl, attempts: 1 });
    const second = ensureAntigravityProject(session, { fetchImpl, attempts: 1 });
    release();
    const [left, right] = await Promise.all([first, second]);
    assert.equal(calls, 1);
    assert.equal(left.projectId, "managed");
    assert.equal(right.projectId, "managed");
  });
});

test("does not persist or cache a pending lookup after durable invalidation", async () => {
  await withToken(baseToken(), async () => {
    let calls = 0;
    let startedResolve;
    const started = new Promise((resolve) => { startedResolve = resolve; });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const fetchImpl = async () => {
      const call = ++calls;
      if (call === 1) {
        startedResolve();
        await gate;
      }
      return new Response(JSON.stringify({
        cloudaicompanionProject: call === 1 ? "stale-project" : "fresh-project",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    };

    const first = ensureAntigravityProject(readAntigravityToken(), {
      fetchImpl,
      attempts: 1,
    });
    await started;
    await invalidateAntigravityProjectCache("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const second = await ensureAntigravityProject(readAntigravityToken(), {
      fetchImpl,
      attempts: 1,
    });
    release();
    await assert.rejects(first, { code: "project_context_changed" });
    assert.equal(calls, 2);
    assert.equal(second.projectId, "fresh-project");
    assert.equal(readAntigravityToken().project_id, "fresh-project");
  });
});

test("a separate process cannot persist stale project discovery after invalidation", async () => {
  await withToken(baseToken(), async (_write, tokenPath) => {
    const directory = path.dirname(tokenPath);
    const started = path.join(directory, "stale-project-started");
    const release = path.join(directory, "release-stale-project");
    const stale = startProjectWorker([tokenPath, started, release]);
    await waitForFile(started);

    await invalidateAntigravityProjectCache("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const fresh = await ensureAntigravityProject(readAntigravityToken(), {
      attempts: 1,
      now: () => 30_000,
      fetchImpl: async () => new Response(JSON.stringify({
        cloudaicompanionProject: "fresh-project",
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    });
    assert.equal(fresh.projectId, "fresh-project");

    writeFileSync(release, "go");
    const staleResult = await finishProjectWorker(stale);
    assert.equal(staleResult.code, "project_context_changed");
    const stored = JSON.parse(readFileSync(tokenPath, "utf8"));
    assert.equal(stored.project_id, "fresh-project");
    assert.equal(stored.project_checked_at, 30_000);
  });
});

test("disconnect invalidates the cached project for that credential", async () => {
  await withToken(baseToken(), async (write) => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Response(JSON.stringify({ cloudaicompanionProject: `managed-${calls}` }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    await ensureAntigravityProject(readAntigravityToken(), { fetchImpl, attempts: 1 });
    assert.equal(await removeAntigravityToken(), true);
    write(baseToken());
    const result = await ensureAntigravityProject(readAntigravityToken(), {
      fetchImpl,
      attempts: 1,
    });
    assert.equal(calls, 2);
    assert.equal(result.projectId, "managed-2");
  });
});

test("does not attach a discovered project to a concurrently replaced account", async () => {
  await withToken(baseToken(), async (write) => {
    let calls = 0;
    await assert.rejects(
      ensureAntigravityProject(readAntigravityToken(), {
        attempts: 1,
        fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          write(baseToken({
            session_generation: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            access_token: "new-access",
            refresh_token: "new-refresh",
          }));
          return new Response(JSON.stringify({ cloudaicompanionProject: "old-project" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ cloudaicompanionProject: "new-project" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
        },
      }),
      { code: "oauth_session_changed" },
    );
    assert.equal(calls, 1);
    const stored = readAntigravityToken();
    assert.equal(stored.refresh_token, "new-refresh");
    assert.equal(stored.project_id, "");
  });
});
