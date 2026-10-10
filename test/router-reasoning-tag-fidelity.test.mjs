import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { callerBaseUrl } from '../src/caller-auth.mjs';
import { userModelEntry } from '../src/user-models.mjs';
import { openPort } from './port-pool.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sample = 'XML: <reason>disk full</reason>.\n```xml\n<think>visible sample</think>\n```\n尾部: visible';
const caller = 'synthetic-reasoning-fidelity-caller-capability';
const internal = 'synthetic-reasoning-fidelity-internal-capability';
const frame = event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

test('actual Router preserves literal tags by default and cleans only explicit legacy routes', async t => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'router-reasoning-fidelity-'));
  assert.equal(path.dirname(scratch), path.resolve(os.tmpdir()));
  assert(path.basename(scratch).startsWith('router-reasoning-fidelity-'));
  const codex = path.join(scratch, 'codex');
  mkdirSync(codex);
  const routes = [undefined, 'preserve', 'legacy-inline'].map((policy, index) => ({
    ...userModelEntry({ providerId: 'custom', upstreamId: `synthetic-tag-policy-${index}`, priority: 900 + index }),
    endpoint: { baseUrl: 'http://127.0.0.1:9/v1', protocol: 'openai-responses', keyless: true },
    ...(policy === undefined ? {} : { reasoningTagPolicy: policy }),
  }));
  writeFileSync(path.join(scratch, 'user-models.json'), JSON.stringify({ version: 1, models: routes }));
  writeFileSync(path.join(scratch, 'enabled-providers.json'), '{"version":1,"providers":["custom"]}');
  const upstream = http.createServer(async (request, response) => {
    if (request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      return;
    }
    for await (const chunk of request) { void chunk; }
    const content = [{ type: 'output_text', text: sample, annotations: [] }];
    const item = { id: 'msg_synthetic_tags', type: 'message', role: 'assistant', status: 'completed', content };
    const events = [
      { type: 'response.created', response: { id: 'resp_synthetic_tags', status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
      { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: item.id, delta: sample },
      { type: 'response.output_text.done', output_index: 0, content_index: 0, item_id: item.id, text: sample },
      { type: 'response.content_part.done', output_index: 0, content_index: 0, part: content[0] },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: 'resp_synthetic_tags', object: 'response', status: 'completed', output: [item] } },
    ];
    response.writeHead(200, { 'content-type': 'text/event-stream' }).end(events.map(frame).join(''));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const stub = `http://127.0.0.1:${upstream.address().port}`;
  const port = await openPort();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(PATH|SystemRoot|WINDIR|ComSpec|PATHEXT|TEMP|TMP|PSModulePath|SystemDrive|ProgramData|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432)$/i.test(key)));
  Object.assign(env, {
    CODEX_HOME: codex, HOME: scratch, USERPROFILE: scratch,
    APPDATA: path.join(scratch, 'appdata'), LOCALAPPDATA: path.join(scratch, 'localappdata'),
    KIMI_CODE_HOME: path.join(scratch, 'kimi'), GROK_HOME: path.join(scratch, 'grok'),
    GROK_AUTH_PATH: path.join(scratch, 'grok', 'auth.json'), NODE_USE_ENV_PROXY: '0',
    MODEL_ROUTER_STATE_DIR: scratch, CODEX_ROUTER_STATE_DIR: scratch,
    MODEL_ROUTER_USER_MODELS: path.join(scratch, 'user-models.json'),
    CODEX_ROUTER_NO_DISCOVERY: '1', CODEX_ROUTER_PORT: String(port),
    CODEX_ROUTER_CALLER_KEY: caller, CODEX_ROUTER_INTERNAL_KEY: internal,
    CODEX_ROUTER_GATEWAY_BASE_URL: stub, CODEX_ROUTER_API_BASE_URL: stub,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: `${stub}/health`, CODEX_ROUTER_API_HEALTH_URL: `${stub}/health`,
    CODEX_ROUTER_OAUTH_HEALTH_URL: `${stub}/health`, CODEX_ROUTER_GROK_OAUTH_HEALTH_URL: `${stub}/health`,
    CODEX_NATIVE_BASE_URL: 'http://127.0.0.1:9/unused-native',
  });
  const child = spawn(process.execPath, [path.join(root, 'src/router.mjs')], { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  const base = callerBaseUrl(port, caller);
  try {
    const deadline = Date.now() + 20000;
    let ready = false;
    while (Date.now() < deadline) {
      assert.equal(child.exitCode, null, errors);
      try { if ((await fetch(`${base}/models`)).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert(ready, `Isolated Router did not start: ${errors}`);
    for (const route of routes) {
      const response = await fetch(`${base}/responses`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: route.slug, stream: true, input: 'Synthetic local regression', tools: [] }),
        signal: AbortSignal.timeout(10000),
      });
      const body = await response.text();
      assert.equal(response.status, 200, body);
      const events = body.split(/\r?\n\r?\n/).flatMap(block => {
        const data = block.split(/\r?\n/).find(line => line.startsWith('data: '));
        return data ? [JSON.parse(data.slice(6))] : [];
      });
      const text = events.filter(event => event.type === 'response.output_text.delta').map(event => event.delta).join('');
      if (route.reasoningTagPolicy === 'legacy-inline') {
        assert.equal(text, 'XML: .\n```xml\n\n```\n尾部: visible');
      } else assert.equal(text, sample);
      assert(events.some(event => event.type === 'response.completed'));
    }
  } finally {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
    await new Promise(resolve => upstream.close(resolve));
    rmSync(scratch, { recursive: true, force: true });
  }
});
