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

export function installStableFetchTransport({
  AgentClass = Agent,
  EnvHttpProxyAgentClass = EnvHttpProxyAgent,
  setDispatcher = setGlobalDispatcher,
  environment = process.env,
  execArgv = process.execArgv,
} = {}) {
  const DispatcherClass = environmentHttpProxyConfigured(environment, execArgv)
    ? EnvHttpProxyAgentClass
    : AgentClass;
  const dispatcher = new DispatcherClass(fetchDispatcherOptions());
  setDispatcher(dispatcher);
  return dispatcher;
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
