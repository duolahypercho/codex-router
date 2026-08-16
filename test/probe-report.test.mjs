import assert from "node:assert/strict";
import test from "node:test";

import { ProbeReport, truncateForReport } from "../src/probe-report.mjs";

test("checks render in the shape bin/doctor already uses", () => {
  const report = new ProbeReport({ title: "probe" });
  report.pass("session", "read from disk");
  report.fail("model list", "nothing decoded", { expected: "one model", observed: "zero", fix: "paste this" });

  const rendered = report.render();
  assert.match(rendered, /^PASS {2}session: read from disk$/m);
  assert.match(rendered, /^FAIL {2}model list: nothing decoded$/m);
  assert.match(rendered, /^ {6}expected: one model$/m);
  assert.match(rendered, /^ {6}observed: zero$/m);
  assert.match(rendered, /^ {6}fix: paste this$/m);
});

test("a run that reached nothing is INCONCLUSIVE, not a pass", () => {
  // The failure this whole exercise is about: a run that never got far enough
  // to test anything must not read as confirmation.
  const report = new ProbeReport();
  report.skip("live turn", "not attempted");
  assert.equal(report.verdict(), "INCONCLUSIVE");
  assert.equal(report.exitCode(), 0);
});

test("a skipped or warned run is PARTIAL, and only a clean run is PASS", () => {
  const partial = new ProbeReport();
  partial.pass("session", "ok");
  partial.skip("live turn", "not attempted");
  assert.equal(partial.verdict(), "PARTIAL");

  const clean = new ProbeReport();
  clean.pass("session", "ok");
  clean.info("host", "example.invalid");
  assert.equal(clean.verdict(), "PASS");
});

test("one failure decides the verdict and the exit code no matter what else passed", () => {
  const report = new ProbeReport();
  for (let index = 0; index < 10; index += 1) report.pass(`check ${index}`, "ok");
  report.fail("tool calls decoded", "none arrived");
  assert.equal(report.verdict(), "FAIL");
  assert.equal(report.exitCode(), 1);
  assert.equal(report.failed, true);
});

test("the summary line counts every status", () => {
  const report = new ProbeReport();
  report.pass("a", "ok");
  report.pass("b", "ok");
  report.warn("c", "hm");
  report.fail("d", "no");
  report.skip("e", "later");
  report.info("f", "note");

  assert.deepEqual(report.counts(), { fail: 1, warn: 1, pass: 2, info: 1, skip: 1 });
  assert.match(report.render(), /VERDICT FAIL — 2 pass, 1 fail, 1 warn, 1 skipped/);
});

test("the paste block is fenced and carries the environment a maintainer needs", () => {
  const report = new ProbeReport({
    title: "codex-router devin-cli probe",
    environment: { node: "v22.19.0", "devin cli": "3000.4.25", empty: "", missing: undefined },
  });
  report.pass("session", "ok");

  const block = report.pasteBlock();
  assert.match(block, /^```text\n/);
  assert.match(block, /```\n$/);
  assert.match(block, /^node: v22\.19\.0$/m);
  assert.match(block, /^devin cli: 3000\.4\.25$/m);
  assert.equal(block.includes("empty:"), false);
  assert.equal(block.includes("missing:"), false);
});

test("the JSON form carries the same verdict as the text form", () => {
  const report = new ProbeReport({ title: "probe", environment: { node: "v22" } });
  report.fail("x", "y", { observed: "z" });
  const json = report.toJson();
  assert.equal(json.verdict, "FAIL");
  assert.equal(json.title, "probe");
  assert.deepEqual(json.environment, { node: "v22" });
  assert.deepEqual(json.checks, [{ status: "fail", name: "x", detail: "y", observed: "z" }]);
});

test("an unknown status is refused rather than rendered as one", () => {
  const report = new ProbeReport();
  assert.throws(() => report.add({ status: "maybe", name: "x", detail: "y" }), /unknown status maybe/);
});

test("addAll accepts the arrays the check modules return", () => {
  const report = new ProbeReport();
  report.addAll([
    { status: "pass", name: "a", detail: "ok" },
    { status: "fail", name: "b", detail: "no" },
  ]);
  assert.equal(report.checks.length, 2);
  assert.equal(report.verdict(), "FAIL");
});

test("long observed values are cut with their real length attached", () => {
  const long = "x".repeat(500);
  const cut = truncateForReport(long, 20);
  assert.equal(cut.startsWith("x".repeat(20)), true);
  assert.match(cut, /\(500 chars\)$/);
  assert.equal(truncateForReport("short", 20), "short");
  assert.equal(truncateForReport({ a: 1 }), '{"a":1}');
});
