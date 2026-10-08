import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { firstFrameImage, parseArgs, runMedia } from "../src/minimax-media.mjs";

const SECRET = "sk-test-media-secret";

// A stub provider keeps the tests off the real registry and resolver; the
// fetch stub records every request so payload shape is asserted, not assumed.
function harness(responses) {
  const requests = [];
  const queue = [...responses];
  const logs = [];
  const emitted = [];
  const hooks = {
    provider: { id: "minimax-token-plan", baseUrl: "https://api.minimax.io/v1" },
    resolveCredential: () => ({ value: SECRET, source: "test", persistent: true }),
    fetchImpl: async (url, init = {}) => {
      requests.push({ url, init });
      const next = queue.shift();
      if (!next) throw new Error(`Unexpected request: ${url}`);
      return {
        ok: next.status === undefined || next.status < 400,
        status: next.status ?? 200,
        text: async () => JSON.stringify(next.body),
        body: next.stream,
      };
    },
    sleep: async () => {},
    now: () => Date.UTC(2026, 0, 2, 3, 4, 5),
    log: (line) => logs.push(line),
    emit: (line) => emitted.push(line),
  };
  return { hooks, requests, logs, emitted };
}

function streamOf(text) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

for (const [filename, expectedNames] of [
  ["picture.jpeg", ["picture-1.jpeg", "picture-2.jpeg"]],
  ["picture.jpg", ["picture-1.jpg", "picture-2.jpg"]],
  ["picture.png", ["picture-1.png", "picture-2.png"]],
  ["picture.JPEG", ["picture-1.JPEG", "picture-2.JPEG"]],
  ["picture", ["picture-1", "picture-2"]],
  [".picture", [".picture-1", ".picture-2"]],
]) {
  test(`multiple images preserve separate files for --out ${filename}`, async (t) => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "mm-images-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const urls = ["https://cdn.example/first.jpeg", "https://cdn.example/second.jpeg"];
    const { hooks, requests, emitted } = harness([
      { body: { data: { image_urls: urls } } },
      { stream: streamOf("first-image-bytes") },
      { stream: streamOf("second-image-bytes") },
    ]);

    const result = await runMedia([
      "image", "--prompt", "a paper boat", "--count", "2",
      "--out", path.join(directory, filename),
    ], hooks);

    const expected = expectedNames.map((name) => path.join(directory, name));
    assert.deepEqual(result.files, expected);
    assert.equal(new Set(result.files).size, 2);
    assert.deepEqual(result.files.map((file) => readFileSync(file, "utf8")), [
      "first-image-bytes", "second-image-bytes",
    ]);
    assert.deepEqual(result.urls, urls);
    assert.deepEqual(emitted, expected.map((file) => `Saved: ${file}`));
    assert.equal(JSON.parse(requests[0].init.body).n, 2);
  });
}

test("one image retains the exact requested output filename", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "mm-image-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const out = path.join(directory, "nested", "picture.png");
  const { hooks } = harness([
    { body: { data: { image_urls: ["https://cdn.example/image.jpeg"] } } },
    { stream: streamOf("single-image-bytes") },
  ]);
  const result = await runMedia(["image", "--prompt", "a boat", "--out", out], hooks);
  assert.deepEqual(result.files, [out]);
  assert.equal(readFileSync(out, "utf8"), "single-image-bytes");
});

for (const existing of [false, true]) {
  test(`a failed media download preserves ${existing ? "the existing output" : "an absent output"}`, async (t) => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "mm-atomic-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const out = path.join(directory, "track.mp3");
    if (existing) writeFileSync(out, "original-track");
    let reads = 0;
    const interrupted = new ReadableStream({
      pull(controller) {
        if (reads++ === 0) controller.enqueue(new TextEncoder().encode("partial-track"));
        else controller.error(new Error("connection lost"));
      },
    });
    const { hooks, emitted } = harness([
      { body: { data: { audio: "https://cdn.example/track.mp3" } } },
      { stream: interrupted },
    ]);
    await assert.rejects(runMedia([
      "music", "--prompt", "lofi", "--instrumental", "--out", out,
    ], hooks), /connection lost/);
    assert.equal(existsSync(out), existing);
    if (existing) assert.equal(readFileSync(out, "utf8"), "original-track");
    assert.deepEqual(readdirSync(directory), existing ? ["track.mp3"] : []);
    assert.deepEqual(emitted, [], "no incomplete download may be announced as saved");
  });
}

