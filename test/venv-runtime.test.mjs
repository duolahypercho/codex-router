import assert from "node:assert/strict";
import test from "node:test";

import { venvRuntimeProblem } from "../src/venv-runtime.mjs";

// The injected success keeps this test platform-independent while the probe
// arguments below verify that production forces real Python initialization.
test("a working interpreter has no runtime problem", () => {
  const calls = [];
  const spawn = (python, args) => {
    calls.push({ python, args });
    return { error: undefined, status: 0, stderr: "", stdout: "/venv\n" };
  };
  assert.equal(venvRuntimeProblem("python", { spawn, timeoutMs: 5_000 }), undefined);
  assert.deepEqual(calls, [
    {
      python: "python",
      args: ["-I", "-c", "import encodings, sys; print(sys.prefix)"],
    },
  ]);
});

test("the probe catches a runtime whose version command would still succeed", () => {
  const spawn = (_python, args) => {
    assert.notDeepEqual(args, ["--version"]);
    return {
      error: undefined,
      status: 1,
      stderr: "Fatal Python error: init_fs_encoding: No module named 'encodings'\n",
      stdout: "",
    };
  };
  assert.match(venvRuntimeProblem("python", { spawn }), /encodings/);
});

test("a transient interpreter timeout is retried with a wider hard bound", () => {
  const timeouts = [];
  const spawn = (_python, _args, { timeout }) => {
    timeouts.push(timeout);
    if (timeouts.length === 1) {
      return {
        error: Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" }),
        status: null,
        stderr: "",
        stdout: "",
      };
    }
    return { error: undefined, status: 0, stderr: "", stdout: "Python 3.13.4\n" };
  };

  assert.equal(venvRuntimeProblem("python", { spawn }), undefined);
  assert.deepEqual(timeouts, [15_000, 45_000]);
});

test("a persistent interpreter timeout is not called permanent venv corruption", () => {
  let calls = 0;
  const timedOut = () => ({
    error: Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" }),
    status: null,
    stderr: "",
    stdout: "",
  });
  const problem = venvRuntimeProblem("python", {
    spawn: () => {
      calls += 1;
      return timedOut();
    },
  });

  assert.equal(calls, 2);
  assert.match(problem, /timed out after 45000 ms/);
  assert.match(problem, /transient/i);
  assert.match(problem, /not proof of a broken virtual environment/i);
});

test("a non-timeout spawn failure is not retried", () => {
  let calls = 0;
  const problem = venvRuntimeProblem("python", {
    spawn: () => {
      calls += 1;
      return {
        error: Object.assign(new Error("spawnSync ENOENT"), { code: "ENOENT" }),
        status: null,
        stderr: "",
        stdout: "",
      };
    },
  });

  assert.equal(calls, 1);
  assert.match(problem, /ENOENT/);
});

test("a missing interpreter reports the spawn failure", () => {
  const problem = venvRuntimeProblem("/nonexistent/python3.99");
  assert.match(problem, /ENOENT|no such file/i);
});

test("an interpreter that exits non-zero reports its status", () => {
  // A probe that deliberately fails: the injected spawn returns status 1, so
  // the assertion does not depend on any platform-specific failing binary.
  const problem = venvRuntimeProblem("interpreter", {
    spawn: () => ({ error: undefined, status: 1, stderr: "boom\n", stdout: "" }),
  });
  assert.match(problem, /exited with code 1: boom/);
});

test("the spawn is injectable for hermetic tests", () => {
  let called = 0;
  const spawn = () => {
    called += 1;
    return { error: undefined, status: 0, stderr: "", stdout: "Python 3.12.12\n" };
  };
  assert.equal(venvRuntimeProblem("python", { spawn }), undefined);
  assert.equal(called, 1);
});
