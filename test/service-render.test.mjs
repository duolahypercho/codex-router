import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function serviceEnv(platform, testRoot, target = "codex") {
  return {
    ...process.env,
    CODEX_HOME: path.join(testRoot, "codex home"),
    CODEX_ROUTER_STATE_DIR: path.join(testRoot, "router state"),
    MODEL_ROUTER_STATE_DIR: path.join(testRoot, `${target} router state`),
    MODEL_ROUTER_TARGET: target,
    CODEX_ROUTER_SERVICE_PLATFORM: platform,
    XDG_CONFIG_HOME: path.join(testRoot, "xdg config"),
  };
}

function serviceCommand(
  script,
  platform,
  testRoot,
  command = "render",
  target = "codex",
  sourceRoot = root,
  env = {},
) {
  const nodeArgs = sourceRoot === root ? [] : ["--preserve-symlinks", "--preserve-symlinks-main"];
  return execFileSync(
    process.execPath,
    [...nodeArgs, path.join(sourceRoot, "src", script), command],
    {
      cwd: sourceRoot,
      encoding: "utf8",
      env: { ...serviceEnv(platform, testRoot, target), ...env },
    },
  );
}

function render(script, platform, testRoot, target = "codex", sourceRoot = root) {
  return serviceCommand(script, platform, testRoot, "render", target, sourceRoot);
}

function writePoolEnvironmentFixture(testRoot) {
  const stateDir = path.join(testRoot, "codex router state");
  const credentialId = "cred_ServiceEnvironment1234";
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path.join(stateDir, "provider-credentials.json"), `${JSON.stringify({
    schemaVersion: 2,
    credentials: [{
      id: credentialId,
      providerId: "opencode-go",
      kind: "api_key",
      state: "active",
      secretRef: {
        type: "environment",
        providerId: "opencode-go",
        target: "codex",
        name: "OPENCODE_API_KEY",
      },
    }],
  })}\n`, { mode: 0o600 });
  writeFileSync(path.join(stateDir, "provider-api-key-pools.json"), `${JSON.stringify({
    version: 1,
    providers: {
      "opencode-go": {
        providerId: "opencode-go",
        credentials: {
          [credentialId]: { id: credentialId, providerId: "opencode-go" },
        },
      },
    },
  })}\n`, { mode: 0o600 });
}

// Mirrors src/service-windows.mjs: MODEL_ROUTER_STATE_DIR wins over every other
// state-directory source, and the fixture name deliberately carries a space.
function windowsStateDir(testRoot) {
  return path.join(testRoot, "codex router state");
}

// Mirrors the quoting in src/service-linux.mjs. Fixture paths are host-shaped,
// so on Windows they carry backslashes that the unit file has to escape; the
// expectation has to escape them too or the test only passes on POSIX hosts.
function systemdQuoted(value) {
  return `"${value
    .replaceAll("%", "%%")
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')}"`;
}

function launchdXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

