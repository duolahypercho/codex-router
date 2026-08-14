import { Agent, setGlobalDispatcher } from "undici";

// Node 26's bundled fetch negotiates HTTP/2 by default. A live router process
// observed its pooled session remain destroyed after ERR_HTTP2_INVALID_SESSION,
// so every later native Codex request failed until launchd restarted the whole
// service. Codex uses streaming Responses over ordinary HTTPS and does not
// require HTTP/2; an HTTP/1.1-only dispatcher removes that poisoned-session
// state while retaining keep-alive connection reuse.
export function installStableFetchTransport({
  AgentClass = Agent,
  setDispatcher = setGlobalDispatcher,
} = {}) {
  const dispatcher = new AgentClass({ allowH2: false });
  setDispatcher(dispatcher);
  return dispatcher;
}
