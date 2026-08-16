import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  mergeConnectorTools,
  readConnectorToolCatalog,
} from "../src/codex-apps-connectors.mjs";
import { flattenNamespaceTools } from "../src/namespace-relay.mjs";

// One entry in the shape Codex writes to
// `$CODEX_HOME/cache/codex_apps_tools/<hash>.json`.
function cacheEntry(connector, method, extra = {}) {
  return {
    server_name: "codex_apps",
    tool_namespace: `codex_apps__${connector}`,
    namespace_description: `Search and reference your ${connector}.`,
    connector_name: connector,
    tool: {
      name: `${connector}.${method}`,
      description: `${method} on ${connector}`,
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
    ...extra,
  };
}

function cacheDir(tools) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "codex-apps-cache-"));
  writeFileSync(
    path.join(dir, "17b5aa79.json"),
    JSON.stringify({ schema_version: 4, tools }),
    "utf8",
  );
  return dir;
}

// The subset Codex actually sends on a routed request: one tool of the
// connector's many, plus the search control that would have loaded the rest.
function clientRoutedTools() {
  return [
    { type: "tool_search" },
    { type: "function", name: "exec_command" },
    {
      type: "namespace",
      name: "mcp__codex_apps__github",
      tools: [{ type: "function", name: "fetch_issue" }],
    },
  ];
}

test("readConnectorToolCatalog keys namespaces the way a request names them", () => {
  const dir = cacheDir([
    cacheEntry("github", "fetch_issue"),
    cacheEntry("microsoft_outlook_email", "list_messages"),
  ]);
  try {
    const catalog = readConnectorToolCatalog(dir);
    assert.deepEqual(
      [...catalog.keys()].sort(),
      ["mcp__codex_apps__github", "mcp__codex_apps__microsoft_outlook_email"],
    );
    // `<connector>.<method>` is the MCP tool name; the namespace child is the
    // method alone, which is what Codex dispatches.
    const outlook = catalog.get("mcp__codex_apps__microsoft_outlook_email");
    assert.deepEqual([...outlook.tools.keys()], ["list_messages"]);
    assert.equal(outlook.tools.get("list_messages").inputSchema.type, "object");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readConnectorToolCatalog survives a missing or unreadable cache", () => {
  assert.equal(readConnectorToolCatalog("/nonexistent/codex_apps_tools").size, 0);
  const dir = mkdtempSync(path.join(os.tmpdir(), "codex-apps-cache-"));
  try {
    writeFileSync(path.join(dir, "broken.json"), "{not json", "utf8");
    assert.equal(readConnectorToolCatalog(dir).size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unselected connector leaves the request untouched", () => {
  const dir = cacheDir([cacheEntry("github", "fetch_issue"), cacheEntry("github", "list_issues")]);
  try {
    const tools = clientRoutedTools();
    const result = mergeConnectorTools(tools, {
      catalog: readConnectorToolCatalog(dir),
      enabled: [],
    });
    assert.equal(result.merged, false);
    assert.equal(result.tools, tools);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a selected connector regains the tools deferred loading held back", () => {
  const dir = cacheDir([
    cacheEntry("github", "fetch_issue"),
    cacheEntry("github", "list_issues"),
    cacheEntry("github", "create_pull_request"),
    cacheEntry("notion", "search"),
  ]);
  try {
    const result = mergeConnectorTools(clientRoutedTools(), {
      catalog: readConnectorToolCatalog(dir),
      enabled: ["github"],
    });
    assert.equal(result.merged, true);
    const github = result.tools.find((tool) => tool.name === "mcp__codex_apps__github");
    assert.deepEqual(
      github.tools.map((fn) => fn.name).sort(),
      ["create_pull_request", "fetch_issue", "list_issues"],
    );
    // An unselected connector is not merged in, and nothing else moves.
    assert.equal(
      result.tools.some((tool) => tool.name === "mcp__codex_apps__notion"),
      false,
    );
    assert.equal(result.tools.some((tool) => tool.name === "exec_command"), true);
    assert.equal(result.tools.some((tool) => tool?.type === "tool_search"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the client's own definition wins over the cached one", () => {
  const dir = cacheDir([cacheEntry("github", "fetch_issue")]);
  try {
    const clientSchema = { type: "object", properties: { issue: { type: "integer" } } };
    const tools = [
      {
        type: "namespace",
        name: "mcp__codex_apps__github",
        tools: [{ type: "function", name: "fetch_issue", inputSchema: clientSchema }],
      },
    ];
    const result = mergeConnectorTools(tools, {
      catalog: readConnectorToolCatalog(dir),
      enabled: ["github"],
    });
    // Nothing was missing, so the request is returned unchanged rather than
    // rebuilt around the cache's copy.
    assert.equal(result.merged, false);
    assert.equal(result.tools, tools);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a selected connector the client omitted entirely is appended whole", () => {
  const dir = cacheDir([cacheEntry("notion", "search"), cacheEntry("notion", "fetch_page")]);
  try {
    const result = mergeConnectorTools(clientRoutedTools(), {
      catalog: readConnectorToolCatalog(dir),
      enabled: ["mcp__codex_apps__notion"],
    });
    assert.equal(result.merged, true);
    const notion = result.tools.find((tool) => tool.name === "mcp__codex_apps__notion");
    assert.deepEqual(notion.tools.map((fn) => fn.name).sort(), ["fetch_page", "search"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("merged connector tools flatten and restore through the existing relay", () => {
  const dir = cacheDir([cacheEntry("microsoft_outlook_email", "list_messages")]);
  try {
    const merged = mergeConnectorTools(clientRoutedTools(), {
      catalog: readConnectorToolCatalog(dir),
      enabled: ["microsoft_outlook_email"],
    });
    const { tools, namespaces } = flattenNamespaceTools(merged.tools);
    const flat = tools.find(
      (tool) => tool.name === "mcp__codex_apps__microsoft_outlook_email__list_messages",
    );
    // Flattening carries the schema across as `parameters`, which is what the
    // chat-completions bridge reads.
    assert.ok(flat, "the merged tool is flattened for the provider");
    assert.equal(flat.parameters.type, "object");
    // And the namespace inventory records it, so the response transform maps
    // the call back to what Codex dispatches.
    assert.deepEqual(
      [...namespaces.get("mcp__codex_apps__microsoft_outlook_email")],
      ["list_messages"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
