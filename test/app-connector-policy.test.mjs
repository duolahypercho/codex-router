import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { appConnectorPolicy, serviceAppConnectorEnvironment } from "../src/app-connector-policy.mjs";
import { mergeCodexAppTools } from "../src/codex-app-tools.mjs";
import { bridgeCustomTools, buildNamespaceLookups, flattenNamespaceTools,
  flattenNamespacedHistory, flattenToolChoice, flattenToolSearchHistory, rewriteNamespaceResponsePayload,
  ToolSearchHistoryCapacityError } from "../src/namespace-relay.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const settingName = "CODEX_ROUTER_APP_CONNECTORS";
const namespace = "mcp__codex_apps__gmail";
const chosenName = `${namespace}__search`;

function withSetting(value, callback) {
  const prior = process.env[settingName];
  if (value === undefined) delete process.env[settingName];
  else process.env[settingName] = value;
  try { return callback(); }
  finally {
    if (prior === undefined) delete process.env[settingName];
    else process.env[settingName] = prior;
  }
}

test("service connector settings preserve runtime policy without launcher metacharacters", () => {
  for (const [raw, expected] of [[undefined, undefined], ["", undefined], ["   ", undefined],
    ["none", "none"], ["all", "all"], [" GMail, none, Gmail , Airtable ", "gmail,airtable"],
    ["gmail,ALL", "all"], ["unknown-connector", "unknown-connector"]]) {
    const environment = { [settingName]: raw };
    const serialized = serviceAppConnectorEnvironment(environment);
    assert.equal(serialized[settingName], expected);
    assert.equal(appConnectorPolicy(serialized).withhold, appConnectorPolicy(environment).withhold);
    if (appConnectorPolicy(environment).withhold) {
      assert.deepEqual([...appConnectorPolicy(serialized).eager], [...appConnectorPolicy(environment).eager]);
    }
  }
  for (const raw of ["gmail\nset INJECTED=1", "gmail&command", "gmail%EXPAND%", "gmail\"", "gmail|command", "gmail<file", "gmail;command"]) {
    assert.throws(() => serviceAppConnectorEnvironment({ [settingName]: raw }), /connector identifiers/);
  }
});

const choices = [
  { type: "function", name: chosenName },
  { type: "function", namespace, name: "search" },
  { type: "function", namespace, function: { name: "search" } },
  { type: "allowed_tools", mode: "required", tools: [{ type: "function", namespace, name: "search" }] },
];
for (const [label, input] of [["array", []], ["string", "hello"], ["absent", undefined]]) {
  test(`connector choice restoration preserves ${label} input and enforces its tool budget`, () => {
    withSetting("none", () => {
      for (const toolChoice of choices) {
        const flattened = flattenNamespaceTools([
          { type: "function", name: "shell", parameters: { type: "object" } },
          { type: "namespace", name: namespace, tools: [
            { type: "function", name: "search", inputSchema: { type: "object" } },
            { type: "function", name: "unused", inputSchema: { type: "object" } },
          ] },
        ]);
        assert.deepEqual(flattened.tools.map(tool => tool.name), ["shell"]);
        const restored = flattenToolSearchHistory(input, flattened.tools, flattened.namespaces,
          { toolChoice, maxTools: 2 });
        assert.equal(restored.input, input);
        assert.deepEqual(restored.tools.map(tool => tool.name), ["shell", chosenName]);
        const choice = flattenToolChoice(toolChoice, flattened.namespaces);
        const reference = choice.type === "allowed_tools" ? choice.tools[0] : choice;
        assert.equal(reference.function?.name ?? reference.name, chosenName);
        assert.equal(reference.namespace, undefined);
        assert.throws(() => flattenToolSearchHistory(input, flattened.tools, flattened.namespaces,
          { toolChoice, maxTools: 1 }), error => {
          assert.ok(error instanceof ToolSearchHistoryCapacityError);
          assert.equal(error.available, 0);
          assert.equal(error.required, 1);
          return true;
        });
      }
    });
  });
}

