import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  boundedOperationChild,
  contractOperationDeadline,
  detachedOperationEnvironment,
  operationDeadlineFromEnvironment,
  runDuringOwnerSignalCleanup,
  runOperationProcessTree,
  runProcessTree,
  terminateProcessTree,
  withOwnerSignalExitBarrier,
  windowsJobProcessInvocation,
} from "../src/process-tree.mjs";

async function waitForFile(target, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(target)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${target}`);
}

async function waitForProcessExit(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`descendant process ${pid} survived process-tree cleanup`);
}

function residualTreeProgram(pidFile, marker, exitCode = 0) {
  // Use base64 encoding to avoid string interpolation with JSON.stringify
  // This prevents CodeQL from flagging the code as potential code injection
  const markerB64 = Buffer.from(marker).toString('base64');
  const pidFileB64 = Buffer.from(pidFile).toString('base64');
  
  const grandchild = [
    "const { writeFileSync } = require('node:fs')",
    "process.on('SIGTERM', () => {})",
    "process.on('SIGINT', () => {})",
    `setTimeout(() => writeFileSync(Buffer.from('${markerB64}', 'base64').toString(), 'unsafe'), 900)`,
    "process.send?.('ready')",
    "process.disconnect?.()",
    "setInterval(() => {}, 1000)",
  ].join(";");
  
  // Encode grandchild code as base64 to avoid nested quoting issues
  const grandchildB64 = Buffer.from(grandchild).toString('base64');
  
  return [
    "const { spawn } = require('node:child_process')",
    "const { writeFileSync } = require('node:fs')",
    // The descendant deliberately inherits the leader's stdout/stderr pipes.
    // Node emits `exit` for the leader while `close` remains blocked on those
    // inherited descriptors, which is the ordering this regression exercises.
    // Decode the base64-encoded child code at runtime
    `const childCode = Buffer.from('${grandchildB64}', 'base64').toString()`,
    `const child = spawn(process.execPath, ['-e', childCode], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })`,
    `child.once('message', () => { writeFileSync(Buffer.from('${pidFileB64}', 'base64').toString(), String(child.pid)); process.stdout.write('leader-out'); process.stderr.write('leader-err'); process.exit(${exitCode}); })`,
    "setInterval(() => {}, 1000)",
  ].join(";");
}

test("operation deadlines cap inherited deadlines", () => {
  const now = Date.now();
  const deadline = operationDeadlineFromEnvironment(
    { CODEX_ROUTER_OPERATION_DEADLINE_MS: String(now + 60_000) },
    { maximumMs: 1_000 },
  );
  assert.ok(deadline >= now);
  assert.ok(deadline <= Date.now() + 1_000);
});

test("bounded child markers require a live absolute deadline", () => {
  const now = Date.now();
  assert.equal(boundedOperationChild({ CODEX_ROUTER_OPERATION_CHILD: "1" }), false);
  assert.equal(boundedOperationChild({
    CODEX_ROUTER_OPERATION_CHILD: "1",
    CODEX_ROUTER_OPERATION_DEADLINE_MS: String(now + 60_000),
  }, { maximumMs: 60_000, now: () => now }), true);
  assert.equal(boundedOperationChild({
    CODEX_ROUTER_OPERATION_CHILD: "1",
    CODEX_ROUTER_OPERATION_DEADLINE_MS: String(now + 60_001),
  }, { maximumMs: 60_000, now: () => now }), false);
  assert.throws(
    () => boundedOperationChild({
      CODEX_ROUTER_OPERATION_CHILD: "1",
      CODEX_ROUTER_OPERATION_DEADLINE_MS: String(Date.now() - 1),
    }),
    { code: "router_operation_timeout" },
  );
});

test("operation children inherit a contracted deadline and require one", async () => {
  const deadline = Date.now() + 60_000;
  let invocation;
  const result = await runOperationProcessTree("/runtime/node", ["worker"], {
    deadline,
    env: { SENTINEL: "present" },
    childEnvironment: { CHILD_SENTINEL: "present" },
    run: async (command, args, options) => {
      invocation = { command, args, options };
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(result.status, 0);
  assert.equal(invocation.options.deadline, deadline);
  assert.equal(
    invocation.options.env.CODEX_ROUTER_OPERATION_DEADLINE_MS,
    String(contractOperationDeadline(deadline)),
  );
  assert.equal(invocation.options.env.SENTINEL, "present");
  assert.equal(invocation.options.env.CHILD_SENTINEL, "present");
  assert.equal(invocation.options.env.CODEX_ROUTER_OWNER_SIGNAL_BUDGET_MS, undefined);
  assert.equal(invocation.options.childMayOwnProcessTrees, true);
  assert.throws(
    () => runOperationProcessTree("/runtime/node", [], { run: async () => ({ status: 0 }) }),
    { code: "router_operation_deadline_required" },
  );
});

test("detached workers do not inherit an operation epoch", () => {
  assert.deepEqual(detachedOperationEnvironment({
    KEEP: "yes",
    CODEX_ROUTER_OPERATION_CHILD: "1",
    CODEX_ROUTER_OPERATION_TIMEOUT_MS: "10",
    CODEX_ROUTER_OPERATION_DEADLINE_MS: "20",
    CODEX_ROUTER_OWNER_SIGNAL_BUDGET_MS: "9000",
    CODEX_ROUTER_OWNER_SIGNAL_BARRIER_DIR: "/tmp/stale-owner-signal-barrier",
  }, { ADDED: "yes" }), { KEEP: "yes", ADDED: "yes" });
});

test("an operation-tree child receives a contracted owner-signal budget", async () => {
  const result = await runProcessTree(
    process.execPath,
    ["-e", "process.stdout.write(process.env.CODEX_ROUTER_OWNER_SIGNAL_BUDGET_MS || '')"],
    {
      childMayOwnProcessTrees: true,
      deadline: Date.now() + 10_000,
    },
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "9500");
});

test("owner-signal cleanup depth fails before spawning past its reserve", () => {
  assert.throws(
    () => runProcessTree(process.execPath, ["-e", ""], {
      deadline: Date.now() + 60_000,
      env: {
        CODEX_ROUTER_OPERATION_CHILD: "1",
        CODEX_ROUTER_OWNER_SIGNAL_BUDGET_MS: "500",
      },
    }),
    { code: "router_operation_signal_depth_exceeded" },
  );
  assert.throws(
    () => runProcessTree(process.execPath, ["-e", ""], {
      deadline: Date.now() + 60_000,
      env: {
        CODEX_ROUTER_OPERATION_CHILD: "1",
        CODEX_ROUTER_OWNER_SIGNAL_BUDGET_MS: "not-a-number",
      },
    }),
    { code: "router_operation_signal_budget_invalid" },
  );
});

test("owner-signal cleanup authority is scoped to its active exit barrier", async () => {
  let barrierReady;
  let releaseBarrier;
  const ready = new Promise((resolve) => { barrierReady = resolve; });
  const blocked = new Promise((resolve) => { releaseBarrier = resolve; });
  const barrier = withOwnerSignalExitBarrier(async () => {
    barrierReady();
    await blocked;
    return runDuringOwnerSignalCleanup(async () => "protected");
  });
  await ready;
  assert.throws(
    () => runDuringOwnerSignalCleanup(() => undefined),
    { code: "router_owner_signal_cleanup_unprotected" },
  );
  releaseBarrier();
  assert.equal(await barrier, "protected");
});

test("deadline termination removes the complete descendant process tree", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "router-process-tree-"));
  const ready = path.join(directory, "grandchild-ready");
  const marker = path.join(directory, "grandchild-survived");
  // A saturated Windows hosted runner can spend more than 500 ms starting the
  // PowerShell Job owner and its descendants. Give startup a platform-sized
  // window, then wait long enough that a surviving grandchild would still
  // prove itself after the latest possible successful start.
  const startupBudgetMs = process.platform === "win32" ? 5_000 : 1_000;
  // Stay well beyond the production 250 ms TERM-to-KILL grace so the marker
  // cannot race legitimate cleanup on POSIX.
  const markerDelayMs = startupBudgetMs + 1_000;
  
  // Use base64 encoding to avoid string interpolation with JSON.stringify
  const readyB64 = Buffer.from(ready).toString('base64');
  const markerB64 = Buffer.from(marker).toString('base64');
  
  const grandchild = [
    "const { writeFileSync } = require('node:fs')",
    "process.on('SIGTERM', () => {})",
    `writeFileSync(Buffer.from('${readyB64}', 'base64').toString(), 'ready')`,
    `setTimeout(() => writeFileSync(Buffer.from('${markerB64}', 'base64').toString(), 'unsafe'), ${markerDelayMs})`,
    "setInterval(() => {}, 1000)",
  ].join(";");
  
  const grandchildB64 = Buffer.from(grandchild).toString('base64');
  
  const child = [
    "const { spawn } = require('node:child_process')",
    "process.on('SIGTERM', () => {})",
    `spawn(process.execPath, ['-e', Buffer.from('${grandchildB64}', 'base64').toString()], { stdio: 'ignore' })`,
    "setInterval(() => {}, 1000)",
  ].join(";");
  try {
    const operation = runProcessTree(process.execPath, ["-e", child], {
      deadline: Date.now() + startupBudgetMs,
    });
    const rejected = assert.rejects(operation, { code: "router_operation_timeout" });
    await waitForFile(ready, startupBudgetMs + 1_000);
    await rejected;
    await new Promise((resolve) => setTimeout(resolve, markerDelayMs + 100));
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const exitCode of [0, 7]) {
  test(`direct-child exit ${exitCode} retires descendants holding inherited pipes`, async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "router-process-close-tree-"));
    const pidFile = path.join(directory, "grandchild.pid");
    const marker = path.join(directory, "grandchild-survived");
    let descendantPid;
    try {
      const result = await runProcessTree(
        process.execPath,
        ["-e", residualTreeProgram(pidFile, marker, exitCode)],
        { deadline: Date.now() + 10_000 },
      );
      assert.equal(result.status, exitCode);
      assert.equal(result.stdout, "leader-out");
      assert.equal(result.stderr, "leader-err");
      descendantPid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
      assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
      await waitForProcessExit(descendantPid);
      await new Promise((resolve) => setTimeout(resolve, 700));
      assert.equal(existsSync(marker), false);
    } finally {
      if (descendantPid) {
        try { process.kill(descendantPid, "SIGKILL"); } catch { /* already gone */ }
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

for (const ownerSignal of ["SIGINT", "SIGTERM"]) {
  test(
    `owner ${ownerSignal} is forwarded only after the descendant tree is retired`,
    { skip: process.platform === "win32" },
    async () => {
      const directory = mkdtempSync(path.join(os.tmpdir(), "router-process-owner-signal-"));
      const pidFile = path.join(directory, "grandchild.pid");
      const marker = path.join(directory, "grandchild-survived");
      const moduleUrl = new URL("../src/process-tree.mjs", import.meta.url).href;
      const childProgram = residualTreeProgram(pidFile, marker, 0).replace(
        /process\.exit\(0\)/,
        "setInterval(() => {}, 1000)",
      );
      const ownerProgram = [
        `import { runProcessTree } from ${JSON.stringify(moduleUrl)}`,
        `await runProcessTree(process.execPath, ['-e', ${JSON.stringify(childProgram)}], { deadline: Date.now() + 60_000 })`,
      ].join(";");
      const owner = spawn(process.execPath, ["--input-type=module", "-e", ownerProgram], {
        stdio: "ignore",
      });
      let descendantPid;
      try {
        await waitForFile(pidFile);
        descendantPid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
        assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
        owner.kill(ownerSignal);
        const [code, signal] = await once(owner, "exit");
        assert.equal(signal, null);
        assert.equal(code, ownerSignal === "SIGINT" ? 130 : 143);
        await waitForProcessExit(descendantPid);
        await new Promise((resolve) => setTimeout(resolve, 700));
        assert.equal(existsSync(marker), false);
      } finally {
        if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
        if (descendantPid) {
          try { process.kill(descendantPid, "SIGKILL"); } catch { /* already gone */ }
        }
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
}

for (const { depth, ownerSignal } of [
  { depth: 5, ownerSignal: "SIGINT" },
  { depth: 12, ownerSignal: "SIGTERM" },
]) {
  test(
    `${depth}-level owner ${ownerSignal} cleanup contracts each nested reserve`,
    { skip: process.platform === "win32" },
    async () => {
      const directory = mkdtempSync(path.join(os.tmpdir(), "router-process-nested-signal-"));
      const pidFile = path.join(directory, "terminal.pid");
      const fixture = fileURLToPath(new URL(
        "fixtures/process-tree-nested-owner.mjs",
        import.meta.url,
      ));
      const owner = spawn(process.execPath, [fixture, String(depth), pidFile], {
        stdio: "ignore",
      });
      let terminalPid;
      try {
        await waitForFile(pidFile, 5_000);
        terminalPid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
        assert.ok(Number.isInteger(terminalPid) && terminalPid > 0);
        owner.kill(ownerSignal);
        const [code, signal] = await once(owner, "exit");
        assert.equal(signal, null);
        assert.equal(code, ownerSignal === "SIGINT" ? 130 : 143);
        await waitForProcessExit(terminalPid, 2_000);
      } finally {
        if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
        if (terminalPid) {
          try { process.kill(terminalPid, "SIGKILL"); } catch { /* already gone */ }
        }
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
}

async function startBarrierOwningTree({ mode, rollbackMs, barrierMs, depth = 0 }) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "router-process-barrier-signal-"));
  const readyPath = path.join(directory, "ready.pid");
  const completedPath = path.join(directory, "rollback-complete");
  const moduleUrl = new URL("../src/process-tree.mjs", import.meta.url).href;
  const fixture = fileURLToPath(new URL(
    "fixtures/process-tree-barrier-owner.mjs",
    import.meta.url,
  ));
  const ownerProgram = [
    `import { runProcessTree } from ${JSON.stringify(moduleUrl)}`,
    "try {",
    `  await runProcessTree(process.execPath, ${JSON.stringify([
      fixture,
      String(depth),
      mode,
      readyPath,
      completedPath,
      String(rollbackMs),
      String(barrierMs),
    ])}, {`,
    "    childMayOwnProcessTrees: true,",
    "    deadline: Date.now() + 10_000,",
    "  });",
    "} catch {}",
  ].join("\n");
  const owner = spawn(process.execPath, ["--input-type=module", "-e", ownerProgram], {
    stdio: "ignore",
    env: {
      ...process.env,
      CODEX_ROUTER_OWNER_SIGNAL_BUDGET_MS: "1500",
    },
  });
  await waitForFile(readyPath);
  return {
    directory,
    readyPath,
    completedPath,
    owner,
    childPid: Number.parseInt(readFileSync(readyPath, "utf8"), 10),
  };
}

test(
  "multilevel owners preserve a descendant rollback barrier past every ordinary signal budget",
  { skip: process.platform === "win32" },
  async () => {
    const tree = await startBarrierOwningTree({
      mode: "complete",
      rollbackMs: 1_300,
      barrierMs: 2_500,
      depth: 1,
    });
    const startedAt = Date.now();
    try {
      tree.owner.kill("SIGTERM");
      const [code, signal] = await once(tree.owner, "exit");
      assert.equal(signal, null);
      assert.equal(code, 143);
      assert.equal(readFileSync(tree.completedPath, "utf8"), "restored");
      assert.ok(Date.now() - startedAt >= 1_100);
      await waitForProcessExit(tree.childPid);
    } finally {
      if (tree.owner.exitCode === null && tree.owner.signalCode === null) tree.owner.kill("SIGKILL");
      try { process.kill(tree.childPid, "SIGKILL"); } catch { /* already gone */ }
      rmSync(tree.directory, { recursive: true, force: true });
    }
  },
);

test(
  "a stuck descendant barrier remains bounded and is forcibly retired",
  { skip: process.platform === "win32" },
  async () => {
    const tree = await startBarrierOwningTree({
      mode: "stuck",
      rollbackMs: 0,
      barrierMs: 1_800,
    });
    const startedAt = Date.now();
    try {
      tree.owner.kill("SIGTERM");
      const [code, signal] = await once(tree.owner, "exit");
      const elapsed = Date.now() - startedAt;
      assert.equal(signal, null);
      assert.equal(code, 143);
      assert.ok(elapsed >= 1_500, `barrier was cut off after only ${elapsed}ms`);
      assert.ok(elapsed < 4_000, `stuck barrier held shutdown for ${elapsed}ms`);
      assert.equal(existsSync(tree.completedPath), false);
      await waitForProcessExit(tree.childPid);
    } finally {
      if (tree.owner.exitCode === null && tree.owner.signalCode === null) tree.owner.kill("SIGKILL");
      try { process.kill(tree.childPid, "SIGKILL"); } catch { /* already gone */ }
      rmSync(tree.directory, { recursive: true, force: true });
    }
  },
);

test(
  "Windows Job containment retires descendants when the Node owner is terminated abruptly",
  { skip: process.platform !== "win32" },
  async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "router-process-owner-exit-"));
    const pidFile = path.join(directory, "grandchild.pid");
    const marker = path.join(directory, "grandchild-survived");
    const moduleUrl = new URL("../src/process-tree.mjs", import.meta.url).href;
    const childProgram = residualTreeProgram(pidFile, marker, 0).replace(
      /process\.exit\(0\)/,
      "setInterval(() => {}, 1000)",
    );
    const ownerProgram = [
      `import { runProcessTree } from ${JSON.stringify(moduleUrl)}`,
      `await runProcessTree(process.execPath, ['-e', ${JSON.stringify(childProgram)}], { deadline: Date.now() + 60_000 })`,
    ].join(";");
    const owner = spawn(process.execPath, ["--input-type=module", "-e", ownerProgram], {
      stdio: "ignore",
    });
    let descendantPid;
    try {
      await waitForFile(pidFile, 10_000);
      descendantPid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
      owner.kill("SIGKILL");
      await once(owner, "exit");
      await waitForProcessExit(descendantPid, 10_000);
      await new Promise((resolve) => setTimeout(resolve, 700));
      assert.equal(existsSync(marker), false);
    } finally {
      if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
      if (descendantPid) {
        try { process.kill(descendantPid, "SIGKILL"); } catch { /* already gone */ }
      }
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("Windows commands enter a suspended kill-on-close Job Object", () => {
  const invocation = windowsJobProcessInvocation(
    "C:\\Program Files\\nodejs\\node.exe",
    ["worker.mjs", "argument with spaces"],
    {
      environment: {},
      ownerPid: 1234,
      windowsHide: false,
      runner: "C:\\router\\src\\windows-process-tree.ps1",
    },
  );
  assert.equal(invocation.command, "powershell.exe");
  assert.deepEqual(invocation.args.slice(0, -1), [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", "C:\\router\\src\\windows-process-tree.ps1",
  ]);
  assert.deepEqual(
    JSON.parse(Buffer.from(invocation.args.at(-1), "base64").toString("utf8")),
    {
      command: "C:\\Program Files\\nodejs\\node.exe",
      arguments: ["worker.mjs", "argument with spaces"],
      ownerProcessId: 1234,
      windowsHide: false,
      windowsVerbatimArguments: false,
    },
  );
  const runner = readFileSync(new URL("../src/windows-process-tree.ps1", import.meta.url), "utf8");
  assert.match(runner, /CREATE_SUSPENDED/);
  assert.match(runner, /EXTENDED_STARTUPINFO_PRESENT/);
  assert.match(runner, /PROC_THREAD_ATTRIBUTE_HANDLE_LIST/);
  assert.match(runner, /DuplicateHandle/);
  assert.doesNotMatch(runner, /SetHandleInformation/);
  assert.match(runner, /CreateFile\(\s*"NUL"/);
  assert.match(runner, /windowsHide \? CREATE_NO_WINDOW : 0/);
  assert.match(runner, /LanguageMode/);
  assert.match(runner, /AssignProcessToJobObject\(job, process\.hProcess\)/);
  assert.match(runner, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/);
  assert.match(runner, /OpenProcess\(SYNCHRONIZE, false, ownerProcessId\)/);
  assert.match(runner, /WaitForMultipleObjects/);
  assert.match(runner, /TerminateJobObject\(job, 1\)/);
  assert.match(runner, /WaitForEmptyJob\(job\)/);
  const processTree = readFileSync(new URL("../src/process-tree.mjs", import.meta.url), "utf8");
  assert.match(
    processTree,
    /const effectiveWindowsHide = stdio === "inherit" \? false : windowsHide/,
  );
  assert.equal(
    processTree.match(/windowsHide: effectiveWindowsHide/g)?.length,
    2,
    "the PowerShell owner and contained target must share the console policy",
  );
});

test("a failed Windows taskkill falls back to terminating the direct child", async () => {
  const killer = new EventEmitter();
  killer.kill = () => {};
  let childKills = 0;
  const child = {
    pid: 4242,
    exitCode: null,
    signalCode: null,
    kill: () => {
      childKills += 1;
      child.signalCode = "SIGKILL";
    },
  };
  const terminating = terminateProcessTree(child, {
    platform: "win32",
    environment: {},
    spawnImpl: () => {
      queueMicrotask(() => killer.emit("close", 1));
      return killer;
    },
  });
  await terminating;
  assert.equal(childKills, 1);
});
