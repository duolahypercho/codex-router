// The LiteLLM virtual environment can be broken while every file it needs
// still exists: an interpreter home pointing at a cleared temporary directory
// (macOS wipes /private/tmp, and an installer that recorded a temporary
// Python as the venv home leaves `.venv/bin/python` dangling) keeps the
// launcher on disk but makes every spawn fail with a bare ENOENT. Probing the
// interpreter turns that silent failure into a checkable, fixable state.
import { spawnSync } from "node:child_process";

import { startupTimeoutMs } from "./startup-timeout.mjs";

// Report the final bounded probe outcome. `spawn` is injectable so tests can
// stub it without forking; permanent failures do not spend the timeout retry.
// Explicit timeouts win; otherwise the VDI-tunable environment applies, and
// the shipped bounds hold when it is unset. These cover process-start latency
// only — a fast genuine failure (ENOENT, bad exit) still reports at once.
export function venvRuntimeOutcome(
  python,
  { spawn = spawnSync, timeoutMs, retryTimeoutMs } = {},
) {
  const firstMs = timeoutMs ??
    startupTimeoutMs("CODEX_ROUTER_VENV_PROBE_TIMEOUT_MS", 15_000);
  const retryMs = retryTimeoutMs ??
    startupTimeoutMs("CODEX_ROUTER_VENV_PROBE_RETRY_TIMEOUT_MS", 45_000);
  const options = {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  };

  // A spawnSync timeout means Windows never finished scheduling the child; it
  // is not evidence that the interpreter or its venv is damaged. Retry once
  // with a wider hard bound before reporting a condition that can be transient
  // under process-launch contention.
  // `--version` is handled before CPython initializes its standard library,
  // so it can succeed even when the venv cannot import `encodings` and every
  // real invocation fails. Isolated mode also keeps an operator's PYTHONHOME
  // or PYTHONPATH from making a healthy managed environment look damaged.
  const probeArgs = ["-I", "-c", "import encodings, sys; print(sys.prefix)"];
  let probe = spawn(python, probeArgs, { ...options, timeout: firstMs });
  if (probe.error?.code === "ETIMEDOUT") {
    probe = spawn(python, probeArgs, { ...options, timeout: retryMs });
  }
  if (probe.error) {
    return probe.error.code === "ETIMEDOUT"
      ? { kind: "timeout", message: `timed out after ${retryMs} ms; transient process scheduling pressure is possible and this is not proof of a broken virtual environment` }
      : { kind: "failed", message: probe.error.message };
  }
  if (probe.status !== 0) {
    const detail = (probe.stderr || "").trim() || "no stderr";
    return { kind: "failed", message: `exited with code ${probe.status}: ${detail}` };
  }
  return { kind: "ok" };
}

// Preserve the string API used by doctor and dependency installation. The
// startup supervisor consumes the typed outcome without running a second probe.
export function venvRuntimeProblem(python, options) {
  return venvRuntimeOutcome(python, options).message;
}
