import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { serviceAppConnectorEnvironment } from "../src/app-connector-policy.mjs";

// Execute the complete lifecycle command and its ownership module with only
// OS, filesystem, scheduler and clock dependencies replaced. Unlike PATH
// stubs, this exercises the same cases on Windows without touching its tasks.
const source = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
const stripImports = (text) => text.replace(/^import\b[\s\S]*?;\s*\n/gm, "").replace(/^export /gm, "");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function run(command, mode, { missingTask = false, queryFailure = false, registration = "present", slowRegistration = false, slow = false, corrupt = false, earlyFailure } = {}) {
  const calls = [], output = [], diagnostics = [], budgets = [];
  const registrationProbes = [];
  let now = 0, killed = false, recordPresent = mode !== "no-record", removed = false;
  const sourceRoot = path.resolve("service-fixture-checkout");
  const stateDir = path.resolve("service-fixture-state");
  const record = {
    version: 1, managed: true, pid: 4242, processIdentity: "fixture-start|node",
    commandLine: `node "${path.join(sourceRoot, "src", "start.mjs")}"`,
    sourceRoot, stateDir, ports: { router: 4200 },
  };
  if (mode === "malformed-record") record.processIdentity = "";
  const processObject = {
    pid: 9999, platform: "win32", argv: ["node", "service-windows.mjs", command],
    execPath: process.execPath, env: { MODEL_ROUTER_STATE_DIR: stateDir }, exitCode: 0,
    stdout: { write: (value) => output.push(value) },
    exit: (code) => { throw Object.assign(new Error("exit"), { exitCode: code }); },
  };
  function spend(options, spawns = 1) {
    const budget = options?.budget;
    budgets.push(budget);
    if (slow) now += spawns * (budget?.timeoutMs ?? 5_000);
  }
  function probe(_pid, options) {
    spend(options);
    if (mode === "unknown-initial" || (killed && mode === "unknown-after-kill")) return { state: "unknown" };
    if (mode === "already-absent" || (killed && !["still-owned", "kill-failed"].includes(mode))) return { state: "absent" };
    return { state: "alive", identity: mode === "reused-pid" ? "new-start|node" : record.processIdentity };
  }
  const os = {
    processStartIdentityProbe: probe,
    processStartIdentity: (pid, options) => { const result = probe(pid, options); return result.state === "alive" ? result.identity : undefined; },
    processCommandLine: (_pid, options) => {
      spend(options, mode === "command-unknown" ? 2 : 1);
      if (mode === "command-unknown") return undefined;
      return mode === "foreign-command" ? "node other-checkout/src/start.mjs" : record.commandLine;
    },
    COLD_START_WINDOWS_PROBE_BUDGET: { timeoutMs: 45_000, attempts: 2 },
  };
  const shared = {
    ...os, path, process: processObject, SOURCE_ROOT: sourceRoot, STATE_DIR: stateDir,
    PORTS: { router: 4200 }, SERVICE_PROCESS_STATE_PATH: path.join(stateDir, "service-process.json"),
    startupTimeoutMs: (_name, defaultMs) => defaultMs, writePrivateJson: () => {},
    readFileSync: () => {
      if (!recordPresent) throw Object.assign(new Error("absent"), { code: "ENOENT" });
      return corrupt ? "{bad json" : JSON.stringify(record);
    },
    unlinkSync: () => { recordPresent = false; calls.push("clear-record"); },
  };
  const ownershipModule = await new AsyncFunction("context", `const {${Object.keys(shared).join(",")}}=context;\n${stripImports(source("service-process.mjs"))}\nreturn {readServiceProcessState, clearServiceProcessState, serviceProcessOwns, serviceProcessOwnership: typeof serviceProcessOwnership === 'function' ? serviceProcessOwnership : undefined, serviceRecordSettled: typeof serviceRecordSettled === 'function' ? serviceRecordSettled : undefined};`)(shared);
  const context = {
    ...shared, ...ownershipModule, CODEX_HOME: "fixture-codex", LOG_PATH: "fixture.log", TARGET: "codex",
    ensureCheckoutReadable: () => { if (earlyFailure === "acl") throw new Error("fixture checkout ACL failed"); },
    protectPrivateFile: () => {},
    providerApiKeyServiceEnvironment: () => ({}), serviceZaiCodingStreamEnvironment: () => ({}),
    responsesWsServiceEnvironment: () => ({}),
    serviceNativeCatalogEnvironment: () => ({}),
    serviceProxyEnvironment: () => ({}), serviceGrokPatchHookEnvironment: () => ({}), serviceStartupTimeoutEnvironment: () => ({}),
    serviceAppConnectorEnvironment: (environment = processObject.env) => serviceAppConnectorEnvironment(environment),
    serviceStartupBackoffEnvironment: () => ({}), resetStartupAttempts: () => true,
    assertServiceWriteIsolated: () => {}, skipServiceManagerCall: () => false,
    windowsScheduledTaskState: async () => undefined,
    existsSync: () => true, mkdirSync: () => {}, renameSync: () => {},
    writeFileSync: () => { if (earlyFailure === "launcher") throw new Error("fixture launcher write failed"); },
    unlinkSync: () => { removed = true; calls.push("remove-launcher"); },
    console: { error: (value) => diagnostics.push(value) },
    Date: class extends Date { static now() { return now; } },
    Atomics: { wait: (_array, _index, _value, duration) => { now += duration; } },
    execFileSync: (executable, args, options) => {
      calls.push(`${executable} ${args.join(" ")}`);
      if (executable === "taskkill.exe") {
        killed = true;
        if (slow) now += options.timeout;
        if (mode === "kill-failed") throw new Error("taskkill failed");
      }
      if (executable === "netstat.exe") {
        if (slow) now += options.timeout;
        if (mode === "port-unknown") throw new Error("netstat unavailable");
        if (mode === "port-listening") return "  TCP    127.0.0.1:4200    0.0.0.0:0    LISTENING    8888\n";
      }
      if (executable === "powershell.exe" || executable === "pwsh.exe") {
        if (args.at(-1).includes("Get-ScheduledTask -ErrorAction Stop")) {
          registrationProbes.push({ executable, script: args.at(-1), options });
          if (slowRegistration) now += options.timeout;
          if (registration === "unknown" || (registration === "second-interpreter" && executable === "powershell.exe")) throw new Error("registration query failed");
          return missingTask ? "absent" : registration === "second-interpreter" ? "present" : registration;
        }
        if (mode === "registration-failed" && args.at(-1).includes("Register-ScheduledTask")) throw new Error("registration restricted");
        return "Ready";
      }
      if ((missingTask || queryFailure) && executable === "schtasks.exe" && args[0] === "/Query") throw new Error("task query unavailable");
      if (mode === "disable-failed" && executable === "schtasks.exe" && args.includes("/DISABLE")) throw new Error("disable denied");
      return "";
    },
  };
  let error;
  try {
    await new AsyncFunction("context", `const {${Object.keys(context).join(",")}}=context;\n${stripImports(source("service-windows.mjs"))}`)(context);
  } catch (caught) { error = caught; processObject.exitCode = caught.exitCode ?? 1; }
  return { calls, output: output.join(""), diagnostics, recordPresent, killed, removed, now, budgets, registrationProbes, error, exitCode: processObject.exitCode };
}

