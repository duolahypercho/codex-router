// Offline protocol proof. Never uses the operator's provider credentials or app MCP.
// Requires an explicit locked LiteLLM Python; --codex adds real client discovery/dispatch.
import assert from "node:assert/strict";
import {spawn, spawnSync} from "node:child_process";
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {callerBaseUrl} from "../src/caller-auth.mjs";
import {spawnableCommand} from "../src/spawnable-command.mjs";
import {writeGrokVersionCli} from "../test/grok-version-fixture.mjs";
import {routedModel} from "../src/catalog.mjs";
import {MODEL_BY_SLUG} from "../src/model-registry.mjs";
const python = process.argv[2];
if (!python || python.startsWith("--")) throw new Error("usage: node scripts/verify-grok-app-tools.mjs <venv-python> [--codex=/absolute/codex]");
const codexBinary = process.argv.find(x => x.startsWith("--codex="))?.slice(8);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = mkdtempSync(path.join(os.tmpdir(), "grok-app-tools-"));
const children = [];
const CALLER_KEY = "test-router-caller-capability-with-sufficient-length";
const INTERNAL_KEY = "test-internal-service-key-with-sufficient-length";
const LITELLM_HEALTH_MS = 300_000;
const captures = [];
let mockFailure;
function redact(text) {
  return String(text || "")
    .replaceAll(CALLER_KEY, "[caller-key]")
    .replaceAll(INTERNAL_KEY, "[internal-key]")
    .replaceAll("fake-access", "[session-key]");
}

function sse(events) {
  return `${events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("")}data: [DONE]\n\n`;
}

async function openPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function nativeProbeEnvironment(home) {
  const environment = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR", "LANG"].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  return { ...environment, HOME: home, USERPROFILE: home, CODEX_HOME: home,
    CODEX_API_KEY: "offline-protocol-fixture-not-a-real-key",
    OPENAI_API_KEY: "offline-protocol-fixture-not-a-real-key" };
}

function spawnChild(command, args, env, { detached = false, cwd = root, interactive = false, inheritEnvironment = true } = {}) {
  const spawnable = spawnableCommand(command, args);
  const child = spawn(spawnable.command, spawnable.args, {
    cwd,
    env: { ...(inheritEnvironment ? process.env : {}), ...env },
    stdio: [interactive ? "pipe" : "ignore", "pipe", "pipe"],
    detached,
    ...spawnable.options,
  });
  let output = "";
  const collect = (chunk) => {
    output = (output + redact(chunk.toString("utf8"))).slice(-128 * 1024);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  child.testOutput = () => output;
  children.push(child);
  return child;
}

function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const done = () => resolve();
    child.once("exit", done);
    if (process.platform === "win32") {
      spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });
    } else if (child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, 5_000).unref();
  });
}

async function waitHttp(url, child, { headers = {}, timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(`exited before ${url}: ${child.testOutput()}`);
    }
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // not bound yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timeout waiting for ${url}: ${child?.testOutput?.() || ""}`);
}

function mockFunctionCall(callId, argumentsText, name, includeArgumentDone = false) {
  return sse([
    {
      type: "response.output_item.added",
      item: {
        type: "function_call",
        id: `fc_${callId}`,
        call_id: callId,
        name,
      },
    },
    ...[argumentsText.slice(0, 13), argumentsText.slice(13, 29), argumentsText.slice(29)].map((delta) => ({
      type: "response.function_call_arguments.delta",
      item_id: `fc_${callId}`,
      delta,
    })),
    ...(includeArgumentDone ? [{
      type: "response.function_call_arguments.done",
      item_id: `fc_${callId}`,
      arguments: argumentsText,
    }] : []),
    {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        id: `fc_${callId}`,
        call_id: callId,
        name,
        arguments: argumentsText,
      },
    },
    { type: "response.completed", response: { usage: { input_tokens: 12, output_tokens: 9 } } },
  ]);
}


