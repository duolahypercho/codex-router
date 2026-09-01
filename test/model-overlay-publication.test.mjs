import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "model-overlay-publication-test-"));
const testEnvironment = {
  CODEX_ROUTER_STATE_DIR: stateDir,
  MODEL_ROUTER_LOCAL_DOWNLOAD_STATE: path.join(stateDir, "download.json"),
  MODEL_ROUTER_LOCAL_MODELS_STATE: path.join(stateDir, "local-models.json"),
  MODEL_ROUTER_VISION_BRIDGE_STATE: path.join(stateDir, "vision-bridge.json"),
};
const originalEnvironment = Object.fromEntries(
  Object.keys(testEnvironment).map((name) => [name, process.env[name]]),
);
Object.assign(process.env, testEnvironment);

after(() => {
  rmSync(stateDir, { recursive: true, force: true });
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const {
  applyModelOverlayPublication,
  publishModelOverlayFresh,
  rebuildModelOverlayPublication,
  restorePublishedModelOverlay,
  restoreModelOverlayFiles,
  transactModelOverlayMutation,
} = await import("../src/model-overlay-publication.mjs");
const { downloadLocalModel, readLocalDownload } = await import("../src/local-download.mjs");

const overlayWorker = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "model-overlay-worker.mjs",
);

function startOverlayWorker(args) {
  const child = spawn(process.execPath, [overlayWorker, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  child._modelOverlayStderr = "";
  child.stderr.on("data", (chunk) => { child._modelOverlayStderr += chunk; });
  return child;
}

async function waitForMarker(marker, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(marker) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(existsSync(marker), `worker did not acquire the overlay lock: ${marker}`);
}

async function finishWorker(child) {
  const [code, signal] = await once(child, "exit");
  return { code, signal, stderr: child._modelOverlayStderr || "" };
}

test("shared publication writes gateway routes before every installed target", async () => {
  const events = [];
  const result = await rebuildModelOverlayPublication({
    writeGateway: () => {
      events.push("gateway");
      return "/private/router/litellm.yaml";
    },
    refreshTargets: () => {
      for (const target of ["codex", "dsh", "gemini", "cursor"]) events.push(target);
      return true;
    },
  });

  assert.deepEqual(events, ["gateway", "codex", "dsh", "gemini", "cursor"]);
  assert.deepEqual(result, {
    gatewayPath: "/private/router/litellm.yaml",
    targetsRefreshed: true,
  });
});

test("overlay rollback reapplies private-file protection to recreated files", () => {
  const events = [];
  restoreModelOverlayFiles(
    [{ path: path.join(stateDir, "recreated.json"), existed: true, contents: Buffer.from("{}\n").toString("base64") }],
    {
      mkdir: () => events.push("mkdir"),
      write: () => events.push("write"),
      chmod: () => events.push("chmod"),
      protect: () => events.push("protect"),
    },
  );
  assert.deepEqual(events, ["mkdir", "write", "chmod", "protect"]);
});

test("independent overlay transactions preserve both successful selections", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "model-overlay-concurrent-success-"));
  const statePath = path.join(directory, "selection.json");
  const firstMarker = path.join(directory, "first-entered");
  const secondMarker = path.join(directory, "second-entered");
  writeFileSync(statePath, JSON.stringify({ selected: [] }) + "\n", { mode: 0o600 });
  try {
    const first = startOverlayWorker(["success", directory, "alpha", firstMarker, "300"]);
    await waitForMarker(firstMarker);
    const second = startOverlayWorker(["success", directory, "beta", secondMarker, "0"]);
    const [firstResult, secondResult] = await Promise.all([
      finishWorker(first),
      finishWorker(second),
    ]);
    assert.equal(firstResult.code, 0, firstResult.stderr);
    assert.equal(secondResult.code, 0, secondResult.stderr);
    assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")), {
      selected: ["alpha", "beta"],
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a failed earlier transaction cannot roll back a later success", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "model-overlay-concurrent-rollback-"));
  const statePath = path.join(directory, "selection.json");
  const successfulMarker = path.join(directory, "successful-entered");
  const failedMarker = path.join(directory, "failed-entered");
  writeFileSync(statePath, JSON.stringify({ selected: [] }) + "\n", { mode: 0o600 });
  try {
    // The failed worker owns the lock while its publication is held open. An
    // unlocked implementation lets the success mutate the same stale
    // snapshot; the failed rollback then erases that later success.
    const failed = startOverlayWorker([
      "failure",
      directory,
      "loser",
      failedMarker,
      "300",
    ]);
    await waitForMarker(failedMarker);
    const successful = startOverlayWorker(["success", directory, "survivor", successfulMarker, "0"]);
    const [successfulResult, failedResult] = await Promise.all([
      finishWorker(successful),
      finishWorker(failed),
    ]);
    assert.equal(successfulResult.code, 0, successfulResult.stderr);
    assert.equal(failedResult.code, 1, failedResult.stderr);
    assert.match(failedResult.stderr, /deliberate publication failure/);
    assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")), {
      selected: ["survivor"],
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("overlay publication always enters through a bounded fresh Node process", async () => {
  let invocation;
  const deadline = Date.now() + 60_000;
  const result = await publishModelOverlayFresh({
    executable: "/runtime/node",
    sourceRoot: "/stable/router",
    environment: { ROUTER_TEST_SENTINEL: "present" },
    deadline,
    run: async (command, args, options) => {
      invocation = { command, args, options };
      return { status: 0, stdout: "{}\n", stderr: "" };
    },
  });

  assert.deepEqual(result, { published: true });
  assert.equal(invocation.command, "/runtime/node");
  assert.match(invocation.args[0], /model-overlay-publication\.mjs$/);
  assert.equal(invocation.args[1], "--publish-in-fresh-process");
  assert.equal(invocation.options.cwd, "/stable/router");
  assert.equal(invocation.options.env.ROUTER_TEST_SENTINEL, "present");
  assert.equal(invocation.options.env.MODEL_ROUTER_TARGET, "codex");
  assert.equal(invocation.options.deadline, deadline);
  assert.equal(
    invocation.options.env.CODEX_ROUTER_OPERATION_DEADLINE_MS,
    String(deadline - 10_000),
  );
  assert.equal(invocation.options.windowsHide, true);
});

test("rollback restores durable overlay state even after the deadline expires", async () => {
  const events = [];
  await assert.rejects(
    restorePublishedModelOverlay({
      deadline: Date.now() - 1,
      restore: async () => events.push("restore"),
      applyPublication: async () => events.push("publish"),
    }),
    { code: "router_operation_timeout" },
  );
  assert.deepEqual(events, ["restore"]);
});

test("synchronous mutations propagate publication errors before restart", async () => {
  const events = [];
  await assert.rejects(
    applyModelOverlayPublication({
      publish: async () => {
        events.push("publish");
        throw new Error("target publication failed");
      },
      restart: true,
      restartService: async () => events.push("restart"),
    }),
    /target publication failed/,
  );
  assert.deepEqual(events, ["publish"]);
});

test("transactional mutations preserve warning-only publication semantics", async () => {
  const events = [];
  const warnings = await transactModelOverlayMutation({
    mutate: async () => events.push("mutate"),
    restore: async () => events.push("restore"),
    warningOnly: true,
    restart: true,
    applyPublication: async (options) => {
      events.push("publish");
      assert.equal(options.warningOnly, true);
      return { catalogError: "installed target could not be refreshed" };
    },
    restartService: async () => events.push("restart"),
  });

  assert.deepEqual(events, ["mutate", "publish"]);
  assert.deepEqual(warnings, { catalogError: "installed target could not be refreshed" });
});

test("transactional rollback is strict even when forward publication is warning-only", async () => {
  const events = [];
  await assert.rejects(
    transactModelOverlayMutation({
      mutate: async () => {
        events.push("mutate");
        throw new Error("mutation failed");
      },
      restore: async () => events.push("restore"),
      warningOnly: true,
      restart: true,
      applyPublication: async (options) => {
        events.push("publish");
        assert.equal(options.warningOnly, false);
        return {};
      },
      restartService: async () => events.push("restart"),
    }),
    /mutation failed/,
  );
  assert.deepEqual(events, ["mutate", "restore", "publish"]);
});

test("deadline failure rolls partial publication back in a non-caller-cancellable epoch", async () => {
  const caller = new AbortController();
  const startedAt = Date.now();
  const operationDeadline = startedAt + 30 * 60_000;
  const state = {
    durable: "old",
    gateway: "old",
    codex: "old",
    dsh: "old",
    gemini: "old",
    running: "old",
  };
  let publication = 0;
  let forwardDeadline;
  const events = [];

  await assert.rejects(
    transactModelOverlayMutation({
      deadline: operationDeadline,
      signal: caller.signal,
      restart: true,
      mutate: async () => {
        state.durable = "new";
        events.push("mutate:new");
      },
      restore: async () => {
        state.durable = "old";
        events.push("restore:old");
      },
      applyPublication: async (options) => {
        publication += 1;
        if (publication === 1) {
          assert.equal(options.signal.aborted, false);
          assert.ok(options.deadline >= startedAt + 630_000);
          assert.ok(options.deadline <= startedAt + 640_100);
          forwardDeadline = options.deadline;
          state.gateway = "new";
          state.codex = "new";
          events.push("publish:new:gateway", "publish:new:codex");
          caller.abort(new Error("caller deadline elapsed"));
          assert.equal(options.signal.aborted, true);
          throw Object.assign(new Error("forward publication deadline elapsed"), {
            code: "router_operation_timeout",
          });
        }
        assert.equal(options.signal, undefined);
        assert.ok(options.deadline >= forwardDeadline);
        assert.ok(options.deadline <= Date.now() + 640_000);
        for (const target of ["gateway", "codex", "dsh", "gemini"]) {
          state[target] = state.durable;
          events.push(`publish:${state.durable}:${target}`);
        }
        state.running = state.durable;
        events.push(`restart:${state.durable}`);
      },
    }),
    /forward publication deadline elapsed/,
  );

  assert.deepEqual(state, {
    durable: "old",
    gateway: "old",
    codex: "old",
    dsh: "old",
    gemini: "old",
    running: "old",
  });
  assert.deepEqual(events, [
    "mutate:new",
    "publish:new:gateway",
    "publish:new:codex",
    "restore:old",
    "publish:old:gateway",
    "publish:old:codex",
    "publish:old:dsh",
    "publish:old:gemini",
    "restart:old",
  ]);
});

test("restart-bearing forward publication preserves distinct publish and readiness epochs", async () => {
  const deadlines = {};
  await transactModelOverlayMutation({
    lock: false,
    mutate: async () => {},
    restore: async () => {},
    restart: true,
    applyPublication: (options) => applyModelOverlayPublication({
      ...options,
      publish: async ({ deadline }) => { deadlines.publish = deadline; },
      restartService: async ({ deadline }) => { deadlines.restart = deadline; },
    }),
  });
  assert.equal(deadlines.restart - deadlines.publish, 340_000);
  assert.ok(deadlines.restart - Date.now() >= 330_000);
});

test("rollback receives the same complete publish and readiness epochs as forward", async () => {
  let durable = "old";
  let restartCount = 0;
  const phases = [];
  await assert.rejects(
    transactModelOverlayMutation({
      lock: false,
      mutate: async () => { durable = "new"; },
      restore: async () => { durable = "old"; },
      restart: true,
      applyPublication: (options) => {
        const phase = { durable };
        phases.push(phase);
        return applyModelOverlayPublication({
          ...options,
          publish: async ({ deadline }) => { phase.publishDeadline = deadline; },
          restartService: async ({ deadline }) => {
            phase.restartDeadline = deadline;
            restartCount += 1;
            if (restartCount === 1) throw new Error("force semantic rollback");
          },
        });
      },
    }),
    /force semantic rollback/,
  );
  assert.equal(durable, "old");
  assert.deepEqual(phases.map((phase) => phase.durable), ["new", "old"]);
  for (const phase of phases) {
    assert.equal(phase.restartDeadline - phase.publishDeadline, 340_000);
    assert.ok(phase.restartDeadline - Date.now() >= 330_000);
  }
});

test("an impossible inherited restart deadline is refused before overlay mutation", async () => {
  const events = [];
  await assert.rejects(
    transactModelOverlayMutation({
      lock: false,
      deadline: Date.now() + 20 * 60_000,
      restart: true,
      mutate: async () => events.push("mutate"),
      restore: async () => events.push("restore"),
    }),
    (error) => error?.code === "router_operation_timeout"
      && /preserve publication/.test(error.message),
  );
  assert.deepEqual(events, []);
});

test(
  "owner SIGTERM waits for rollback publication children before exiting",
  { skip: process.platform === "win32" },
  async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "model-overlay-owner-signal-"));
    const statePath = path.join(directory, "selection.json");
    const eventsPath = path.join(directory, "events.log");
    const readyPath = path.join(directory, "forward-ready");
    const overlayModule = new URL("../src/model-overlay-publication.mjs", import.meta.url).href;
    const processTreeModule = new URL("../src/process-tree.mjs", import.meta.url).href;
    const forwardChild = [
      "const { writeFileSync } = require('node:fs')",
      `writeFileSync(${JSON.stringify(readyPath)}, 'ready')`,
      "process.on('SIGTERM', () => {})",
      "setInterval(() => {}, 1000)",
    ].join(";");
    const rollbackChild = [
      "const { appendFileSync } = require('node:fs')",
      `appendFileSync(${JSON.stringify(eventsPath)}, 'rollback-child\\n')`,
    ].join(";");
    const ownerProgram = [
      'import { appendFileSync, readFileSync, writeFileSync } from "node:fs"',
      `import { transactModelOverlayMutation } from ${JSON.stringify(overlayModule)}`,
      `import { runProcessTree } from ${JSON.stringify(processTreeModule)}`,
      `const statePath = ${JSON.stringify(statePath)}`,
      `const eventsPath = ${JSON.stringify(eventsPath)}`,
      "const event = (value) => appendFileSync(eventsPath, value + '\\n')",
      "let publication = 0",
      "try {",
      "  await transactModelOverlayMutation({",
      "    lock: false,",
      "    deadline: Date.now() + 9 * 60_000,",
      "    capture: async () => readFileSync(statePath, 'utf8'),",
      "    mutate: async () => { writeFileSync(statePath, 'new'); event('mutate'); },",
      "    restore: async (snapshot) => { writeFileSync(statePath, snapshot); event('restore'); },",
      "    applyPublication: async (options) => {",
      "      publication += 1;",
      "      if (publication === 1) {",
      "        event('forward-start');",
      `        await runProcessTree(process.execPath, ['-e', ${JSON.stringify(forwardChild)}], { deadline: options.deadline });`,
      "      } else {",
      "        event('rollback-start');",
      `        await runProcessTree(process.execPath, ['-e', ${JSON.stringify(rollbackChild)}], { deadline: options.deadline });`,
      "        event('rollback-finish');",
      "      }",
      "    },",
      "  });",
      "} catch {",
      "  event('caught');",
      "  await new Promise(() => {});",
      "}",
    ].join("\n");
    writeFileSync(statePath, "old", { mode: 0o600 });
    const owner = spawn(process.execPath, ["--input-type=module", "-e", ownerProgram], {
      stdio: "ignore",
    });
    try {
      await waitForMarker(readyPath);
      owner.kill("SIGTERM");
      const [code, signal] = await once(owner, "exit");
      assert.equal(signal, null);
      assert.equal(code, 143);
      assert.equal(readFileSync(statePath, "utf8"), "old");
      assert.deepEqual(readFileSync(eventsPath, "utf8").trim().split("\n"), [
        "mutate",
        "forward-start",
        "restore",
        "rollback-start",
        "rollback-child",
        "rollback-finish",
      ]);
    } finally {
      if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "a nested process-tree owner cannot cut off rollback after its ordinary signal reserve",
  { skip: process.platform === "win32" },
  async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "model-overlay-nested-signal-"));
    const statePath = path.join(directory, "selection.json");
    const readyPath = path.join(directory, "forward-ready");
    const restoredPath = path.join(directory, "rollback-finished");
    const overlayModule = new URL("../src/model-overlay-publication.mjs", import.meta.url).href;
    const processTreeModule = new URL("../src/process-tree.mjs", import.meta.url).href;
    const transactionProgram = [
      'import { writeFileSync } from "node:fs"',
      `import { transactModelOverlayMutation } from ${JSON.stringify(overlayModule)}`,
      `const statePath = ${JSON.stringify(statePath)}`,
      `const readyPath = ${JSON.stringify(readyPath)}`,
      `const restoredPath = ${JSON.stringify(restoredPath)}`,
      "let publication = 0",
      "try {",
      "  await transactModelOverlayMutation({",
      "    lock: false,",
      "    deadline: Date.now() + 9 * 60_000,",
      "    capture: async () => 'old',",
      "    mutate: async () => { writeFileSync(statePath, 'new'); },",
      "    restore: async (snapshot) => {",
      "      await new Promise((resolve) => setTimeout(resolve, 1300));",
      "      writeFileSync(statePath, snapshot);",
      "      writeFileSync(restoredPath, 'restored');",
      "    },",
      "    applyPublication: async ({ signal }) => {",
      "      publication += 1;",
      "      if (publication !== 1) return;",
      "      writeFileSync(readyPath, 'ready');",
      "      await new Promise((resolve, reject) => {",
      "        const hold = setInterval(() => {}, 1000);",
      "        const abort = () => { clearInterval(hold); reject(signal.reason); };",
      "        signal.addEventListener('abort', abort, { once: true });",
      "        if (signal.aborted) abort();",
      "      });",
      "    },",
      "  });",
      "} catch {}",
    ].join("\n");
    const ownerProgram = [
      `import { runProcessTree } from ${JSON.stringify(processTreeModule)}`,
      "try {",
      `  await runProcessTree(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(transactionProgram)}], {`,
      "    childMayOwnProcessTrees: true,",
      "    deadline: Date.now() + 10_000,",
      "  });",
      "} catch {}",
    ].join("\n");
    writeFileSync(statePath, "old", { mode: 0o600 });
    const owner = spawn(process.execPath, ["--input-type=module", "-e", ownerProgram], {
      stdio: "ignore",
      env: {
        ...process.env,
        CODEX_ROUTER_OWNER_SIGNAL_BUDGET_MS: "1500",
      },
    });
    try {
      await waitForMarker(readyPath);
      owner.kill("SIGTERM");
      const [code, signal] = await once(owner, "exit");
      assert.equal(signal, null);
      assert.equal(code, 143);
      assert.equal(readFileSync(statePath, "utf8"), "old");
      assert.equal(readFileSync(restoredPath, "utf8"), "restored");
    } finally {
      if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("restart timeout republishes and restarts the prior overlay", async () => {
  const operationDeadline = Date.now() + 30 * 60_000;
  let durable = "old";
  let publication = 0;
  const events = [];
  await assert.rejects(
    transactModelOverlayMutation({
      deadline: operationDeadline,
      restart: true,
      mutate: async () => { durable = "new"; },
      restore: async () => { durable = "old"; },
      applyPublication: (options) => applyModelOverlayPublication({
        ...options,
        publish: async () => {
          publication += 1;
          events.push(`publish:${durable}`);
        },
        restartService: async () => {
          events.push(`restart:${durable}`);
          if (publication === 1) {
            throw Object.assign(new Error("forward restart deadline elapsed"), {
              code: "router_operation_timeout",
            });
          }
        },
      }),
    }),
    /forward restart deadline elapsed/,
  );
  assert.equal(durable, "old");
  assert.deepEqual(events, [
    "publish:new",
    "restart:new",
    "publish:old",
    "restart:old",
  ]);
});

test("completed operations warn and skip restart when publication fails", async () => {
  const events = [];
  const warnings = await applyModelOverlayPublication({
    warningOnly: true,
    publish: async () => {
      events.push("publish");
      throw new Error("target publication failed");
    },
    restart: true,
    restartService: async () => events.push("restart"),
  });

  assert.deepEqual(events, ["publish"]);
  assert.deepEqual(warnings, {
    catalogError: "target publication failed",
  });
});

test("warning-only completion treats an impossible inherited restart epoch as a warning", async () => {
  const events = [];
  const warnings = await applyModelOverlayPublication({
    warningOnly: true,
    deadline: Date.now() + 300_000,
    publish: async () => events.push("publish"),
    restart: true,
    restartService: async () => events.push("restart"),
  });

  assert.deepEqual(events, []);
  assert.match(warnings.catalogError, /cannot preserve publication/);
  assert.equal(warnings.restartError, undefined);
});

test("completed operations retain a post-publication restart failure as a warning", async () => {
  const events = [];
  const warnings = await applyModelOverlayPublication({
    warningOnly: true,
    publish: async () => events.push("publish"),
    restart: true,
    restartService: async () => {
      events.push("restart");
      throw new Error("service restart failed");
    },
  });

  assert.deepEqual(events, ["publish", "restart"]);
  assert.deepEqual(warnings, { restartError: "service restart failed" });
});

test("a completed local pull reports publication failure without becoming failed", async () => {
  const events = [];
  const result = await downloadLocalModel("publication-test:latest", {
    ensureRuntime: async () => ({ running: true }),
    pull: async () => events.push("download"),
    capabilitiesFor: () => ["completion", "tools"],
    enable: async () => events.push("overlay"),
    restartService: async () => events.push("restart"),
    finalizePublication: (options) => applyModelOverlayPublication({
      ...options,
      publish: async () => {
        events.push("publish");
        throw new Error("installed target could not be refreshed");
      },
    }),
  });

  assert.deepEqual(events, ["download", "overlay", "publish"]);
  assert.equal(result.status, "done");
  assert.equal(result.catalogError, "installed target could not be refreshed");
  assert.equal(readLocalDownload().status, "done");
  assert.match(readLocalDownload().detail, /catalog refresh needed/);
});

test("control and both detached workers use the shared publication finalizer", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const sources = Object.fromEntries(
    ["control.mjs", "local-download.mjs", "vision-download.mjs"].map((name) => [
      name,
      readFileSync(path.join(root, "src", name), "utf8"),
    ]),
  );

  for (const [name, source] of Object.entries(sources)) {
    assert.ok(
      source.includes('from "./model-overlay-publication.mjs"'),
      `${name} must import the shared publication module`,
    );
    assert.ok(
      source.includes("applyModelOverlayPublication"),
      `${name} must use the shared publication helper`,
    );
  }
  assert.match(sources["control.mjs"], /applyModelOverlayPublication\(/);
  for (const name of ["local-download.mjs", "vision-download.mjs"]) {
    assert.ok(
      sources[name].includes("finalizePublication"),
      `${name} must expose a publication finalizer hook`,
    );
    assert.ok(
      sources[name].includes("applyModelOverlayPublication"),
      `${name} must invoke the shared publication helper`,
    );
  }
  assert.ok(
    [...sources["control.mjs"].matchAll(/applyModelOverlayPublication|transactModelOverlayMutation|finalizeLocalModelPublication/g)].length >= 4,
    "control must publish vision, sync toggle, and uninstall-finalization mutations",
  );
});
