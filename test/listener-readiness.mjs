// Readiness for tests that spawn the router beside the API forwarder it
// proxies through. Nothing orders those processes' startup, so the router can
// already serve /models while the forwarder has not bound its port. A test that
// polled only the router could send its first turn to that closed port and get
// back the router's own opaque 502, and a bounded loop that ran out of attempts
// started the turn anyway. Wait for every listener, and fail with the
// children's output instead of proceeding.

const STDERR_TAIL = 8_000;

/** Keeps a bounded stderr tail per child; interpolates as a labelled report. */
export function childOutput() {
  const tails = new Map();
  return {
    capture(label, child) {
      tails.set(label, "");
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        tails.set(label, `${tails.get(label)}${chunk}`.slice(-STDERR_TAIL));
      });
      return child;
    },
    toString() {
      return [...tails].map(([label, text]) => `[${label}]\n${text}`).join("\n");
    },
  };
}

export async function waitForListeners(targets, { children, output, timeoutMs = 15_000 }) {
  const deadline = Date.now() + timeoutMs;
  const pending = new Map(targets.map((target) => [target.url, target]));
  while (pending.size > 0) {
    // A child killed by a signal reports exitCode null and signalCode set.
    const exited = children.find((child) => child.exitCode !== null || child.signalCode !== null);
    if (exited) {
      const status = exited.exitCode ?? exited.signalCode;
      throw new Error(`A router child exited before it was ready (${status}):\n${output}`);
    }
    if (Date.now() > deadline) {
      const names = [...pending.values()].map((target) => target.name).join(", ");
      throw new Error(`Timed out waiting for ${names}:\n${output}`);
    }
    for (const target of [...pending.values()]) {
      try {
        // Bound each poll so a listener that accepts but never answers cannot
        // hold the loop past its deadline.
        const remaining = Math.max(1, Math.min(2_000, deadline - Date.now()));
        const response = await fetch(target.url, {
          headers: target.headers,
          signal: AbortSignal.timeout(remaining),
        });
        await response.arrayBuffer();
        if (response.ok) pending.delete(target.url);
      } catch {
        // Not listening yet.
      }
    }
    if (pending.size > 0) await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
