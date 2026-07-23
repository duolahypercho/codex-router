import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "codex-router-alias-"));
process.env.MODEL_ROUTER_STATE_DIR = stateDir;

const { buildNativeAliasAssignments, nativeAliasFor, readNativeAliases } = await import(
  "../src/native-alias.mjs"
);
const { NATIVE_ALIAS_PATH } = await import("../src/paths.mjs");

test.after(() => rmSync(stateDir, { recursive: true, force: true }));

test("assignments pair listed native slots with external models by priority", () => {
  const native = [
    { slug: "codex-auto-review", visibility: "hide", priority: 1 },
    { slug: "gpt-5.4", visibility: "list", priority: 20 },
    { slug: "gpt-5.5", visibility: "list", priority: 10 },
  ];
  const external = [{ slug: "kimi-oauth/k3" }, { slug: "grok-oauth/grok-4.5" }, { slug: "extra/model" }];
  const assignments = buildNativeAliasAssignments(native, external);
  assert.deepEqual(
    assignments.map(({ nativeModel, model }) => [nativeModel.slug, model.slug]),
    [
      ["gpt-5.5", "kimi-oauth/k3"],
      ["gpt-5.4", "grok-oauth/grok-4.5"],
    ],
  );
});

test("alias reads tolerate a missing or invalid state file", () => {
  assert.deepEqual(readNativeAliases(), {});
  writeFileSync(NATIVE_ALIAS_PATH, "not json", { mode: 0o600 });
  assert.deepEqual(readNativeAliases(), {});
  writeFileSync(NATIVE_ALIAS_PATH, `${JSON.stringify({ version: 2, aliases: { a: "b" } })}\n`, {
    mode: 0o600,
  });
  assert.deepEqual(readNativeAliases(), {});
});

test("alias reads pick up rewritten state and reverse lookups resolve", () => {
  writeFileSync(
    NATIVE_ALIAS_PATH,
    `${JSON.stringify({ version: 1, aliases: { "gpt-5.5": "kimi-oauth/k3" } })}\n`,
    { mode: 0o600 },
  );
  assert.deepEqual(readNativeAliases(), { "gpt-5.5": "kimi-oauth/k3" });
  assert.equal(nativeAliasFor("kimi-oauth/k3"), "gpt-5.5");
  assert.equal(nativeAliasFor("grok-oauth/grok-4.5"), undefined);
});
