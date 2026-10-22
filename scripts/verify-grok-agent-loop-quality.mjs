// Explicitly authorized, bounded live comparison. No production listeners/config
// are touched. The client executor below accepts synthetic fixture operations only.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let Ajv2020;
let validatorVersion;
try {
  validatorVersion = require('ajv/package.json').version;
  if (validatorVersion !== '8.20.0') throw new Error('version mismatch');
  Ajv2020 = require('ajv/dist/2020.js').default;
} catch {
  throw new Error('Optional benchmark dependency required: ajv@8.20.0. Install separately with npm install --no-save --package-lock=false ajv@8.20.0; this script never installs dependencies.');
}
import { CODEX_APP_TOOLS } from '../src/codex-app-tools.mjs';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  GROK_QUALITY_SOURCE_FILES, GROK_FINAL_VALIDATION_SOURCE_FILES, reconcileInterruptedQualityRuns,
} from './grok-quality-resume.mjs';

const BASELINE = '8c5c128867d3b9f1bd359b9e9491d94cd65b90e1';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIMITS = { taskRuns: 18, providerGenerations: 114, generationsPerRun: 12, clientTurns: 6, requestMs: 90_000, campaignMs: 1_200_000 };
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const string = { type: 'string' };
const operationSchema = CODEX_APP_TOOLS.flatMap(namespace => namespace.tools || []).find(tool => tool.name === 'automation_update').inputSchema;
const validateAutomation = new Ajv2020({ strict: false, allErrors: true }).compile(operationSchema);
const automationFixture = { id:'2', kind:'heartbeat', name:'Fixture check', prompt:'Check synthetic fixture state.', rrule:'FREQ=MINUTELY;INTERVAL=30', status:'ACTIVE' };

const nativePatch = { type: 'custom', name: 'apply_patch', description: 'Edit module.mjs using the native Codex patch tool. Inspect the current file and preserve unrelated behavior.', format: { type: 'text' } };
const execTool = { type: 'function', name: 'exec_command', description: 'Synthetic workspace terminal: read module.mjs with cat or sed, then verify with node verify.mjs. Only these fixture commands are supported.', parameters: object({ cmd: string, workdir: string, max_output_tokens: { type: 'integer' } }, ['cmd']) };
const fixture = `export function price(kind, count) {\n  if (kind === 'standard') {\n    const fee = 2;\n    return count * 10 + fee;\n  }\n  if (kind === 'express') {\n    const fee = 2;\n    return count * 10 + fee;\n  }\n  throw new Error('unknown kind');\n}\n`;
const verifier = `import assert from 'node:assert/strict';
import { price } from './module.mjs';
assert.equal(price('standard',3),32);
assert.equal(price('express',3),37);
assert.equal(price('standard',0),2);
assert.equal(price('express',0),7);
assert.throws(()=>price('unknown',1));
console.log('all 5 fixture assertions passed');
`;

const cases = ['edit_repeated_context', 'recover_invalid_union_argument', 'two_step_then_final'];
function shellRun(bin, args, options = {}) { return spawnSync(bin, args, { encoding: 'utf8', timeout: 10_000, maxBuffer: 128 * 1024, ...options }); }
function listen(server) { return new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); }); }
async function freePort() { const server = http.createServer(); const port = await listen(server); await new Promise(r => server.close(r)); return port; }
function hash(text) { return createHash('sha256').update(text).digest('hex'); }
function nativePatchAllowed(patch) {
  if (typeof patch !== 'string' || /\*\*\* (?:Add|Delete|Move)/.test(patch)) return false;
  const files = [...patch.matchAll(/^\*\*\* Update File: (.+)$/gm)].map(m => m[1]);
  return files.length > 0 && files.every(file => file === 'module.mjs');
}
function validateOperation(args) {
  if (validateAutomation(args)) return null;
  if (typeof args?.id !== 'string' && ['view','update','delete'].includes(args?.mode)) return 'Invalid arguments: id must be a string.';
  return 'Invalid arguments: satisfy exactly one declared automation_update schema branch with all required fields and no extra fields. No state changed.';
}

