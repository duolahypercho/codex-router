import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { userModelEntry } from "../src/user-models.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureBase = process.env.CODEX_HOME || os.tmpdir();

function model(provider, id, extra = {}) {
  return { ...userModelEntry({ providerId: provider, upstreamId: id, priority: 1 }), ...extra };
}

function apiProvider(id, protocol = "openai") {
  return { id, kind: "openai-compatible", displayName: id, ownedBy: "fixture", protocol,
    baseUrl: "https://fixture.example.test/v1",
    credential: { file: `${id}.secret`, environment: ["FIXTURE_UNUSED_KEY"] } };
}

function fixture({ providers = [], models = [], selected = [], generic, userModels } = {}) {
  const directory = mkdtempSync(path.join(fixtureBase, "runtime-dependencies-"));
  const home = path.join(directory, "codex");
  const state = path.join(directory, "state");
  mkdirSync(home, { recursive: true });
  mkdirSync(state, { recursive: true });
  const registry = path.join(directory, "registry.json");
  writeFileSync(registry, JSON.stringify({ version: 1, providers, models }));
  if (selected !== null) writeFileSync(path.join(state, "enabled-providers.json"),
    JSON.stringify({ version: 1, providers: selected }));
  if (generic) writeFileSync(path.join(state, "generic-providers.json"),
    JSON.stringify({ version: 1, providers: generic }));
  if (userModels) writeFileSync(path.join(state, "user-models.json"),
    JSON.stringify({ version: 1, models: userModels }));
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(MODEL_ROUTER_|CODEX_ROUTER_|KIMI_|GROK_|GOOGLE_|GCLOUD_)/.test(name) || /(?:_API_KEY|_TOKEN)$/.test(name)) {
      delete env[name];
    }
  }
  Object.assign(env, {
    HOME: directory, USERPROFILE: directory, APPDATA: path.join(directory, "appdata"),
    LOCALAPPDATA: path.join(directory, "localappdata"), CODEX_HOME: home,
    MODEL_ROUTER_STATE_DIR: state, CODEX_ROUTER_STATE_DIR: state,
    MODEL_ROUTER_REGISTRY: registry, CODEX_ROUTER_NO_DISCOVERY: "1",
  });
  // A synthetic path alone is insufficient if a forgotten alias wins. Assert
  // the roots that the child will use before it can import any state reader.
  for (const name of ["CODEX_HOME", "MODEL_ROUTER_STATE_DIR", "CODEX_ROUTER_STATE_DIR", "MODEL_ROUTER_REGISTRY"]) {
    const relative = path.relative(directory, env[name]);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), name);
  }
  return { directory, env };
}

function requirements(options, args = []) {
  const staged = fixture(options);
  try {
    const result = spawnSync(process.execPath, ["src/runtime-dependency-requirements.mjs", ...args], {
      cwd: root, env: staged.env, encoding: "utf8", timeout: 20_000,
    });
    assert.equal(result.status, 0, result.stderr);
    return args.length ? result.stdout.trim() : JSON.parse(result.stdout);
  } finally {
    rmSync(staged.directory, { recursive: true, force: true });
  }
}

test("native-only selection needs no Python despite other registry providers", () => {
  const providers = [apiProvider("unused-chat")];
  assert.deepEqual(requirements({ providers, models: [model("unused-chat", "a")] }),
    { needsGateway: false, services: [] });
});

test("per-model Responses protocol avoids gateway without credential readiness", () => {
  const custom = { id: "custom", kind: "openai-compatible", displayName: "Custom",
    ownedBy: "fixture", perModelEndpoint: true, authMode: "per-model" };
  const endpoint = { protocol: "openai-responses", baseUrl: "https://fixture.example.test/v1",
    credential: { file: "missing-synthetic-key.secret", environment: ["FIXTURE_UNUSED_KEY"] } };
  const options = { providers: [custom], selected: ["custom"], models: [
    model("custom", "glm-5.3", { endpoint }),
    model("custom", "grok-4.6", { endpoint }),
  ] };
  assert.deepEqual(requirements(options), { needsGateway: false, services: ["api"] });
  assert.equal(requirements(options, ["--gateway-required"]), "unused");
});

