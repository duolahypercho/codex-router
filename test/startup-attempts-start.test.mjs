import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn,spawnSync} from 'node:child_process';
import {chmodSync,existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import { freePort } from './port-pool.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// This is an outer process guard, including Node's cold module imports. The
// combined lifecycle suite exceeded 5s before reaching an immediate fake
// interpreter failure; allow that scheduling pressure without changing the
// production probe limits or any exit/message/cache assertion.
const CHILD_TIMEOUT_MS = 30_000;
// The fixture has no provider credentials, but Windows child processes still
// need their runtime environment to start PowerShell and load system modules.
// Match the public runtime allowlist used by the private-file ACL helper.
function startupChildRuntimeEnvironment(environment = process.env) {
  const allowed = new Set([
    'PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP',
    'PSModulePath', 'SystemDrive', 'ProgramData', 'ProgramFiles',
    'ProgramFiles(x86)', 'ProgramW6432', 'USERPROFILE',
  ].map(name => name.toLowerCase()));
  return Object.fromEntries(Object.entries(environment).filter(([name, value]) =>
    allowed.has(name.toLowerCase()) && typeof value === 'string'));
}
function state(t) {
  const directory=mkdtempSync(path.join(os.tmpdir(), 'startup-contract-'));
  const stateDir=path.join(directory,'state');
  mkdirSync(stateDir,{mode:0o700});
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const env={
    ...startupChildRuntimeEnvironment(),
    TMPDIR:os.tmpdir(),
    CODEX_HOME:path.join(directory,'codex-home'),
    KIMI_CODE_HOME:path.join(directory,'kimi-home'),
    MODEL_ROUTER_TARGET:'codex',
    MODEL_ROUTER_STATE_DIR:stateDir,
    CODEX_ROUTER_STATE_DIR:stateDir,
    MODEL_ROUTER_LITELLM_BIN:path.join(directory,'missing-litellm'),
    MODEL_ROUTER_QUIET:'1',
  };
  const record=path.join(stateDir,'startup-attempts.json');
  return {directory,stateDir,env,record};
}
function seed(record) {
  writeFileSync(record,JSON.stringify({version:1,consecutiveFailures:3,lastFailureAt:Date.now(),nextAttemptNotBefore:Date.now()+600000}),{mode:0o600});
}
function run(entry,env,timeout=CHILD_TIMEOUT_MS) {
  const result=spawnSync(process.execPath,[path.join(root,'src',entry)],{env,cwd:root,encoding:'utf8',timeout});
  assert.ifError(result.error);
  return {status:result.status,output:`${result.stdout||''}${result.stderr||''}`};
}

test('isolated startup children keep Windows runtime variables without inheriting credentials', () => {
  const environment = startupChildRuntimeEnvironment({
    PATH: 'fixture-bin', sYsTeMrOoT: 'C:\\Windows', ComSpec: 'fixture-cmd.exe',
    PSModulePath: 'fixture-modules', PATHEXT: '.EXE;.CMD', TEMP: 'fixture-temp',
    OPENAI_API_KEY: 'unrelated-provider-secret', CODEX_ROUTER_CALLER_KEY: 'unrelated-caller-secret',
    MODEL_ROUTER_STATE_DIR: 'unrelated-installed-state',
  });
  assert.equal(environment.sYsTeMrOoT, 'C:\\Windows');
  assert.equal(environment.ComSpec, 'fixture-cmd.exe');
  assert.equal(environment.PSModulePath, 'fixture-modules');
  assert.equal(environment.PATHEXT, '.EXE;.CMD');
  assert.equal(environment.TEMP, 'fixture-temp');
  assert.equal(environment.PATH, 'fixture-bin');
  assert.equal(Object.hasOwn(environment, 'OPENAI_API_KEY'), false);
  assert.equal(Object.hasOwn(environment, 'CODEX_ROUTER_CALLER_KEY'), false);
  assert.equal(Object.hasOwn(environment, 'MODEL_ROUTER_STATE_DIR'), false);
});

test('automatic payload still skips an active cooldown before launcher checks',t=>{
  const fixture=state(t);seed(fixture.record);
  const result=run('start.mjs',fixture.env);
  assert.equal(result.status,69,result.output);
  assert.match(result.output,/backing off/);
  assert.doesNotMatch(result.output,/LiteLLM is not installed/);
});

test('explicit foreground startup bypasses the automatic cooldown',t=>{
  const fixture=state(t);seed(fixture.record);
  const result=run('foreground-start.mjs',fixture.env);
  assert.notEqual(result.status,69,'explicit foreground start was refused by automatic cooldown: '+result.output);
  assert.match(result.output,/LiteLLM is not installed/);
  assert.equal(JSON.parse(readFileSync(fixture.record,'utf8')).consecutiveFailures,3);
});

test('direct kill switch bypasses cooldown and reveals a permanent launcher error',t=>{
  const fixture=state(t);seed(fixture.record);
  const result=run('start.mjs',{...fixture.env,CODEX_ROUTER_DISABLE_STARTUP_BACKOFF:'1'});
  assert.equal(result.status,1,result.output);
  assert.match(result.output,/LiteLLM is not installed/);
  assert.doesNotMatch(result.output,/backing off/);
});

test('a permanent preflight launcher error fails fast without creating cooldown',t=>{
  const fixture=state(t);
  const result=run('start.mjs',fixture.env);
  assert.equal(result.status,1,result.output);
  assert.match(result.output,/LiteLLM is not installed/);
  assert.equal(existsSync(fixture.record),false);
});

test('a permanent bundled venv import error is a setup failure without cooldown',{skip:process.platform==='win32'},t=>{
  const fixture=state(t);
  const source=path.join(fixture.directory,'source');
  const bin=path.join(source,'.venv','bin');mkdirSync(bin,{recursive:true});
  symlinkSync(path.join(root,'config'),path.join(source,'config'),'dir');
  writeFileSync(path.join(bin,'litellm'),'placeholder\n',{mode:0o755});
  writeFileSync(path.join(bin,'python'),"#!/bin/sh\nprintf 'ModuleNotFoundError: encodings\\n' >&2\nexit 1\n",{mode:0o755});
  const env={...fixture.env,CODEX_ROUTER_SOURCE_ROOT:source};delete env.MODEL_ROUTER_LITELLM_BIN;
  const result=run('start.mjs',env);
  assert.equal(result.status,1,result.output);
  assert.match(result.output,/virtual environment is broken/);
  assert.match(result.output,/exited with code 1/);
  assert.equal(existsSync(fixture.record),false);
});

// The fresh main already exposes bounded startup timeout overrides. This
// diagnostic uses those existing overrides only to keep a real pending probe
// deterministic and short; it does not alter the reviewed source or945 work.
test('transient bundled venv timeouts continue to the credential preflight without cooldown',{skip:process.platform==='win32'},t=>{
  const fixture=state(t);
  const source=path.join(fixture.directory,'source');
  const bin=path.join(source,'.venv','bin');mkdirSync(bin,{recursive:true});
  symlinkSync(path.join(root,'config'),path.join(source,'config'),'dir');
  writeFileSync(path.join(bin,'litellm'),'placeholder\n',{mode:0o755});
  // Only shell builtins: no orphanable grandchildren on the spawn timeout.
  writeFileSync(path.join(bin,'python'),"#!/bin/sh\ntrap 'exit 0' TERM\nwhile :; do :; done\n",{mode:0o755});
  const env={...fixture.env,CODEX_ROUTER_SOURCE_ROOT:source,CODEX_ROUTER_VENV_PROBE_TIMEOUT_MS:'30',CODEX_ROUTER_VENV_PROBE_RETRY_TIMEOUT_MS:'30'};
  delete env.MODEL_ROUTER_LITELLM_BIN;
  const result=run('start.mjs',env);
  assert.equal(result.status,1,result.output);
  assert.match(result.output,/transient process scheduling pressure is possible/);
  assert.match(result.output,/Internal service key is missing/);
  assert.equal(existsSync(fixture.record),false,'an inconclusive probe must not seed cooldown');
});


test('foreground and disabled final venv timeouts leave managed state untouched',{skip:process.platform==='win32'},t=>{
  for (const [entry,disabled] of [['foreground-start.mjs',false],['start.mjs',true]]) {
    const fixture=state(t);
    const source=path.join(fixture.directory,'source');
    const bin=path.join(source,'.venv','bin');mkdirSync(bin,{recursive:true});
    symlinkSync(path.join(root,'config'),path.join(source,'config'),'dir');
    writeFileSync(path.join(bin,'litellm'),'placeholder\n',{mode:0o755});
    writeFileSync(path.join(bin,'python'),"#!/bin/sh\ntrap 'exit 0' TERM\nwhile :; do :; done\n",{mode:0o755});
    seed(fixture.record);
    const original=readFileSync(fixture.record,'utf8');
    const env={...fixture.env,CODEX_ROUTER_SOURCE_ROOT:source,CODEX_ROUTER_VENV_PROBE_TIMEOUT_MS:'30',CODEX_ROUTER_VENV_PROBE_RETRY_TIMEOUT_MS:'30'};
    delete env.MODEL_ROUTER_LITELLM_BIN;
    if (disabled) env.CODEX_ROUTER_DISABLE_STARTUP_BACKOFF='1';
    const result=run(entry,env);
    assert.equal(result.status,1,result.output);
    assert.match(result.output,/transient process scheduling pressure is possible/);
    assert.equal(readFileSync(fixture.record,'utf8'),original);
  }
});

test('a missing internal credential is fatal and never seeds cooldown',t=>{
  const fixture=state(t);
  const result=run('start.mjs',{...fixture.env,MODEL_ROUTER_LITELLM_BIN:process.execPath});
  assert.equal(result.status,1,result.output);
  assert.match(result.output,/Internal service key is missing/);
  assert.equal(existsSync(fixture.record),false);
});

test('the real foreground supervisor reaches its children without changing an active managed cooldown', { timeout: 120_000 }, async t => {
  const fixture = state(t);
  const ports = await Promise.all(Array.from({ length: 5 }, () => freePort()));
  const [router, gateway, oauth, api, grok] = ports;
  seed(fixture.record);
  const original = readFileSync(fixture.record, 'utf8');
  writeFileSync(path.join(fixture.stateDir, 'internal-secret'), 'foreground-synthetic-internal-key\n', { mode: 0o600 });
  writeFileSync(path.join(fixture.stateDir, 'caller-secret'), 'foreground-synthetic-caller-key-with-sufficient-length\n', { mode: 0o600 });
  const child = spawn(process.execPath, [path.join(root, 'src', 'foreground-start.mjs')], {
    cwd: root,
    env: {
      ...fixture.env, MODEL_ROUTER_LITELLM_BIN: process.execPath,
      MODEL_ROUTER_PORT: String(router), MODEL_ROUTER_GATEWAY_PORT: String(gateway),
      MODEL_ROUTER_OAUTH_PORT: String(oauth), MODEL_ROUTER_API_PORT: String(api), MODEL_ROUTER_GROK_OAUTH_PORT: String(grok),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let output = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { output += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  let timer;
  try {
    const result = await Promise.race([
      exited,
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`foreground startup did not finish: ${output}`)), 90_000); }),
    ]);
    assert.equal(result.signal, null, output);
    assert.equal(result.code, 1, output);
    assert.match(output, /startup failed: LiteLLM gateway exited before becoming healthy/);
    assert.doesNotMatch(output, /backing off|foreground-synthetic-(?:internal|caller)-key/);
    assert.equal(readFileSync(fixture.record, 'utf8'), original);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
  }
});