test("namespaced custom tools remain callable through deferral and connector withholding", () => {
  for (const policy of [undefined, "none"]) {
    withSetting(policy, () => {
      const flattened = flattenNamespaceTools([
        { type: "tool_search", execution: "client", parameters: { type: "object" } },
        { type: "namespace", name: namespace, defer_loading: true, tools: [
          { type: "custom", name: "raw", defer_loading: true, description: "Pass raw input." },
          { type: "function", name: "unused", inputSchema: { type: "object" } },
        ] },
      ]);
      const custom = flattened.tools.find(tool => tool.type === "custom");
      assert.ok(custom);
      assert.equal(custom.name, `${namespace}__raw`);
      assert.equal(custom.defer_loading, undefined);
      assert.equal(flattened.tools.some(tool => tool.name === `${namespace}__unused`), false);
      const bridged = bridgeCustomTools(flattened.tools, [], flattened.namespaces,
        undefined, [custom.name]);
      const callable = bridged.tools.find(tool => tool.name === custom.name);
      assert.equal(callable.type, "function");
      const restored = rewriteNamespaceResponsePayload({ output: [{ type: "function_call",
        name: callable.name, call_id: "raw-1", arguments: JSON.stringify({ input: "raw bytes\n☃" }) }] },
      buildNamespaceLookups(flattened.namespaces));
      assert.deepEqual(restored.output[0], { type: "custom_tool_call", namespace,
        name: "raw", call_id: "raw-1", input: "raw bytes\n☃" });
    });
  }
});

test("snapshot expansion preserves namespace deferral for unknown client functions", () => {
  withSetting("all", () => {
    const clientTools = [
      { type: "tool_search", execution: "client", parameters: { type: "object" } },
      { type: "namespace", name: "codex_app", defer_loading: true, tools: [
        { type: "function", name: "navigate_to_codex_page", inputSchema: { type: "object", properties: {} } },
        { type: "function", name: "future_client_tool", inputSchema: { type: "object", properties: {} } },
      ] },
    ];
    const original = structuredClone(clientTools);
    const merged = mergeCodexAppTools(clientTools);
    assert.deepEqual(clientTools, original, "snapshot expansion does not mutate client registrations");
    const flattened = flattenNamespaceTools(merged.tools);
    assert.ok(flattened.tools.some(tool => tool.name === "codex_app__navigate_to_codex_page"));
    assert.ok(!flattened.tools.some(tool => tool.name === "codex_app__future_client_tool"));
    const restored = flattenToolSearchHistory("hello", flattened.tools, flattened.namespaces,
      { toolChoice: { type: "function", namespace: "codex_app", name: "future_client_tool" } });
    const callable = restored.tools.find(tool => tool.name === "codex_app__future_client_tool");
    assert.ok(callable);
    assert.equal(callable.defer_loading, undefined);
    assert.deepEqual(callable.parameters, original[1].tools[1].inputSchema);
  });
});