test("selected hidden vision Chat route still provisions the gateway", () => {
  const options = { providers: [apiProvider("fixture-responses", "openai-responses"), apiProvider("fixture-chat")],
    selected: ["fixture-responses", "fixture-chat"], models: [
      model("fixture-responses", "main"),
      model("fixture-chat", "vision", { listed: false, inputModalities: ["text", "image"] }),
    ] };
  assert.deepEqual(requirements(options), { needsGateway: true, services: ["api", "gateway"] });
});

test("canonical parent selection includes an Anthropic protocol variant", () => {
  const parent = apiProvider("fixture-family", "openai-responses");
  const variant = { ...apiProvider("fixture-messages", "anthropic"), variantOf: parent.id,
    credential: parent.credential };
  assert.equal(requirements({ providers: [parent, variant], selected: [parent.id],
    models: [model(parent.id, "a"), model(variant.id, "b")] }).needsGateway, true);
});

test("enabled generic Chat routes override empty built-in selection; disabled ones do not", () => {
  const generic = { id: "fixture-generic", displayName: "Fixture", baseUrl: "https://generic.example.test/v1",
    adapter: "openai-chat", enabled: true, allowPrivate: false,
    credentialRef: "cred_fixture_missing_key_001" };
  const options = { generic: [generic], userModels: [model(generic.id, "vision", { listed: false })] };
  assert.equal(requirements(options).needsGateway, true);
  assert.deepEqual(requirements({ ...options, generic: [{ ...generic, enabled: false }] }),
    { needsGateway: false, services: [] });
  assert.deepEqual(requirements({ ...options, generic: [{ ...generic, adapter: "openai-responses" }] }),
    { needsGateway: false, services: ["api"] });
});

test("legacy missing selection retains all requestable gateway dependencies", () => {
  assert.equal(requirements({ selected: null, providers: [apiProvider("fixture-chat")],
    models: [model("fixture-chat", "hidden", { listed: false })] }).needsGateway, true);
});

test("selected OAuth and Ollama routes preserve their gateway requirement", () => {
  const providers = [
    { id: "kimi-oauth", displayName: "Fixture Kimi", ownedBy: "fixture", kind: "oauth", proxyBaseEnv: "FIXTURE_KIMI_PROXY" },
    { id: "ollama", displayName: "Fixture Ollama", ownedBy: "fixture", kind: "openai-compatible", keyless: true,
      transport: "ollama", baseUrl: "http://127.0.0.1:11434/v1" },
  ];
  const models = [model("kimi-oauth", "k"), model("ollama", "o")];
  assert.deepEqual(requirements({ providers, models, selected: providers.map((p) => p.id) }),
    { needsGateway: true, services: ["gateway", "kimi", "ollama"] });
});

