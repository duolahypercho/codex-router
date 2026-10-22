// Synthetic-only continuation of the explicitly authorized quality investigation.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CODEX_APP_TOOLS } from '../src/codex-app-tools.mjs';
import { createStreamObservation } from './grok-stream-observation.mjs';
const require = createRequire(import.meta.url);
const Ajv = require('ajv/dist/2020.js').default;
assert.equal(require('ajv/package.json').version, '8.20.0');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const acceptance = process.argv.includes('--acceptance');
const output = path.join(root, acceptance ? 'docs/grok-loop-acceptance-results.json' : 'docs/grok-loop-followup-results.json');
const generationLimit = acceptance ? 30 : 60;
const schema = CODEX_APP_TOOLS.flatMap(n=>n.tools||[]).find(t=>t.name==='automation_update').inputSchema;
const validate = new Ajv({strict:false,allErrors:true}).compile(schema);
const fixture = { id:'2',kind:'heartbeat',name:'Fixture check',prompt:'Check synthetic fixture state.',rrule:'FREQ=MINUTELY;INTERVAL=30',status:'ACTIVE' };
const hash = value => createHash('sha256').update(value).digest('hex');
const listen = server => new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const close = server => new Promise(resolve=>{server.closeAllConnections();server.close(resolve);});
const option = (name, fallback) => process.argv.find(a=>a.startsWith(`--${name}=`))?.slice(name.length+3)||fallback;
const mode=option('mode','diagnose');
if(!['diagnose','validate','final'].includes(mode)) throw Error('Unknown mode');
if(!process.argv.includes('--live')||!process.argv.includes('--yes')) throw Error('Requires explicit live quota consent and --live --yes');
const report=existsSync(output)?JSON.parse(readFileSync(output,'utf8')):{startedAt:new Date().toISOString(),limits:{providerGenerations:generationLimit,campaignMs:acceptance?1200000:1800000,requestMs:acceptance?180000:600000,clientTurns:6},runs:[],requests:[]};
const started=Date.parse(report.startedAt);
const remaining=()=>report.limits.campaignMs-(Date.now()-started);
if(remaining()<=0||report.requests.length>=report.limits.providerGenerations) throw Error('Authorized follow-up budget exhausted');
const save=()=>writeFileSync(output,JSON.stringify(report,null,2)+'\n');
const cancel=new AbortController();
process.once('SIGINT',()=>cancel.abort());process.once('SIGTERM',()=>cancel.abort());
const deadline=setTimeout(()=>cancel.abort(),remaining());
let active;
const proxy=http.createServer(async(req,res)=>{
 if(!active||report.requests.length>=report.limits.providerGenerations||remaining()<=0){res.writeHead(429);res.end();return;}
 const record={runId:active.id,index:report.requests.length+1,terminal:null};report.requests.push(record);save();
 const begin=Date.now();const stop=new AbortController();res.once('close',()=>{if(!res.writableEnded)stop.abort();});
 const observation=createStreamObservation(record);
 try{
  const chunks=[];for await(const c of req)chunks.push(c);const body=Buffer.concat(chunks);const parsed=JSON.parse(body);
  record.inputItems=(parsed.input||[]).map(i=>({type:i.type,role:i.role,...(i.type==='function_call'?{name:i.name,idHash:hash(i.call_id||''),argumentHash:hash(i.arguments||'')}:{})}));
  record.toolChoice=parsed.tool_choice||'auto';record.toolNames=(parsed.tools||[]).map(t=>t.name||t.type);record.maxOutputTokens=parsed.max_output_tokens??null;record.temperature=parsed.temperature??null;record.topP=parsed.top_p??null;
  const headers={...req.headers};delete headers.host;delete headers.connection;delete headers['content-length'];
  const upstream=await fetch('https://cli-chat-proxy.grok.com/v1/responses',{method:'POST',headers,body,signal:AbortSignal.any([cancel.signal,stop.signal,AbortSignal.timeout(Math.min(report.limits.requestMs,Math.max(1,remaining())))])});
  record.headersMs=Date.now()-begin;record.httpStatus=upstream.status;res.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')||'text/event-stream'});
  for await(const bytes of upstream.body){observation.push(bytes);res.write(bytes);if(!record.savedAt||Date.now()-record.savedAt>5000){record.savedAt=Date.now();save();}}observation.end();res.end();
 }catch(error){record.errorType=error.name;if(!res.headersSent)res.writeHead(502);res.end();}
 finally{record.elapsedMs=Date.now()-begin;save();}
});
const port=await listen(proxy);
const configurations=acceptance?['current','current']:mode==='diagnose'?['current','auto','no_carry']:['current','current','current'];
try{
 for(const [configIndex, config] of configurations.entries()){
  if(cancel.signal.aborted||remaining()<=0)break;
  const server=http.createServer();const childPort=await listen(server);await close(server);
  const key=randomUUID();const env={...process.env,MODEL_ROUTER_GROK_OAUTH_PORT:String(childPort),GROK_CLI_CHAT_PROXY_BASE_URL:`http://127.0.0.1:${port}`,MODEL_ROUTER_INTERNAL_KEY:key,MODEL_ROUTER_QUIET:'1'};
  delete env.CODEX_ROUTER_GROK_PROGRESS_ONLY_RETRY;delete env.CODEX_ROUTER_GROK_REASONING_CARRY;
  if(config==='auto')env.CODEX_ROUTER_GROK_PROGRESS_ONLY_RETRY='0';
  if(config==='no_carry')env.CODEX_ROUTER_GROK_REASONING_CARRY='0';
  const sourceHashes=[];for(const file of ['src/grok-oauth-forwarder.mjs','src/grok-oauth-turn.mjs','src/grok-tool-schema.mjs','src/grok-tool-alternatives.mjs'])sourceHashes.push({path:file,sha256:hash(readFileSync(path.join(root,file)))});
  const harnessHashes=['scripts/verify-grok-loop-followup.mjs','scripts/grok-stream-observation.mjs','src/codex-app-tools.mjs'].map(file=>({path:file,sha256:hash(readFileSync(path.join(root,file)))}));
  const child=spawn(process.execPath,[path.join(root,'src/grok-oauth-forwarder.mjs')],{cwd:root,env,stdio:['ignore','ignore','ignore']});
  try{
   let ready=false;
   for(let i=0;i<100;i++){try{const r=await fetch(`http://127.0.0.1:${childPort}/health`,{headers:{Authorization:`Bearer ${key}`},signal:AbortSignal.timeout(500)});if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}
   if(!ready)throw Error('Forwarder unavailable');
   for(const task of (acceptance?['recovery','loop_recovery','final']:mode==='final'?(configIndex<2?['loop_recovery','final']:['final']):mode==='validate'?['recovery','loop_recovery','final']:['recovery','final'])){
    const isRecovery=task!=='final';
    if(cancel.signal.aborted||remaining()<=0||report.requests.length>=report.limits.providerGenerations)break;
    const run={id:report.runs.length+1,mode,config,task,status:'running',calls:[],sourceHashes,harnessHashes};report.runs.push(run);active=run;
    const begin=Date.now();let state={...fixture};let viewed=false;let writes=0;
    const messages=[{role:'system',content:`Synthetic fixture ${task}. Use the available tools and returned results to complete all requested actions, then give one concise final answer.`},{role:'user',content:isRecovery?'Recover from the failed view call below. View synthetic automation with string id "2", then update its status to PAUSED, preserving all other fields. Perform the update and report completion. This is an in-memory fixture; no real scheduling action occurs.':'What is 20 + 22? Return just the number.'},{role:'assistant',content:null,tool_calls:[{id:'seed',type:'function',function:isRecovery?{name:'automation_update',arguments:'{"mode":"view","id":2}'}:{name:'calculator',arguments:'{"expression":"20+22"}'}}]},{role:'tool',tool_call_id:'seed',content:isRecovery?'Invalid arguments: id must be a string. No state changed.':'{"result":42}'}];
    if(task==='loop_recovery'){run.seededRepeatedRounds=3;viewed=true;for(let i=1;i<=3;i++)messages.push({role:'assistant',content:null,tool_calls:[{id:`view-${i}`,type:'function',function:{name:'automation_update',arguments:'{"mode":"view","id":"2"}'}}]},{role:'tool',tool_call_id:`view-${i}`,content:JSON.stringify(state)});}
    const tools=[{type:'function',function:isRecovery?{name:'automation_update',description:'Synthetic fixture only: view or update automation 2 in memory. No real automation exists or is changed.',parameters:schema}:{name:'calculator',description:'Readonly calculator. The requested calculation already succeeded.',parameters:{type:'object',properties:{expression:{type:'string'}},required:['expression'],additionalProperties:false}}}];
    try{
     for(let turn=0;turn<6;turn++){
      if(report.requests.length>=report.limits.providerGenerations||remaining()<=0)break;
      const response=await fetch(`http://127.0.0.1:${childPort}/v1/chat/completions`,{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model:'grok-4.7',reasoning_effort:'medium',stream:false,messages,tools}),signal:AbortSignal.any([cancel.signal,AbortSignal.timeout(Math.min(report.limits.requestMs,Math.max(1,remaining())))])});
      if(!response.ok){run.status=`http_${response.status}`;try{run.errorCode=(await response.json()).error?.code;}catch{}break;}
      const result=await response.json();const message=result.choices?.[0]?.message;
      if(!message)throw Error('Missing message');
      if(!message.tool_calls?.length){run.status='completed';run.finalText=message.content?.slice(0,200)||'';run.answerCorrect=task==='final'?/^42[.!]?$/.test(message.content?.trim()||''):!!message.content?.trim();run.success=run.answerCorrect&&(task==='final'||(viewed&&writes===1&&state.status==='PAUSED'));break;}
      messages.push({role:'assistant',content:message.content||null,tool_calls:message.tool_calls});
      for(const call of message.tool_calls){
       const trace={name:call.function?.name,idHash:hash(call.id||''),argumentHash:hash(call.function?.arguments||'')};run.calls.push(trace);let result;
       try{const args=JSON.parse(call.function.arguments);trace.mode=args.mode;trace.status=args.status;
        if(isRecovery&&call.function.name==='automation_update'){
         trace.valid=validate(args)&&args.id==='2'&&['view','update'].includes(args.mode);
         if(!trace.valid)result='Invalid arguments: use a declared view/update branch and string id "2". No state changed.';
         else if(args.mode==='view'){viewed=true;result=JSON.stringify(state);}
         else{const preserved=Object.entries(fixture).every(([k,v])=>k==='status'||args[k]===v);trace.preserved=preserved;if(preserved&&args.status==='PAUSED'){writes++;state={...fixture,status:'PAUSED'};}result=JSON.stringify(state);}
        }else{trace.valid=false;result='No further calculation is needed: result is 42.';}
       }catch{trace.valid=false;result='Invalid JSON arguments. No state changed.';}
       messages.push({role:'tool',tool_call_id:call.id,content:result});
      }
     }
     if(run.status==='running')run.status='client_turn_limit';
    }catch(error){run.status=error.name==='TimeoutError'?'request_timeout':'execution_error';run.errorType=error.name;}
    run.sourceUnchanged=sourceHashes.every(({path:file,sha256})=>hash(readFileSync(path.join(root,file)))===sha256);run.elapsedMs=Date.now()-begin;run.viewed=viewed;run.writes=writes;run.stateCorrect=state.status==='PAUSED';run.success??=false;run.providerRequests=report.requests.filter(r=>r.runId===run.id).length;active=undefined;save();console.log(JSON.stringify(run));
   }
  }finally{active=undefined;child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,2000))]);}
 }
}finally{clearTimeout(deadline);active=undefined;await close(proxy);report.lastFinishedAt=new Date().toISOString();save();}
