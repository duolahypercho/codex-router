import assert from "node:assert/strict";
import test from "node:test";

import { venvRuntimeProblem } from "../src/venv-runtime.mjs";

// process.execPath is the current Node binary: present on every platform
// (Windows runners have no /usr/bin/true), and `--version` exits 0 with
// stdout, so it is a portable "working interpreter".
test("a working interpreter has no runtime problem", () => {
  assert.equal(venvRuntimeProblem(process.execPath, { timeoutMs: 5_000 }), undefined);
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
