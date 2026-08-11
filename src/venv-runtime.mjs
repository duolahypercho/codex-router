// The LiteLLM virtual environment can be broken while every file it needs
// still exists: an interpreter home pointing at a cleared temporary directory
// (macOS wipes /private/tmp, and an installer that recorded a temporary
// Python as the venv home leaves `.venv/bin/python` dangling) keeps the
// launcher on disk but makes every spawn fail with a bare ENOENT. Probing the
// interpreter turns that silent failure into a checkable, fixable state.
import { spawnSync } from "node:child_process";

// Returns undefined when the interpreter runs, or a human-readable reason it
// cannot. `spawn` is injectable so tests can stub it without forking.
export function venvRuntimeProblem(python, { spawn = spawnSync, timeoutMs = 15_000 } = {}) {
  const probe = spawn(python, ["--version"], {
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (probe.error) return probe.error.message;
  if (probe.status !== 0) {
    const detail = (probe.stderr || "").trim() || "no stderr";
    return `exited with code ${probe.status}: ${detail}`;
  }
  return undefined;
}
