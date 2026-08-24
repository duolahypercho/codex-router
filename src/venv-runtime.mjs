// The LiteLLM virtual environment can be broken while every file it needs
// still exists: an interpreter home pointing at a cleared temporary directory
// (macOS wipes /private/tmp, and an installer that recorded a temporary
// Python as the venv home leaves `.venv/bin/python` dangling) keeps the
// launcher on disk but makes every spawn fail with a bare ENOENT. Probing the
// interpreter turns that silent failure into a checkable, fixable state.
import { spawnSync } from "node:child_process";

// Returns undefined when the interpreter runs, or a human-readable reason it
// cannot. `spawn` is injectable so tests can stub it without forking.
export function venvRuntimeProblem(
  python,
  { spawn = spawnSync, timeoutMs = 15_000, retryTimeoutMs = 45_000 } = {},
) {
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
  let probe = spawn(python, probeArgs, { ...options, timeout: timeoutMs });
  if (probe.error?.code === "ETIMEDOUT") {
    probe = spawn(python, probeArgs, { ...options, timeout: retryTimeoutMs });
  }
  if (probe.error) {
    return probe.error.code === "ETIMEDOUT"
      ? `timed out after ${retryTimeoutMs} ms; transient process scheduling pressure is possible and this is not proof of a broken virtual environment`
      : probe.error.message;
  }
  if (probe.status !== 0) {
    const detail = (probe.stderr || "").trim() || "no stderr";
    return `exited with code ${probe.status}: ${detail}`;
  }
  return undefined;
}
