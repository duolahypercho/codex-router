import { probeDelayMs, probeTimeoutMs } from "./health-backoff.mjs";

// Startup gates each service on an HTTP health probe. The loop used to treat
// every failed probe the same, and that was the defect: on loopback, a port
// with nothing behind it refuses instantly, so a refusal is real evidence that
// the service is not up, while a probe we abort ourselves is evidence of
// nothing at all -- something accepted the connection, or this machine was too
// starved to schedule the answer inside the window we allowed. Charging both to
// the same budget let a live, healthy forwarder be declared dead under
// fork/exec contention.
//
// So the two outcomes are handled differently:
//   * refused  -> back off before retrying. Probes are free and the evidence is
//                 conclusive, so the only thing left to manage is the flood of
//                 access-log lines a cold-starting gateway would otherwise get.
//   * aborted  -> retry immediately with a wider window. The probe already
//                 spent its entire timeout waiting, which is backoff enough;
//                 sleeping on top of it only burns budget without learning
//                 anything, and the next probe needs to be *wider*, not later.
//
// The services also announce themselves on stderr ("[api-forwarder] listening"),
// which looks like corroborating evidence, but start.mjs spawns them with
// inherited stdio so that line goes straight to the service log and is not
// readable here without piping and re-forwarding every child's output. That
// would change log ordering for every service and risk a full pipe stalling a
// child, to learn something weaker than the probe already establishes:
// "listening" is not "healthy", and the router wait checks the payload too.
//
// One consequence of a bounded-but-wide window: the last probe of a budget can
// run past the deadline by up to its own window, so a service that accepts
// connections and never answers is reported up to MAX_PROBE_TIMEOUT_MS late.
// That is the right trade -- the alternative is spending the tail of the budget
// on narrow probes that cannot conclude anything -- and a service that died is
// still reported sooner than it used to be, because the backoff sleep after the
// probe is cut short the moment the child exits.

function hasExited(child) {
  return Boolean(child) && (child.exitCode !== null || child.signalCode !== null);
}

/**
 * Poll `url` until the service behind it is healthy.
 *
 * Rejects when the child exits, when startup is interrupted, or when the
 * budget runs out. A child exit cuts the backoff sleep short, so a crash is
 * reported without waiting out a sleep the dead process cannot benefit from.
 */
export async function waitForHealth({
  label,
  url,
  headers = {},
  timeoutMs = 30_000,
  expectedService,
  child,
  fetchImpl = fetch,
  isShuttingDown = () => false,
}) {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  let lastFailure = "the service never answered";

  const assertStillStarting = () => {
    if (hasExited(child)) throw new Error(`${label} exited before becoming healthy.`);
    if (isShuttingDown()) throw new Error("Service startup was interrupted.");
  };

  // Deliberately no "exit" listener on the child. Waking the backoff sleep the
  // moment a service dies is a genuine improvement and it is not worth what it
  // costs here: on Windows, reaching into this loop from the child's exit
  // callback while startup is already unwinding kills the process with
  // 0xC0000409 on a libuv assertion (!(handle->flags & UV_HANDLE_CLOSING),
  // win/async.c:94) -- in the middle of reporting the failure it had already
  // diagnosed correctly. Two narrower attempts at keeping it did not help, so
  // the exit is detected where it always was, by assertStillStarting() between
  // the probe and the sleep. A dead child costs at most one backoff interval,
  // exactly as it did before, and the widened probe window plus the
  // abort-versus-refusal split -- the actual point of this change -- are intact.
  const sleep = (ms) =>
    ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

  {
    while (Date.now() < deadline) {
      assertStillStarting();

      const windowMs = probeTimeoutMs(attempt);
      let timedOut = false;
      try {
        // AbortSignal.timeout rather than a hand-rolled AbortController and
        // setTimeout. The two look interchangeable and are not: this is the
        // mechanism that was here before, it is managed by Node rather than by
        // a userland timer this loop has to remember to clear on every exit
        // path, and a manual controller here crashed Node on Windows -- a libuv
        // assertion in win/async.c, killing startup with 0xC0000409 while it was
        // reporting a failure it had already diagnosed correctly.
        const response = await fetchImpl(url, {
          headers,
          signal: AbortSignal.timeout(windowMs),
        });
        if (response.ok) {
          if (!expectedService) return;
          const payload = await response.json().catch(() => ({}));
          if (payload.service === expectedService) return;
          lastFailure = `the health response did not identify ${expectedService}`;
        } else {
          lastFailure = `the service answered HTTP ${response.status}`;
        }
      } catch (error) {
        // The distinction the whole fix rests on. A refusal is conclusive; a
        // window we closed ourselves concluded nothing. AbortSignal.timeout
        // rejects with a TimeoutError, and undici surfaces it either directly
        // or wrapped, so check both.
        timedOut = error?.name === "TimeoutError" || error?.cause?.name === "TimeoutError";
        lastFailure = timedOut
          ? `the service did not answer within ${windowMs} ms`
          : "the connection was refused";
      }

      const wait = timedOut
        ? 0
        : Math.min(probeDelayMs(attempt), Math.max(0, deadline - Date.now()));
      attempt += 1;
      assertStillStarting();
      await sleep(wait);
    }
    throw new Error(`Timed out waiting for ${label} to become healthy (${lastFailure}).`);
  }
}