test("plain native identities own raw names that collide with withheld connector aliases", () => {
  withSetting("none", () => {
    for (const deferred of [false, true]) {
      const flattened = flattenNamespaceTools([
        { type: "function", name: "shell", parameters: { type: "object" } },
        { type: "tool_search", execution: "client", parameters: { type: "object" } },
        { type: "namespace", name: namespace, tools: [
          { type: "function", name: "search", inputSchema: { type: "object", properties: { connector: { type: "boolean" } } } },
        ] },
        { type: "function", name: chosenName, defer_loading: deferred,
          parameters: { type: "object", properties: { plain: { type: "boolean" } } } },
      ], { aliasCollisions: true });
      const references = [
        { type: "function", name: chosenName },
        { type: "function", function: { name: chosenName } },
        { type: "allowed_tools", tools: [{ type: "function", name: chosenName }] },
      ];
      const capacity = flattened.tools.length + (deferred ? 1 : 0);
      for (const toolChoice of references) {
        const restored = flattenToolSearchHistory("hello", flattened.tools, flattened.namespaces,
          { toolChoice, maxTools: capacity });
        const plain = restored.tools.find(tool => tool.parameters?.properties?.plain);
        assert.ok(plain);
        assert.ok(!restored.tools.some(tool => tool.parameters?.properties?.connector));
        const choice = flattenToolChoice(toolChoice, flattened.namespaces);
        const reference = choice.type === "allowed_tools" ? choice.tools[0] : choice;
        assert.equal(reference.function?.name ?? reference.name, plain.name);
        assert.equal(restored.tools.length, capacity);
      }
      const history = [{ type: "function_call", name: chosenName, call_id: "plain-owner", arguments: "{}" }];
      const restoredHistory = flattenToolSearchHistory(history, flattened.tools, flattened.namespaces,
        { maxTools: capacity });
      const plain = restoredHistory.tools.find(tool => tool.parameters?.properties?.plain);
      assert.equal(flattenNamespacedHistory(restoredHistory.input, flattened.namespaces)[0].name, plain.name);
      assert.ok(!restoredHistory.tools.some(tool => tool.parameters?.properties?.connector));
      assert.throws(() => flattenToolSearchHistory("hello", flattened.tools, flattened.namespaces,
        { toolChoice: { type: "function", namespace, name: "search" }, maxTools: flattened.tools.length }),
      ToolSearchHistoryCapacityError);
    }
  });
});

test("every service platform carries only safe canonical connector settings", () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "connector-service-render-"));
  try {
    for (const platform of ["linux", "macos", "windows"]) {
      for (const [raw, expected] of [[undefined, undefined], ["none", "none"], [" GMail , AIRTABLE ", "gmail,airtable"], ["all", "all"]]) {
        const environment = { ...process.env, HOME: temporary, CODEX_HOME: path.join(temporary, "codex"),
          MODEL_ROUTER_STATE_DIR: path.join(temporary, "state"), XDG_CONFIG_HOME: path.join(temporary, "xdg"),
          [settingName]: raw };
        const rendered = spawnSync(process.execPath, [`src/service-${platform}.mjs`, "render"],
          { cwd: root, env: environment, encoding: "utf8", timeout: 10_000, windowsHide: true });
        assert.equal(rendered.status, 0, rendered.stderr);
        const line = platform === "linux" ? `Environment="${settingName}=${expected}"`
          : platform === "macos" ? `<key>${settingName}</key>\n    <string>${expected}</string>`
            : `set "${settingName}=${expected}"`;
        if (expected === undefined) assert.equal(rendered.stdout.includes(settingName), false);
        else assert.ok(rendered.stdout.includes(line), platform);
        environment[settingName] = "gmail\nset INJECTED=1";
        const rejected = spawnSync(process.execPath, [`src/service-${platform}.mjs`, "render"],
          { cwd: root, env: environment, encoding: "utf8", timeout: 10_000, windowsHide: true });
        assert.notEqual(rejected.status, 0);
        assert.equal(rejected.stdout, "");
        assert.match(rejected.stderr, /connector identifiers/);
      }
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});

