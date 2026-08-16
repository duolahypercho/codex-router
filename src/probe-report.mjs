// A checklist for probes whose output a stranger has to paste into an issue.
//
// A probe that prints one boolean answers "did anything happen". A probe whose
// findings are worth a maintainer's time answers "which of the things we assumed
// held, and what came back instead for the ones that did not". This renders the
// second, in the same `STATUS name: detail` shape `bin/doctor` already uses, and
// adds two things a remote tester needs: the observed value on every failure,
// and a single fenced block that is safe and sufficient to paste back.

const STATUS_ORDER = Object.freeze(["fail", "warn", "pass", "info", "skip"]);
const FAILING = new Set(["fail"]);

export class ProbeReport {
  constructor({ title = "probe", environment = {} } = {}) {
    this.title = title;
    this.environment = environment;
    this.checks = [];
  }

  add(check) {
    const status = String(check?.status || "info").toLowerCase();
    if (!STATUS_ORDER.includes(status)) throw new Error(`probe-report: unknown status ${status}`);
    const entry = {
      status,
      name: String(check?.name || ""),
      detail: String(check?.detail || ""),
    };
    if (check?.expected !== undefined) entry.expected = String(check.expected);
    if (check?.observed !== undefined) entry.observed = String(check.observed);
    if (check?.fix) entry.fix = String(check.fix);
    this.checks.push(entry);
    return entry;
  }

  addAll(checks = []) {
    for (const check of checks) this.add(check);
    return this;
  }

  pass(name, detail, extra) {
    return this.add({ ...extra, status: "pass", name, detail });
  }

  fail(name, detail, extra) {
    return this.add({ ...extra, status: "fail", name, detail });
  }

  warn(name, detail, extra) {
    return this.add({ ...extra, status: "warn", name, detail });
  }

  info(name, detail, extra) {
    return this.add({ ...extra, status: "info", name, detail });
  }

  skip(name, detail, extra) {
    return this.add({ ...extra, status: "skip", name, detail });
  }

  get failed() {
    return this.checks.some((check) => FAILING.has(check.status));
  }

  counts() {
    const totals = Object.fromEntries(STATUS_ORDER.map((status) => [status, 0]));
    for (const check of this.checks) totals[check.status] += 1;
    return totals;
  }

  // Three outcomes, not two. A run that never reached the thing it was meant to
  // test is not a pass, and calling it one is how "seems to work" gets reported.
  verdict() {
    if (this.failed) return "FAIL";
    if (!this.checks.some((check) => check.status === "pass")) return "INCONCLUSIVE";
    if (this.checks.some((check) => check.status === "skip" || check.status === "warn")) return "PARTIAL";
    return "PASS";
  }

  render() {
    const lines = [];
    for (const check of this.checks) {
      lines.push(`${check.status.toUpperCase().padEnd(5)} ${check.name}: ${check.detail}`);
      if (check.expected !== undefined) lines.push(`      expected: ${check.expected}`);
      if (check.observed !== undefined) lines.push(`      observed: ${check.observed}`);
      if (check.fix) lines.push(`      fix: ${check.fix}`);
    }
    const totals = this.counts();
    lines.push("");
    lines.push(
      `VERDICT ${this.verdict()} — ${totals.pass} pass, ${totals.fail} fail, ${totals.warn} warn, ${totals.skip} skipped`,
    );
    return `${lines.join("\n")}\n`;
  }

  toJson() {
    return {
      title: this.title,
      verdict: this.verdict(),
      environment: this.environment,
      counts: this.counts(),
      checks: this.checks,
    };
  }

  // What the tester pastes. Fenced so a GitHub comment keeps the alignment, and
  // limited to the checklist plus environment facts, never a response body.
  pasteBlock() {
    const environment = Object.entries(this.environment)
      .filter(([, value]) => value !== undefined && value !== "")
      .map(([key, value]) => `${key}: ${value}`);
    return [
      "```text",
      `${this.title}`,
      ...environment,
      "",
      this.render().trimEnd(),
      "```",
      "",
    ].join("\n");
  }

  exitCode() {
    return this.failed ? 1 : 0;
  }
}

export function truncateForReport(value, limit = 200) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (typeof text !== "string") return String(value);
  return text.length > limit ? `${text.slice(0, limit)}… (${text.length} chars)` : text;
}
