import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "vision-download-test-"));
process.env.CODEX_ROUTER_STATE_DIR = stateDir;

const {
  VISION_DOWNLOAD_STATE_PATH,
  createProgressTracker,
  parseNdjsonLines,
  readVisionDownload,
  streamOllamaPull,
  writeVisionDownload,
} = await import("../src/vision-download.mjs");

function ndjsonResponse(events) {
  const body = Readable.from(
    events.map((event) => Buffer.from(`${JSON.stringify(event)}\n`, "utf8")),
  );
  return { ok: true, status: 200, body };
}

test("progress sums every layer so it only moves forward", () => {
  const tracker = createProgressTracker();
  // One layer half done.
  assert.equal(tracker.update({ digest: "a", completed: 50, total: 100 }), 50);
  // A second layer starting must not drop the overall number to zero.
  assert.equal(tracker.update({ digest: "b", completed: 0, total: 100 }), 25);
  assert.equal(tracker.update({ digest: "b", completed: 100, total: 100 }), 75);
  assert.equal(tracker.update({ digest: "a", completed: 100, total: 100 }), 100);
  // Status-only events carry no totals and report nothing.
  assert.equal(tracker.update({ status: "verifying sha256 digest" }), undefined);
});

test("ndjson parsing keeps a partial trailing line for the next chunk", () => {
  const first = parseNdjsonLines('{"status":"a"}\n{"status":"b"}\n{"stat');
  assert.deepEqual(first.events.map((e) => e.status), ["a", "b"]);
  assert.equal(first.remainder, '{"stat');
  const second = parseNdjsonLines(`${first.remainder}us":"c"}\n`);
  assert.deepEqual(second.events.map((e) => e.status), ["c"]);
});

test("a completed pull reports progress and resolves", async () => {
  const seen = [];
  await streamOllamaPull("qwen2.5vl:3b", {
    fetchImpl: async (url, init) => {
      assert.equal(url, "http://127.0.0.1:11434/api/pull");
      assert.deepEqual(JSON.parse(init.body), { model: "qwen2.5vl:3b", stream: true });
      return ndjsonResponse([
        { status: "pulling manifest" },
        { status: "pulling abc", digest: "abc", completed: 500, total: 1000 },
        { status: "pulling abc", digest: "abc", completed: 1000, total: 1000 },
        { status: "success" },
      ]);
    },
    onProgress: (update) => seen.push(update.percent),
  });
  // Manifest and success events carry no byte totals, so they report no
  // percentage; the worker holds the last known value across them.
  assert.deepEqual(seen, [undefined, 50, 100, undefined]);
});

test("an error event fails the pull with the server's message", async () => {
  await assert.rejects(
    streamOllamaPull("nope", {
      fetchImpl: async () => ndjsonResponse([{ error: "model 'nope' not found" }]),
    }),
    /model 'nope' not found/,
  );
});

test("a stream that ends without success is a failure, not a silent pass", async () => {
  await assert.rejects(
    streamOllamaPull("qwen2.5vl:3b", {
      fetchImpl: async () =>
        ndjsonResponse([{ status: "pulling abc", digest: "abc", completed: 1, total: 100 }]),
    }),
    /ended before Ollama confirmed success/,
  );
});

test("an unreachable daemon names the cause", async () => {
  await assert.rejects(
    streamOllamaPull("x", {
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    }),
    /Could not reach Ollama/,
  );
});

test("the /v1 inference prefix is stripped for the daemon API", async () => {
  let seenUrl;
  await streamOllamaPull("x", {
    baseUrl: "http://127.0.0.1:11434/v1",
    fetchImpl: async (url) => {
      seenUrl = url;
      return ndjsonResponse([{ status: "success" }]);
    },
  });
  assert.equal(seenUrl, "http://127.0.0.1:11434/api/pull");
});

test("download state round-trips through protected state", () => {
  assert.equal(readVisionDownload(), null);
  writeVisionDownload({ version: 1, tag: "moondream", status: "downloading", percent: 12 });
  assert.equal(readVisionDownload().percent, 12);
  assert.ok(VISION_DOWNLOAD_STATE_PATH.startsWith(stateDir));
});
