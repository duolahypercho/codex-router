export const DEFAULT_GROK_MAX_INFLIGHT = 6;
export const MAX_GROK_MAX_INFLIGHT = 64;

export function grokInflightLimit(environment = process.env) {
  const raw = environment.CODEX_ROUTER_GROK_MAX_INFLIGHT;
  if (raw == null || String(raw).trim() === "") return DEFAULT_GROK_MAX_INFLIGHT;
  if (!/^\d+$/.test(String(raw).trim())) return DEFAULT_GROK_MAX_INFLIGHT;
  const value = Number(String(raw).trim());
  if (value < 1 || value > MAX_GROK_MAX_INFLIGHT) return DEFAULT_GROK_MAX_INFLIGHT;
  return value;
}

function abortError() {
  const error = new Error("The Grok upstream request was aborted while waiting for a free stream.");
  error.name = "AbortError";
  return error;
}

// One slot per in-flight POST /responses body. A healthy turn acquires
// immediately. Extra children wait here instead of opening another socket.
export function createGrokInflightGate(limit = DEFAULT_GROK_MAX_INFLIGHT) {
  let active = 0;
  const waiters = [];

  const grant = (waiter) => {
    waiter.cleanup?.();
    if (waiter.signal?.aborted) {
      waiter.reject(abortError());
      return false;
    }
    active += 1;
    waiter.resolve();
    return true;
  };

  const releaseSlot = () => {
    active = Math.max(0, active - 1);
    while (waiters.length > 0) {
      if (grant(waiters.shift())) return;
    }
  };

  return {
    async acquire(signal) {
      if (signal?.aborted) throw abortError();
      if (active < limit) {
        active += 1;
        return releaseSlot;
      }
      await new Promise((resolve, reject) => {
        let settled = false;
        const waiter = {
          signal,
          settle(fn) {
            if (settled) return;
            settled = true;
            waiter.cleanup?.();
            fn();
          },
          resolve() { waiter.settle(resolve); },
          reject(error) { waiter.settle(() => reject(error)); },
        };
        if (signal) {
          const onAbort = () => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) waiters.splice(index, 1);
            waiter.reject(abortError());
          };
          signal.addEventListener("abort", onAbort, { once: true });
          waiter.cleanup = () => signal.removeEventListener("abort", onAbort);
        }
        waiters.push(waiter);
      });
      return releaseSlot;
    },
    release: releaseSlot,
  };
}

// The slot stays taken until the upstream body ends, errors, or is cancelled.
// Releasing on response headers would free it while the socket is still open.
export function responseWithInflightRelease(response, release) {
  if (!response?.body) {
    release();
    return response;
  }
  let released = false;
  const finish = () => {
    if (released) return;
    released = true;
    release();
  };
  let reader;
  try {
    reader = response.body.getReader();
  } catch (error) {
    finish();
    throw error;
  }
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          finish();
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    cancel(reason) {
      finish();
      return reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
