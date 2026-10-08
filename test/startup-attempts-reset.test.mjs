import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeStartupFixture, startupFixturePaths } from './startup-attempts-fixture.mjs';

// Execute unchanged ESM sources with every filesystem/manager/probe replaced.
// Only this host harness reads repository text and writes the requested report.
const root = process.env.PR895_REVIEW_SOURCE_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const names = ['service.mjs', 'service-macos.mjs', 'service-linux.mjs', 'service-windows.mjs', 'service-process.mjs', 'startup-attempts.mjs', 'service-readiness.mjs', 'app-connector-policy.mjs'];
const sources = Object.fromEntries(names.map(name => [name, readFileSync(path.join(root, 'src', name), 'utf8')]));
const at = 1_700_000_000_000;
const freshRecord = () => ({ version: 1, consecutiveFailures: 3, lastFailureAt: at, nextAttemptNotBefore: at + 240_000 });

async function run(platform, command, mode = 'success', { wrapper = false } = {}) {
  const events = [], output = [], diagnostics = [];
  let clock = at, record = freshRecord(), stopStarted = false, oldStopped = false, killed = false, processRecordPresent = true;
  let registered = true, restartQueries = 0;
  const { path: fixturePath, root: fixtureRoot, fileURLToPath: fixtureFileURLToPath, pathToFileURL } = startupFixturePaths(platform, 'independent');
  const stateDir = fixturePath.join(fixtureRoot, 'state'), sourceRoot = fixturePath.join(fixtureRoot, 'checkout');
  const processRecord = { version: 1, managed: true, pid: 4242, processIdentity: 'fixture|node', commandLine: `node ${fixturePath.join(sourceRoot, "src", "start.mjs")}`, sourceRoot, stateDir, ports: { router: 4200 } };
  const fakeProcess = {
    pid: 9999, platform, argv: [fixturePath.join(fixtureRoot, 'node'), fixturePath.join(fixtureRoot, 'entry.mjs'), command], execPath: fixturePath.join(fixtureRoot, 'node'),
    env: { CODEX_ROUTER_SERVICE_PLATFORM: platform, MODEL_ROUTER_STATE_DIR: stateDir,
      ...(mode.endsWith('-disabled') ? { CODEX_ROUTER_DISABLE_STARTUP_BACKOFF: '1' } : {}),
    }, exitCode: 0,
    getuid: () => 501, stdout: { write: x => output.push(x) },
    exit: code => { throw Object.assign(new Error('exit'), { exitCode: code }); },
  };
  const absent = () => Object.assign(new Error('Could not find specified service'), { status: 113, stdout: '', stderr: 'Could not find service "io.github.codex-router" in domain for user gui: 501\n' });
  const unknown = () => Object.assign(new Error('fixture manager unavailable'), { status: 13, stderr: 'Permission denied' });
  const emitOldFailure = () => { stopStarted = true; record = freshRecord(); events.push({ kind: 'old-writer' }); };
  const launch = kind => { events.push({ kind: 'launch', verb: kind, blocked: Boolean(record) }); };
  const fs = {
    existsSync: () => true, mkdirSync: () => {}, chmodSync: () => {}, renameSync: () => {},
    writeFileSync: () => {}, writeSync: () => {},
    readFileSync: file => {
      if (String(file).endsWith('startup-attempts.json') && record) return JSON.stringify(record);
      if (String(file).endsWith('service-process.json') && processRecordPresent) return JSON.stringify(processRecord);
      throw Object.assign(new Error('absent fixture file'), { code: 'ENOENT' });
    },
    unlinkSync: file => {
      if (String(file).endsWith('startup-attempts.json')) {
        events.push({ kind: 'reset', phase: stopStarted ? 'after-stop' : 'before-stop', confirmed: oldStopped });
        if ((mode === 'clear-error' || mode.startsWith('clear-error-deferred')) || (mode.includes('clear-error-after-stop') && stopStarted)) {
          throw Object.assign(new Error('fixture reset denied'), { code: 'EACCES' });
        }
        record = undefined;
      } else if (String(file).endsWith('service-process.json')) {
        processRecordPresent = false; oldStopped = true; events.push({ kind: 'clear-process-record' });
      }
    },
  };
  const execFileSync = (executable, args, options = {}) => {
    events.push({ kind: 'manager', executable, args, timeout: options.timeout });
    if (executable.endsWith('launchctl')) {
      if (args[0] === 'print') {
        if (mode === 'query-unknown' || (mode === 'query-unknown-after-stop' && stopStarted)) throw unknown();
        if (mode === 'malformed-print') return 'fixture malformed output';
        if (mode === 'slow-still-loaded' && stopStarted) clock += options.timeout ?? 15_000;
        if (!registered) throw absent();
        return `gui/501/io.github.codex-router = {\n path = /fixture/router.plist\n state = running\n pid = 4242\n}\n`;
      }
      if (args[0] === 'bootout') {
        emitOldFailure();
        if (mode === 'stop-error') throw unknown();
        if (mode !== 'slow-still-loaded') { registered = false; oldStopped = true; }
      }
      if (args[0] === 'bootstrap') { registered = true; launch('bootstrap'); }
      if (args[0] === 'kickstart') { emitOldFailure(); oldStopped = true; launch('kickstart'); }
      return '';
    }
    if (executable === 'systemctl') {
      const verb = args.filter(x => x !== '--user')[0];
      if (verb === 'stop' || verb === 'restart') {
        emitOldFailure();
        if (mode === 'stop-error') throw unknown();
        oldStopped = true;
        if (verb === 'restart') launch('restart');
      }
      if (verb === 'start' || (verb === 'enable' && args.includes('--now'))) launch(verb);
      return '';
    }
    if (executable === 'schtasks.exe') {
      if (args[0] === '/End') emitOldFailure();
      if (args[0] === '/Run') launch('/Run');
      return '';
    }
    if (executable === 'taskkill.exe') { emitOldFailure(); killed = true; return ''; }
    if (executable === 'netstat.exe') return '';
    if (executable === 'powershell.exe' || executable === 'pwsh.exe') {
      if (args.at(-1).includes('Register-ScheduledTask')) {
        if (mode.includes('register-error')) throw new Error('fixture registration denied');
        registered = true;
      }
      if (args.at(-1).includes('Get-ScheduledTask -ErrorAction Stop')) return registered ? 'present' : 'absent';
      return 'Ready';
    }
    throw new Error(`Unexpected executable ${executable}`);
  };
  const globals = {
    process: fakeProcess, Buffer, SharedArrayBuffer, Int32Array, clearTimeout,
    setTimeout: (callback, milliseconds) => setTimeout(() => { clock += milliseconds; callback(); }, 0),
    console: { error: x => diagnostics.push(String(x)), warn: x => diagnostics.push(String(x)), log: () => {} },
    Date: class extends Date { static now() { return clock; } },
    Atomics: { wait: (_array, _index, _value, duration) => { clock += duration; } },
  };
  const noopEnvironment = () => ({});
  const identityProbe = () => mode === 'ownership-unknown' ? { state: 'unknown' } : killed ? { state: 'absent' } : { state: 'alive', identity: processRecord.processIdentity };
  const modules = new Map();
  const deps = {
    'node:fs': fs, 'node:path': { default: fixturePath }, 'node:os': { default: { homedir: () => fixturePath.join(fixtureRoot, 'home') } },
    'node:url': { fileURLToPath: fixtureFileURLToPath },
    'node:child_process': { execFileSync, spawnSync: (_executable, args) => {
      if (args[1] === 'restart-count') {
        events.push({ kind: 'restart-query' });
        return { status: 0, stdout: JSON.stringify({ restarts: restartQueries++ === 0 ? 0 : 3 }) };
      }
      events.push({ kind: 'platform-spawn' }); return { status: 0 };
    } },
    './paths.mjs': { CODEX_HOME: fixturePath.join(fixtureRoot, 'codex'), LOG_PATH: fixturePath.join(fixtureRoot, 'log'), PORTS: { router: 4200 }, SOURCE_ROOT: sourceRoot, STATE_DIR: stateDir, TARGET: 'codex', TARGET_DISPLAY_NAME: 'Codex Router', SERVICE_LABEL: 'io.github.codex-router', LAUNCH_AGENT_PATH: fixturePath.join(fixtureRoot, 'router.plist'), SERVICE_PROCESS_STATE_PATH: fixturePath.join(stateDir, 'service-process.json') },
    './file-security.mjs': { ensureCheckoutReadable: () => {}, protectPrivateFile: () => {}, writePrivateJson: (file, value) => { if (String(file).endsWith('startup-attempts.json')) record = value; } },
    './log-rotation.mjs': { rotateLog: () => {} },
    './provider-api-key-service-environment.mjs': { providerApiKeyServiceEnvironment: noopEnvironment },
    './zai-stream-timeouts.mjs': { serviceZaiCodingStreamEnvironment: noopEnvironment },
    './proxy-environment.mjs': { serviceProxyEnvironment: noopEnvironment, environmentProxyOptedIn: () => false },
    './grok-patch-hook-settings.mjs': { serviceGrokPatchHookEnvironment: noopEnvironment },
    './startup-timeout.mjs': { serviceStartupTimeoutEnvironment: noopEnvironment, startupTimeoutMs: (_name, fallback) => fallback },
    './service-write-guard.mjs': { skipServiceManagerCall: () => false, assertServiceWriteIsolated: () => {} },
    './windows-task-state.mjs': { windowsScheduledTaskState: async () => mode.startsWith('clear-error-deferred')
      ? { launcherAlive: false, instanceCount: 0, lastTaskResult: 69 } : undefined },
    './router-health.mjs': { waitForRouterHealth: () => new Promise(() => {}) },
    './windows-launch-diagnosis.mjs': { diagnoseWindowsLaunchFailure: () => undefined, readLogTail: () => '' },
    './process-identity.mjs': { processStartIdentityProbe: identityProbe, processStartIdentity: () => processRecord.processIdentity, processCommandLine: () => processRecord.commandLine, COLD_START_WINDOWS_PROBE_BUDGET: { timeoutMs: 45_000, attempts: 2 } },
    './service-readiness.mjs': { waitForServiceReadiness: async options => {
      if (command === 'install') assert.equal(typeof options.getStartupBackoffRemainingMs, 'function');
      else assert.equal(options.getStartupBackoffRemainingMs, undefined);
      if (mode === 'readiness-fatal') throw new Error('fixture genuine fatal readiness');
      return { ok: true };
    } },
    './ollama-runtime.mjs': { stopManagedOllama: async () => {} },
    './service-operation-lock.mjs': { withServiceOperationLock: async fn => fn() },
  };
  async function load(name) {
    if (modules.has(name)) return modules.get(name);
    const evaluated = executeStartupFixture(sources[name], {
      globals, url: pathToFileURL(fixturePath.join(sourceRoot, 'src', name)).href,
      dependency: async specifier => {
        if (['./startup-attempts.mjs', './service-process.mjs', './app-connector-policy.mjs'].includes(specifier)
          || (specifier === './service-readiness.mjs' && mode.startsWith('clear-error-deferred'))) return load(path.basename(specifier));
        const exports = deps[specifier];
        assert.ok(exports, `Unmocked dependency ${specifier}`);
        return exports;
      },
    });
    modules.set(name, evaluated);
    return evaluated;
  }
  let error, resultStatus;
  try {
    const name = wrapper ? 'service.mjs' : { darwin: 'service-macos.mjs', linux: 'service-linux.mjs', win32: 'service-windows.mjs' }[platform];
    const module = await load(name);
    if (wrapper) resultStatus = await module.runServiceCommandUnlocked(command, [command]);
  } catch (caught) { error = caught; }
  return { resultStatus, events, output: output.join(''), diagnostics, error: error && { name: error.name, message: error.message, code: error.code }, recordPresent: Boolean(record), processRecordPresent, oldStopped, elapsedMs: clock - at, exitCode: fakeProcess.exitCode };
}

