import assert from "node:assert/strict";
import http from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";

import {
  connectTimeoutMs,
  directLoopbackFetch,
  createLoopbackProbeDispatcher,
  fetchDispatcherOptions,
  installStableFetchTransport,
  longIdleStreamDispatcher,
  longIdleStreamFetch,
  loopbackProbeDispatcher,
  loopbackProbeFetch,
} from "../src/fetch-transport.mjs";
import { NATIVE_RETRY_BUDGET_MS, NATIVE_RETRY_LIMIT } from "../src/upstream-retry.mjs";

const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));

// The exact shape of the process-wide pool. The connect bound is part of it:
// it is what makes the connect codes in `upstream-retry.mjs`'s retryable set
// reachable at all, which the cross-module test at the end asserts.
const POOL_DEFAULTS = {
  allowH2: false,
  pipelining: 1,
  connectTimeout: connectTimeoutMs({}),
  autoSelectFamily: true,
  autoSelectFamilyAttemptTimeout: 250,
};

function installFakeTransport(environment, execArgv = []) {
  const created = [];
  const installed = [];

  class FakeAgent {
    constructor(options) {
      this.kind = "direct";
      this.options = options;
      created.push(this);
    }
  }

  class FakeEnvHttpProxyAgent {
    constructor(options) {
      this.kind = "environment-proxy";
      this.options = options;
      created.push(this);
    }
  }

  const dispatcher = installStableFetchTransport({
    AgentClass: FakeAgent,
    EnvHttpProxyAgentClass: FakeEnvHttpProxyAgent,
    environment,
    execArgv,
    setDispatcher(value) {
      installed.push(value);
    },
  });

  return { created, dispatcher, installed };
}

test("the router disables HTTP/2 on its process-wide fetch dispatcher", () => {
  const { created, dispatcher, installed } = installFakeTransport({});

  assert.equal(created.length, 1);
  assert.equal(dispatcher.kind, "direct");
  assert.deepEqual(created[0].options, POOL_DEFAULTS);
  assert.equal(dispatcher, created[0]);
  assert.deepEqual(installed, [dispatcher]);
});

test("a Grok long-idle pool raises the header and body idle bounds together", () => {
  const { created } = installFakeTransport({});
  assert.equal("bodyTimeout" in created[0].options, false, "the shared pool keeps undici's default");
  assert.equal("headersTimeout" in created[0].options, false, "the shared pool keeps undici's header default");

  class FakeAgent {
    constructor(options) {
      this.kind = "direct";
      this.options = options;
    }
  }
  class FakeEnvHttpProxyAgent {
    constructor(options) {
      this.kind = "environment-proxy";
      this.options = options;
    }
  }
  const forwarderPool = installStableFetchTransport({
    AgentClass: FakeAgent,
    EnvHttpProxyAgentClass: FakeEnvHttpProxyAgent,
    environment: {},
    execArgv: [],
    bodyTimeoutMs: 660_000,
    setDispatcher() {},
  });
  assert.deepEqual(forwarderPool.options, {
    ...POOL_DEFAULTS,
    headersTimeout: 660_000,
    bodyTimeout: 660_000,
  });

  const classes = { AgentClass: FakeAgent, EnvHttpProxyAgentClass: FakeEnvHttpProxyAgent, execArgv: [] };
  const direct = longIdleStreamDispatcher(660_001, { ...classes, environment: {} });
  assert.equal(direct.kind, "direct");
  assert.deepEqual(direct.options, {
    ...POOL_DEFAULTS,
    headersTimeout: 660_001,
    bodyTimeout: 660_001,
  });
  assert.equal(longIdleStreamDispatcher(660_001), direct, "one pool per bound, not one per request");
  const proxied = longIdleStreamDispatcher(660_002, {
    ...classes,
    environment: { NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: "http://proxy.example:8080" },
  });
  assert.equal(proxied.kind, "environment-proxy");
});