function selfTest() {
  assert.equal(nativePatchAllowed('*** Begin Patch\n*** Update File: module.mjs\n@@\n-a\n+b\n*** End Patch'), true);
  for (const p of ['*** Update File: ../module.mjs', '*** Update File: /tmp/module.mjs', '*** Add File: module.mjs', '*** Update File: module.mjs\n*** Move to: ../escape']) assert.equal(nativePatchAllowed(p), false);
  assert.match(validateOperation({mode:'view',id:2}), /string/);
  assert.equal(validateOperation({mode:'update',...automationFixture,status:'PAUSED'}), null);
  assert.ok(validateOperation({mode:'update',id:'2'}));
  assert.ok(validateOperation({mode:'view',id:'2',value:41}));
  const codex = process.argv.find(a => a.startsWith('--codex='))?.slice(8);
  if (!codex || !path.isAbsolute(codex)) throw new Error('Self-test requires --codex=<absolute stock executable>');
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(),'grok-quality-selftest-')));
  try {
    writeFileSync(path.join(dir,'module.mjs'),fixture);writeFileSync(path.join(dir,'verify.mjs'),verifier);
    assert.notEqual(shellRun(process.execPath,['verify.mjs'],{cwd:dir}).status,0,'original fee fails behavioral assertion');
    const patch = "*** Begin Patch\n*** Update File: module.mjs\n@@\n   if (kind === 'express') {\n-    const fee = 2;\n+    const fee = 7;\n*** End Patch";
    assert.equal(nativePatchAllowed(patch),true);
    const applied=shellRun(codex,['--codex-run-as-apply-patch',patch],{cwd:dir});
    assert.equal(applied.status,0,applied.stderr);
    const verified=shellRun(process.execPath,['verify.mjs'],{cwd:dir});
    assert.equal(verified.status,0,verified.stderr);
    assert.match(verified.stdout,/all 5 fixture assertions passed/);
  } finally {rmSync(dir,{recursive:true,force:true});}
  process.stdout.write('ok: native patch, failing-original/passing-corrected Node verifier, fixture guards and actual automation schema\n');
}

