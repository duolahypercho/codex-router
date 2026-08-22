import { Agent, EnvHttpProxyAgent, fetch as undiciFetch, setGlobalDispatcher } from "undici";

import { environmentHttpProxyConfigured } from "./proxy-environment.mjs";
import { KEEPALIVE_TIMEOUT_MS } from "./http-utils.mjs";

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
// "waiting for network". Keep idle sockets as long as the router server so
// Codex's 90s client pool is not handed a dead connection.
export function fetchDispatcherOptions() {
  return {
    allowH2: false,
    pipelining: 1,
    keepAliveTimeout: KEEPALIVE_TIMEOUT_MS,
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

export function loopbackProbeFetch(url, init = {}, dispatcher = createLoopbackProbeDispatcher()) {
  return undiciFetch(url, { ...init, dispatcher });
}
