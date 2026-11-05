import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "codex-router-alias-"));
process.env.MODEL_ROUTER_STATE_DIR = stateDir;

const { buildNativeAliasAssignments, nativeAliasFor, readNativeAliases, readNativeAliasSnapshot, resolveNativeAliasRoute } = await import(
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
  const { assignments } = buildNativeAliasAssignments(native, external);
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

test("alias reads see a same-size rewrite made within one clock tick", () => {
  const write = (target) =>
    writeFileSync(
      NATIVE_ALIAS_PATH,
      `${JSON.stringify({ version: 1, aliases: { "gpt-5.5": target } })}\n`,
      { mode: 0o600 },
    );
  write("kimi-oauth/k3");
  assert.deepEqual(readNativeAliases(), { "gpt-5.5": "kimi-oauth/k3" });
  // Same byte length as the first write, so only a sub-millisecond mtime
  // difference distinguishes the two revisions.
  write("kimi-oauth/k9");
  assert.deepEqual(readNativeAliases(), { "gpt-5.5": "kimi-oauth/k9" });
});

test("alias snapshot routes use one read and distinguish withdrawal from native mode", () => {
  writeFileSync(NATIVE_ALIAS_PATH, JSON.stringify({ version: 1, mode: "login-free",
    aliases: { slot1: "custom/a" }, bindings: { slot1: "custom/a", slot2: "custom/b" } }));
  const snapshot = readNativeAliasSnapshot();
  const route = { slug: "custom/a" };
  assert.deepEqual(resolveNativeAliasRoute("slot1", snapshot, () => route), { kind: "active", target: "custom/a", route });
  assert.deepEqual(resolveNativeAliasRoute("slot1", snapshot, () => undefined), { kind: "withdrawn", target: "custom/a" });
  assert.deepEqual(resolveNativeAliasRoute("slot2", snapshot, () => assert.fail("withdrawn target must not resolve")), { kind: "withdrawn", target: "custom/b" });
  writeFileSync(NATIVE_ALIAS_PATH, "not json");
  assert.equal(resolveNativeAliasRoute("slot1", snapshot, () => route).target, "custom/a", "a request retains its read snapshot");
  assert.throws(readNativeAliasSnapshot, /unreadable/);
  assert.equal(resolveNativeAliasRoute("slot1", { ...snapshot, mode: "native", aliases: {} }, () => assert.fail("native must pass through")).kind, "native");
});

test("bindings survive native-slot priority and availability changes", () => {
  const native = ["slot-a", "slot-b", "slot-c"].map((slug, priority) => ({ slug, priority, visibility: "list" }));
  const models = ["custom/a", "custom/b"].map((slug) => ({ slug }));
  const first = buildNativeAliasAssignments(native, models);
  const reordered = buildNativeAliasAssignments([...native].reverse().map((slot, priority) => ({ ...slot, priority })), [...models].reverse(), first.bindings);
  assert.deepEqual(reordered.bindings, first.bindings);
  assert.deepEqual(Object.fromEntries(reordered.assignments.map(({ nativeModel, model }) => [nativeModel.slug, model.slug])), first.bindings);
  const unavailable = buildNativeAliasAssignments(native.map((slot) => slot.slug === "slot-a" ? { ...slot, visibility: "hide" } : slot), [...models, { slug: "custom/c" }], first.bindings);
  assert.equal(unavailable.bindings["slot-a"], "custom/a");
  assert.equal(unavailable.bindings["slot-c"], "custom/c");
  assert.ok(!unavailable.assignments.some(({ model }) => model.slug === "custom/a"));
  const restored = buildNativeAliasAssignments(native, models, unavailable.bindings);
  assert.equal(restored.assignments.find(({ model }) => model.slug === "custom/a").nativeModel.slug, "slot-a");
});
