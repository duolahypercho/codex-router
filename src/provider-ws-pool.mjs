// A Responses connection carries one full request at a time; leases never
// transfer connection-local previous_response_id state between requests.
import { createHash } from "node:crypto";
import { ResponsesWebSocketClient } from "./responses-ws-client.mjs";

const DEFAULT_IDLE_EVICT_MS = 120_000;

export class ProviderWebSocketPool {
  constructor({ connect, healthy = (connection) => !connection.closed,
    maxConnections = 4, acquireTimeoutMs = 5_000,
    idleEvictMs = DEFAULT_IDLE_EVICT_MS, now = Date.now } = {}) {
    this.connect = connect;
    this.healthy = healthy;
    this.maxConnections = maxConnections;
    this.acquireTimeoutMs = acquireTimeoutMs;
    this.idleEvictMs = idleEvictMs;
    this.now = now;
    this.idle = [];
    this.leased = new Set();
    this.opening = new Set();
    this.waiters = [];
    this.closed = false;
    this.lastUsed = now();
  }

  acquire(signal) {
    if (this.closed) return Promise.reject(new Error("Provider WebSocket pool is closed."));
    if (signal?.aborted) return Promise.reject(signal.reason || new Error("Request aborted."));
    if (this.waiters.length >= 64) return Promise.reject(new Error("Provider WebSocket wait queue is full."));
    this.lastUsed = this.now();
    return new Promise((resolve, reject) => {
      const waiter = { signal, done: false };
      const onAbort = () => waiter.finish(signal.reason || new Error("Request aborted."));
      const timer = setTimeout(() => {
        const error = new Error("Provider WebSocket pool acquisition timed out.");
        error.fallbackToHttp = true;
        waiter.finish(error);
      }, this.acquireTimeoutMs);
      timer.unref?.();
      waiter.finish = (error, connection) => {
        if (waiter.done) {
          if (connection) connection.abort();
          return;
        }
        waiter.done = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        if (error) {
          waiter.controller?.abort();
          reject(error);
        } else {
          connection.idleRef(false);
          this.leased.add(connection);
          let released = false;
          resolve({ connection, release: () => {
            if (released) return;
            released = true;
            this.release(connection);
          } });
        }
        this.pumpWaiters();
      };
      this.waiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      else this.pumpWaiters();
    });
  }

  pumpWaiters() {
    if (this.closed) return;
    while (this.waiters.length) {
      let connection;
      while (this.idle.length) {
        const entry = this.idle.shift();
        clearTimeout(entry.timer);
        if (this.healthy(entry.connection)) { connection = entry.connection; break; }
        entry.connection.abort();
      }
      if (connection) {
        this.waiters.shift().finish(undefined, connection);
        continue;
      }
      if (this.leased.size + this.opening.size >= this.maxConnections) return;
      const waiter = this.waiters.shift();
      waiter.controller = new AbortController();
      this.opening.add(waiter);
      Promise.resolve().then(() => this.connect(waiter.controller.signal)).then((opened) => {
        this.opening.delete(waiter);
        if (this.closed || waiter.done || waiter.signal?.aborted || !this.healthy(opened)) {
          opened.abort();
          waiter.finish(new Error("Provider WebSocket acquisition cancelled."));
        } else waiter.finish(undefined, opened);
      }, (error) => {
        this.opening.delete(waiter);
        waiter.finish(error);
      }).finally(() => this.pumpWaiters());
    }
  }

  release(connection) {
    if (!this.leased.delete(connection)) return;
    this.lastUsed = this.now();
    if (this.closed || !this.healthy(connection)) {
      connection.abort();
    } else {
      connection.idleRef(true);
      const entry = { connection };
      if (this.idleEvictMs !== Infinity) {
        entry.timer = setTimeout(() => {
          const index = this.idle.indexOf(entry);
          if (index >= 0) this.idle.splice(index, 1);
          connection.close(1000, "idle");
        }, this.idleEvictMs);
        entry.timer.unref?.();
      }
      this.idle.push(entry);
    }
    this.pumpWaiters();
  }

  closeAll() {
    this.closed = true;
    for (const entry of this.idle.splice(0)) {
      clearTimeout(entry.timer);
      entry.connection.abort();
    }
    for (const connection of this.leased) connection.abort();
    this.leased.clear();
    for (const waiter of [...this.waiters, ...this.opening]) {
      waiter.finish(new Error("Provider WebSocket pool closed."));
    }
  }
}

// Resolve every acquisition so disablement, endpoint edits and credential
// rotation cannot reuse a handshake authenticated with stale configuration.
export function providerPoolRegistry({ resolveProvider }) {
  const registry = new Map();
  let closed = false;
  const sweep = setInterval(() => {
    for (const [key, pool] of registry) {
      if (!pool.leased.size && !pool.opening.size && !pool.waiters.length && Date.now() - pool.lastUsed >= DEFAULT_IDLE_EVICT_MS) {
        pool.closeAll();
        registry.delete(key);
      }
    }
  }, DEFAULT_IDLE_EVICT_MS);
  sweep.unref?.();
  return {
    async poolFor(providerId, context) {
      if (closed) throw new Error("Provider WebSocket registry is closed.");
      const provider = resolveProvider(providerId, context);
      if (!provider) throw new Error("Provider is unavailable.");
      const target = await provider.wsTarget();
      if (closed) throw new Error("Provider WebSocket registry is closed.");
      const headers = Object.entries(target.headers || {}).map(([name, value]) => [name.toLowerCase(), value]).sort(([a], [b]) => a.localeCompare(b));
      const key = createHash("sha256").update(JSON.stringify([providerId, String(target.url), headers])).digest("hex");
      let pool = registry.get(key);
      if (!pool) {
        // shortcut: cap distinct handshake identities, add eviction policy if busy identities exceed 64.
        if (registry.size >= 64) throw new Error("Provider WebSocket registry is at capacity.");
        pool = new ProviderWebSocketPool({ connect: (signal) => ResponsesWebSocketClient.connect(target.url, { ...target, signal }) });
        registry.set(key, pool);
      }
      return pool;
    },
    closeAll() {
      closed = true;
      clearInterval(sweep);
      for (const pool of registry.values()) pool.closeAll();
      registry.clear();
    },
  };
}