for (const mode of ["unknown-initial", "unknown-after-kill", "command-unknown", "still-owned", "kill-failed", "port-unknown", "port-listening"]) {
  for (const command of ["stop", "restart", "uninstall", "install"]) {
    test(`${command} refuses ${mode} without clearing state or launching a replacement`, async () => {
      const result = await run(command, mode);
      assert.equal(result.exitCode, 1, JSON.stringify(result));
      assert.equal(result.recordPresent, true);
      assert.equal(result.removed, false);
      assert.equal(result.output, "", "an unverified operation must not emit a success record");
      assert.equal(result.error?.code, "SERVICE_STOP_UNVERIFIED");
      assert.match(result.error?.message ?? result.diagnostics.join("\n"), /could not (?:be )?verif|unverified|not confirmed/i);
      assert.equal(result.calls.some((call) => /schtasks\.exe \/Run|schtasks\.exe \/Delete|Register-ScheduledTask/.test(call)), false);
      if (["unknown-initial", "command-unknown"].includes(mode)) assert.equal(result.killed, false);
      const disable = result.calls.findIndex((call) => call.includes("/DISABLE"));
      const end = result.calls.findIndex((call) => call.startsWith("schtasks.exe /End"));
      assert.ok(disable >= 0 && disable < end, "the heartbeat must stay disabled while shutdown is unverified");
    });
  }
}

