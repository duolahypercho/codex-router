import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-targets-"));
process.env.CODEX_HOME = path.join(testRoot, "codex");
process.env.CODEX_ROUTER_STATE_DIR = path.join(testRoot, "state");

const {
  installedTargets,
  refreshTargetPickerIfInstalled,
  runTargetPublicationProcess,
} = await import("../src/target-integration.mjs");
const {
  CONFIG_PATH,
  CLAUDE_CATALOG_PATH,
  CURSOR_CATALOG_PATH,
  DSH_CATALOG_PATH,
  NATIVE_CATALOG_PATH,
  OPENCLAW_CATALOG_PATH,
} = await import("../src/paths.mjs");

function stageFile(filePath, contents) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents, "utf8");
}

function clearStagedFiles() {
  for (const filePath of [CONFIG_PATH, CLAUDE_CATALOG_PATH, CURSOR_CATALOG_PATH, DSH_CATALOG_PATH, NATIVE_CATALOG_PATH, OPENCLAW_CATALOG_PATH]) {
    rmSync(filePath, { force: true });
  }
}

test("a retained native catalog alone does not keep the codex integration installed", () => {
  try {
    // Uninstall retains the cached catalog on purpose, so its presence must
    // not read as "Codex is still pointed at the plane" -- that is what left
    // the service and its LaunchAgent behind after the last uninstall.
    stageFile(NATIVE_CATALOG_PATH, "{}");
    assert.deepEqual(installedTargets(), []);

    stageFile(CONFIG_PATH, 'model = "gpt-5"\n');
    assert.deepEqual(installedTargets(), []);
  } finally {
    clearStagedFiles();
  }
});

test("a managed config block marks the codex integration as installed", () => {
  try {
    stageFile(
      CONFIG_PATH,
      [
        'model = "gpt-5"',
        "# BEGIN codex-router-managed",
        'openai_base_url = "http://127.0.0.1:4202/caller"',
        "# END codex-router-managed",
        "",
      ].join("\n"),
    );
    assert.deepEqual(installedTargets(), ["codex"]);
  } finally {
    clearStagedFiles();
  }
});

test("legacy managed markers still count as an installed codex integration", () => {
  try {
    // A config written by the kimi-era router must keep the shared service
    // alive until that block is migrated or removed.
    stageFile(
      CONFIG_PATH,
      "# BEGIN kimi-codex-proxy-managed\n# END kimi-codex-proxy-managed\n",
    );
    assert.deepEqual(installedTargets(), ["codex"]);
  } finally {
    clearStagedFiles();
  }
});

test("the harness catalog snapshot still marks the dsh integration", () => {
  try {
    // dsh-config-manager.mjs removes this snapshot on uninstall, so unlike the
    // codex catalog it is a faithful installed-state marker.
    stageFile(DSH_CATALOG_PATH, "{}");
    assert.deepEqual(installedTargets(), ["dsh"]);

    stageFile(CONFIG_PATH, "# BEGIN codex-router-managed\n# END codex-router-managed\n");
    assert.deepEqual(installedTargets(), ["codex", "dsh"]);
  } finally {
    clearStagedFiles();
  }
});

test("publication refuses an aborted shared activation before touching a client", async () => {
  const controller = new AbortController();
  const aborted = new Error("planned publication abort");
  controller.abort(aborted);
  await assert.rejects(
    refreshTargetPickerIfInstalled({
      signal: controller.signal,
      deadline: Date.now() + 10_000,
    }),
    (error) => error === aborted,
  );
});

test("each target publisher owns a finite tree and contracts its child deadline", async () => {
  let invocation;
  const deadline = Date.now() + 60_000;
  await runTargetPublicationProcess("catalog.mjs", [], {
    sourceRoot: "/stable/router",
    executable: "/runtime/node",
    environment: { SENTINEL: "present" },
    deadline,
    run: async (command, args, options) => {
      invocation = { command, args, options };
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(invocation.command, "/runtime/node");
  assert.deepEqual(invocation.args, [path.join("/stable/router", "src", "catalog.mjs")]);
  assert.equal(invocation.options.deadline, deadline);
  assert.equal(invocation.options.env.SENTINEL, "present");
  assert.equal(
    invocation.options.env.CODEX_ROUTER_OPERATION_DEADLINE_MS,
    String(deadline - 10_000),
  );
});

test("target publication honors and caps an injected operation environment", async () => {
  let invocation;
  const now = Date.now();
  await runTargetPublicationProcess("catalog.mjs", [], {
    sourceRoot: "/stable/router",
    executable: "/runtime/node",
    environment: { CODEX_ROUTER_OPERATION_TIMEOUT_MS: "600000" },
    run: async (_command, _args, options) => {
      invocation = options;
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  assert.ok(invocation.deadline >= now);
  assert.ok(invocation.deadline <= Date.now() + 300_000);
  assert.equal(
    Number(invocation.env.CODEX_ROUTER_OPERATION_DEADLINE_MS),
    invocation.deadline - 10_000,
  );
});

test("the Cursor publication snapshot marks the Cursor integration", () => {
  try {
    stageFile(CURSOR_CATALOG_PATH, "{}");
    assert.deepEqual(installedTargets(), ["cursor"]);

    stageFile(CONFIG_PATH, "# BEGIN codex-router-managed\n# END codex-router-managed\n");
    assert.deepEqual(installedTargets(), ["codex", "cursor"]);
  } finally {
    clearStagedFiles();
  }
});

test("the Claude publication snapshot marks the Claude Code integration", () => {
  try {
    stageFile(CLAUDE_CATALOG_PATH, "{}");
    assert.deepEqual(installedTargets(), ["claude"]);
    stageFile(CONFIG_PATH, "# BEGIN codex-router-managed\n# END codex-router-managed\n");
    assert.deepEqual(installedTargets(), ["codex", "claude"]);
  } finally {
    clearStagedFiles();
  }
});

test("the OpenClaw publication snapshot marks the OpenClaw integration", () => {
  try {
    stageFile(OPENCLAW_CATALOG_PATH, "{}");
    assert.deepEqual(installedTargets(), ["openclaw"]);
    stageFile(CONFIG_PATH, "# BEGIN codex-router-managed\n# END codex-router-managed\n");
    assert.deepEqual(installedTargets(), ["codex", "openclaw"]);
  } finally {
    clearStagedFiles();
  }
});

test.after(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

test("a config that exists but cannot be read still counts as installed", () => {
  try {
    // This answer feeds retire-the-service-if-unused. Codex mid-write, an AV
    // lock, or a permission hiccup makes the read throw while the integration
    // is plainly still there; "cannot tell" must keep the shared service
    // alive rather than tear it down over a flaked read. A directory at the
    // config path throws EISDIR on every platform, root included, which makes
    // the unreadable case portable to test.
    mkdirSync(CONFIG_PATH, { recursive: true });
    assert.deepEqual(installedTargets(), ["codex"]);
  } finally {
    rmSync(CONFIG_PATH, { recursive: true, force: true });
    clearStagedFiles();
  }
});