async function main() {
  if (process.argv.includes('--self-test')) return selfTest();
  if (!process.argv.includes('--prepare') && (!process.argv.includes('--live') || !process.argv.includes('--yes'))) throw new Error('Live quota use requires --live --yes. Use --self-test for offline fixture checks.');
  const codex = process.argv.find(a => a.startsWith('--codex='))?.slice(8);
  if (!codex || !path.isAbsolute(codex)) throw new Error('--codex=<absolute stock Codex executable> is required');
  const outputPath = path.join(ROOT, 'docs/grok-agent-loop-quality-results.json');
  const temp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'grok-agent-loop-quality-')));
  const baselineRoot = path.join(temp, 'baseline'); mkdirSync(baselineRoot);
  const archive = spawnSync('git', ['archive', BASELINE], { cwd: ROOT, maxBuffer: 100 * 1024 * 1024 });
  if (archive.status !== 0) throw new Error('Pinned baseline archive unavailable');
  const unpack = spawnSync('tar', ['-xf', '-', '-C', baselineRoot], { input: archive.stdout });
  if (unpack.status !== 0) throw new Error('Cannot unpack pinned baseline');
  symlinkSync(path.join(ROOT, 'node_modules'), path.join(baselineRoot, 'node_modules'), 'dir');
  const previous = process.argv.includes('--resume') ? JSON.parse(readFileSync(outputPath,'utf8')) : undefined;
  const report = previous || { validationDependency: { name:'ajv', version:validatorVersion, dialect:'2020-12', optional:true }, nodeVersion:process.version, candidateSourceDiffSha256:hash(shellRun('git',['diff','--','src'],{cwd:ROOT}).stdout), baseline: BASELINE, candidateBase: shellRun('git',['rev-parse','HEAD'],{cwd:ROOT}).stdout.trim(), candidateSourceHashes: [], scope: 'Actual per-revision namespace bridge/edit facade and Grok OAuth forwarder, direct Chat adapter, stock client patch executor. LiteLLM and router HTTP listener are outside this experiment.', model: 'grok-4.7', effort: 'medium', serviceTier: 'default (omitted)', limits: LIMITS, startedAt: null, finishedAt: null, plannedRuns: LIMITS.taskRuns, runs: [], providerRequests: [], exclusions: [], limitations: ['Synthetic fixtures; not a general coding ranking.', 'Cached tokens are null when provider telemetry omits them.', 'Seeded invalid call is input setup and counted separately from generated invalid calls.', 'No personal prompts, credentials or raw reasoning are stored.','A client tool_search sentinel prevents bundled app expansion; fixture tools are eager and the search declaration is omitted upstream.'] };
  const snapshot=[];
  for (const file of GROK_QUALITY_SOURCE_FILES) snapshot.push({path:file,sha256:hash(readFileSync(path.join(ROOT,file)))});
  if(previous) { report.resumedAt=new Date().toISOString(); report.resumedCandidateSourceHashes=snapshot; } else report.candidateSourceHashes=snapshot;
  const reconciled = reconcileInterruptedQualityRuns(report, LIMITS);
  const save = () => writeFileSync(outputPath, JSON.stringify(report,null,2)+'\n');
  // Checkpoint interrupted-run exclusions and reserves before any new call.
  if (previous && !process.argv.includes('--prepare')) save();
  let activeRun; let campaignStart; let providerCount = reconciled.providerBudgetUsedUpperBound;
  const campaignAbort=new AbortController();
  for(const signal of ['SIGTERM','SIGINT']) process.once(signal,()=>campaignAbort.abort());
  const children = []; const arms = {}; const internalKey = randomUUID();
  const proxy = http.createServer(async (request,response) => {
    if (!activeRun || providerCount >= LIMITS.providerGenerations || activeRun.providerRequests >= LIMITS.generationsPerRun || Date.now()-campaignStart >= LIMITS.campaignMs) { response.writeHead(429); response.end('{"error":"experiment_generation_limit"}'); return; }
    const run = activeRun; providerCount++; run.providerRequests++;
    const record = { runId: run.id, index: providerCount, elapsedMs: null, httpStatus: null, terminal: null, inputTokens: null, outputTokens: null, cachedTokens: null };
    report.providerRequests.push(record);save();
    const started = Date.now(); const abort = new AbortController(); const timer = setTimeout(()=>abort.abort(), Math.min(LIMITS.requestMs, LIMITS.campaignMs-(Date.now()-campaignStart)));
    response.on('close',()=>{ if (!response.writableEnded) abort.abort(); });
    try {
      const body = []; for await (const chunk of request) body.push(chunk);
      try {const outgoing=JSON.parse(Buffer.concat(body).toString());record.hasPrivateFinal=(outgoing.tools||[]).some(t=>t.name?.startsWith('__codex_router_submit_final'));record.toolChoice=typeof outgoing.tool_choice==='string'?outgoing.tool_choice:outgoing.tool_choice?.type||null;record.emittedFunctionNames=[];record.publicContentLength=0;record.privateFinalArgumentShapes=[];} catch {}
      const headers = { ...request.headers }; delete headers.host; delete headers.connection; delete headers['content-length'];
      const upstream = await fetch('https://cli-chat-proxy.grok.com/v1/responses', { method: 'POST', headers, body: Buffer.concat(body), signal: AbortSignal.any([abort.signal,campaignAbort.signal]) });
      record.httpStatus = upstream.status;
      response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'text/event-stream' });
      let buffer = '';
      for await (const chunk of upstream.body) {
        response.write(chunk); buffer += Buffer.from(chunk).toString('utf8');
        let end;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0,end); buffer = buffer.slice(end+2);
          for (const line of block.split('\n')) if (line.startsWith('data: ')) {
            try { const event = JSON.parse(line.slice(6)); if(event.type==='response.output_item.done') {
              if(event.item?.type==='message') record.publicContentLength+=(event.item.content||[]).filter(p=>p.type==='output_text').reduce((n,p)=>n+(p.text?.length||0),0);
              if(event.item?.type==='function_call') {
                record.emittedFunctionNames?.push(event.item.name);
                if(event.item.name?.startsWith('__codex_router_submit_final')) {
                  try {const a=JSON.parse(event.item.arguments);record.privateFinalArgumentShapes?.push({jsonValid:true,keys:a&&typeof a==='object'?Object.keys(a):[],answerType:typeof a?.answer,answerLength:typeof a?.answer==='string'?a.answer.length:null});}
                  catch {record.privateFinalArgumentShapes?.push({jsonValid:false});}
                }
              }
            } if (['response.completed','response.failed','response.incomplete'].includes(event.type)) { record.terminal = event.type; const u = event.response?.usage; if (u) { record.inputTokens = u.input_tokens ?? null; record.outputTokens = u.output_tokens ?? null; record.cachedTokens = u.input_tokens_details?.cached_tokens ?? null; } } } catch {}
          }
        }
        if (buffer.length > 2*1024*1024) buffer = '';
      }
      response.end();
    } catch (error) { record.errorType = error.name; if (!response.headersSent) response.writeHead(502); response.end(); }
    finally { clearTimeout(timer); record.elapsedMs = Date.now()-started;save(); }
  });
  try {
    const proxyPort = await listen(proxy);
    for (const [label, root] of [['baseline',baselineRoot],['candidate',ROOT]]) {
      const port = await freePort();
      const env = { ...process.env, MODEL_ROUTER_GROK_OAUTH_PORT: String(port), GROK_CLI_CHAT_PROXY_BASE_URL: `http://127.0.0.1:${proxyPort}`, MODEL_ROUTER_INTERNAL_KEY: internalKey, MODEL_ROUTER_QUIET: '1', CODEX_ROUTER_GROK_PATCH_HOOK: '0' };
      for (const key of ['CODEX_ROUTER_GROK_STRUCTURED_PATCH','CODEX_ROUTER_GROK_PROGRESS_ONLY_RETRY','CODEX_ROUTER_GROK_PROGRESS_ONLY_MAX_TEXT','CODEX_ROUTER_GROK_PROGRESS_ONLY_MIN_OUTPUT_TOKENS']) delete env[key];
      const child = spawn(process.execPath,[path.join(root,'src/grok-oauth-forwarder.mjs')],{cwd:root,env,stdio:['ignore','ignore',process.argv.includes('--prepare')?'inherit':'ignore']}); children.push(child);
      let ready = false;
      for (let attempt=0;attempt<100;attempt++) { try { const health=await fetch(`http://127.0.0.1:${port}/health`,{headers:{Authorization:`Bearer ${internalKey}`},signal:AbortSignal.timeout(500)}); if (health.ok) { ready=true;break; } } catch {} await new Promise(r=>setTimeout(r,50)); }
      if (!ready) throw new Error(`${label} isolated forwarder unavailable`);
      const imp = file => import(pathToFileURL(path.join(root,'src',file)).href);
      arms[label] = { port, root, relay: await imp('namespace-relay.mjs'), patch: await imp('grok-structured-patch.mjs'), facade: await imp('grok-tool-facade.mjs'), guidance: await imp('grok-apply-patch-guidance.mjs'), surface: await imp('chat-tool-surface.mjs') };
    }
    if(process.argv.includes('--prepare')) { process.stdout.write('ok: isolated baseline and candidate forwarders ready; no provider calls\n'); return; }
    campaignStart=previous?Date.parse(report.startedAt):Date.now(); report.startedAt=new Date(campaignStart).toISOString(); save();
    let sequence=0;
    for (let repeat=1;repeat<=3;repeat++) for (const caseName of cases) for (const label of repeat%2 ? ['baseline','candidate'] : ['candidate','baseline']) {
      sequence++;
      if(report.runs.some(run=>run.id===sequence))continue;
      if (campaignAbort.signal.aborted || providerCount>=LIMITS.providerGenerations || Date.now()-campaignStart>=LIMITS.campaignMs) { report.exclusions.push({caseName,repeat,arm:label,reason:'campaign_budget_not_started'});continue; }
      const run = { id: sequence, arm: label, caseName, repeat, status: 'running', success: false, elapsedMs: null, providerRequests:0, clientTurns:0, generatedToolCalls:0, invalidCalls:0, repeatedInvalidCalls:0, patchFailures:0, seededInvalidCalls:caseName==='recover_invalid_union_argument'?1:0, verified:false, finalMessages:0, inputTokens:null,outputTokens:null,cachedTokens:null, toolNames:[], toolOutcomes:[] };
      report.runs.push(run);activeRun=run;save();const started=Date.now();const workspace=path.join(temp,`run-${sequence}`);mkdirSync(workspace);
      writeFileSync(path.join(workspace,'module.mjs'),fixture);writeFileSync(path.join(workspace,'verify.mjs'),verifier);
      const state = { updated:false,ticketRead:false,ticketVerified:false,invalid:new Set() };
      const arm=arms[label];const route={slug:'grok-oauth/grok-4.7'};
      let declared = caseName==='edit_repeated_context' ? [nativePatch,execTool] : caseName==='recover_invalid_union_argument' ? [{type:'function',name:'automation_update',description:'Synthetic fixture only: view or update automation 2 in memory. No real automation exists or is changed. Uses the exact bundled Codex automation_update input schema.',parameters:operationSchema}] : [
        {type:'function',name:'get_ticket',description:'Read the fixture ticket before verification.',parameters:object({})},
        {type:'function',name:'verify_ticket',description:'Verify the exact ticket returned by get_ticket.',parameters:object({ticket:string})},
      ];
      const flattened=arm.surface.chatProviderToolSurface([...declared,{type:'tool_search',execution:'client'}],'grok-oauth',{upstreamModel:'grok-4.7',input:[]});
      // Client tool_search suppresses bundled app expansion. All synthetic tools
      // are eager, so no fixture search declaration is needed upstream.
      const declaredNames=new Set(declared.map(tool=>tool.name));
      flattened.tools=flattened.tools.filter(tool=>declaredNames.has(tool.name));
      const structured=arm.patch.grokStructuredPatchEnabled(route,{});
      // Generic raw-custom bridge emulates the custom-to-function conversion that
      // LiteLLM provides to baseline; candidate uses its actual typed codec.
      const guided=structured?flattened.tools:arm.guidance.applyGrokApplyPatchGuidance(flattened.tools,route);
      const bridged=arm.relay.bridgeCustomTools(guided,[],flattened.namespaces,undefined,undefined,structured?{codecs:new Map([['apply_patch',arm.patch.GROK_STRUCTURED_PATCH_CODEC]])}:undefined);
      const installed=new Set(); const tools=arm.facade.applyGrokEditFacade(bridged.tools,flattened.namespaces,route,structured,{installed,patchHook:false});
      const messages=[{role:'system',content:`You are completing a small synthetic fixture task. Use the available tools and their returned errors to correct mistakes. Complete all requested actions, verify them, and give one concise final answer. Fixture ${caseName}; replicate ${repeat}.`},
        {role:'user',content:caseName==='edit_repeated_context' ? 'Inspect module.mjs. Change only the express fee from 2 to 7; preserve standard behavior and the error for unknown kinds. Apply the edit with the editing tool, run node verify.mjs, then report completion.' : caseName==='recover_invalid_union_argument' ? 'Recover from the failed view call below. View synthetic automation with string id "2", then update its status to PAUSED, preserving all other fields. Perform the update and report completion. This is an in-memory fixture; no real scheduling action occurs.' : 'Read the fixture ticket with get_ticket, then verify that exact ticket with verify_ticket. Once both actions succeed, give a concise final answer.'}];
      if(caseName==='recover_invalid_union_argument') messages.push({role:'assistant',content:null,tool_calls:[{id:'seed-invalid',type:'function',function:{name:'automation_update',arguments:'{"mode":"view","id":2}'}}]},{role:'tool',tool_call_id:'seed-invalid',content:'Invalid arguments: id must be a string. No state changed.'});
      try {
        while(run.clientTurns<LIMITS.clientTurns) {
          run.clientTurns++;
          const response=await fetch(`http://127.0.0.1:${arm.port}/v1/chat/completions`,{method:'POST',headers:{Authorization:`Bearer ${internalKey}`,'Content-Type':'application/json'},body:JSON.stringify({model:'grok-4.7',messages,tools:tools.map(t=>({type:'function',function:{name:t.name,description:t.description,parameters:t.parameters}})),reasoning_effort:'medium',stream:false}),signal:AbortSignal.any([campaignAbort.signal,AbortSignal.timeout(Math.min(LIMITS.requestMs,Math.max(1,LIMITS.campaignMs-(Date.now()-campaignStart))))])});
          if(!response.ok) { run.status=`http_${response.status}`;try {const failure=await response.json();run.httpErrorCode=typeof failure.error?.code==='string'?failure.error.code:null;} catch {run.httpErrorCode=null;}break; }
          const result=await response.json();const message=result.choices?.[0]?.message;
          if(!message) {run.status='missing_message';break;}
          // Retain only public tool/text history in process memory. Forwarder's
          // encrypted reasoning carry remains internal to that isolated process.
          const calls=message.tool_calls||[];
          messages.push({role:'assistant',content:message.content||null,...(calls.length?{tool_calls:calls}:{})});
          if(!calls.length) {run.finalMessages++;run.status='completed';break;}
          for(const call of calls) {
            run.generatedToolCalls++;const name=call.function?.name;run.toolNames.push(name);let output;let valid=true;let invalidReason;const trace={name};
            try {
              const chunks=[];
              await pipeline(Readable.from([JSON.stringify({output:[{type:'function_call',id:call.id,call_id:call.id,name,arguments:call.function.arguments}]})]),new arm.relay.NamespaceToolCallTransform(flattened.namespaces,'application/json',route.slug),new Writable({write(c,_e,next){chunks.push(c);next();}}));
              const native=JSON.parse(Buffer.concat(chunks).toString()).output[0];
              if(native.type==='custom_tool_call'&&native.name==='apply_patch') {
                if(!nativePatchAllowed(native.input)) throw new Error('Only in-place module.mjs patches are permitted in the synthetic fixture.');
                state.verified=false;
                const applied=shellRun(codex,['--codex-run-as-apply-patch',native.input],{cwd:workspace,env:{...process.env,CODEX_HOME:path.join(workspace,'codex-state')}});
                output=applied.stdout+applied.stderr;valid=applied.status===0;if(!valid)invalidReason='native_patch_rejected';if(!valid) run.patchFailures++;
              } else {
                const args=JSON.parse(native.arguments);
                if(native.name==='exec_command') {trace.command=String(args.cmd).slice(0,200);
                  if(args.cmd==='node verify.mjs') {const checked=shellRun(process.execPath,['verify.mjs'],{cwd:workspace});valid=checked.status===0;state.verified=valid;if(!valid)invalidReason='fixture_verifier_failed';output=valid?'all 5 fixture assertions passed':checked.stderr;}
                  else if(/^(?:cat (?:'module\.mjs'|module\.mjs)|sed -n '[0-9]+,[0-9]+p' 'module\.mjs')$/.test(args.cmd)) output=readFileSync(path.join(workspace,'module.mjs'),'utf8');
                  else {valid=false;invalidReason='unsupported_fixture_command';output='Synthetic terminal supports only cat module.mjs, sed -n line ranges on module.mjs, and node verify.mjs. No other command executed.';}
                } else if(native.name==='automation_update') {trace.mode=args.mode;trace.idType=typeof args.id;trace.status=args.status;output=validateOperation(args);valid=!output;if(!valid)invalidReason='schema_validation_failed';if(valid){if(args.mode==='update'&&args.id==='2') state.updated=args.status==='PAUSED'&&Object.entries(automationFixture).every(([k,v])=>k==='status'||args[k]===v);output=JSON.stringify({...automationFixture,status:state.updated?'PAUSED':'ACTIVE'});}}
                else if(native.name==='get_ticket') {state.ticketRead=true;output=JSON.stringify({ticket:'fixture-ticket-42'});}
                else if(native.name==='verify_ticket') {valid=state.ticketRead&&args.ticket==='fixture-ticket-42';state.ticketVerified=valid;output=valid?'ticket verified':'Invalid ticket or get_ticket has not been called.';}
                else {valid=false;output='Unknown synthetic tool; no action performed.';}
              }
            } catch(error) {valid=false;invalidReason=error.code||error.name;output=`Invalid tool call: ${error.code||error.name}. Read the declared tool schema and correct the arguments; no action performed.`;}
            run.toolOutcomes.push({...trace,valid,...(invalidReason?{invalidReason}:{})});
            if(!valid){run.invalidCalls++;const signature=name+'\0'+call.function.arguments;if(state.invalid.has(signature))run.repeatedInvalidCalls++;state.invalid.add(signature);}
            messages.push({role:'tool',tool_call_id:call.id,content:output||'ok'});
          }
        }
        run.verified=caseName==='edit_repeated_context'?state.verified===true:caseName==='recover_invalid_union_argument'?state.updated:state.ticketRead&&state.ticketVerified;
        run.success=run.verified&&run.status==='completed'&&run.finalMessages===1;
        if(run.status==='running')run.status='client_turn_limit';
      } catch(error){run.status=error.name==='TimeoutError'?'request_timeout':'execution_error';run.errorType=error.name;}
      run.elapsedMs=Date.now()-started;
      const attempts=report.providerRequests.filter(r=>r.runId===run.id);
      for(const field of ['inputTokens','outputTokens','cachedTokens'])run[field]=attempts.length&&attempts.every(a=>Number.isFinite(a[field]))?attempts.reduce((n,a)=>n+a[field],0):null;
      activeRun=undefined;save();process.stdout.write(JSON.stringify({run:run.id,arm:label,caseName,repeat,success:run.success,status:run.status,providerRequests:run.providerRequests,elapsedMs:run.elapsedMs})+'\n');
    }
  } finally {
    activeRun=undefined;for(const child of children)child.kill('SIGTERM');proxy.closeAllConnections();await new Promise(r=>proxy.close(r));
    report.finishedAt=new Date().toISOString();report.providerGenerationCount=report.providerRequests.length;report.providerBudgetUsedUpperBound=providerCount;
    report.summary=Object.fromEntries(['baseline','candidate'].map(arm=>{const runs=report.runs.filter(r=>r.arm===arm);return [arm,{started:runs.length,eligible:runs.filter(r=>r.qualityEligible!==false).length,excludedFromQuality:runs.filter(r=>r.qualityEligible===false).length,harnessErrors:runs.filter(r=>r.status==='harness_error').length,interrupted:runs.filter(r=>r.status==='interrupted').length,succeeded:runs.filter(r=>r.qualityEligible!==false&&r.success).length,failed:runs.filter(r=>r.qualityEligible!==false&&!r.success).length,providerRequests:runs.reduce((s,r)=>s+r.providerRequests,0),elapsedMs:runs.reduce((s,r)=>s+(r.elapsedMs||0),0),invalidCalls:runs.reduce((s,r)=>s+r.invalidCalls,0),repeatedInvalidCalls:runs.reduce((s,r)=>s+r.repeatedInvalidCalls,0),patchFailures:runs.reduce((s,r)=>s+r.patchFailures,0)}];}));if(!process.argv.includes('--prepare'))save();rmSync(temp,{recursive:true,force:true});
  }
}

