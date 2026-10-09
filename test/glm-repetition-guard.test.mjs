import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { GlmRepetitionGuard, glmRepetitionGuardTransform, hasSustainedProseRepetition,
  REPETITIVE_GENERATION_CODE } from "../src/glm-repetition-guard.mjs";
import { userModelEntry } from "../src/user-models.mjs";

const phrase = "The same sentence is being repeated without progress. ";
const loop = phrase.repeat(220);
const frame = (event, newline = "\n") => `event: ${event.type}${newline}data: ${JSON.stringify(event)}${newline}${newline}`;
const delta = (text, item = "message_1", index = 0) => frame({ type: "response.output_text.delta", item_id: item, content_index: index, delta: text });
async function observe(chunks) {
  const output = [];
  await pipeline(Readable.from(chunks), new GlmRepetitionGuard(), new Writable({
    write(chunk, _encoding, callback) { output.push(Buffer.from(chunk)); callback(); },
  }));
  return Buffer.concat(output);
}
const rejected = (chunks) => assert.rejects(observe(chunks), (error) => error.code === REPETITIVE_GENERATION_CODE && error.status === 400);

test("requires explicit opt-in, GLM-5.3 family and an SSE response", () => {
  for (const flag of [undefined, false, "true", 1]) {
    assert.equal(glmRepetitionGuardTransform({ upstreamModel: "glm-5.3", repetitionGuard: flag }, "text/event-stream"), undefined);
  }
  for (const id of ["glm-5.3", "glm-5.3-flash", "vendor/GLM-5.3:fast"]) {
    const guard = glmRepetitionGuardTransform({ upstreamModel: id, repetitionGuard: true }, "text/event-stream; charset=utf-8");
    assert.ok(guard instanceof GlmRepetitionGuard); guard.destroy();
  }
  for (const id of ["glm-5.30", "glm-5", "gpt-6.1-sol", "other-glm-5.3"]) {
    assert.equal(glmRepetitionGuardTransform({ upstreamModel: id, repetitionGuard: true }, "text/event-stream"), undefined);
  }
  assert.equal(glmRepetitionGuardTransform({ upstreamModel: "glm-5.3", repetitionGuard: true }, "application/json"), undefined);
  assert.equal(glmRepetitionGuardTransform(undefined, "text/event-stream"), undefined);
});

test("detects sustained whole prose units rather than low character diversity", () => {
  assert.equal(hasSustainedProseRepetition(loop), true);
  assert.equal(hasSustainedProseRepetition("目前没有取得任何新的进展，我会继续检查这个问题。".repeat(400)), true);
  assert.equal(hasSustainedProseRepetition(phrase.repeat(20)), false);
  assert.equal(hasSustainedProseRepetition("a".repeat(15000)), false);
  assert.equal(hasSustainedProseRepetition(Array.from({ length: 700 }, (_, i) => `Record ${i}: completed successfully. `).join("")), false);
});

test("detects one large delta and accumulation at arbitrary text boundaries", async () => {
  await rejected([delta(loop)]);
  await rejected(Array.from({ length: Math.ceil(loop.length / 137) }, (_, i) => delta(loop.slice(i * 137, (i + 1) * 137))));
  await rejected(Array.from({ length: loop.length }, (_, i) => delta(loop[i])));
});

test("JSON fixtures, strings and fenced code remain valid after openings leave the tail", async () => {
  for (const text of [
    JSON.stringify(Array.from({ length: 1000 }, () => ({ ok: true, message: phrase }))),
    JSON.stringify(loop), " ".repeat(500) + JSON.stringify(loop),
    "Example:\n```text\n" + loop + "\n```", "Example:\n~~~text\n" + loop + "\n~~~",
  ]) {
    assert.equal(hasSustainedProseRepetition(text), false);
    const chunks = Array.from({ length: Math.ceil(text.length / 71) }, (_, i) => delta(text.slice(i * 71, (i + 1) * 71)));
    const expected = Buffer.from(chunks.join(""));
    assert.deepEqual(await observe(chunks), expected);
  }
  const splitFence = [delta("Example: `"), delta("`"), delta("`text\n"), delta(loop), delta("\n```")];
  assert.deepEqual(await observe(splitFence), Buffer.from(splitFence.join("")));
});

