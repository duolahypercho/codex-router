import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// A console process spawned by a parent that has no console of its own -- the
// Electron Control Center and the tray -- gets its own window unless
// `windowsHide` is set. The helpers those parents reach run on routine
// refreshes, so one missing flag produced a burst of visible PowerShell
// windows every time a message was sent (issue #565).
//
// A source assertion is the only cheap guard here: the failure is invisible on
// macOS and Linux, and reproducing it needs a Windows desktop session.
//
// The exemption is a property of the call, not a list of files: a process that
// inherits stdin is prompting the operator through a console that already
// exists, and `windowsHide` is not what governs that case. Everything else --
// stdio `ignore` or `pipe` -- is a background helper with nothing to show.
function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.isFile() && entry.name.endsWith(".mjs") ? [full] : [];
  });
}

// Balanced-paren slice of the call's argument list, so a nested object or a
// trailing callback cannot truncate it.
function callArguments(source, callIndex) {
  const open = source.indexOf("(", callIndex);
  if (open === -1) return "";
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "(") depth += 1;
    else if (source[index] === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  return source.slice(open);
}

// Options, and `stdio` within them, are sometimes variables rather than
// literals. Resolve one level of each so a hoisted options object or a
// computed stdio still counts; anything deeper is out of scope for a guard
// whose job is to catch a forgotten flag at the call site.
function resolvedOptions(source, argumentText) {
  const objectNames = [...argumentText.matchAll(/\b([A-Za-z_$][\w$]*)\s*(?:,|\))/g)].map(
    (match) => match[1],
  );
  const objects = objectNames
    .map((name) => {
      const declared = new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=\\s*\\{`).exec(source);
      return declared ? callObject(source, declared.index) : "";
    })
    .join("\n");
  const withObjects = `${argumentText}\n${objects}`;
  const stdioNames = [...withObjects.matchAll(/stdio:\s*([A-Za-z_$][\w$]*)/g)].map(
    (match) => match[1],
  );
  const stdioValues = stdioNames
    .map((name) => {
      const declared = new RegExp(
        `\\b(?:const|let|var)\\s+${name}\\s*=\\s*([^;\\n]*(?:\\n[^;\\n]*)*?);`,
      ).exec(source);
      return declared ? `stdio: ${declared[1]}` : "";
    })
    .join("\n");
  return `${withObjects}\n${stdioValues}`;
}

function callObject(source, index) {
  const open = source.indexOf("{", index);
  if (open === -1) return "";
  let depth = 0;
  for (let cursor = open; cursor < source.length; cursor += 1) {
    if (source[cursor] === "{") depth += 1;
    else if (source[cursor] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, cursor + 1);
    }
  }
  return source.slice(open);
}

function powershellCalls() {
  const calls = [];
  for (const file of sourceFiles(path.join(root, "src"))) {
    const source = readFileSync(file, "utf8");
    const pattern = /\b(execFileSync|execFile|spawnSync|spawn)\s*\(/g;
    let match;
    while ((match = pattern.exec(source))) {
      const argumentText = callArguments(source, match.index);
      if (!/powershell|pwsh/i.test(argumentText)) continue;
      const options = resolvedOptions(source, argumentText);
      calls.push({
        where: `${path.relative(root, file)}:${source.slice(0, match.index).split("\n").length}`,
        // The stdio value may be a literal, a variable, or a ternary over
        // both; what matters is whether any branch inherits a console.
        interactive: /stdio:[^\n]*inherit/.test(options),
        hidden: /windowsHide\s*:\s*true/.test(options),
      });
    }
  }
  return calls;
}

test("every background PowerShell invocation hides its console window", () => {
  const offenders = powershellCalls()
    .filter((call) => !call.interactive && !call.hidden)
    .map((call) => call.where);
  assert.deepEqual(
    offenders,
    [],
    `PowerShell launched without windowsHide: true:\n  ${offenders.join("\n  ")}`,
  );
});

test("the scan actually finds the PowerShell call sites it is guarding", () => {
  // A regex that silently stops matching would make the guard above pass for
  // the wrong reason, so assert the population it inspects.
  const calls = powershellCalls();
  assert.ok(calls.length >= 8, `expected the scan to find call sites, saw ${calls.length}`);
  assert.ok(
    calls.some((call) => call.where.startsWith("src/file-security.mjs")),
    "the helper every private write reaches must be covered",
  );
  assert.ok(
    calls.some((call) => call.interactive),
    "the interactive prompts must still be recognised as interactive",
  );
});
