import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import test from "node:test";
import { GrokChatServiceTierTransform, grokChatServiceTierBody } from "../src/grok-service-tier-compat.mjs";

async function transform(chunks) {
  const output = [];
  await pipeline(Readable.from(chunks), new GrokChatServiceTierTransform(), new Writable({
    write(chunk, _encoding, callback) { output.push(chunk); callback(); },
  }));
  return Buffer.concat(output);
}

test("Grok Chat compatibility carries only reported default/priority or bounded unknown metadata", () => {
  for (const [reported, expected] of [["priority", "priority"], [" default ", "default"], ["future-tier", "unknown"], [7, "unknown"]]) {
    const payload = { choices: [], service_tier: reported, provider_specific_fields: { retained: 42 } };
    const actual = grokChatServiceTierBody(Buffer.from(JSON.stringify(payload)));
    const result = JSON.parse(actual.body);
    assert.equal(actual.serviceTier, expected);
    assert.deepEqual(result.provider_specific_fields, { retained: 42, grok_service_tier: expected });
    assert.equal(result.service_tier, expected === "unknown" ? undefined : expected);
  }
});

test("missing/ambiguous/non-Chat Grok tier metadata leaves response bytes unchanged", () => {
  for (const raw of [
    '{"choices":[],"service_tier":null}', '{"choices":[]}',
    '{"choices":[],"service_tier":""}', '{"error":{"message":"failed"},"service_tier":"priority"}',
    '{"choices":[],"service_tier":"default","service_tier":"priority"}',
    '{"choices":[],"service_tier":"priority","value":9007199254740993}',
    '{"choices":[],"service_tier":"priority","value":1e-1000}', '[{"service_tier":"priority"}]', 'not-json',
  ]) {
    const body = Buffer.from(raw);
    assert.deepEqual(grokChatServiceTierBody(body), { body });
  }
  const body = Buffer.from([0xff]);
  assert.deepEqual(grokChatServiceTierBody(body), { body });
});

test("Grok SSE tier metadata survives byte-split unicode, CRLF and multiline data", async () => {
  const first = 'data: {"choices":[{"delta":{"content":"Привет"}}]}\r\n\r\n';
  const final = 'event: completion\r\ndata: {"choices": [],\r\ndata: "service_tier": "priority"}\r\n\r\n';
  const done = 'data: [DONE]\r\n\r\n';
  const bytes = Buffer.from(first + final + done);
  const output = (await transform([...bytes].map(byte => Buffer.from([byte])))).toString();
  assert.ok(output.startsWith(first), "chunks without tier metadata remain byte-identical");
  assert.ok(output.endsWith(done));
  assert.match(output, /event: completion\r\n/);
  const payload = JSON.parse(output.split("\r\n\r\n")[1].split("\r\n").find(line => line.startsWith("data:")).slice(5));
  assert.deepEqual(payload.provider_specific_fields, { grok_service_tier: "priority" });
});

test("Grok SSE preserves malformed and oversized events, then resumes bounded metadata parsing", async () => {
  const large = Buffer.from(`data: ${"x".repeat(4 * 1024 * 1024 + 10)}\n\n`);
  const invalid = Buffer.from('data: {"choices":[],"service_tier":"priority","service_tier":"default"}\n\n');
  const valid = Buffer.from('data: {"choices":[],"service_tier":"default"}\n\n');
  const chunks = [];
  for (let offset = 0; offset < large.length; offset += 65536) chunks.push(large.subarray(offset, offset + 65536));
  chunks.push(invalid, valid);
  const output = await transform(chunks);
  assert.ok(output.subarray(0, large.length).equals(large));
  assert.ok(output.subarray(large.length, large.length + invalid.length).equals(invalid));
  assert.equal(JSON.parse(output.subarray(large.length + invalid.length).toString().slice(5)).provider_specific_fields.grok_service_tier, "default");
});
