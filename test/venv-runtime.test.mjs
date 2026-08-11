import assert from "node:assert/strict";
import test from "node:test";

import { venvRuntimeProblem } from "../src/venv-runtime.mjs";

test("a working interpreter has no runtime problem", () => {
  assert.equal(venvRuntimeProblem("/usr/bin/true", { timeoutMs: 5_000 }), undefined);
});

test("a missing interpreter reports the spawn failure", () => {
  const problem = venvRuntimeProblem("/nonexistent/python3.99");
  assert.match(problem, /ENOENT|no such file/i);
});

test("an interpreter that exits non-zero reports its status", () => {
  const problem = venvRuntimeProblem("/usr/bin/false");
  assert.match(problem, /exited with code 1/);
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
