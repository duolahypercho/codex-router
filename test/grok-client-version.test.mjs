import assert from "node:assert/strict";
import test from "node:test";
import { createGrokClientVersionReader } from "../src/grok-client-version.mjs";

test("a failed CLI probe is retried, never replaced with the Router version", async () => {
  let attempts = 0;
  const read = createGrokClientVersionReader({
    resolveCli: () => "/fixture/grok", platform: "darwin",
    environment: { XAI_API_KEY: "must-not-pass", PATH: "/bin" },
    run: async (command, args, options) => {
      assert.equal(command, "/fixture/grok");
      assert.deepEqual(args, ["--version"]);
      assert.equal(options.env.XAI_API_KEY, undefined);
      if (++attempts === 1) throw new Error("ETIMEDOUT private output");
      return { stdout: "grok 1.0.46 (build) [stable]\n" };
    },
  });
  await assert.rejects(read(), error => error.code === "grok_cli_version_unavailable" && !error.message.includes("private"));
  assert.equal(await read(), "1.0.46");
  assert.equal(await read(), "1.0.46");
  assert.equal(attempts, 2);
});

test("concurrent probes share work and an updated CLI is discovered after cache expiry", async () => {
  let clock = 0, attempts = 0;
  const read = createGrokClientVersionReader({
    resolveCli: () => "/fixture/grok", platform: "darwin", now: () => clock,
    run: async () => ({ stdout: `grok 1.0.${++attempts}` }),
  });
  assert.deepEqual(await Promise.all([read(), read()]), ["1.0.1", "1.0.1"]);
  clock = 60_001;
  assert.equal(await read(), "1.0.2");
});

test("missing CLI and unrelated version output fail explicitly", async () => {
  for (const resolveCli of [() => undefined, () => "/fixture/grok"]) {
    const read = createGrokClientVersionReader({ resolveCli, platform: "darwin", run: async () => ({ stdout: "node 22.19.0" }) });
    await assert.rejects(read(), { code: "grok_cli_version_unavailable", status: 503 });
    await assert.rejects(read(), { code: "grok_cli_version_unavailable" });
  }
});

test("Windows npm CLI uses the shared batch shim launcher", async () => {
  const read = createGrokClientVersionReader({
    resolveCli: () => "C:\\Program Files\\grok.cmd", platform: "win32",
    run: async (command, args) => {
      assert.match(command, /cmd(?:\.exe)?$/i);
      assert.match(args.join(" "), /--version/);
      return { stdout: "grok 1.0.46" };
    },
  });
  assert.equal(await read(), "1.0.46");
});