async function runChecks() {
const results = [];
async function check(name, platform, command, mode, oracle, options) {
  const result = await run(platform, command, mode, options);
  let failure;
  try { oracle(result); } catch (error) { failure = error.message; }
  results.push({ name, passed: !failure, failure, ...result });
}
const launches = result => result.events.filter(x => x.kind === 'launch');
const noLaunch = result => assert.equal(launches(result).length, 0);
const afterStopFresh = result => {
  assert.equal(result.error, undefined);
  assert.ok(result.oldStopped, 'stop must be confirmed');
  assert.equal(launches(result).length, 1);
  assert.equal(launches(result)[0].blocked, false, 'old payload failure must be reset before launch');
  const writer = result.events.findLastIndex(x => x.kind === 'old-writer');
  const reset = result.events.findLastIndex(x => x.kind === 'reset');
  const launch = result.events.findIndex(x => x.kind === 'launch');
  assert.ok(writer < reset && reset < launch, 'old-writer < second reset < launch');
  assert.equal(result.events[reset].confirmed, true);
};
for (const command of ['start', 'restart']) {
  await check(`shared ${command} reset failure refuses platform mutation`, 'linux', command, 'clear-error', r => { assert.ok(r.error); assert.equal(r.events.filter(x => x.kind === 'platform-spawn').length, 0); }, { wrapper: true });
}
await check('shared install optional clear preserves platform call', 'linux', 'install', 'clear-error', r => { assert.equal(r.error, undefined); assert.equal(r.events.filter(x => x.kind === 'platform-spawn').length, 1); }, { wrapper: true });
await check('confirmed installed cooldown returns temporary failure without rollback', 'linux', 'install', 'clear-error-deferred', r => { assert.equal(r.error, undefined); assert.equal(r.resultStatus, 75); assert.equal(r.events.filter(x => x.kind === 'platform-spawn').length, 1); assert.ok(r.diagnostics.some(x => x.includes('startup is deferred'))); }, { wrapper: true });
await check('disabled install treats a real crash loop as fatal despite an uncleared active record', 'linux', 'install', 'clear-error-deferred-disabled', r => { assert.match(r.error?.message ?? '', /crash-looping/); assert.notEqual(r.resultStatus, 75); assert.equal(r.events.filter(x => x.kind === 'platform-spawn').length, 1); assert.ok(r.recordPresent); assert.equal(r.diagnostics.some(x => x.includes('startup is deferred')), false); }, { wrapper: true });
await check('Windows installed cooldown returns temporary failure only after dead launcher grace', 'win32', 'install', 'clear-error-deferred', r => { assert.equal(r.error, undefined); assert.equal(r.resultStatus, 75); assert.ok(r.elapsedMs >= 15_000); assert.equal(r.events.filter(x => x.kind === 'platform-spawn').length, 1); }, { wrapper: true });
await check('disabled Windows install cannot use stale exit69 and cache to excuse a dead launcher', 'win32', 'install', 'clear-error-deferred-disabled', r => { assert.match(r.error?.message ?? '', /no running launcher.*LastTaskResult=0x45/); assert.notEqual(r.resultStatus, 75); assert.ok(r.elapsedMs >= 15_000); assert.ok(r.recordPresent); assert.equal(r.diagnostics.some(x => x.includes('startup is deferred')), false); }, { wrapper: true });
await check('genuine installed readiness failure is never converted to temporary cooldown', 'linux', 'install', 'readiness-fatal', r => { assert.ok(r.error); assert.notEqual(r.resultStatus, 75); }, { wrapper: true });
for (const platform of ['darwin', 'linux', 'win32']) {
  await check(`${platform} restart resets old writer after verified stop`, platform, 'restart', 'success', afterStopFresh);
  await check(`${platform} post-stop reset failure refuses manual restart`, platform, 'restart', 'clear-error-after-stop', r => { assert.ok(r.error); noLaunch(r); assert.ok(r.recordPresent); });
  await check(`${platform} install optional post-stop reset failure still launches`, platform, 'install', 'clear-error-after-stop', r => { assert.equal(r.error, undefined); assert.equal(launches(r).length, 1); assert.ok(r.diagnostics.some(x => x.includes('Could not reset automatic startup cooldown (EACCES)')), 'optional reset warning must be observable'); });
}
for (const mode of ['query-unknown', 'query-unknown-after-stop', 'malformed-print', 'stop-error']) {
  await check(`darwin ${mode} refuses bootstrap and post-stop reset`, 'darwin', 'restart', mode, r => { assert.ok(r.error); noLaunch(r); assert.equal(r.events.filter(x => x.kind === 'reset' && x.phase === 'after-stop').length, 0); });
}
await check('darwin slow stop shares one finite deadline', 'darwin', 'restart', 'slow-still-loaded', r => { assert.ok(r.error); noLaunch(r); assert.ok(r.elapsedMs <= 15_000, `spent ${r.elapsedMs}ms`); });
await check('linux failed stop prevents second reset and new start', 'linux', 'restart', 'stop-error', r => { assert.ok(r.error); noLaunch(r); assert.equal(r.events.filter(x => x.kind === 'reset' && x.phase === 'after-stop').length, 0); });
await check('Windows unknown ownership retains process/failure records without launch', 'win32', 'restart', 'ownership-unknown', r => { assert.equal(r.error?.code, 'SERVICE_STOP_UNVERIFIED'); noLaunch(r); assert.ok(r.processRecordPresent); assert.ok(r.recordPresent); assert.equal(r.events.filter(x => x.kind === 'reset' && x.phase === 'after-stop').length, 0); });
await check('Windows surviving registration recovery tolerates optional reset failure', 'win32', 'install', 'register-error+clear-error-after-stop', r => { assert.equal(r.error, undefined); assert.equal(launches(r).length, 1); assert.ok(r.oldStopped); assert.ok(r.diagnostics.some(x => x.includes('Could not reset automatic startup cooldown (EACCES)'))); });
const report = { sourceRoot: root, sourceSha256: Object.fromEntries(Object.entries(sources).map(([name, text]) => [name, createHash('sha256').update(text).digest('hex')])), cases: results.length, passed: results.filter(x => x.passed).length, failed: results.filter(x => !x.passed).length, results };
return report;
}

if (process.env.CODEX_ROUTER_RESET_TEST_CHILD === '1') {
  console.log(JSON.stringify(await runChecks()));
} else {
  test('actual service sources preserve stop/reset/launch ordering and failure boundaries', async () => {
    const report = await runChecks();
    assert.equal(report.cases, 25);
    assert.equal(report.failed, 0, JSON.stringify(report.results.filter(result => !result.passed), null, 2));
  });
}