for (const platform of ["linux", "macos", "windows"]) {
  test(`${platform} rejects connector settings before install mutations`, () => {
    const source = readFileSync(path.join(root, "src", `service-${platform}.mjs`), "utf8");
    const marker = '} else if (command === "install") {';
    const start = source.indexOf(marker);
    const end = source.indexOf('} else if (command === "uninstall") {', start);
    assert.ok(start >= 0 && end > start, "extract the actual platform install branch");
    const body = source.slice(start + marker.length, end);
    const runInstall = (setting) => {
      const effects = [];
      const environment = { [settingName]: setting };
      const renderEnvironment = () => serviceAppConnectorEnvironment(environment);
      const writeDefinition = () => {
        effects.push("mkdir");
        renderEnvironment();
        effects.push("write");
      };
      const bindings = {
        serviceAppConnectorEnvironment: renderEnvironment,
        guardPlistWrite() {}, guardLauncherWrite() {},
        writeUnit: writeDefinition, writePlist: writeDefinition, writeLaunchers: writeDefinition,
        resetStartupAttempts: () => effects.push("reset"),
        rotateLog: () => effects.push("rotate"),
        bootout: () => effects.push("stop"), endTask: () => effects.push("stop"),
        bootstrap: () => effects.push("start"), installTask: () => effects.push("register"),
        systemctl: args => effects.push(`systemctl:${args[0]}`),
        schtasks: args => effects.push(`schtasks:${args[0]}`),
        ensureCheckoutReadable: () => effects.push("acl"),
        setTaskEnabled: () => effects.push("enable"),
        existsSync: () => true, taskExists: () => true,
        SOURCE_ROOT: "/fixture", STATE_DIR: "/fixture/state", LOG_PATH: "/fixture/log",
        LAUNCH_AGENT_PATH: "/fixture/agent", unitPath: "/fixture/unit", unitName: "fixture",
        wrapperPath: "/fixture/wrapper", launcherPath: "/fixture/launcher", taskName: "fixture",
        process: { stdout: { write() {} } }, console: { error() {} },
      };
      const execute = new Function(...Object.keys(bindings), body);
      return { effects, execute: () => execute(...Object.values(bindings)) };
    };
    const invalid = runInstall("gmail\nset INJECTED=1");
    assert.throws(invalid.execute, /connector identifiers/);
    assert.deepEqual(invalid.effects, [], "no manager, ACL, directory, cache or file mutation");
    const valid = runInstall("gmail");
    valid.execute();
    assert.ok(valid.effects.includes("write"), "the mutation detector observes a valid install");
    assert.ok(valid.effects.includes("reset"));
  });
}

test("service dispatcher rejects connector settings before its lock, reset and child", async () => {
  let source = readFileSync(path.join(root, "src", "service.mjs"), "utf8");
  const entryPoint = source.indexOf("\nif (process.argv[1] && path.resolve(process.argv[1])");
  assert.ok(entryPoint > 0, "evaluate the actual exported API without its process entry point");
  source = source.slice(0, entryPoint);
  source = source.replace(/^import[\s\S]*?from\s+["'][^"']+["'];\s*$/gm, "")
    .replace(/^export /gm, "");
  assert.doesNotMatch(source, /^import\s/m);
  const load = (setting) => {
    const effects = [];
    const environment = { [settingName]: setting, CODEX_ROUTER_SERVICE_PLATFORM: "darwin" };
    const context = {
      process: { env: environment, argv: [], execPath: process.execPath }, path, fileURLToPath,
      SOURCE_ROOT: "/fixture", environmentProxyOptedIn: () => false,
      serviceAppConnectorEnvironment: () => serviceAppConnectorEnvironment(environment),
      resetStartupAttempts: () => effects.push("reset"),
      withServiceOperationLock: callback => { effects.push("lock"); return callback(); },
      spawnSync: () => { effects.push("child"); return { status: 1 }; },
    };
    runInNewContext(source, context, { timeout: 1000 });
    return { effects, cli: context.runServiceCli, unlocked: context.runServiceCommandUnlocked };
  };
  for (const entry of ["cli", "unlocked"]) {
    const invalid = load("gmail\nset INJECTED=1");
    await assert.rejects(() => entry === "cli" ? invalid.cli(["install"]) : invalid.unlocked("install"),
      /connector identifiers/);
    assert.deepEqual(invalid.effects, []);
    const valid = load("gmail");
    assert.equal(await (entry === "cli" ? valid.cli(["install"]) : valid.unlocked("install")), 1);
    assert.ok(valid.effects.includes("reset"));
    assert.ok(valid.effects.includes("child"));
    assert.equal(valid.effects.includes("lock"), entry === "cli");
  }
});