test("the destination changes only after the media stream completes", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "mm-atomic-complete-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const out = path.join(directory, "picture.png");
  writeFileSync(out, "old-image");
  let reads = 0;
  const stream = new ReadableStream({
    pull(controller) {
      assert.equal(readFileSync(out, "utf8"), "old-image");
      if (reads++ === 0) controller.enqueue(new TextEncoder().encode("new-image"));
      else controller.close();
    },
  });
  const { hooks } = harness([
    { body: { data: { image_urls: ["https://cdn.example/image"] } } }, { stream },
  ]);
  const result = await runMedia(["image", "--prompt", "a boat", "--out", out], hooks);
  assert.deepEqual(result.files, [out]);
  assert.equal(readFileSync(out, "utf8"), "new-image");
  assert.deepEqual(readdirSync(directory), ["picture.png"]);
});

test("a failed final rename cleans the download without replacing a directory", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "mm-atomic-rename-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const out = path.join(directory, "directory");
  // An existing non-empty directory cannot be replaced by a downloaded file.
  mkdirSync(out);
  writeFileSync(path.join(out, "keep"), "untouched");
  const { hooks } = harness([
    { body: { data: { image_urls: ["https://cdn.example/image"] } } },
    { stream: streamOf("image-bytes") },
  ]);
  await assert.rejects(runMedia(["image", "--prompt", "a boat", "--out", out], hooks));
  assert.deepEqual(readdirSync(directory), ["directory"]);
  assert.equal(readFileSync(path.join(out, "keep"), "utf8"), "untouched");
});

test("atomic replacement retains existing POSIX file permissions", {
  skip: process.platform === "win32" ? "POSIX permission bits are not a Windows ACL" : false,
}, async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "mm-atomic-mode-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const out = path.join(directory, "private.mp3");
  writeFileSync(out, "old");
  chmodSync(out, 0o640);
  const { hooks } = harness([
    { body: { data: { audio: "https://cdn.example/track" } } },
    { stream: streamOf("new") },
  ]);
  const previousUmask = process.umask(0o077);
  try {
    await runMedia(["music", "--prompt", "lofi", "--instrumental", "--out", out], hooks);
  } finally {
    process.umask(previousUmask);
  }
  assert.equal(statSync(out).mode & 0o777, 0o640);
  assert.equal(readFileSync(out, "utf8"), "new");
});

test("a failed concurrent download cannot remove a completed result", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "mm-atomic-concurrent-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const out = path.join(directory, "shared.mp3");
  let interrupt;
  const slow = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("partial"));
      interrupt = () => controller.error(new Error("first transfer failed"));
    },
  });
  const first = harness([
    { body: { data: { audio: "https://cdn.example/first" } } }, { stream: slow },
  ]);
  const second = harness([
    { body: { data: { audio: "https://cdn.example/second" } } }, { stream: streamOf("complete") },
  ]);
  const args = ["music", "--prompt", "lofi", "--instrumental", "--out", out];
  const failed = runMedia(args, first.hooks).then(
    () => assert.fail("the interrupted transfer must reject"),
    (error) => error,
  );
  try {
    await runMedia(args, second.hooks);
  } finally {
    interrupt();
  }
  assert.match((await failed).message, /first transfer failed/);
  assert.equal(readFileSync(out, "utf8"), "complete");
  assert.deepEqual(readdirSync(directory), ["shared.mp3"]);
});

test("multiple images share one timestamp in the default output filenames", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "mm-image-defaults-"));
  const previousCwd = process.cwd();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const files = [1, 2].map((index) => `minimax-image-2026-01-02T03-04-05-${index}.jpeg`);
  const { hooks } = harness([
    { body: { data: { image_urls: ["https://cdn.example/one", "https://cdn.example/two"] } } },
    { stream: streamOf("first") },
    { stream: streamOf("second") },
  ]);
  let clockCalls = 0;
  hooks.now = () => Date.UTC(2026, 0, 2, 3, 4, 5 + clockCalls++);
  process.chdir(directory);
  try {
    const result = await runMedia(["image", "--prompt", "a boat", "--count", "2"], hooks);
    assert.deepEqual(result.files, files);
    assert.deepEqual(result.files.map((file) => readFileSync(file, "utf8")), ["first", "second"]);
  } finally {
    process.chdir(previousCwd);
  }
});

test("image --no-download returns the URLs without fetching or saving images", async () => {
  const urls = ["https://cdn.example/one", "https://cdn.example/two"];
  const { hooks, requests } = harness([{ body: { data: { image_urls: urls } } }]);
  const result = await runMedia([
    "image", "--prompt", "a boat", "--count", "2", "--out", "picture.jpg", "--no-download",
  ], hooks);
  assert.deepEqual(result, { action: "image", urls, files: [] });
  assert.equal(requests.length, 1);
});

