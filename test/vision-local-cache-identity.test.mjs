import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

test("local image evidence follows the actual endpoint and model while unchanged reads cache", async () => {
  const source = await readFile(new URL("../src/router.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async function visionEvidenceFor(");
  const end = source.indexOf("async function readVisionEvidence(", start);
  assert.ok(start >= 0 && end > start);
  const cache = new Map();
  let requests = 0;
  const read = vm.runInNewContext(`${source.slice(start, end)}\nvisionEvidenceFor`, {
    evidenceCache: cache, visionReadsInFlight: new Map(),
    cachedVisionFailure: () => undefined, rememberVisionFailure() {},
    providerCooldown: () => undefined, cooldownScope: x => x,
    visionEngineProvider: () => "local",
    readVisionEvidence: async ({ engine, key }) => {
      requests += 1;
      const text = `${engine.baseUrl}/${engine.gatewayModel}`;
      cache.set(key, text);
      return text;
    },
  });
  const image = "data:image/png;base64,AAAA";
  const engine = { slug: "local", local: true, gatewayModel: "reader-a", baseUrl: "http://first/v1" };
  assert.equal(await read(image, engine), "http://first/v1/reader-a");
  assert.equal(await read(image, engine), "http://first/v1/reader-a");
  assert.equal(requests, 1);
  assert.equal(await read(image, { ...engine, gatewayModel: "reader-b" }), "http://first/v1/reader-b");
  assert.equal(await read(image, { ...engine, baseUrl: "http://second/v1" }), "http://second/v1/reader-a");
  assert.equal(requests, 3);
});