test("the long-idle fetch honors its body idle bound on a real socket", async () => {
  // Undici checks body timeouts on a coarse (about half-second) timer wheel,
  // so the pause is several ticks longer than the short bound.
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.write("first");
    const timer = setTimeout(() => response.end("second"), 2_500);
    response.once("close", () => clearTimeout(timer));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    const patient = await longIdleStreamFetch(url, {}, { bodyTimeoutMs: 10_000 });
    assert.equal(await patient.text(), "firstsecond");
    // Negative control: the same pause trips a shorter bound, so the option
    // reaches the dispatcher rather than being silently ignored.
    const impatient = await longIdleStreamFetch(url, {}, { bodyTimeoutMs: 100 });
    await assert.rejects(impatient.text(), (error) =>
      [error?.code, error?.cause?.code].includes("UND_ERR_BODY_TIMEOUT"));
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("the long-idle fetch honors the same bound for response headers", async () => {
  // A non-streaming Grok compaction receives its headers only after the whole
  // generation, so a pause before the head must be bounded like a pause
  // between body chunks rather than by Undici's 300s headers default.
  const server = http.createServer((_request, response) => {
    const timer = setTimeout(() => {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("late head");
    }, 2_500);
    response.once("close", () => clearTimeout(timer));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    const patient = await longIdleStreamFetch(url, {}, { bodyTimeoutMs: 10_000 });
    assert.equal(await patient.text(), "late head");
    // Negative control: the same delay before the head trips a shorter bound.
    await assert.rejects(
      longIdleStreamFetch(url, {}, { bodyTimeoutMs: 100 }),
      (error) => [error?.code, error?.cause?.code].includes("UND_ERR_HEADERS_TIMEOUT"),
    );
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

// Every outbound provider request shares this pool. Holding idle sockets
// longer than an upstream does hands the next POST a half-closed connection
// that surfaces as UND_ERR_SOCKET, and Undici will not retry it -- so the
// process-wide pool keeps Undici's own 4s default and only the loopback
// probe pool, which talks to our own server, raises it.
test("the process-wide pool does not hold idle sockets past the undici default", () => {
  const { created } = installFakeTransport({});

  assert.equal("keepAliveTimeout" in created[0].options, false);
  assert.equal("connections" in created[0].options, false);

  const probe = createLoopbackProbeDispatcher({
    AgentClass: class {
      constructor(options) {
        this.options = options;
      }
    },
    environment: {},
  });
  assert.equal(probe.options.keepAliveTimeout, 10_000);
});

test("the router uses the environment proxy dispatcher only with explicit opt-in", () => {
  for (const environment of [
    { NODE_USE_ENV_PROXY: "1", http_proxy: "http://proxy.example:8080" },
    { NODE_USE_ENV_PROXY: "1", HTTP_PROXY: "http://proxy.example:8080" },
    { NODE_USE_ENV_PROXY: "1", https_proxy: "http://proxy.example:8080" },
    { NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: "http://proxy.example:8080", NO_PROXY: "localhost" },
  ]) {
    const { created, dispatcher } = installFakeTransport(environment);

    assert.equal(created.length, 1);
    assert.equal(dispatcher.kind, "environment-proxy");
    assert.equal(dispatcher, created[0]);
    assert.deepEqual(dispatcher.options, fetchDispatcherOptions(environment));
  }
});

test("proxy variables alone do not opt the router into proxying", () => {
  const environment = {
    HTTP_PROXY: "http://proxy.example:8080",
    HTTPS_PROXY: "http://secure-proxy.example:8443",
  };
  const { created, dispatcher } = installFakeTransport(environment);

  assert.equal(created.length, 1);
  assert.equal(dispatcher.kind, "direct");
  assert.deepEqual(dispatcher.options, fetchDispatcherOptions(environment));
});

test("the router accepts the NODE_OPTIONS and command-line opt-in forms", () => {
  for (const [environment, execArgv] of [
    [{ NODE_OPTIONS: "--use-env-proxy", HTTP_PROXY: "http://proxy.example:8080" }, []],
    [{ HTTP_PROXY: "http://proxy.example:8080" }, ["--use-env-proxy"]],
  ]) {
    const { created, dispatcher } = installFakeTransport(environment, execArgv);
    assert.equal(created.length, 1);
    assert.equal(dispatcher.kind, "environment-proxy");
    assert.deepEqual(dispatcher.options, fetchDispatcherOptions(environment));
  }
});

test("NO_PROXY or ALL_PROXY alone keeps the lower-overhead direct agent", () => {
  for (const environment of [
    { NO_PROXY: "localhost,127.0.0.1" },
    { ALL_PROXY: "socks5://proxy.example:1080" },
    // EnvHttpProxyAgent ignores uppercase HTTP_PROXY when lowercase is present,
    // even when the lowercase value deliberately disables it.
    { http_proxy: "", HTTP_PROXY: "http://proxy.example:8080" },
  ]) {
    const { created, dispatcher } = installFakeTransport(environment);

    assert.equal(created.length, 1);
    assert.equal(dispatcher.kind, "direct");
    assert.equal(dispatcher, created[0]);
    assert.deepEqual(dispatcher.options, fetchDispatcherOptions(environment));
  }
});

test("the installed transport proxies requests and honors NO_PROXY", async () => {
  const proxyEnvironmentNames = [
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "NODE_USE_ENV_PROXY",
  ];
  const originalEnvironment = Object.fromEntries(
    proxyEnvironmentNames.map((name) => [name, process.env[name]]),
  );
  const originalDispatcher = getGlobalDispatcher();
  let proxiedRequests = 0;
  let directRequests = 0;
  const target = http.createServer((_request, response) => {
    directRequests += 1;
    response.end("direct");
  });
  const proxy = http.createServer((_request, response) => {
    proxiedRequests += 1;
    response.end("proxied");
  });
  const listen = (server) =>
    new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve(server.address().port));
    });
  const close = (server) => new Promise((resolve) => server.close(resolve));

  let dispatcher;
  try {
    const [targetPort, proxyPort] = await Promise.all([listen(target), listen(proxy)]);
    for (const name of proxyEnvironmentNames) delete process.env[name];
    process.env.NODE_USE_ENV_PROXY = "1";
    process.env.HTTP_PROXY = `http://127.0.0.1:${proxyPort}`;

    dispatcher = installStableFetchTransport();
    let response = await fetch(`http://127.0.0.1:${targetPort}/through-proxy`);
    assert.equal(await response.text(), "proxied");
    assert.equal(proxiedRequests, 1);
    assert.equal(directRequests, 0);

    response = await directLoopbackFetch(`http://127.0.0.1:${targetPort}/router-reentry`);
    assert.equal(await response.text(), "direct");
    assert.equal(proxiedRequests, 1);
    assert.equal(directRequests, 1);

    process.env.NO_PROXY = "127.0.0.1";
    response = await fetch(`http://127.0.0.1:${targetPort}/bypass-proxy`);
    assert.equal(await response.text(), "direct");
    assert.equal(proxiedRequests, 1);
    assert.equal(directRequests, 2);
  } finally {
    setGlobalDispatcher(originalDispatcher);
    await dispatcher?.close();
    await Promise.all([close(target), close(proxy)]);
    for (const [name, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

// The service is four long-lived processes, and setGlobalDispatcher only
// reaches the one that called it. A forwarder that skips the install keeps
// Node's HTTP/2-capable default and stays exposed to the poisoned-session
// failure this module exists to remove — so every server entry point must
// install the stable transport, including ones added after this test.
test("every long-lived server process installs the stable transport", () => {
  const serverEntryPoints = readdirSync(SRC_DIR)
    .filter((name) => name.endsWith(".mjs"))
    .filter((name) =>
      readFileSync(path.join(SRC_DIR, name), "utf8").includes("createServer("),
    );

  assert.ok(
    serverEntryPoints.length >= 4,
    `expected at least the four known server entry points, found: ${serverEntryPoints.join(", ")}`,
  );

  for (const name of serverEntryPoints) {
    const source = readFileSync(path.join(SRC_DIR, name), "utf8");
    // A process may pass options (the Grok forwarder raises its body idle
    // bound), but it must still install the transport.
    assert.match(
      source,
      /installStableFetchTransport\((?:\{[\s\S]*?\})?\);/,
      `${name} creates a server but never installs the stable fetch transport`,
    );
  }
});

test("loopback health probes use the same proxy opt-in as routed traffic", () => {
  const created = [];
  class FakeAgent {
    constructor(options) {
      this.kind = "direct";
      this.options = options;
      created.push(this);
    }
  }
  class FakeEnvHttpProxyAgent {
    constructor(options) {
      this.kind = "environment-proxy";
      this.options = options;
      created.push(this);
    }
  }

  const proxied = createLoopbackProbeDispatcher({
    AgentClass: FakeAgent,
    EnvHttpProxyAgentClass: FakeEnvHttpProxyAgent,
    environment: { NODE_USE_ENV_PROXY: "1", HTTP_PROXY: "http://proxy.example:8080" },
  });
  assert.equal(proxied.kind, "environment-proxy");

  created.length = 0;
  const direct = createLoopbackProbeDispatcher({
    AgentClass: FakeAgent,
    EnvHttpProxyAgentClass: FakeEnvHttpProxyAgent,
    environment: { HTTP_PROXY: "http://proxy.example:8080" },
  });
  assert.equal(direct.kind, "direct");
});

test("loopback probes use undici fetch so a separate Agent is accepted", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, service: "gateway" }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const port = server.address().port;
    const response = await loopbackProbeFetch(`http://127.0.0.1:${port}/health/liveliness`, {
      headers: { Authorization: "Bearer test" },
      signal: AbortSignal.timeout(2_000),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, service: "gateway" });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// A default parameter that called the factory built a new Agent -- a whole
// connection pool -- on every probe, and the router polls /health continuously.
test("repeated loopback probes share one dispatcher", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const seen = [];
  const original = loopbackProbeDispatcher();
  try {
    const port = server.address().port;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await loopbackProbeFetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      await response.json();
      seen.push(loopbackProbeDispatcher());
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  assert.equal(seen.length, 3);
  for (const dispatcher of seen) assert.equal(dispatcher, original);
  // The accessor returns the one singleton; the factory still makes new pools,
  // which is what the default parameter used to do on every single probe.
  const separate = createLoopbackProbeDispatcher();
  try {
    assert.notEqual(original, separate);
  } finally {
    await separate.close();
  }
});

// Importing the module must not open a pool; only a probe should.
test("the shared probe dispatcher is built on first use, not at import", () => {
  const source = readFileSync(path.join(SRC_DIR, "fetch-transport.mjs"), "utf8");
  assert.match(source, /let sharedProbeDispatcher;/);
  assert.match(source, /sharedProbeDispatcher \?\?= createLoopbackProbeDispatcher\(\)/);
  assert.doesNotMatch(
    source,
    /^(const|let) \w+ = createLoopbackProbeDispatcher\(\)/m,
    "a module-level call would open a connection pool for every importer",
  );
});

// The regression these three guard: undici's 10s connect default outran the
// 5s pre-retry budget, so the connect codes named as retryable could never
// actually be retried and every blip surfaced as a 502 (2026-09-21: 454 of
// 466 failures across two machines, zero connect retries logged). A test of
// either module alone passes with that hole open, so the last one asserts the
// relationship between them.
test("the process-wide pool bounds the connect phase and races addresses", () => {
  const { created } = installFakeTransport({});

  assert.equal(created[0].options.connectTimeout, connectTimeoutMs({}));
  assert.ok(
    created[0].options.connectTimeout <= 5_000,
    "a connect blip must be detected in seconds, not tens of seconds",
  );
  assert.equal(created[0].options.autoSelectFamily, true);
  assert.ok(created[0].options.autoSelectFamilyAttemptTimeout > 0);
});

test("the connect bound is overridable and clamped", () => {
  assert.equal(connectTimeoutMs({}), 3_000);
  assert.equal(connectTimeoutMs({ CODEX_ROUTER_CONNECT_TIMEOUT_MS: "1200" }), 1_200);
  assert.equal(connectTimeoutMs({ CODEX_ROUTER_CONNECT_TIMEOUT_MS: "10" }), 500);
  assert.equal(connectTimeoutMs({ CODEX_ROUTER_CONNECT_TIMEOUT_MS: "999999" }), 30_000);
  assert.equal(connectTimeoutMs({ CODEX_ROUTER_CONNECT_TIMEOUT_MS: "not-a-number" }), 3_000);

  // The override must reach the dispatcher, not only the helper.
  assert.equal(
    fetchDispatcherOptions({ CODEX_ROUTER_CONNECT_TIMEOUT_MS: "1500" }).connectTimeout,
    1_500,
  );
});

test("the retry budget can afford every bounded connect attempt it allows", () => {
  // A deliberately disabled loop (0) is an operator decision, not a defect.
  if (NATIVE_RETRY_BUDGET_MS === 0 || NATIVE_RETRY_LIMIT === 0) return;
  const connect = connectTimeoutMs({});
  assert.ok(
    NATIVE_RETRY_BUDGET_MS >= NATIVE_RETRY_LIMIT * connect,
    `budget ${NATIVE_RETRY_BUDGET_MS}ms cannot afford ` +
      `${NATIVE_RETRY_LIMIT} bounded connects of ${connect}ms`,
  );
});