// Separate follow-up campaign: never executes a model-generated client tool.
// Requires its own explicit --live --yes authorization and cannot silently add
// runs to the paired campaign above.
async function validateFinal() {
  if(!process.argv.includes('--live')||!process.argv.includes('--yes')) throw new Error('--validate-final requires --live --yes and separate approval for up to 6 provider generations.');
  const outputPath=path.join(ROOT,'docs/grok-final-validation.json');
  const report={scope:'Three isolated candidate post-tool final responses; no client tool execution, production listeners, or configuration changes.',model:'grok-4.7',effort:'medium',limits:{taskRuns:3,providerGenerations:6,requestMs:90000,campaignMs:300000},startedAt:new Date().toISOString(),sourceHashes:[],runs:[],providerRequests:[]};
  for(const file of GROK_FINAL_VALIDATION_SOURCE_FILES)report.sourceHashes.push({path:file,sha256:hash(readFileSync(path.join(ROOT,file)))});
  const save=()=>writeFileSync(outputPath,JSON.stringify(report,null,2)+'\n');
  const started=Date.now();const key=randomUUID();let activeRun;let child;const abortAll=new AbortController();
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>abortAll.abort());
  const proxy=http.createServer(async(req,res)=>{
    if(!activeRun||report.providerRequests.length>=6||Date.now()-started>=300000){res.writeHead(429);res.end('{"error":"validation_budget"}');return;}
    const meta={runId:activeRun.id,index:report.providerRequests.length+1,elapsedMs:null,httpStatus:null,terminal:null,hasPrivateFinal:false,toolChoice:null,emittedFunctionNames:[],publicContentLength:0,privateFinalArgumentShapes:[],inputTokens:null,outputTokens:null,cachedTokens:null};
    report.providerRequests.push(meta);save();const begin=Date.now();const cancel=new AbortController();res.once('close',()=>{if(!res.writableEnded)cancel.abort();});
    try{
      const pieces=[];for await(const piece of req)pieces.push(piece);const body=Buffer.concat(pieces);const outgoing=JSON.parse(body.toString());
      meta.hasPrivateFinal=(outgoing.tools||[]).some(t=>t.name?.startsWith('__codex_router_submit_final'));meta.toolChoice=typeof outgoing.tool_choice==='string'?outgoing.tool_choice:outgoing.tool_choice?.type||null;
      const headers={...req.headers};delete headers.host;delete headers.connection;delete headers['content-length'];
      const upstream=await fetch('https://cli-chat-proxy.grok.com/v1/responses',{method:'POST',headers,body,signal:AbortSignal.any([cancel.signal,abortAll.signal,AbortSignal.timeout(Math.min(90000,Math.max(1,300000-(Date.now()-started))))])});
      meta.httpStatus=upstream.status;res.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')||'text/event-stream'});let buffer='';
      for await(const bytes of upstream.body){res.write(bytes);buffer+=Buffer.from(bytes).toString('utf8');let end;
        while((end=buffer.indexOf('\n\n'))!==-1){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);for(const line of frame.split('\n'))if(line.startsWith('data: ')){
          try{const e=JSON.parse(line.slice(6));
            if(e.type==='response.output_item.done'){
              const item=e.item;
              if(item?.type==='message')meta.publicContentLength+=(item.content||[]).filter(p=>p.type==='output_text').reduce((n,p)=>n+(p.text?.length||0),0);
              if(item?.type==='function_call'){
                meta.emittedFunctionNames.push(item.name);
                if(item.name?.startsWith('__codex_router_submit_final')){try{const args=JSON.parse(item.arguments);meta.privateFinalArgumentShapes.push({jsonValid:true,keys:args&&typeof args==='object'?Object.keys(args):[],answerType:typeof args?.answer,answerLength:typeof args?.answer==='string'?args.answer.length:null});}catch{meta.privateFinalArgumentShapes.push({jsonValid:false});}}
              }
            }
            if(['response.completed','response.failed','response.incomplete'].includes(e.type)){meta.terminal=e.type;const u=e.response?.usage;if(u){meta.inputTokens=u.input_tokens??null;meta.outputTokens=u.output_tokens??null;meta.cachedTokens=u.input_tokens_details?.cached_tokens??null;}}
          }catch{}
        }}
        if(buffer.length>2*1024*1024)buffer='';
      }res.end();
    }catch(error){meta.errorType=error.name;if(!res.headersSent)res.writeHead(502);res.end();}
    finally{meta.elapsedMs=Date.now()-begin;save();}
  });
  try{
    const proxyPort=await listen(proxy);const port=await freePort();
    const env={...process.env,MODEL_ROUTER_GROK_OAUTH_PORT:String(port),GROK_CLI_CHAT_PROXY_BASE_URL:`http://127.0.0.1:${proxyPort}`,MODEL_ROUTER_INTERNAL_KEY:key,MODEL_ROUTER_QUIET:'1',CODEX_ROUTER_GROK_PATCH_HOOK:'0'};
    for(const name of ['CODEX_ROUTER_GROK_PROGRESS_ONLY_RETRY','CODEX_ROUTER_GROK_PROGRESS_ONLY_MAX_TEXT','CODEX_ROUTER_GROK_PROGRESS_ONLY_MIN_OUTPUT_TOKENS'])delete env[name];
    child=spawn(process.execPath,[path.join(ROOT,'src/grok-oauth-forwarder.mjs')],{cwd:ROOT,env,stdio:['ignore','ignore','ignore']});
    let ready=false;for(let i=0;i<100;i++){try{const r=await fetch(`http://127.0.0.1:${port}/health`,{headers:{Authorization:`Bearer ${key}`},signal:AbortSignal.timeout(500)});if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}
    if(!ready)throw new Error('Isolated candidate forwarder unavailable');
    for(let id=1;id<=3;id++){
      if(abortAll.signal.aborted||report.providerRequests.length>=6||Date.now()-started>=300000)break;
      const run={id,status:'running',success:false,elapsedMs:null,providerRequests:0,finalMessages:0,unexpectedClientCalls:0,httpErrorCode:null};report.runs.push(run);activeRun=run;save();const begin=Date.now();
      try{
        const response=await fetch(`http://127.0.0.1:${port}/v1/chat/completions`,{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},signal:AbortSignal.any([abortAll.signal,AbortSignal.timeout(Math.min(90000,Math.max(1,300000-(Date.now()-started))))]),body:JSON.stringify({model:'grok-4.7',reasoning_effort:'medium',stream:false,tools:[{type:'function',function:{name:'calculator',description:'Readonly synthetic calculator. The requested calculation already succeeded in the tool history.',parameters:object({expression:string})}}],messages:[{role:'system',content:`Synthetic final-response validation ${id}. Complete the user's task using the provided successful tool result. No further action is needed.`},{role:'user',content:'What is 20 + 22? Return just the number.'},{role:'assistant',content:null,tool_calls:[{id:`seed-${id}`,type:'function',function:{name:'calculator',arguments:'{"expression":"20+22"}'}}]},{role:'tool',tool_call_id:`seed-${id}`,content:'{"result":42}'}]})});
        if(!response.ok){run.status=`http_${response.status}`;try{run.httpErrorCode=(await response.json()).error?.code||null;}catch{}}
        else{const result=await response.json();const message=result.choices?.[0]?.message;run.unexpectedClientCalls=message?.tool_calls?.length||0;run.finalMessages=message&&!run.unexpectedClientCalls?1:0;run.answerCorrect=/^42[.!]?$/.test(message?.content?.trim()||'');run.success=run.finalMessages===1&&run.answerCorrect;run.status=run.success?'completed':'unexpected_result';}
      }catch(error){run.status=error.name==='TimeoutError'?'request_timeout':'execution_error';run.errorType=error.name;}
      run.elapsedMs=Date.now()-begin;run.providerRequests=report.providerRequests.filter(p=>p.runId===id).length;activeRun=undefined;save();process.stdout.write(JSON.stringify(run)+'\n');
    }
  }finally{activeRun=undefined;child?.kill('SIGTERM');proxy.closeAllConnections();await new Promise(r=>proxy.close(r));report.finishedAt=new Date().toISOString();report.successes=report.runs.filter(r=>r.success).length;report.allPassed=report.runs.length===3&&report.successes===3;save();}
}

if(process.argv.includes('--validate-final')) await validateFinal();
else await main();