test("background service definitions render for macOS, Linux, and Windows", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-services-"));
  try {
    const launchd = render("service-macos.mjs", "darwin", testRoot);
    assert.match(launchd, /<string>io\.github\.codex-router<\/string>/);
    assert.match(launchd, /<key>PATH<\/key>/);
    assert.match(launchd, /CODEX_ROUTER_STATE_DIR/);
    // Background starves LiteLLM; Adaptive is a no-op without XPC and starves
    // Node forwarders past the 30s OAuth health budget. Keep Standard.
    assert.match(launchd, /<key>ProcessType<\/key>\s*<string>Standard<\/string>/);
    assert.doesNotMatch(launchd, /<key>ProcessType<\/key>\s*<string>Adaptive<\/string>/);
    assert.doesNotMatch(launchd, /<key>ProcessType<\/key>\s*<string>Background<\/string>/);

    const systemd = render("service-linux.mjs", "linux", testRoot);
    assert.match(systemd, /\[Service\]/);
    assert.match(systemd, /ExecStart=/);
    assert.match(systemd, /Environment="PATH=/);
    assert.match(systemd, /Environment="CODEX_ROUTER_STATE_DIR=/);
    assert.match(systemd, /MODEL_ROUTER_GATEWAY_PORT=4200/);
    assert.match(systemd, /MODEL_ROUTER_OAUTH_PORT=4201/);
    assert.match(systemd, /MODEL_ROUTER_PORT=4202/);
    assert.match(systemd, /MODEL_ROUTER_API_PORT=4203/);

    const windows = render("service-windows.mjs", "win32", testRoot);
    assert.match(windows, /@echo off\r?\n/);
    assert.match(windows, /set "CODEX_ROUTER_STATE_DIR=/);
    assert.match(windows, /litellm|start\.mjs/);
    // The Python gateway must run with UTF-8 output even when the host
    // console code page is not UTF-8 (see service-windows.mjs).
    assert.match(windows, /set "PYTHONIOENCODING=utf-8"/);
    assert.match(windows, /set "PYTHONUTF8=1"/);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("background services never copy the Antigravity client secret", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-antigravity-service-"));
  const secret = "test-antigravity-client-secret";
  try {
    const launchd = serviceCommand(
      "service-macos.mjs", "darwin", testRoot, "render", "codex", root,
      { ANTIGRAVITY_CLIENT_SECRET: secret },
    );
    assert.doesNotMatch(launchd, /ANTIGRAVITY_CLIENT_SECRET|test-antigravity-client-secret/);

    const systemd = serviceCommand(
      "service-linux.mjs", "linux", testRoot, "render", "codex", root,
      { ANTIGRAVITY_CLIENT_SECRET: secret },
    );
    assert.doesNotMatch(systemd, /ANTIGRAVITY_CLIENT_SECRET|test-antigravity-client-secret/);

    const windows = serviceCommand(
      "service-windows.mjs", "win32", testRoot, "render", "codex", root,
      { ANTIGRAVITY_CLIENT_SECRET: secret },
    );
    assert.doesNotMatch(windows, /ANTIGRAVITY_CLIENT_SECRET|test-antigravity-client-secret/);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("background services preserve only environment credentials referenced by a pool", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-pool-environment-service-"));
  const secret = "test-pooled-opencode-secret";
  try {
    writePoolEnvironmentFixture(testRoot);
    const environment = {
      OPENCODE_API_KEY: secret,
      OPENCODE_GO_API_KEY: "unreferenced-secret-must-not-appear",
    };
    const launchd = serviceCommand(
      "service-macos.mjs", "darwin", testRoot, "render", "codex", root, environment,
    );
    assert.match(launchd, new RegExp(`<key>OPENCODE_API_KEY</key>\\s*<string>${secret}</string>`));
    assert.doesNotMatch(launchd, /unreferenced-secret-must-not-appear|OPENCODE_GO_API_KEY/);

    const systemd = serviceCommand(
      "service-linux.mjs", "linux", testRoot, "render", "codex", root, environment,
    );
    assert.match(systemd, new RegExp(`Environment="OPENCODE_API_KEY=${secret}"`));
    assert.doesNotMatch(systemd, /unreferenced-secret-must-not-appear|OPENCODE_GO_API_KEY/);

    const windows = serviceCommand(
      "service-windows.mjs", "win32", testRoot, "render", "codex", root, environment,
    );
    assert.match(windows, new RegExp(`set "OPENCODE_API_KEY=${secret}"`));
    assert.doesNotMatch(windows, /unreferenced-secret-must-not-appear|OPENCODE_GO_API_KEY/);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("background services preserve the installer's proxy environment", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-service-proxy-"));
  const proxyEnvironment = {
    http_proxy: "http://proxy.example:8080",
    HTTPS_PROXY: "http://secure-proxy.example:8443",
    all_proxy: "socks5://proxy.example:1080",
    NO_PROXY: "localhost,127.0.0.1,::1",
    NODE_USE_ENV_PROXY: "1",
  };
  try {
    const launchd = serviceCommand(
      "service-macos.mjs",
      "darwin",
      testRoot,
      "render",
      "codex",
      root,
      proxyEnvironment,
    );
    const systemd = serviceCommand(
      "service-linux.mjs",
      "linux",
      testRoot,
      "render",
      "codex",
      root,
      proxyEnvironment,
    );
    const windows = serviceCommand(
      "service-windows.mjs",
      "win32",
      testRoot,
      "render",
      "codex",
      root,
      proxyEnvironment,
    );

    for (const [name, value] of Object.entries(proxyEnvironment)) {
      assert.ok(
        launchd.includes(
          `<key>${launchdXml(name)}</key>\n    <string>${launchdXml(value)}</string>`,
        ),
        `launchd did not preserve ${name}`,
      );
      assert.ok(
        systemd.includes(`Environment=${systemdQuoted(`${name}=${value}`)}`),
        `systemd did not preserve ${name}`,
      );
      assert.ok(
        windows.includes(`set "${name}=${value}"`),
        `Task Scheduler wrapper did not preserve ${name}`,
      );
    }
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test(
  "the generated systemd unit stays owner-only when it stores proxy settings",
  { skip: process.platform === "win32" },
  () => {
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-service-mode-"));
    const stubDir = path.join(testRoot, "bin");
    mkdirSync(stubDir, { recursive: true });
    const systemctl = path.join(stubDir, "systemctl");
    writeFileSync(systemctl, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(systemctl, 0o755);
    try {
      serviceCommand(
        "service-linux.mjs",
        "linux",
        testRoot,
        "install",
        "codex",
        root,
        {
          PATH: `${stubDir}${path.delimiter}${process.env.PATH || ""}`,
          HTTPS_PROXY: "http://user:secret@proxy.example:8443",
        },
      );

      const unitPath = path.join(
        testRoot,
        "xdg config",
        "systemd",
        "user",
        "codex-router.service",
      );
      assert.equal(statSync(unitPath).mode & 0o777, 0o600);
      assert.match(readFileSync(unitPath, "utf8"), /HTTPS_PROXY=/);
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);

test("packaged services preserve wrapper and PATH values with service-safe quoting", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-packaged-service-"));
  const stableRoot = path.join(testRoot, "opt % router", "libexec");
  const stableNode = path.join(testRoot, 'runtime "bin" %', "node wrapper");
  const servicePath = `${path.dirname(stableNode)}:${path.join(testRoot, "support & tools")}`;
  const env = {
    CODEX_ROUTER_SOURCE_ROOT: stableRoot,
    CODEX_ROUTER_NODE_BIN: stableNode,
    CODEX_ROUTER_PACKAGE_MANAGER: "homebrew",
    PATH: servicePath,
  };
  try {
    const launchd = serviceCommand(
      "service-macos.mjs",
      "darwin",
      testRoot,
      "render",
      "codex",
      root,
      env,
    );
    assert.ok(launchd.includes(`<string>${launchdXml(stableNode)}</string>`));
    assert.ok(
      launchd.includes(
        `<key>PATH</key>\n    <string>${launchdXml(servicePath)}</string>`,
      ),
    );
    assert.match(launchd, /<key>CODEX_ROUTER_SOURCE_ROOT<\/key>/);
    assert.match(launchd, /<key>CODEX_ROUTER_NODE_BIN<\/key>/);
    assert.match(launchd, /<string>homebrew<\/string>/);

    const systemd = serviceCommand(
      "service-linux.mjs",
      "linux",
      testRoot,
      "render",
      "codex",
      root,
      env,
    );
    assert.ok(systemd.includes(`WorkingDirectory=${stableRoot.replaceAll("%", "%%")}`));
    assert.ok(systemd.includes(`ExecStart=${systemdQuoted(stableNode)}`));
    assert.ok(systemd.includes(`Environment=${systemdQuoted(`PATH=${servicePath}`)}`));
    assert.ok(systemd.includes(`Environment="CODEX_ROUTER_PACKAGE_MANAGER=homebrew"`));
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("the Windows launcher starts the wrapper hidden and propagates its exit code", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-hidden-launcher-"));
  try {
    const stateDir = windowsStateDir(testRoot);
    assert.ok(stateDir.includes(" "), "the fixture state directory must contain a space");
    const wrapperPath = path.join(stateDir, "start-codex-router.cmd");
    const script = serviceCommand("service-windows.mjs", "win32", testRoot, "render-launcher");

    assert.match(script, /^Option Explicit\r\n/);
    assert.match(script, /\r\nSet shell = CreateObject\("WScript\.Shell"\)\r\n/);
    // Window style 0 hides the wrapper's console; True waits for it so that
    // Run returns the wrapper's exit code instead of returning immediately.
    assert.ok(
      script.includes(
        `status = shell.Run("cmd.exe /D /C " & quote & quote & "${wrapperPath}" & quote & quote, 0, True)\r\n`,
      ),
      `launcher did not embed the wrapper path correctly:\n${script}`,
    );
    // LastTaskResult still needs the real exit code for doctor/readiness.
    assert.match(script, /\r\nWScript\.Quit status\r\n$/);
    // A failure to even start the wrapper must also surface as a failure.
    assert.match(script, /\r\nIf Err\.Number <> 0 Then\r\n {2}WScript\.Quit 1\r\nEnd If\r\n/);

    // Every generated line must be a valid VBScript statement: string literals
    // escape a double quote by doubling it, so quotes always come in pairs.
    for (const line of script.split("\r\n")) {
      assert.equal(
        (line.match(/"/g) || []).length % 2,
        0,
        `unbalanced quotes in generated line: ${line}`,
      );
    }
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("the Windows scheduled task runs the VBS launcher through wscript.exe", () => {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-task-action-"));
  try {
    const launcherPath = path.join(windowsStateDir(testRoot), "start-codex-router-hidden.vbs");
    const action = JSON.parse(
      serviceCommand("service-windows.mjs", "win32", testRoot, "render-task"),
    );

    assert.equal(action.execute, "wscript.exe");
    // //B and //NoLogo keep the windowless host quiet; the launcher path takes a
    // single quote pair because wscript.exe uses the standard argument parser.
    assert.equal(action.argument, `//B //NoLogo "${launcherPath}"`);
    // The console-visible cmd.exe action is what issue #98 reported.
    assert.doesNotMatch(`${action.execute} ${action.argument}`, /cmd\.exe/);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("Windows installTask registers a minute heartbeat beside logon", () => {
  // RestartOnFailure does not relaunch after a started action exits (issue #581).
  // The heartbeat trigger is the supervisor; IgnoreNew drops it while Running.
  const source = readFileSync(path.join(root, "src", "service-windows.mjs"), "utf8");
  const install = source.slice(
    source.indexOf("function installTask()"),
    source.indexOf("function waitForTaskToStop()"),
  );
  assert.match(install, /New-ScheduledTaskTrigger -AtLogOn/);
  assert.match(
    install,
    /New-ScheduledTaskTrigger -Once -At \(Get-Date\) -RepetitionInterval \(New-TimeSpan -Minutes 1\)/,
  );
  assert.match(install, /-Trigger @\(\$logon, \$heartbeat\)/);
  assert.match(install, /-MultipleInstances IgnoreNew -StartWhenAvailable/);
});

test("Windows explicit stop disables heartbeat while start and restart re-enable it", () => {
  const source = readFileSync(path.join(root, "src", "service-windows.mjs"), "utf8");
  assert.match(source, /function setTaskEnabled\(enabled\)/);
  assert.match(
    source,
    /command === "stop"\) \{[\s\S]*?setTaskEnabled\(false\);[\s\S]*?endTask\(\);/,
  );
  assert.match(
    source,
    /if \(command === "restart"\) endTask\(\);[\s\S]*?setTaskEnabled\(true\);[\s\S]*?schtasks\(\["\/Run"/,
  );
});

// Propagating the wrapper exit code keeps LastTaskResult honest for doctor
// and readiness. It is not what relaunches a dead router: RestartOnFailure
// only covers actions that fail to start (issue #581). The minute heartbeat
// trigger in installTask() is the supervisor.
// Nothing off Windows can execute a .vbs, so -- exactly like
// `install.ps1 parses under powershell.exe` in test/installer-scripts.test.mjs --
// this is the only place that link is executed rather than reasoned about.
//
// wscript.exe with //B //NoLogo is the host the scheduled task actually uses
// (see taskAction in src/service-windows.mjs). cscript.exe is the console host
// over the same script engine, and it runs without //B so that a broken
// launcher reports the parse or runtime error on stderr instead of arriving as
// an unexplained exit code.
const WINDOWS_SCRIPT_HOSTS = [
  { name: "cscript.exe", args: ["//NoLogo"] },
  { name: "wscript.exe", args: ["//B", "//NoLogo"] },
];

// Resolved absolutely: these live in the system directory, and naming them
// outright keeps the test independent of whatever PATH the runner supplies.
function scriptHost(name) {
  return path.join(process.env.SystemRoot || "C:\\Windows", "System32", name);
}

test(
  "the generated Windows launcher returns the wrapper's exit code to its script host",
  { skip: process.platform !== "win32" },
  () => {
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-vbs-exit-"));
    try {
      const stateDir = windowsStateDir(testRoot);
      mkdirSync(stateDir, { recursive: true });
      const wrapperPath = path.join(stateDir, "start-codex-router.cmd");
      const launcherPath = path.join(stateDir, "start-codex-router-hidden.vbs");

      // The shipped generator produces the source. Only the encoding is
      // repeated here: `install` is the code path that writes the file, and
      // running it would register a real scheduled task on this machine.
      // `the Windows installer writes both launchers idempotently` asserts that
      // the shipped writer emits exactly these bytes.
      const source = serviceCommand(
        "service-windows.mjs",
        "win32",
        testRoot,
        "render-launcher",
      );
      const encoded = Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from(source, "utf16le"),
      ]);
      writeFileSync(launcherPath, encoded);

      const report = (host, result, expectation, note) =>
        [
          `host: ${host.name} ${host.args.join(" ")} "${launcherPath}"`,
          `expected exit code: ${expectation}`,
          `actual exit code: ${result.status}`,
          `terminating signal: ${result.signal ?? "none"}`,
          `spawn error: ${result.error ? result.error.message : "none"}`,
          `stdout: ${(result.stdout || "").trim() || "(empty)"}`,
          `stderr: ${(result.stderr || "").trim() || "(empty)"}`,
          note,
          "generated launcher source:",
          source,
        ].join("\n");

      const runLauncher = (host) => {
        const result = spawnSync(scriptHost(host.name), [...host.args, launcherPath], {
          encoding: "utf8",
          timeout: 60_000,
          windowsHide: true,
        });
        // A spawn failure or a timeout leaves status null, which would satisfy
        // the "not zero" assertion below without the launcher having run at all.
        assert.equal(
          typeof result.status,
          "number",
          report(host, result, "any number", "the script host did not run to completion"),
        );
        return result;
      };

      for (const host of WINDOWS_SCRIPT_HOSTS) {
        // A crashed router has to reach Task Scheduler as a failed run. 42 is
        // arbitrary and distinctive: it is neither the 1 a WSH script error
        // produces nor the 0 a silent success would.
        writeFileSync(wrapperPath, "@echo off\r\nexit /b 42\r\n");
        let result = runLauncher(host);
        assert.equal(
          result.status,
          42,
          report(host, result, 42, "the wrapper's exit code must reach the host unchanged"),
        );

        // ...and the reverse: a clean stop must not be reported as a failure,
        // or the task restarts a router that was deliberately shut down.
        writeFileSync(wrapperPath, "@echo off\r\nexit /b 0\r\n");
        result = runLauncher(host);
        assert.equal(
          result.status,
          0,
          report(host, result, 0, "a clean wrapper exit must not be reported as a failure"),
        );

        // A wrapper that cannot start at all must still fail. `On Error Resume
        // Next` without the Err.Number guard leaves `status` unset, and
        // `WScript.Quit` on an unset value exits 0 -- which is the shape that
        // silently disables the restart policy. cmd.exe itself reports this
        // particular failure; the Err.Number branch covers a cmd.exe that will
        // not start, which no ordinary host can reproduce because CreateProcess
        // resolves it from the system directory whatever PATH says.
        rmSync(wrapperPath);
        result = runLauncher(host);
        assert.notEqual(
          result.status,
          0,
          report(host, result, "anything but 0", "a wrapper that never ran must not report success"),
        );
      }
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);

test(
  "the Windows installer writes both launchers idempotently and uninstall removes both",
  { skip: process.platform === "win32" },
  () => {
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-win-install-"));
    try {
      const stateDir = windowsStateDir(testRoot);
      const wrapperPath = path.join(stateDir, "start-codex-router.cmd");
      const launcherPath = path.join(stateDir, "start-codex-router-hidden.vbs");
      const run = (command) =>
        JSON.parse(serviceCommand("service-windows.mjs", "win32", testRoot, command));

      // schtasks.exe and powershell.exe are absent off Windows. The launchers
      // are still generated, but the service is not truthfully reported as
      // installed when no Task Scheduler definition exists.
      assert.equal(run("install").installed, false);
      assert.equal(existsSync(wrapperPath), true);
      assert.equal(existsSync(launcherPath), true);
      assert.equal(statSync(wrapperPath).mode & 0o777, 0o600);
      assert.equal(statSync(launcherPath).mode & 0o777, 0o600);

      const bytes = readFileSync(launcherPath);
      // wscript.exe falls back to the ANSI code page without this byte order
      // mark, which corrupts a state directory holding non-ASCII characters.
      assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe]);
      assert.match(bytes.toString("utf16le").slice(1), /^Option Explicit\r\n/);

      // Reinstalling over an existing pair overwrites instead of failing.
      assert.equal(run("install").installed, false);
      assert.equal(readFileSync(launcherPath).equals(bytes), true);

      assert.equal(run("uninstall").installed, false);
      assert.equal(existsSync(wrapperPath), false);
      assert.equal(existsSync(launcherPath), false);

      // Uninstalling again must not fail on the already-removed launchers.
      assert.equal(run("uninstall").installed, false);
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);

// Off Windows there is no schtasks.exe or powershell.exe, so every scheduler
// call src/service-windows.mjs makes is a failure and the ordering between them
// is invisible. Executable stubs of those names, first on PATH, make the whole
// sequence observable and let one call be failed on demand -- which is the only
// way to reach the recovery path without a Windows box and a restricted shell.
// They can never shadow the real executables, because the tests that use them
// are skipped on win32.
function schedulerStubs(directory, options = {}) {
  const {
    schtasksFail = "",
    powershellFail = "",
    runningQueries = 0,
    authoritativeState = "0|0|0",
    authoritativeFail = false,
  } = options;
  mkdirSync(directory, { recursive: true });
  const logPath = path.join(directory, "calls.log");
  const counterPath = path.join(directory, "state-queries");
  const preamble = (fail) =>
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> "${logPath}"`,
      `for pattern in ${fail}; do`,
      '  case "$*" in *"$pattern"*) exit 1 ;; esac',
      "done",
    ].join("\n");

  writeFileSync(path.join(directory, "schtasks.exe"), `${preamble(schtasksFail)}\nexit 0\n`);
  // taskState() reads the task state off this process's stdout. The counter is
  // what lets a test say "report Running for the first N queries", so the stop
  // wait can be observed polling and then finishing.
  writeFileSync(
    path.join(directory, "powershell.exe"),
    [
      preamble(powershellFail),
      'case "$*" in',
      "  *Schedule.Service*)",
      authoritativeFail
        ? "    exit 1"
        : `    printf '%s' ${JSON.stringify(authoritativeState)}`,
      "    ;;",
      "  *Get-ScheduledTask*)",
      "    count=0",
      `    if [ -f "${counterPath}" ]; then count=$(cat "${counterPath}"); fi`,
      "    count=$((count + 1))",
      `    printf '%s' "$count" > "${counterPath}"`,
      `    if [ "$count" -le ${runningQueries} ]; then printf 'Running'; else printf 'Ready'; fi`,
      "    ;;",
      "esac",
      "exit 0",
      "",
    ].join("\n"),
  );

  for (const name of ["schtasks.exe", "powershell.exe"]) {
    chmodSync(path.join(directory, name), 0o755);
  }
  return {
    path: `${directory}${path.delimiter}${process.env.PATH}`,
    calls: () =>
      existsSync(logPath)
        ? readFileSync(logPath, "utf8").split("\n").filter(Boolean)
        : [],
  };
}

function runWindowsService(testRoot, command, extraEnv = {}) {
  return spawnSync(
    process.execPath,
    [path.join(root, "src", "service-windows.mjs"), command],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 120_000,
      env: { ...serviceEnv("win32", testRoot), ...extraEnv },
    },
  );
}

test(
  "Windows stop disables the heartbeat before ending the active task",
  { skip: process.platform === "win32" },
  () => {
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-win-explicit-stop-"));
    try {
      const stubs = schedulerStubs(path.join(testRoot, "scheduler"));
      const result = runWindowsService(testRoot, "stop", { PATH: stubs.path });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { state: "stopped" });

      const calls = stubs.calls();
      const disable = calls.findIndex((line) => line.includes("/Change") && line.includes("/DISABLE"));
      const end = calls.findIndex((line) => line.includes("/End"));
      assert.ok(disable >= 0, `explicit stop did not disable the task:\n${calls.join("\n")}`);
      assert.ok(end > disable, `task must be disabled before /End:\n${calls.join("\n")}`);
      assert.equal(calls.some((line) => line.includes("/Run")), false);
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);

test(
  "Windows start and restart re-enable heartbeat recovery before running",
  { skip: process.platform === "win32" },
  async (context) => {
    for (const command of ["start", "restart"]) {
      await context.test(command, () => {
        const testRoot = mkdtempSync(path.join(os.tmpdir(), `codex-router-win-${command}-enable-`));
        try {
          const stubs = schedulerStubs(path.join(testRoot, "scheduler"));
          const result = runWindowsService(testRoot, command, { PATH: stubs.path });
          assert.equal(result.status, 0, result.stderr);
          assert.deepEqual(JSON.parse(result.stdout), { state: "running" });

          const calls = stubs.calls();
          const enable = calls.findIndex((line) => line.includes("/Change") && line.includes("/ENABLE"));
          const run = calls.findIndex((line) => line.includes("/Run"));
          assert.ok(enable >= 0, `${command} did not re-enable the task:\n${calls.join("\n")}`);
          assert.ok(run > enable, `${command} must enable before /Run:\n${calls.join("\n")}`);
          if (command === "restart") {
            const end = calls.findIndex((line) => line.includes("/End"));
            assert.ok(end >= 0 && end < enable, `restart must end before enabling:\n${calls.join("\n")}`);
          }
        } finally {
          rmSync(testRoot, { recursive: true, force: true });
        }
      });
    }
  },
);

test(
  "Windows status trusts a live launcher when Task Scheduler reports Ready",
  { skip: process.platform === "win32" },
  () => {
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-win-status-live-"));
    try {
      const stubs = schedulerStubs(path.join(testRoot, "scheduler"), {
        authoritativeState: "1|267009|1",
      });
      const result = runWindowsService(testRoot, "status", { PATH: stubs.path });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        installed: true,
        loaded: true,
        state: "running",
      });
      assert.equal(stubs.calls().some((line) => line.includes("Schedule.Service")), true);
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);

test(
  "Windows status keeps Ready when the authoritative launcher is dead",
  { skip: process.platform === "win32" },
  () => {
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-win-status-dead-"));
    try {
      const stubs = schedulerStubs(path.join(testRoot, "scheduler"), {
        authoritativeState: "1|267014|0",
      });
      const result = runWindowsService(testRoot, "status", { PATH: stubs.path });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        installed: true,
        loaded: false,
        state: "ready",
      });
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);

test(
  "Windows status does not claim an idle task from an external launcher",
  { skip: process.platform === "win32" },
  () => {
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-win-status-external-"));
    try {
      const stubs = schedulerStubs(path.join(testRoot, "scheduler"), {
        authoritativeState: "0|267009|1",
      });
      const result = runWindowsService(testRoot, "status", { PATH: stubs.path });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        installed: true,
        loaded: false,
        state: "ready",
      });
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);

test(
  "Windows status keeps Ready when launcher evidence is incomplete",
  { skip: process.platform === "win32" },
  () => {
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-win-status-partial-"));
    try {
      const stubs = schedulerStubs(path.join(testRoot, "scheduler"), {
        authoritativeState: "1|267009",
      });
      const result = runWindowsService(testRoot, "status", { PATH: stubs.path });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        installed: true,
        loaded: false,
        state: "ready",
      });
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);

test(
  "Windows status keeps Ready when authoritative launcher state is inconclusive",
  { skip: process.platform === "win32" },
  async (context) => {
    for (const [name, options] of [
      ["malformed", { authoritativeState: "not-task-state" }],
      ["failed", { authoritativeFail: true }],
    ]) {
      await context.test(name, () => {
        const testRoot = mkdtempSync(path.join(os.tmpdir(), `codex-router-win-status-${name}-`));
        try {
          const stubs = schedulerStubs(path.join(testRoot, "scheduler"), options);
          const result = runWindowsService(testRoot, "status", { PATH: stubs.path });
          assert.equal(result.status, 0, result.stderr);
          assert.deepEqual(JSON.parse(result.stdout), {
            installed: true,
            loaded: false,
            state: "ready",
          });
        } finally {
          rmSync(testRoot, { recursive: true, force: true });
        }
      });
    }
  },
);

test(
  "Windows status accepts Running without an authoritative fallback query",
  { skip: process.platform === "win32" },
  () => {
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-win-status-running-"));
    try {
      const stubs = schedulerStubs(path.join(testRoot, "scheduler"), {
        runningQueries: 1,
        authoritativeFail: true,
      });
      const result = runWindowsService(testRoot, "status", { PATH: stubs.path });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        installed: true,
        loaded: true,
        state: "running",
      });
      assert.equal(stubs.calls().some((line) => line.includes("Schedule.Service")), false);
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);

test(
  "a blocked registration restarts whichever task definition survived",
  { skip: process.platform === "win32" },
  () => {
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-win-recover-"));
    try {
      // Registration is blocked through both routes, the way a restricted or
      // non-elevated terminal blocks it. endTask() has already stopped the
      // running router by then, so returning here would trade a working install
      // for nothing at all -- the regression this guards.
      const stubs = schedulerStubs(path.join(testRoot, "survivor"), {
        schtasksFail: "/Create",
        powershellFail: "Register-ScheduledTask",
      });
      const result = runWindowsService(testRoot, "install", { PATH: stubs.path });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).installed, true);

      const calls = stubs.calls();
      const at = (needle) => calls.findIndex((line) => line.includes(needle));
      assert.ok(at("/End") >= 0, `no /End in:\n${calls.join("\n")}`);
      assert.ok(
        at("/End") < at("Register-ScheduledTask"),
        `the running instance must be ended before re-registering:\n${calls.join("\n")}`,
      );
      // The surviving definition is queried before it is started: /Run against
      // a name that failed to register recovers nothing and reports its own
      // error over the one that actually matters.
      assert.ok(
        at("/Create") < at("/Query") && at("/Query") < at("/Run"),
        `the recovery must query before it runs:\n${calls.join("\n")}`,
      );
      assert.equal(calls.filter((line) => line.includes("/Run")).length, 1);
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);

test(
  "a registration failure that leaves no task does not start one",
  { skip: process.platform === "win32" },
  () => {
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-win-no-task-"));
    try {
      const stubs = schedulerStubs(path.join(testRoot, "gone"), {
        schtasksFail: "/Create /Query",
        powershellFail: "Register-ScheduledTask",
      });
      const result = runWindowsService(testRoot, "install", { PATH: stubs.path });
      // Still best effort: the launchers are written and the caller retries,
      // but no surviving task must be reported as installed.
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).installed, false);

      const calls = stubs.calls();
      assert.ok(calls.some((line) => line.includes("/Query")));
      assert.equal(
        calls.some((line) => line.includes("/Run")),
        false,
        `nothing survived to start, so /Run must not be issued:\n${calls.join("\n")}`,
      );
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);

test(
  "install waits for the ended instance before starting the new one",
  { skip: process.platform === "win32" },
  () => {
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-win-stop-wait-"));
    try {
      // schtasks /End returns before the instance is gone. Reporting Running
      // for the first two state queries reproduces that window; a /Run issued
      // inside it is dropped by MultipleInstances IgnoreNew.
      const stubs = schedulerStubs(path.join(testRoot, "winding-down"), {
        runningQueries: 2,
      });
      const result = runWindowsService(testRoot, "install", { PATH: stubs.path });
      assert.equal(result.status, 0, result.stderr);

      const calls = stubs.calls();
      const states = calls.filter((line) => line.includes("Get-ScheduledTask"));
      assert.equal(
        states.length,
        3,
        `the wait must poll until the state leaves Running:\n${calls.join("\n")}`,
      );
      const lastState = calls.findLastIndex((line) => line.includes("Get-ScheduledTask"));
      assert.ok(
        lastState < calls.findIndex((line) => line.includes("/Run")),
        `the new instance must start after the old one has gone:\n${calls.join("\n")}`,
      );
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);

test(
  "an instance that never stops cannot hang the install",
  { skip: process.platform === "win32" },
  () => {
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-win-stuck-"));
    try {
      // The state never leaves Running, so only the deadline can end the wait.
      // Without it install would block forever and take the installer with it.
      const stubs = schedulerStubs(path.join(testRoot, "stuck"), {
        runningQueries: 1_000_000,
      });
      const result = runWindowsService(testRoot, "install", { PATH: stubs.path });
      assert.equal(result.status, 0, result.stderr);

      const calls = stubs.calls();
      const states = calls.filter((line) => line.includes("Get-ScheduledTask"));
      assert.ok(states.length > 1, "the wait must have polled more than once");
      assert.ok(
        states.length < 500,
        `the wait must be bounded, not merely slow: ${states.length} state queries`,
      );
      // Giving up is not giving in: the install still registers and starts the
      // task, and the readiness check downstream is what reports a router that
      // never came back.
      assert.ok(calls.some((line) => line.includes("/Run")));
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);

test(
  "stopping a service that was never installed is not an error",
  { skip: process.platform === "win32" },
  () => {
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-win-stop-"));
    try {
      // No stubs on PATH, so schtasks.exe is missing exactly as it is when the
      // task does not exist. stop used to throw that straight at the caller
      // while uninstall and restart tolerated it.
      const result = runWindowsService(testRoot, "stop");
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { state: "stopped" });
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);

test(
  "systemd WorkingDirectory is unquoted and escapes literal specifiers",
  { skip: process.platform === "win32" },
  () => {
    const testRoot = mkdtempSync(path.join(os.tmpdir(), "codex-router-systemd-path-"));
    const linkedRoot = path.join(testRoot, "router %u");
    symlinkSync(root, linkedRoot, "dir");
    try {
      const systemd = render("service-linux.mjs", "linux", testRoot, "codex", linkedRoot);
      const workingDirectory = systemd
        .split(/\r?\n/)
        .find((line) => line.startsWith("WorkingDirectory="));
      assert.equal(
        workingDirectory,
        `WorkingDirectory=${linkedRoot.replaceAll("%", "%%")}`,
      );
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  },
);