const discoveryTool = {type:"tool_search", execution:"client", description:"Search deferred app tools.", parameters:{type:"object",properties:{query:{type:"string"},limit:{type:"number"}},required:["query"]}};
const appDefinition = {type:"namespace",name:"mcp__codex_app",tools:[{type:"function",name:"list_projects",defer_loading:true,parameters:{type:"object",properties:{}}}]};
const searchQuery = "codex_app list_projects";
function finalResponse() {
  const text = "Offline app proof complete.";
  const item = {id:"msg_final",type:"message",role:"assistant",status:"completed",content:[{type:"output_text",text,annotations:[]}]};
  return sse([{type:"response.created",response:{id:"resp_final",status:"in_progress",output:[]}},
    {type:"response.output_item.added",output_index:0,item},
    {type:"response.output_text.delta",item_id:item.id,output_index:0,content_index:0,delta:text},
    {type:"response.output_item.done",output_index:0,item},
    {type:"response.completed",response:{id:"resp_final",status:"completed",output:[item],usage:{input_tokens:12,output_tokens:9}}}]);
}

let stage = 0;
const mockXai = http.createServer(async (request,response) => {
  try {
    const chunks=[];for await (const chunk of request) chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks));captures.push(body);stage++;
    assert.ok(stage<=4, "bounded search/call/call/final sequence");
    const names=(body.tools??[]).map(t=>t.name);
    assert.ok(!names.some(n=>n?.startsWith("codex_app__")||n?.startsWith("plugin_management__")), "no fabricated legacy tools");
    assert.ok(names.includes("tool_search"), "native search relay reaches xAI");
    if(stage===1) {
      assert.ok(!names.includes("mcp__codex_app__list_projects"), "deferred tool is not eager");
      response.writeHead(200,{"Content-Type":"text/event-stream"});
      response.end(mockFunctionCall("call_search",JSON.stringify({query:searchQuery,limit:1}),"tool_search"));
      return;
    }
    const appTool=body.tools.find(t=>t.name==="mcp__codex_app__list_projects");
    assert.ok(appTool, `discovered MCP definition survives subsequent requests (stage ${stage}, names=${JSON.stringify(names)})`);
    assert.equal(appTool.parameters.type,"object");
    const history=JSON.stringify(body.input);
    assert.ok(history.includes(searchQuery), "search arguments survive the full history roundtrip");
    assert.ok(body.input.some(item=>item.type==="function_call"&&item.call_id==="call_search"&&item.name==="tool_search"), "search call pairing survives");
    if(stage>=3) {
      const feedback=body.input.find(item=>item.type==="function_call_output"&&item.call_id===`call_app_${stage-1}`);
      assert.ok(JSON.stringify(feedback?.output).includes("OFFLINE_FIXTURE_OK"), "matching native MCP result reaches upstream");
    }
    response.writeHead(200,{"Content-Type":"text/event-stream"});
    response.end(stage<=3 ? mockFunctionCall(`call_app_${stage}`,"{}",appTool.name):finalResponse());
  } catch(error) {
    mockFailure ||= error;
    if(!response.headersSent) response.writeHead(500);
    response.end("Offline fixture assertion failed");
  }
});

