import { Agent, EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

// Node 26's bundled fetch negotiates HTTP/2 by default. A live router process
// observed its pooled session remain destroyed after ERR_HTTP2_INVALID_SESSION,
// so every later native Codex request failed until launchd restarted the whole
// service. Codex uses streaming Responses over ordinary HTTPS and does not
// require HTTP/2; an HTTP/1.1-only dispatcher removes that poisoned-session
// state while retaining keep-alive connection reuse.
export function installStableFetchTransport({
  AgentClass = Agent,
  EnvProxyClass = EnvHttpProxyAgent,
  setDispatcher = setGlobalDispatcher,
  env = process.env,
} = {}) {
  // NODE_USE_ENV_PROXY only seeds the global dispatcher at process start. The
  // plain Agent below would overwrite it, so preserve an explicitly configured
  // outbound proxy while keeping the same HTTP/1.1-only policy.
  const proxyConfigured =
    env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  const dispatcher = proxyConfigured
    ? new EnvProxyClass({ allowH2: false })
    : new AgentClass({ allowH2: false });
  setDispatcher(dispatcher);
  return dispatcher;
}
