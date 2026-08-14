import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "dsh-web-test-"));
process.env.CODEX_ROUTER_STATE_DIR = stateDir;
const statePath = path.join(stateDir, "dsh-web-state.json");
process.env.MODEL_ROUTER_DSH_WEB_STATE = statePath;

const { DSH_WEB_PORT, dshWebState, dshWebUrl, probeDshWeb, stopDshWeb } = await import(
  "../src/dsh-web.mjs"
);

const reachable = async () => ({ status: 200 });
const refused = async () => {
  throw new Error("connect ECONNREFUSED");
};

function writeState(state) {
  writeFileSync(statePath, JSON.stringify({ version: 1, ...state }), "utf8");
}

test("the URL follows the harness's own default port", () => {
  assert.equal(DSH_WEB_PORT, 3080);
  assert.equal(dshWebUrl(), "http://127.0.0.1:3080");
  assert.equal(dshWebUrl({ port: 8080 }), "http://127.0.0.1:8080");
});

test("any HTTP answer counts as served, and a refusal does not", async () => {
  // A 404 from the harness's own router is still a running harness; the probe
  // asks whether the port answers, not what it thinks of the path.
  assert.deepEqual(await probeDshWeb({ fetchImpl: async () => ({ status: 404 }) }), {
    reachable: true,
    status: 404,
  });
  const down = await probeDshWeb({ fetchImpl: refused });
  assert.equal(down.reachable, false);
  assert.match(down.error, /ECONNREFUSED/);
});

test("a server this router did not start is reported but not owned", async () => {
  // No state file at all: somebody's `dsh web` in a terminal.
  const external = await dshWebState({ fetchImpl: reachable, identity: () => undefined });
  assert.equal(external.running, true);
  assert.equal(external.managed, false);
  assert.equal(external.pid, undefined);
  assert.equal(external.url, "http://127.0.0.1:3080");
});

test("a recorded process counts as managed only while its identity still matches", async () => {
  writeState({ managed: true, pid: 4242, port: 3080, processIdentity: "started-at|dsh" });

  const owned = await dshWebState({ fetchImpl: reachable, identity: () => "started-at|dsh" });
  assert.equal(owned.managed, true);
  assert.equal(owned.pid, 4242);

  // The PID was reused by something else, so the recorded identity no longer
  // describes it. Reported as running, never as ours.
  const reused = await dshWebState({ fetchImpl: reachable, identity: () => "other-time|bash" });
  assert.equal(reused.running, true);
  assert.equal(reused.managed, false);

  // A matching identity for a port that stopped answering is not running.
  const dead = await dshWebState({ fetchImpl: refused, identity: () => "started-at|dsh" });
  assert.equal(dead.running, false);
  assert.equal(dead.managed, false);
});

test("stop refuses to signal a process this router does not own", async () => {
  writeState({ managed: true, pid: 4242, port: 3080, processIdentity: "started-at|dsh" });
  let signalled = 0;

  const foreign = await stopDshWeb({
    identity: () => "somebody-else|node",
    kill: () => {
      signalled += 1;
    },
  });
  assert.deepEqual(foreign, { stopped: false, reason: "external-or-unmanaged" });
  assert.equal(signalled, 0, "a port somebody else is serving must never be signalled");

  // A server that exits on SIGTERM: the identity stops resolving once the
  // signal lands, which is what "it is gone" looks like from here.
  let alive = true;
  const ours = await stopDshWeb({
    identity: () => (alive ? "started-at|dsh" : undefined),
    kill: () => {
      signalled += 1;
      alive = false;
    },
    timeoutMs: 50,
  });
  assert.equal(ours.stopped, true);
  assert.equal(ours.pid, 4242);
  assert.equal(signalled, 1, "a process that honours SIGTERM is never escalated to SIGKILL");
  // The record is cleared so a later PID reuse cannot be mistaken for ours.
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).managed, false);
});

test("stop escalates to SIGKILL and refuses to claim a server it could not end", async () => {
  writeState({ managed: true, pid: 4242, port: 3080, processIdentity: "started-at|dsh" });
  const signals = [];

  // Ignores every signal, which is the case the old code reported as stopped:
  // the port stayed bound while the ownership record was cleared, after which
  // the tray read the server as somebody else's and nothing could stop it.
  const stubborn = await stopDshWeb({
    identity: () => "started-at|dsh",
    kill: (_pid, signal) => {
      signals.push(signal);
    },
    timeoutMs: 50,
  });
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(stubborn.stopped, false);
  assert.equal(stubborn.reason, "still-running");
  // The record survives on purpose: it is the only thing that still identifies
  // this process as ours to stop on the next attempt.
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).managed, true);
});

test("stop reports success when SIGKILL is what finally ends it", async () => {
  writeState({ managed: true, pid: 4242, port: 3080, processIdentity: "started-at|dsh" });
  const signals = [];
  let alive = true;

  const killed = await stopDshWeb({
    identity: () => (alive ? "started-at|dsh" : undefined),
    kill: (_pid, signal) => {
      signals.push(signal);
      if (signal === "SIGKILL") alive = false;
    },
    timeoutMs: 50,
  });
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(killed.stopped, true);
  assert.equal(killed.pid, 4242);
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).managed, false);
});

test("an unreadable state file degrades to unmanaged rather than throwing", async () => {
  writeFileSync(statePath, "{ not json", "utf8");
  const state = await dshWebState({ fetchImpl: reachable, identity: () => "anything" });
  assert.equal(state.running, true);
  assert.equal(state.managed, false);
});