try {
  await new Promise((resolve,reject)=>{mockXai.once("error",reject);mockXai.listen(0,"127.0.0.1",resolve);});
  const xaiPort=mockXai.address().port;
  const grokPort=await openPort(), gatewayPort=await openPort(), routerPort=await openPort();
  const pythonDir=path.dirname(python);
  const litellmBin=path.join(pythonDir,process.platform==="win32"?"litellm.exe":"litellm");
  assert.ok(existsSync(python), "explicit Python exists");assert.ok(existsSync(litellmBin), "locked LiteLLM entrypoint exists");
  const authPath = path.join(workspace, "auth.json");
  writeFileSync(
    authPath,
    JSON.stringify({ "https://auth.x.ai::test-client-id": { key: "fake-access" } }),
    { mode: 0o600 },
  );
  const litellmConfig = path.join(workspace, "litellm.yaml");
  writeFileSync(path.join(workspace, "litellm_stream_cleanup_callback.py"), readFileSync(path.join(root, "src", "litellm_stream_cleanup_callback.py")), {mode: 0o600});
  writeFileSync(
    litellmConfig,
    [
      "model_list:",
      '  - model_name: "grok-oauth-grok-4-7"',
      "    litellm_params:",
      '      model: "openai/grok-4.7"',
      "      api_base: os.environ/GROK_OAUTH_FORWARD_BASE_URL",
      '      api_key: "os.environ/CODEX_ROUTER_INTERNAL_KEY"',
      "      use_chat_completions_api: true",
      "      num_retries: 0",
      "",
      "litellm_settings:",
      "  callbacks: [litellm_stream_cleanup_callback.stream_cleanup_callback]",
      "  drop_params: true",
      "  request_timeout: 60",
      "",
      "router_settings:",
      "  disable_cooldowns: true",
      "",
      "general_settings:",
      "  disable_spend_logs: true",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  const sharedEnv = {
    MODEL_ROUTER_TARGET: "codex",
    MODEL_ROUTER_QUIET: "1",
    MODEL_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
    CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY,
    CODEX_ROUTER_CALLER_KEY: CALLER_KEY,
    CODEX_ROUTER_GROK_PROGRESS_ONLY_RETRY: "0",
    CODEX_ROUTER_EMPTY_COMPLETION_RETRY: "1",
    CODEX_ROUTER_GROK_STRUCTURED_PATCH: "0",
    CODEX_ROUTER_GROK_PATCH_HOOK: "0",
    LITELLM_MASTER_KEY: INTERNAL_KEY,
    LITELLM_LOG: "ERROR",
    LITELLM_TELEMETRY: "False",
    LITELLM_LOCAL_MODEL_COST_MAP: "True",
    NO_COLOR: "1",
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
    PATH: `${pythonDir}${path.delimiter}${process.env.PATH || ""}`,
  };

  const grokChild = spawnChild(
    process.execPath,
    [path.join(root, "src", "grok-oauth-forwarder.mjs")],
    {
      ...sharedEnv,
      MODEL_ROUTER_GROK_OAUTH_PORT: String(grokPort),
      GROK_CLI_CHAT_PROXY_BASE_URL: `http://127.0.0.1:${xaiPort}`,
      GROK_CLI: writeGrokVersionCli(path.dirname(authPath)),
      GROK_AUTH_PATH: authPath,
    },
  );
  await waitHttp(`http://127.0.0.1:${grokPort}/health`, grokChild, {
    headers: { Authorization: `Bearer ${INTERNAL_KEY}` },
  });

  const litellmChild = spawnChild(
    litellmBin,
    ["--config", litellmConfig, "--host", "127.0.0.1", "--port", String(gatewayPort)],
    {
      ...sharedEnv,
      GROK_OAUTH_FORWARD_BASE_URL: `http://127.0.0.1:${grokPort}/v1`,
    },
    { detached: process.platform !== "win32" },
  );
  await waitHttp(`http://127.0.0.1:${gatewayPort}/health/liveliness`, litellmChild, {
    timeoutMs: LITELLM_HEALTH_MS,
  });

  const stateDir = path.join(workspace, "state");
  const codexHome = path.join(workspace, "codex-home");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: ["grok-oauth"] }, null, 2)}\n`,
    { mode: 0o600 },
  );
  const routerChild = spawnChild(process.execPath, [path.join(root, "src", "router.mjs")], {
    ...sharedEnv,
    MODEL_ROUTER_STATE_DIR: stateDir,
    CODEX_ROUTER_STATE_DIR: stateDir,
    CODEX_HOME: codexHome,
    CODEX_ROUTER_PORT: String(routerPort),
    CODEX_ROUTER_GATEWAY_BASE_URL: `http://127.0.0.1:${gatewayPort}/v1`,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${gatewayPort}/health/liveliness`,
    CODEX_ROUTER_GROK_OAUTH_HEALTH_URL: `http://127.0.0.1:${grokPort}/health`,
    MODEL_ROUTER_GROK_OAUTH_PORT: String(grokPort),
  });
  await waitHttp(`http://127.0.0.1:${routerPort}/health`, routerChild);


  const routerUrl = `${callerBaseUrl(routerPort,CALLER_KEY)}/responses`;
  async function post(input) {
    const response=await fetch(routerUrl,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${CALLER_KEY}`},
      body:JSON.stringify({model:"grok-oauth/grok-4.7",stream:true,input,tools:[discoveryTool]}),signal:AbortSignal.timeout(90_000)});
    const text=await response.text();if(mockFailure)throw mockFailure;assert.equal(response.status,200,text);
    return text.split("\n").filter(l=>l.startsWith("data:")).map(l=>l.slice(5).trim()).filter(l=>l&&l!=="[DONE]").map(l=>JSON.parse(l));
  }
  if(codexBinary) {
    const env=nativeProbeEnvironment(codexHome);
    const bundled=spawnSync(codexBinary,["debug","models","--bundled"],{env,encoding:"utf8",timeout:30_000,maxBuffer:32*1024*1024});
    assert.equal(bundled.status,0,bundled.stderr);
    const template=JSON.parse(bundled.stdout).models.find(m=>m.apply_patch_tool_type==="freeform");assert.ok(template);
    const catalogPath=path.join(workspace,"catalog.json");
    writeFileSync(catalogPath,JSON.stringify({models:[routedModel(template,MODEL_BY_SLUG.get("grok-oauth/grok-4.7"))]}));
    const mcpPath=path.join(workspace,"fixture-mcp.mjs");
    writeFileSync(mcpPath, `import readline from "node:readline";for await(const line of readline.createInterface({input:process.stdin})){const x=JSON.parse(line);if(x.id===undefined)continue;const result=x.method==="initialize"?{protocolVersion:"2024-11-05",capabilities:{tools:{}},serverInfo:{name:"offline-app-fixture",version:"1"}}:x.method==="tools/list"?{tools:[{name:"list_projects",description:"Offline fixture list projects",annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},inputSchema:{type:"object",properties:{}}}]}:x.method==="tools/call"?{content:[{type:"text",text:"OFFLINE_FIXTURE_OK"}]}:{};process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:x.id,result})+"\\n");}`);
    const args=["exec","--ephemeral","--skip-git-repo-check","--sandbox","read-only","--color","never","--json","--model","grok-oauth/grok-4.7","--cd",workspace];
    for(const setting of ['model_provider="local-protocol"',`model_catalog_json=${JSON.stringify(catalogPath)}`,'model_providers.local-protocol.name="Offline app proof"',`model_providers.local-protocol.base_url=${JSON.stringify(callerBaseUrl(routerPort,CALLER_KEY))}`,'model_providers.local-protocol.wire_api="responses"','model_providers.local-protocol.requires_openai_auth=false','model_providers.local-protocol.supports_websockets=false','approval_policy="never"','features.plugins=false','features.remote_plugin=false','features.tool_search=false','features.tool_search_always_defer_mcp_tools=true','features.code_mode=false',`mcp_servers.codex_app.command=${JSON.stringify(process.execPath)}`,`mcp_servers.codex_app.args=[${JSON.stringify(mcpPath)}]`])args.push("-c",setting);
    args.push("Offline app protocol fixture. Search and call only the supplied read-only fixture, then finish.");
    const child=spawnChild(codexBinary,args,env,{cwd:workspace,inheritEnvironment:false});
    let timer;const exit=await Promise.race([new Promise(resolve=>child.once("exit",resolve)),new Promise((_,reject)=>{timer=setTimeout(()=>{void stopChild(child);reject(new Error("native app proof deadline"));},90_000);})]).finally(()=>clearTimeout(timer));
    if(mockFailure)throw mockFailure;assert.equal(exit,0,child.testOutput());assert.match(child.testOutput(),/turn.completed/);
  } else {
    const first=await post([{role:"user",content:"Offline app discovery fixture."}]);
    const search=first.find(e=>e.type==="response.output_item.done"&&e.item?.type==="tool_search_call")?.item;
    assert.ok(search, "search call restores native type");assert.deepEqual(search.arguments,{query:searchQuery,limit:1});
    const input=[{role:"user",content:"Offline app discovery fixture."},search,{type:"tool_search_output",id:"tso_fixture",call_id:search.call_id,execution:"client",status:"completed",tools:[appDefinition]}];
    for(let i=2;i<=4;i++) {
      const events=await post(input);
      if(i===4){assert.ok(events.some(e=>e.type==="response.completed"));break;}
      const call=events.find(e=>e.type==="response.output_item.done"&&e.item?.type==="function_call")?.item;
      assert.ok(call);assert.equal(call.namespace,"mcp__codex_app");assert.equal(call.name,"list_projects");assert.equal(call.arguments,"{}");
      input.push(call,{type:"function_call_output",call_id:call.call_id,output:"OFFLINE_FIXTURE_OK"});
    }
  }
  assert.equal(stage,4);assert.equal(captures.length,4);
  process.stdout.write(`ok ${codexBinary?"installed Codex + fixture MCP":"native-shaped fixture"} search → app call → repeated app call → final through Router, locked LiteLLM, Grok forwarder, mock xAI (4 requests; no provider quota)\n`);
} finally {
  await Promise.all(children.map(stopChild));mockXai.closeAllConnections();if(mockXai.listening)await new Promise(resolve=>mockXai.close(resolve));
  rmSync(workspace,{recursive:true,force:true});
}