for (const mode of ["gone-after-kill", "already-absent", "reused-pid", "foreign-command"]) {
  test(`stop accounts for ${mode} without killing an unowned PID`, async () => {
    const result = await run("stop", mode);
    assert.equal(result.exitCode, 0, result.error?.stack);
    assert.equal(result.recordPresent, false);
    assert.equal(result.killed, mode === "gone-after-kill");
    assert.deepEqual(JSON.parse(result.output), { state: "stopped" });
  });
}

test("stop still cleans a recorded orphan when the scheduled task is absent", async () => {
  const result = await run("stop", "gone-after-kill", { missingTask: true });
  assert.equal(result.exitCode, 0, result.error?.stack);
  assert.equal(result.killed, true);
  assert.equal(result.recordPresent, false);
});

test("an unidentifiable orphan refuses stop even without its scheduled task", async () => {
  const result = await run("stop", "unknown-initial", { missingTask: true });
  assert.equal(result.exitCode, 1);
  assert.equal(result.recordPresent, true);
  assert.equal(result.killed, false);
});

test("a missing task and absent record make repeated stop idempotent", async () => {
  const result = await run("stop", "no-record", { missingTask: true });
  assert.equal(result.exitCode, 0);
  assert.equal(result.killed, false);
  assert.equal(result.calls.some((call) => /\/Run|\/Change|taskkill/.test(call)), false);
});

for (const command of ["stop", "restart", "uninstall", "install"]) {
  for (const registration of ["unknown", "malformed"]) {
    test(`${command} refuses an unanswered ${registration} registration query before touching the tree`, async () => {
      const result = await run(command, "gone-after-kill", { queryFailure: true, registration });
      assert.equal(result.exitCode, 1, JSON.stringify(result));
      assert.equal(result.error?.code, "SERVICE_STOP_UNVERIFIED");
      assert.equal(result.recordPresent, true);
      assert.equal(result.killed, false);
      assert.equal(result.removed, false);
      assert.equal(result.output, "");
      assert.equal(result.calls.some((call) => /\/Run|\/End|\/Delete|Register-ScheduledTask/.test(call)), false);
      assert.equal(result.registrationProbes.length, 2);
    });
  }
}

for (const registration of ["present", "second-interpreter"]) {
  test(`an answered ${registration} registration query still disables the heartbeat before stopping`, async () => {
    const result = await run("stop", "gone-after-kill", { queryFailure: true, registration });
    assert.equal(result.exitCode, 0, result.error?.stack);
    assert.equal(result.killed, true);
    assert.equal(result.recordPresent, false);
    const disable = result.calls.findIndex((call) => call.includes("/DISABLE"));
    const end = result.calls.findIndex((call) => call.startsWith("schtasks.exe /End"));
    assert.ok(disable >= 0 && disable < end);
  });
}

test("an unanswered registration cannot report a no-record service stopped", async () => {
  const result = await run("stop", "no-record", { queryFailure: true, registration: "unknown" });
  assert.equal(result.exitCode, 1);
  assert.equal(result.error?.code, "SERVICE_STOP_UNVERIFIED");
  assert.equal(result.output, "");
  assert.equal(result.killed, false);
});

test("registration fallbacks share one deadline instead of multiplying it", async () => {
  const result = await run("stop", "gone-after-kill", { queryFailure: true, registration: "unknown", slowRegistration: true });
  assert.equal(result.exitCode, 1);
  assert.equal(result.registrationProbes.length, 1);
  assert.ok(result.now <= 10_000, `query spent ${result.now}ms`);
  assert.equal(result.killed, false);
  assert.equal(result.recordPresent, true);
});