test("pending Antigravity proof gets its adoption listener before enablement; gateway queries do not inspect it", () => {
  const provider = { id: "antigravity-oauth", displayName: "Fixture Antigravity", ownedBy: "fixture",
    kind: "oauth", proxyBaseEnv: "FIXTURE_ANTIGRAVITY_PROXY" };
  const staged = fixture({ providers: [provider], selected: [provider.id] });
  try {
    // This is the one credential-discovery fixture: all roots are asserted
    // synthetic above, and the only provider is the synthetic proof below.
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import fs from "node:fs";
      import path from "node:path";
      import {syncBuiltinESMExports} from "node:module";
      import {writePrivateJson} from "./src/file-security.mjs";
      import {runtimeDependencyRequirements} from "./src/runtime-dependency-requirements.mjs";
      const token = path.join(process.env.MODEL_ROUTER_STATE_DIR,"antigravity-oauth.json");
      writePrivateJson(token, {
        version:3,managed_by:"codex-router",session_generation:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        client_id:"operator-owned.apps.googleusercontent.com",client_secret:"synthetic-client-secret",
        access_token:"synthetic-access",refresh_token:"synthetic-refresh",expires_at:2000000000,expires_in:3600,
        project_id:"fixture-project",project_source:"managed",probe_version:1,probe_verified_at:1700000000000,
        probe_model:"gemini-3.1-pro",probe_activation:{version:1,state:"pending_activation",
          generation:"11111111-1111-4111-8111-111111111111"}
      });
      let reads=0;
      for (const method of ["readFileSync","openSync"]) {
        const original=fs[method];
        fs[method]=function(file,...args) {
          if (typeof file==="string" && path.resolve(file)===token) reads++;
          return original.call(this,file,...args);
        };
      }
      syncBuiltinESMExports();
      const selected=runtimeDependencyRequirements();
      const selectedReads=reads;
      fs.writeFileSync(path.join(process.env.MODEL_ROUTER_STATE_DIR,"enabled-providers.json"),
        JSON.stringify({version:1,providers:[]}));
      reads=0;
      const unselected=runtimeDependencyRequirements();
      const unselectedReads=reads;
      reads=0;
      const gatewayOnly=runtimeDependencyRequirements({includePendingActivation:false});
      const gatewayOnlyReads=reads;
      fs.writeFileSync(path.join(process.env.MODEL_ROUTER_STATE_DIR,"antigravity-oauth.json"),
        JSON.stringify({...JSON.parse(fs.readFileSync(token,"utf8")),probe_activation:{version:1,state:"active",
          generation:"11111111-1111-4111-8111-111111111111"}}));
      const ordinaryUnselected=runtimeDependencyRequirements();
      process.stdout.write(JSON.stringify({selected:selected.services,needsGateway:selected.needsGateway,
        selectedReads,unselected:unselected.services,unselectedReads,gatewayOnly:gatewayOnly.services,
        gatewayOnlyReads,ordinaryUnselected:ordinaryUnselected.services}));
    `], { cwd: root, env: { ...staged.env, CODEX_ROUTER_NO_DISCOVERY: "0" }, encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    assert.deepEqual(value.selected, ["antigravity"]);
    assert.equal(value.needsGateway, false);
    assert.ok(value.selectedReads > 0, "selected proof must exercise the credential read positive control");
    assert.deepEqual(value.unselected, ["antigravity"]);
    assert.ok(value.unselectedReads > 0, "pending adoption must inspect the protected proof before enablement");
    assert.deepEqual(value.gatewayOnly, []);
    assert.equal(value.gatewayOnlyReads, 0);
    assert.deepEqual(value.ordinaryUnselected, []);
    const preload = path.join(staged.directory, "credential-read-probe.mjs");
    const readLog = path.join(staged.directory, "credential-reads.log");
    const token = path.join(staged.env.MODEL_ROUTER_STATE_DIR, "antigravity-oauth.json");
    writeFileSync(preload, `
      import fs from "node:fs";
      import path from "node:path";
      import {syncBuiltinESMExports} from "node:module";
      const watched=${JSON.stringify(token)},log=${JSON.stringify(readLog)};
      for(const method of ["readFileSync","openSync"]){
        const original=fs[method];
        fs[method]=function(file,...args){
          if(typeof file==="string"&&path.resolve(file)===watched)fs.appendFileSync(log,"read\\n");
          return original.call(this,file,...args);
        };
      }
      syncBuiltinESMExports();
    `);
    const run = (args) => spawnSync(process.execPath, ["--import", pathToFileURL(preload).href,
      "src/runtime-dependency-requirements.mjs", ...args], {
      cwd: root, env: { ...staged.env, CODEX_ROUTER_NO_DISCOVERY: "0" }, encoding: "utf8", timeout: 20_000,
    });
    const adoption = run([]);
    assert.equal(adoption.status, 0, adoption.stderr);
    assert.ok(existsSync(readLog), "adoption CLI must exercise the credential read detector");
    rmSync(readLog);
    const gateway = run(["--gateway-required"]);
    assert.equal(gateway.status, 0, gateway.stderr);
    assert.equal(gateway.stdout.trim(), "unused");
    assert.equal(existsSync(readLog), false, "gateway-only CLI must not read an unselected OAuth record");
  } finally {
    rmSync(staged.directory, { recursive: true, force: true });
  }
});
