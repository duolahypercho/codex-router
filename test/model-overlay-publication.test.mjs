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

test("overlay publication always enters through a fresh Node process", () => {
  let invocation;
  const result = publishModelOverlayFresh({
    executable: "/runtime/node",
    sourceRoot: "/stable/router",
    environment: { ROUTER_TEST_SENTINEL: "present" },
    spawn: (command, args, options) => {
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
  assert.equal(invocation.options.windowsHide, true);
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

test("transactional rollback preserves warning-only publication semantics", async () => {
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
        assert.equal(options.warningOnly, true);
        return {};
      },
      restartService: async () => events.push("restart"),
    }),
    /mutation failed/,
  );
  assert.deepEqual(events, ["mutate", "restore", "publish"]);
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
