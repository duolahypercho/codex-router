// Changelog entries live one-per-file until release.
//
// Every pull request used to append its bullet to the top of CHANGELOG.md's
// `## Unreleased` section, so two branches that shared no source file still
// collided there. `.gitattributes` answers that with `CHANGELOG.md merge=union`,
// which works for a local `git merge` -- and does nothing on GitHub, because
// GitHub's server-side merge does not run `.gitattributes` merge drivers. The
// result was a queue where a pull request reported CONFLICTING on github.com
// while merging cleanly on a maintainer's machine, and where every merge to
// `main` re-conflicted every other open pull request.
//
// A fragment per change removes the shared line entirely: two pull requests
// write two different files, so there is nothing to collide on. The fragments
// are folded into CHANGELOG.md once, at release.
//
// The union driver stays in `.gitattributes` for pull requests written before
// this landed, which still edit CHANGELOG.md directly. Both paths work; only
// the fragment path is conflict-free.

import { readFileSync, readdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";

export const FRAGMENT_DIR = "changelog.d";
export const UNRELEASED_HEADING = "## Unreleased";

// `README.md` documents the directory for contributors and is not an entry.
const NOT_A_FRAGMENT = new Set(["README.md"]);

export function fragmentPaths(root = process.cwd()) {
  const dir = path.join(root, FRAGMENT_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md") && !NOT_A_FRAGMENT.has(name))
    // Sorted so the assembled section is byte-identical on every machine.
    .sort()
    .map((name) => path.join(dir, name));
}

// A fragment is the bullet exactly as it will appear under `## Unreleased`, so
// what a reviewer reads in the pull request is what ships. The rules below are
// the ones that keep the assembled file valid Markdown; wording is not policed.
export function fragmentProblem(text, name) {
  const body = text.replace(/\s+$/, "");
  if (!body.trim()) return `${name} is empty`;
  if (!body.startsWith("- ")) {
    return `${name} must start with "- " so it reads as a bullet under ${UNRELEASED_HEADING}`;
  }
  const heading = body.split("\n").find((line) => /^#{1,6}\s/.test(line));
  if (heading) {
    return `${name} contains a Markdown heading (${heading.trim()}); a fragment is one bullet, and the release adds the heading`;
  }
  // A second top-level bullet is legal Markdown but makes one change read as
  // two entries. Separate changes get separate files, which is the whole point.
  const bullets = body.split("\n").filter((line) => line.startsWith("- ")).length;
  if (bullets > 1) {
    return `${name} holds ${bullets} top-level bullets; give each change its own file in ${FRAGMENT_DIR}/`;
  }
  return undefined;
}

export function readFragments(root = process.cwd()) {
  return fragmentPaths(root).map((file) => ({
    file,
    name: path.basename(file),
    text: readFileSync(file, "utf8"),
  }));
}

export function checkFragments(root = process.cwd()) {
  return readFragments(root)
    .map(({ text, name }) => fragmentProblem(text, name))
    .filter(Boolean);
}

// Folds every fragment into the `## Unreleased` section, newest-first like the
// entries already there, and reports what it moved. Writing nothing when there
// are no fragments keeps the release script idempotent.
export function assembleChangelog(root = process.cwd(), { dryRun = false } = {}) {
  const fragments = readFragments(root);
  const problems = fragments.map(({ text, name }) => fragmentProblem(text, name)).filter(Boolean);
  if (problems.length) throw new Error(problems.join("\n"));
  if (!fragments.length) return { moved: [], changed: false };

  const changelogPath = path.join(root, "CHANGELOG.md");
  const changelog = readFileSync(changelogPath, "utf8");
  const index = changelog.indexOf(`${UNRELEASED_HEADING}\n`);
  if (index === -1) {
    throw new Error(`CHANGELOG.md has no "${UNRELEASED_HEADING}" section to fold fragments into`);
  }
  const insertAt = index + `${UNRELEASED_HEADING}\n`.length;
  const bullets = fragments.map(({ text }) => `${text.replace(/\s+$/, "")}\n`).join("");
  const next = changelog.slice(0, insertAt) + bullets + changelog.slice(insertAt);

  if (!dryRun) {
    writeFileSync(changelogPath, next, "utf8");
    for (const { file } of fragments) rmSync(file);
  }
  return { moved: fragments.map(({ name }) => name), changed: true };
}