test("reasoning, refusal and tool payloads are excluded", async () => {
  const chunks = [
    frame({ type: "response.reasoning_text.delta", delta: loop }),
    frame({ type: "response.refusal.done", refusal: loop }),
    frame({ type: "response.function_call_arguments.delta", delta: loop }),
    frame({ type: "response.output_item.done", item: { type: "function_call", arguments: loop } }),
    frame({ type: "response.completed", response: { output: [{ type: "message", content: [{ type: "refusal", refusal: loop }] }] } }),
  ];
  assert.deepEqual(await observe(chunks), Buffer.from(chunks.join("")));
});

for (const [name, event] of [
  ["text done", { type: "response.output_text.done", text: loop }],
  ["part done", { type: "response.content_part.done", part: { type: "output_text", text: loop } }],
  ["item done", { type: "response.output_item.done", item: { type: "message", role: "assistant", content: [{ type: "output_text", text: loop }] } }],
  ["completed snapshot", { type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", text: loop }] }] } }],
]) test(`detects repetition supplied only in ${name}`, async () => rejected([frame(event)]));

test("does not accumulate separate message/content parts or a subsequent response", async () => {
  const short = phrase.repeat(45);
  const chunks = [delta(short, "a", 0), delta(short, "a", 1), delta(short, "b", 0),
    frame({ type: "response.completed", response: { output: [] } }), delta(short, "a", 0)];
  assert.deepEqual(await observe(chunks), Buffer.from(chunks.join("")));
  const tooLongId = [delta(loop, "x".repeat(10000))];
  assert.deepEqual(await observe(tooLongId), Buffer.from(tooLongId.join("")));
});

test("healthy SSE forwards exact UTF-8 bytes, CRLF, comments and multiline data", async () => {
  const source = Buffer.from(": keepalive\r\n\r\n" + frame({ type: "response.output_text.delta", delta: "正常内容😀" }, "\r\n") +
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta",\ndata: "delta":"More content."}\n\n');
  assert.deepEqual(await observe(Array.from(source, (_, i) => source.subarray(i, i + 1))), source);
});

test("malformed and oversized frames pass through and parsing recovers afterwards", async () => {
  const oversize = "data: " + "x".repeat(1100000) + "\n\n";
  const chunks = ["data: {not-json}\n\n", oversize.slice(0, 600000), oversize.slice(600000), delta("A normal answer.")];
  assert.deepEqual(await observe(chunks), Buffer.from(chunks.join("")));
  await rejected([...chunks, delta(loop)]);
});

test("a large unfinished frame fragmented into single bytes remains bounded and recovers", async () => {
  const source = Buffer.from("data: " + "x".repeat(320000) + "\r\n\r\n");
  function* bytes() { for (let index = 0; index < source.length; index++) yield source.subarray(index, index + 1); }
  assert.deepEqual(await observe(bytes()), source);
  function* recover() { yield* bytes(); yield delta(loop); }
  await rejected(recover());
});

test("curation retains the optional repetition metadata", () => {
  const entry = userModelEntry({ providerId: "fixture", upstreamId: "glm-5.3", metadata: { repetitionGuard: true } });
  assert.equal(entry.repetitionGuard, true);
  assert.equal(userModelEntry({ providerId: "fixture", upstreamId: "glm-5.3" }).repetitionGuard, undefined);
});

test("registry validates opt-in booleans and never enables an omitted flag", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "repetition-registry-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const registryPath = path.join(dir, "registry.json");
  const entry = { ...userModelEntry({ providerId: "custom", upstreamId: "glm-5.3", priority: 1 }),
    endpoint: { baseUrl: "http://127.0.0.1:9999/v1", keyless: true } };
  for (const flag of [undefined, true, false, "true", 1, null, {}]) {
    writeFileSync(registryPath, JSON.stringify({ version: 1, providers: [{ id: "custom", displayName: "Custom",
      kind: "openai-compatible", ownedBy: "custom", authMode: "per-model", perModelEndpoint: true }],
      models: [{ ...entry, repetitionGuard: flag }] }));
    const result = spawnSync(process.execPath, ["--input-type=module", "-e",
      "const { MODEL_BY_SLUG } = await import('./src/model-registry.mjs'); console.log(JSON.stringify(MODEL_BY_SLUG.get('custom/glm-5.3')));"], {
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), encoding: "utf8",
      env: { ...process.env, MODEL_ROUTER_REGISTRY: registryPath, MODEL_ROUTER_STATE_DIR: dir,
        CODEX_HOME: path.join(dir, "codex"), MODEL_ROUTER_USER_MODELS: path.join(dir, "absent.json") },
    });
    if (flag === undefined || typeof flag === "boolean") {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).repetitionGuard, flag);
    } else {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /invalid repetitionGuard flag/);
    }
  }
});
