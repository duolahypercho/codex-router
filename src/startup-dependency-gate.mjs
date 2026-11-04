// The supervisor starts the router alongside its local dependencies rather than
// after them, so a restart closes the client-facing port only for as long as the
// service manager takes to relaunch, and never for a LiteLLM cold start. Native
// turns need none of those dependencies. A routed request does, and during that
// window it would be refused by a port this same service is about to open, so it
// waits here for the dependencies its own route uses, and no others: a direct
// Responses provider never waits on the gateway.
//
// This covers startup only. Each dependency latches open the first time it is
// healthy, or when the bound runs out, and never closes again: a gateway that
// crashes later is the gateway supervisor's to replace and is reported through
// `/health`, exactly as it was before this gate existed.
//
// The bound stays well under Codex's stream idle timeout, because a held request
// has sent the client nothing. A slower cold start falls through to the ordinary
// upstream failure, which names the unreachable dependency.
export const DEFAULT_STARTUP_HOLD_MS = 60_000;
export const MAX_STARTUP_HOLD_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 500;

// Off unless the supervisor asks for it, because a router started on its own has
// nothing bringing those dependencies up and would hold every routed request for
// the whole bound.
export function parseStartupHoldMs(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return 0;
  return Math.min(parsed, MAX_STARTUP_HOLD_MS);
}

function createLatch() {
  let release;
  const opened = new Promise((resolve) => {
    release = resolve;
  });
  return { opened, release };
}

export function createStartupDependencyGate({
  holdMs,
  dependencies = [],
  isReady,
  intervalMs = DEFAULT_POLL_INTERVAL_MS,
  log = () => {},
  now = () => Date.now(),
}) {
  if (!(holdMs > 0) || dependencies.length === 0) {
    return { isOpen: () => true, wait: () => Promise.resolve() };
  }

  const startedAt = now();
  const pending = new Map(dependencies.map((name) => [name, createLatch()]));

  const probe = async (name) => {
    try {
      return Boolean(await isReady(name));
    } catch {
      return false;
    }
  };

  const open = (name) => {
    pending.get(name)?.release();
    pending.delete(name);
  };

  const poll = async () => {
    const deadline = startedAt + holdMs;
    while (pending.size > 0 && now() < deadline) {
      const names = [...pending.keys()];
      const results = await Promise.all(names.map(probe));
      names.filter((_name, index) => results[index]).forEach(open);
      const remaining = deadline - now();
      if (pending.size > 0 && remaining > 0) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));
      }
    }
    if (pending.size === 0) return;
    // These are fixed local service names, never a URL or a credential.
    log(`local dependencies were not healthy after ${holdMs} ms: ${[...pending.keys()].join(", ")}`);
    [...pending.keys()].forEach(open);
  };
  poll();

  return {
    isOpen: () => pending.size === 0,
    // Resolves on release or on abort. A caller must recheck its signal, because
    // nothing here tells it which of the two happened.
    wait: ({ dependencies: needed = [], signal } = {}) => {
      const latches = needed.flatMap((name) => pending.get(name)?.opened ?? []);
      if (latches.length === 0 || signal?.aborted) return Promise.resolve();
      const heldFrom = now();
      const released = Promise.all(latches).then(() => {
        // A delayed turn that looks like a slow provider is its own kind of
        // mystery, so a hold is always logged and never gated on the quiet
        // setting. A caller that already left was not held for anything.
        if (signal?.aborted) return;
        log(`held a routed request for ${now() - heldFrom} ms until ${needed.join(", ")} started`);
      });
      if (!signal) return released;
      return new Promise((resolve) => {
        const done = () => {
          signal.removeEventListener("abort", done);
          resolve();
        };
        signal.addEventListener("abort", done, { once: true });
        released.then(done);
      });
    },
  };
}
