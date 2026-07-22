import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function portsForTarget(target) {
  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'import { PORTS } from "./src/paths.mjs"; process.stdout.write(JSON.stringify(PORTS));',
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        MODEL_ROUTER_TARGET: target,
        MODEL_ROUTER_GATEWAY_PORT: "",
        MODEL_ROUTER_OAUTH_PORT: "",
        MODEL_ROUTER_PORT: "",
        MODEL_ROUTER_API_PORT: "",
        MODEL_ROUTER_GROK_OAUTH_PORT: "",
      },
    },
  );
  return JSON.parse(output);
}

test("Cursor path defaults are its own dedicated ports", () => {
  assert.deepEqual(portsForTarget("cursor"), {
    gateway: 4105,
    oauth: 4106,
    router: 4104,
    api: 4107,
    grokOauth: 4116,
  });
});

test("every target's five ports are pairwise disjoint across all targets", () => {
  const targets = ["codex", "cursor"];
  const seen = new Map();
  for (const target of targets) {
    for (const value of Object.values(portsForTarget(target))) {
      assert.ok(
        !seen.has(value),
        `port ${value} is shared by ${seen.get(value)} and ${target}`,
      );
      seen.set(value, target);
    }
  }
});