test("the real PowerShell registration script answers absence and presence and refuses query errors", { skip: process.platform !== "win32" }, async () => {
  const fixture = await run("stop", "no-record", { queryFailure: true, registration: "unknown" });
  const script = fixture.registrationProbes[0].script;
  for (const [body, status, answer] of [
    ["return", 0, "absent"],
    ["[pscustomobject]@{ TaskName='Codex Router'; TaskPath='\\' }", 0, "present"],
    ["[pscustomobject]@{ TaskName='Codex Router'; TaskPath='\\another\\' }", 0, "absent"],
    ["[pscustomobject]@{ TaskName='Other task'; TaskPath='\\' }", 0, "absent"],
    ["Write-Error 'fixture query unavailable'", 1, ""],
  ]) {
    // Replace this child process's cmdlet only; never enumerate or modify host tasks.
    const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      `function Get-ScheduledTask { [CmdletBinding()] param(); ${body} }; ${script}`,
    ], { encoding: "utf8", timeout: 45_000, windowsHide: true, env: { ...process.env, CODEX_ROUTER_TASK: "Codex Router" } });
    assert.equal(result.status, status, result.error?.message ?? result.stderr);
    assert.equal(result.stdout.trim(), answer);
  }
});

test("an unreadable process record blocks install recovery instead of running over it", async () => {
  const result = await run("install", "gone-after-kill", { corrupt: true });
  assert.equal(result.exitCode, 1);
  assert.equal(result.recordPresent, true);
  assert.equal(result.calls.some((call) => /\/Run|Register-ScheduledTask/.test(call)), false);
});

test("a malformed managed record cannot count as an answered foreign process", async () => {
  const result = await run("restart", "malformed-record");
  assert.equal(result.exitCode, 1);
  assert.equal(result.recordPresent, true);
  assert.equal(result.killed, false);
  assert.equal(result.budgets.length, 0);
  assert.equal(result.calls.some((call) => /\/Run/.test(call)), false);
});

for (const earlyFailure of ["acl", "launcher"]) {
  test(`an early ${earlyFailure} failure cannot run install recovery without a verified stop`, async () => {
    const result = await run("install", "unknown-initial", { earlyFailure });
    assert.equal(result.exitCode, 1);
    assert.equal(result.recordPresent, true);
    assert.equal(result.killed, false);
    assert.equal(result.budgets.length, 0);
    assert.equal(result.calls.some((call) => /\/Run|\/ENABLE|Register-ScheduledTask/.test(call)), false);
    assert.match(result.diagnostics.join("\n"), /fixture .* failed/);
  });
}

test("install still restores a surviving registration after a verified stop", async () => {
  const result = await run("install", "registration-failed");
  assert.equal(result.exitCode, 0, result.error?.stack);
  assert.equal(result.recordPresent, false);
  assert.equal(result.calls.filter((call) => call.startsWith("schtasks.exe /Run")).length, 1);
});

test("install cannot recover by running a task whose heartbeat it failed to disable", async () => {
  const result = await run("install", "disable-failed");
  assert.equal(result.exitCode, 1);
  assert.equal(result.error?.code, "SERVICE_STOP_UNVERIFIED");
  assert.equal(result.recordPresent, true);
  assert.equal(result.killed, false);
  assert.equal(result.calls.some((call) => /\/Run|Register-ScheduledTask/.test(call)), false);
});

for (const mode of ["command-unknown", "unknown-after-kill", "still-owned", "port-unknown", "port-listening"]) {
  test(`slow ${mode} probes cannot outlive the service-tree stop allowance`, async () => {
    const result = await run("restart", mode, { slow: true });
    assert.equal(result.exitCode, 1);
    assert.ok(result.now <= 15_000, `stop spent ${result.now}ms`);
    assert.ok(result.budgets.every((budget) => budget?.attempts === 1 && budget.timeoutMs <= 2_000));
    assert.equal(result.recordPresent, true);
  });
}
