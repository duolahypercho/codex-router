import { Agent, EnvHttpProxyAgent, fetch as undiciFetch, setGlobalDispatcher } from "undici";

import { environmentHttpProxyConfigured } from "./proxy-environment.mjs";

// Node 26's bundled fetch negotiates HTTP/2 by default. A live router process
// observed its pooled session remain destroyed after ERR_HTTP2_INVALID_SESSION,
// so every later native Codex request failed until launchd restarted the whole
// service. Codex uses streaming Responses over ordinary HTTPS and does not
// require HTTP/2; an HTTP/1.1-only dispatcher removes that poisoned-session
// state while retaining keep-alive connection reuse.
//
// Concurrent Codex turns each hold one HTTP/1.1 streaming socket for the
// whole generation. Do not cap `connections`: Undici's HTTP/1.1 pool is
// unbounded by default, and one router plane serves every installed client.
// A numeric ceiling queues the next turn once it fills and recreates
// "waiting for network".
//
// Leave `keepAliveTimeout` at Undici's 4s default. This pool is shared by
// every outbound provider request, and an upstream that idle-closes without
// advertising `Keep-Alive: timeout=` hands back a half-closed socket once we
// hold connections longer than it does -- surfacing as UND_ERR_SOCKET on a
// POST Undici will not retry. Only the loopback probe pool below, whose one
// origin is our own server, raises it.
export function fetchDispatcherOptions() {
  return {
    allowH2: false,
    pipelining: 1,
  };
}

// `bodyTimeoutMs` raises Undici's 300s idle bound between body chunks. Only a
// process that carries nothing but long-silent streams (the Grok OAuth
// forwarder) sets it for its whole pool. The headers bound moves with it: a
// Grok turn can stay silent until the first response headers, and Undici's
// 300s headers default would abort that wait while the body bound still had
// room. Callers that omit `bodyTimeoutMs` keep both defaults.
export function installStableFetchTransport({
  AgentClass = Agent,
  EnvHttpProxyAgentClass = EnvHttpProxyAgent,
  setDispatcher = setGlobalDispatcher,
  environment = process.env,
  execArgv = process.execArgv,
  bodyTimeoutMs,
} = {}) {
  const DispatcherClass = environmentHttpProxyConfigured(environment, execArgv)
    ? EnvHttpProxyAgentClass
    : AgentClass;
  const dispatcher = new DispatcherClass({
    ...fetchDispatcherOptions(),
    ...(bodyTimeoutMs ? { headersTimeout: bodyTimeoutMs, bodyTimeout: bodyTimeoutMs } : {}),
  });
  setDispatcher(dispatcher);
  return dispatcher;
}

// A Grok OAuth turn can stay silent for minutes while it reasons. The shared
// pool keeps Undici's 300s body idle bound for every other provider; a hop that
// carries a Grok stream uses this separate pool instead, whose bound outlasts
// the router's stall guard. The dispatcher class and proxy decision match the
// shared pool, so only the idle bounds differ. The headers bound moves with the
// body bound: a Grok compaction is not streamed, so the gateway answers its
// headers only after the whole generation, and Undici's 300s headers default
// would end a long compaction before the stall guard's allowance.
const longIdleStreamDispatchers = new Map();

export function longIdleStreamDispatcher(bodyTimeoutMs, {
  AgentClass = Agent,
  EnvHttpProxyAgentClass = EnvHttpProxyAgent,
  environment = process.env,
  execArgv = process.execArgv,
} = {}) {
  let dispatcher = longIdleStreamDispatchers.get(bodyTimeoutMs);
  if (!dispatcher) {
    const DispatcherClass = environmentHttpProxyConfigured(environment, execArgv)
      ? EnvHttpProxyAgentClass
      : AgentClass;
    dispatcher = new DispatcherClass({
      ...fetchDispatcherOptions(),
      headersTimeout: bodyTimeoutMs,
      bodyTimeout: bodyTimeoutMs,
    });
    longIdleStreamDispatchers.set(bodyTimeoutMs, dispatcher);
  }
  return dispatcher;
}

// Undici's own `fetch`, for the reason given at the probe pool below.
export function longIdleStreamFetch(url, init = {}, { bodyTimeoutMs } = {}) {
  return undiciFetch(url, { ...init, dispatcher: longIdleStreamDispatcher(bodyTimeoutMs) });
}

// Health probes must not share the streaming pool. A GET /health/liveliness
// that queues behind five SSE POSTs to the same origin is what made the
// unauthenticated `/health` leaf hang long enough for doctor and the tray
// to call the router dead.
//
// Use undici's own `fetch` with this Agent. Passing an npm-undici dispatcher
// into Node's builtin `fetch` throws `invalid onRequestStart method`, every
// probe looks unreachable, and `/health` stays 503 until startup gives up.
export function createLoopbackProbeDispatcher({
  AgentClass = Agent,
  EnvHttpProxyAgentClass = EnvHttpProxyAgent,
  environment = process.env,
  execArgv = process.execArgv,
  timeoutMs = 3_000,
} = {}) {
  const DispatcherClass = environmentHttpProxyConfigured(environment, execArgv)
    ? EnvHttpProxyAgentClass
    : AgentClass;
  return new DispatcherClass({
    allowH2: false,
    pipelining: 1,
    keepAliveTimeout: 10_000,
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
  });
}

// One pool for the whole process. Building the Agent in a default parameter
// made a fresh connection pool on every probe instead, so each `/health` poll
// left another dispatcher -- and its sockets -- behind with nothing to close
// them. Created on first use so importing this module opens nothing.
let sharedProbeDispatcher;

export function loopbackProbeDispatcher() {
  sharedProbeDispatcher ??= createLoopbackProbeDispatcher();
  return sharedProbeDispatcher;
}

export function loopbackProbeFetch(url, init = {}, dispatcher = loopbackProbeDispatcher()) {
  return undiciFetch(url, { ...init, dispatcher });
}

// Re-entry surfaces carry the caller capability in their loopback URL. Unlike
// health probes, that hop must never honor an environment proxy: doing so can
// disclose the local capability to a corporate or user-configured proxy. Keep
// one direct HTTP/1.1 pool for those authenticated same-machine requests.
let sharedDirectLoopbackDispatcher;

export function directLoopbackFetch(url, init = {}) {
  sharedDirectLoopbackDispatcher ??= new Agent(fetchDispatcherOptions());
  return undiciFetch(url, { ...init, dispatcher: sharedDirectLoopbackDispatcher });
}
