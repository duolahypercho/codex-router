import net from "node:net";

// Kernel handles own these short-lived leases; no stale pathname can grant ownership.
const POSIX_OWNER_LEASE_PORT_COUNT = 10_000;
const FNV64_OFFSET = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;

function fnv1a64(value, seed = FNV64_OFFSET) {
  let hash = seed;
  for (const byte of Buffer.from(value, "utf8")) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * FNV64_PRIME);
  }
  return hash;
}

function ownerLeaseIdentity(value) {
  // This is routing, not credential verification: a collision can only deny a
  // lease, never admit two owners. A non-cryptographic digest states that
  // contract plainly and avoids treating a credential pathname as a password.
  const first = fnv1a64(`first\0${value}`);
  const second = fnv1a64(`second\0${value}`, FNV64_OFFSET ^ 0x9e3779b97f4a7c15n);
  return {
    id: `${first.toString(16).padStart(16, "0")}${second.toString(16).padStart(16, "0")}`
      .slice(0, 24),
    portOffset: Number(first & 0xffffffffn),
  };
}

export function ownerLeaseEndpoint(namespace, identity, posixPortBase, { family = "antigravity" } = {}) {
  const leaseIdentity = ownerLeaseIdentity(`${namespace}\0${identity}`);
  if (process.platform === "win32") {
    // Named-pipe ownership belongs to the server handle. Windows removes the
    // pipe instance when its process dies, and a suspended process retains it.
    return `\\\\.\\pipe\\codex-router-${family}-${namespace}-${leaseIdentity.id}`;
  }
  // Linux has abstract Unix sockets, but macOS does not. A deterministic
  // loopback listener gives both platforms the same kernel-owned lifetime and
  // atomic exclusion without a stale filesystem pathname. A hash collision or
  // unrelated listener can deny this refresh temporarily, but can never allow
  // two owners; acquisition therefore fails closed after the bounded wait.
  return {
    host: "127.0.0.1",
    port: posixPortBase +
      (leaseIdentity.portOffset % POSIX_OWNER_LEASE_PORT_COUNT),
    exclusive: true,
  };
}


function listenOwnerServer(server, endpoint, callback) {
  if (process.platform !== "win32" || typeof endpoint !== "string") {
    server.listen(endpoint, callback);
    return;
  }

  // Node 22/24/26 can access-violate after a named-pipe bind loses with
  // EADDRINUSE when this inherited tuning variable caused libuv to mark the
  // unbound handle as a pipe server first (nodejs/node#65057). Node reads the
  // variable synchronously inside listen(), so remove it only around that
  // call and restore the operator's process environment before yielding.
  const hadPendingInstances = Object.hasOwn(process.env, "NODE_PENDING_PIPE_INSTANCES");
  const pendingInstances = process.env.NODE_PENDING_PIPE_INSTANCES;
  delete process.env.NODE_PENDING_PIPE_INSTANCES;
  try {
    server.listen(endpoint, callback);
  } finally {
    if (hadPendingInstances) process.env.NODE_PENDING_PIPE_INSTANCES = pendingInstances;
  }
}

export function startOwnerServer(endpoint) {
  return new Promise((resolve, reject) => {
    // This temporary listener is a kernel lease, not a long-lived HTTP server
    // entry point. Production entry points remain responsible for installing
    // the process-wide stable fetch dispatcher exactly once.
    const server = new net.Server((socket) => socket.destroy());
    const onError = (error) => {
      reject(error);
    };
    server.once("error", onError);
    listenOwnerServer(server, endpoint, () => {
      server.off("error", onError);
      // A later accept error must not become an unhandled process crash. Only
      // closing this listening handle (or process death) releases ownership.
      server.on("error", () => {});
      server.unref();
      resolve(server);
    });
  });
}

export async function closeOwnerServer(owner) {
  if (!owner?.server) return;
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 1_000);
    timer.unref?.();
    try {
      owner.server.close(finish);
    } catch {
      finish();
    }
  });
}