test("parseArgs separates flags, values, and booleans", () => {
  const { action, options } = parseArgs([
    "music",
    "--prompt",
    "lofi",
    "--instrumental",
    "--json",
  ]);
  assert.equal(action, "music");
  assert.deepEqual(options, { prompt: "lofi", instrumental: true, json: true });
  assert.throws(() => parseArgs(["music", "--prompt"]), /Missing value/);
  assert.throws(() => parseArgs(["music", "stray"]), /Unexpected argument/);
});

test("music generation posts the documented payload and downloads the track", async () => {
  const out = path.join(mkdtempSync(path.join(os.tmpdir(), "mm-media-")), "track.mp3");
  const { hooks, requests } = harness([
    {
      body: {
        data: { audio: "https://cdn.example/track.mp3" },
        extra_info: { music_duration: 1234 },
        base_resp: { status_code: 0, status_msg: "success" },
      },
    },
    { body: null, stream: streamOf("mp3-bytes") },
  ]);
  const result = await runMedia(
    ["music", "--prompt", "upbeat synthwave", "--instrumental", "--out", out],
    hooks,
  );
  assert.equal(requests[0].url, "https://api.minimax.io/v1/music_generation");
  const payload = JSON.parse(requests[0].init.body);
  assert.equal(payload.model, "music-3.0");
  assert.equal(payload.lyrics, "[inst]");
  assert.equal(requests[0].init.headers.Authorization, `Bearer ${SECRET}`);
  assert.equal(result.file, out);
  assert.equal(readFileSync(out, "utf8"), "mp3-bytes");
});

test("video polls the task and downloads the finished clip", async () => {
  const out = path.join(mkdtempSync(path.join(os.tmpdir(), "mm-media-")), "clip.mp4");
  const ok = { status_code: 0, status_msg: "success" };
  const { hooks, requests } = harness([
    { body: { task_id: "42", base_resp: ok } },
    { body: { status: "Processing", base_resp: ok } },
    { body: { status: "Success", file_id: "77", base_resp: ok } },
    { body: { file: { download_url: "https://cdn.example/clip.mp4" }, base_resp: ok } },
    { body: null, stream: streamOf("mp4-bytes") },
  ]);
  const result = await runMedia(
    ["video", "--prompt", "a paper boat", "--out", out, "--json"],
    hooks,
  );
  assert.equal(requests[0].url, "https://api.minimax.io/v1/video_generation");
  assert.equal(JSON.parse(requests[0].init.body).model, "MiniMax-Hailuo-02");
  assert.match(requests[1].url, /query\/video_generation\?task_id=42/);
  assert.match(requests[3].url, /files\/retrieve\?file_id=77/);
  assert.equal(result.file, out);
  assert.equal(readFileSync(out, "utf8"), "mp4-bytes");
});

test("H3 video is refused locally with Token Plan guidance", async () => {
  const { hooks, requests } = harness([]);
  await assert.rejects(
    runMedia(["video", "--prompt", "x", "--model", "MiniMax-H3"], hooks),
    /not available on the Token Plan/,
  );
  assert.equal(requests.length, 0);
});

test("an in-band MiniMax error surfaces its status_msg, never the key", async () => {
  const { hooks } = harness([
    { body: { base_resp: { status_code: 1008, status_msg: "insufficient balance" } } },
  ]);
  await assert.rejects(
    runMedia(["music", "--prompt", "x", "--instrumental"], hooks),
    (error) => {
      assert.match(error.message, /insufficient balance/);
      assert.ok(!error.message.includes(SECRET));
      return true;
    },
  );
});

test("a missing credential names the provider-key command", async () => {
  const { hooks } = harness([]);
  hooks.resolveCredential = () => undefined;
  await assert.rejects(
    runMedia(["speech", "--text", "hi"], hooks),
    /provider-key minimax-token-plan set/,
  );
});

test("a still-rendering task points at media status instead of resubmitting", async () => {
  const ok = { status_code: 0, status_msg: "success" };
  const pending = { body: { status: "Processing", base_resp: ok } };
  const { hooks } = harness([
    { body: { task_id: "9", base_resp: ok } },
    ...Array.from({ length: 90 }, () => pending),
  ]);
  await assert.rejects(
    runMedia(["video", "--prompt", "x"], hooks),
    /media status --task-id 9/,
  );
});

test("firstFrameImage passes URLs through and inlines local files", () => {
  assert.equal(firstFrameImage("https://example.com/a.png"), "https://example.com/a.png");
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "mm-media-")), "frame.png");
  const bytes = Buffer.from("png-bytes");
  writeFileSync(file, bytes);
  assert.equal(
    firstFrameImage(file),
    `data:image/png;base64,${bytes.toString("base64")}`,
  );
});
