import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  FRAGMENT_DIR,
  UNRELEASED_HEADING,
  assembleChangelog,
  checkFragments,
  fragmentPaths,
  fragmentProblem,
} from "../scripts/changelog-fragments.mjs";

const CHANGELOG = `# Changelog

${UNRELEASED_HEADING}
- **An entry that was already here.** Existing text.

## 0.6.0
- **A released entry.** Shipped text.
`;

function workspace(fragments = {}, changelog = CHANGELOG) {
  const root = mkdtempSync(path.join(tmpdir(), "changelog-fragments-"));
  mkdirSync(path.join(root, FRAGMENT_DIR));
  writeFileSync(path.join(root, "CHANGELOG.md"), changelog, "utf8");
  for (const [name, text] of Object.entries(fragments)) {
    writeFileSync(path.join(root, FRAGMENT_DIR, name), text, "utf8");
  }
  return root;
}

test("a fragment is folded in under Unreleased and removed", () => {
  const root = workspace({ "a-change.md": "- **A new entry.** New text.\n" });
  try {
    const result = assembleChangelog(root);
    assert.deepEqual(result.moved, ["a-change.md"]);
    const changelog = readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
    assert.match(changelog, /## Unreleased\n- \*\*A new entry\.\*\* New text\.\n- \*\*An entry that was already here\.\*\*/);
    // The released section is untouched.
    assert.match(changelog, /## 0\.6\.0\n- \*\*A released entry\.\*\*/);
    assert.equal(existsSync(path.join(root, FRAGMENT_DIR, "a-change.md")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("several fragments fold in filename order so every machine agrees", () => {
  const root = workspace({
    "b-second.md": "- **Second.** Text.\n",
    "a-first.md": "- **First.** Text.\n",
  });
  try {
    const result = assembleChangelog(root);
    assert.deepEqual(result.moved, ["a-first.md", "b-second.md"]);
    const changelog = readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
    assert.ok(changelog.indexOf("**First.**") < changelog.indexOf("**Second.**"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the directory README is documentation, not an entry", () => {
  const root = workspace({ "README.md": "# Changelog fragments\n\nHow to add one.\n" });
  try {
    assert.deepEqual(fragmentPaths(root), []);
    assert.deepEqual(checkFragments(root), []);
    assert.equal(assembleChangelog(root).changed, false);
    assert.equal(readFileSync(path.join(root, "CHANGELOG.md"), "utf8"), CHANGELOG);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("assembling with no fragments leaves CHANGELOG.md byte-identical", () => {
  const root = workspace();
  try {
    assert.equal(assembleChangelog(root).changed, false);
    assert.equal(readFileSync(path.join(root, "CHANGELOG.md"), "utf8"), CHANGELOG);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a dry run reports what it would move without touching anything", () => {
  const root = workspace({ "a-change.md": "- **A new entry.** New text.\n" });
  try {
    const result = assembleChangelog(root, { dryRun: true });
    assert.deepEqual(result.moved, ["a-change.md"]);
    assert.equal(readFileSync(path.join(root, "CHANGELOG.md"), "utf8"), CHANGELOG);
    assert.equal(existsSync(path.join(root, FRAGMENT_DIR, "a-change.md")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a malformed fragment is refused rather than written into the changelog", () => {
  assert.match(fragmentProblem("", "empty.md"), /empty/);
  assert.match(fragmentProblem("Just prose.\n", "prose.md"), /must start with/);
  assert.match(fragmentProblem("## A heading\n\n- **x.** y.\n", "heading.md"), /must start with/);
  assert.match(fragmentProblem("- **x.** y.\n\n## A heading\n", "heading2.md"), /Markdown heading/);
  assert.match(fragmentProblem("- **x.** y.\n- **z.** w.\n", "two.md"), /2 top-level bullets/);
  assert.equal(fragmentProblem("- **x.** y.\n", "ok.md"), undefined);
  // A nested bullet belongs to the one entry and is not a second entry.
  assert.equal(fragmentProblem("- **x.** y.\n  - a nested point\n", "nested.md"), undefined);
});

test("assembly fails closed on a malformed fragment and writes nothing", () => {
  const root = workspace({ "bad.md": "not a bullet\n", "good.md": "- **Fine.** Text.\n" });
  try {
    assert.throws(() => assembleChangelog(root), /bad\.md must start with/);
    assert.equal(readFileSync(path.join(root, "CHANGELOG.md"), "utf8"), CHANGELOG);
    assert.equal(existsSync(path.join(root, FRAGMENT_DIR, "good.md")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a changelog with no Unreleased section is refused rather than guessed at", () => {
  const root = workspace({ "a.md": "- **x.** y.\n" }, "# Changelog\n\n## 0.6.0\n- **Released.** Text.\n");
  try {
    assert.throws(() => assembleChangelog(root), /no "## Unreleased" section/);
    assert.equal(existsSync(path.join(root, FRAGMENT_DIR, "a.md")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the repository's own fragments are valid", () => {
  const root = path.join(import.meta.dirname, "..");
  assert.deepEqual(checkFragments(root), []);
});
