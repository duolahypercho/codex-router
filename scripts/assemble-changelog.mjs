#!/usr/bin/env node
// Folds `changelog.d/*.md` into CHANGELOG.md's `## Unreleased` section and
// deletes the fragments. Run this once when cutting a release, then commit the
// result. `--check` validates the fragments without writing anything, which is
// what `npm run check` calls on every pull request.

import { assembleChangelog, checkFragments, fragmentPaths, FRAGMENT_DIR } from "./changelog-fragments.mjs";

const root = process.cwd();
const args = new Set(process.argv.slice(2));

if (args.has("--check")) {
  const problems = checkFragments(root);
  if (problems.length) {
    for (const problem of problems) process.stderr.write(`changelog fragment: ${problem}\n`);
    process.exit(1);
  }
  process.stdout.write(`changelog fragments valid (${fragmentPaths(root).length})\n`);
  process.exit(0);
}

const dryRun = args.has("--dry-run");
let result;
try {
  result = assembleChangelog(root, { dryRun });
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}

if (!result.changed) {
  process.stdout.write(`no fragments in ${FRAGMENT_DIR}/; CHANGELOG.md unchanged\n`);
} else {
  const verb = dryRun ? "would fold" : "folded";
  process.stdout.write(`${verb} ${result.moved.length} fragment(s) into CHANGELOG.md:\n`);
  for (const name of result.moved) process.stdout.write(`  ${name}\n`);
}
