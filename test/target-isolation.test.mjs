import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function pathsForTarget(target) {
  return execFileSync(
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
}

test("codex owns the default port block", () => {
  assert.deepEqual(JSON.parse(pathsForTarget("codex")), {
    gateway: 4200,
    oauth: 4201,
    router: 4202,
    api: 4203,
    grokOauth: 4208,
    devinCli: 4210,
  });
});

test("operators can keep an explicitly configured legacy block during migration", () => {
  const ports = JSON.parse(
    execFileSync(
      process.execPath,
      ["--input-type=module", "--eval", 'import { PORTS } from "./src/paths.mjs"; process.stdout.write(JSON.stringify(PORTS));'],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          MODEL_ROUTER_TARGET: "codex",
          MODEL_ROUTER_GATEWAY_PORT: "4100",
          MODEL_ROUTER_OAUTH_PORT: "4101",
          MODEL_ROUTER_PORT: "4102",
          MODEL_ROUTER_API_PORT: "4103",
          MODEL_ROUTER_GROK_OAUTH_PORT: "4108",
        },
      },
    ),
  );
  // The Devin CLI forwarder postdates the legacy block, so an operator
  // migrating from it never pinned that port and keeps the current default.
  assert.deepEqual(ports, {
    gateway: 4100,
    oauth: 4101,
    router: 4102,
    api: 4103,
    grokOauth: 4108,
    devinCli: 4210,
  });
});

test("removed targets are rejected rather than silently mapped to codex", () => {
  for (const target of ["cursor", "opencode"]) {
    assert.throws(
      () => pathsForTarget(target),
      /MODEL_ROUTER_TARGET must be one of/,
      `${target} should no longer be a valid target`,
    );
  }
});
