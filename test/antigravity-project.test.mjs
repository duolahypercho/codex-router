import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  discoverAntigravityProject,
  ensureAntigravityProject,
  invalidateAntigravityProjectCache,
  loadAntigravityProject,
} from "../src/antigravity-project.mjs";
import {
  readAntigravityToken,
  removeAntigravityToken,
} from "../src/antigravity-oauth-session.mjs";

async function withToken(token, run) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "antigravity-project-"));
  const tokenPath = path.join(directory, "token.json");
  const write = (value) => writeFileSync(tokenPath, JSON.stringify(value), { mode: 0o600 });
  write(token);
  const previous = process.env.ANTIGRAVITY_TOKEN_PATH;
  process.env.ANTIGRAVITY_TOKEN_PATH = tokenPath;
  invalidateAntigravityProjectCache();
  try {
    return await run(write, tokenPath);
  } finally {
    invalidateAntigravityProjectCache();
    if (previous === undefined) delete process.env.ANTIGRAVITY_TOKEN_PATH;
    else process.env.ANTIGRAVITY_TOKEN_PATH = previous;
    rmSync(directory, { recursive: true, force: true });
  }
}

function baseToken(overrides = {}) {
  return {
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
    "User-Agent": `antigravity/ide/2.5.5 (os_type=${process.platform === "win32" ? "windows" : process.platform}; arch=${process.arch === "x64" ? "amd64" : process.arch === "ia32" ? "386" : process.arch}; aidev_client; auth_method=oauth)`,
    Authorization: "Bearer access",
    "Content-Type": "application/json",
    "Accept-Encoding": "gzip",
  });
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    metadata: { ideType: "ANTIGRAVITY" },
  });
  assert.equal(calls[0].options.headers["Client-Metadata"], undefined);
  assert.equal(calls[0].options.headers["X-Goog-Api-Client"], undefined);
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
      { code: "project_required" },
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

test("does not repopulate the result cache when a pending lookup is invalidated", async () => {
  await withToken(baseToken(), async (write) => {
    let calls = 0;
    let startedResolve;
    const started = new Promise((resolve) => { startedResolve = resolve; });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) {
        startedResolve();
        await gate;
      }
      return new Response(JSON.stringify({
        cloudaicompanionProject: calls === 1 ? "stale-project" : "fresh-project",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    };

    const first = ensureAntigravityProject(readAntigravityToken(), {
      fetchImpl,
      attempts: 1,
    });
    await started;
    invalidateAntigravityProjectCache("refresh");
    release();
    await first;

    write(baseToken());
    const second = await ensureAntigravityProject(readAntigravityToken(), {
      fetchImpl,
      attempts: 1,
    });
    assert.equal(calls, 2);
    assert.equal(second.projectId, "fresh-project");
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
    const result = await ensureAntigravityProject(readAntigravityToken(), {
      attempts: 1,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          write(baseToken({
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
    });
    assert.equal(calls, 2);
    assert.equal(result.session.refresh_token, "new-refresh");
    assert.equal(result.session.project_id, "new-project");
    assert.equal(result.projectId, "new-project");
  });
});
