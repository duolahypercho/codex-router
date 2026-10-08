# Changelog fragments

One file per change. At release they are folded into `CHANGELOG.md` under
`## Unreleased`, newest-first, and deleted.

## Why this exists

Every pull request used to append its bullet to the top of the same
`## Unreleased` section, so two branches that shared no source file still
collided there. `.gitattributes` answers that with `CHANGELOG.md merge=union`,
which resolves a local `git merge` — and does nothing on GitHub, because
GitHub's server-side merge does not run `.gitattributes` merge drivers.

So a pull request would report CONFLICTING on github.com while merging cleanly
on a maintainer's machine, and every merge to `main` re-conflicted every other
open pull request. Two pull requests writing two different files have nothing
to collide on.

## Adding one

Create `changelog.d/<short-slug>.md` containing the bullet exactly as it should
appear in the changelog:

```markdown
- **The lede is a full sentence in bold.** Then the detail: what changed, what
  it was before, and what a reader has to do differently. Match the surrounding
  entries in `CHANGELOG.md` for tone and length.
```

Name the file after the change, not the pull request number — `grok-idle-bound.md`
reads better in a diff than `pr-874.md`, and two branches picking the same
number is likelier than two picking the same slug.

Rules the assembler enforces (`node scripts/assemble-changelog.mjs --check`,
which `npm run check` runs):

- The file starts with `- ` and is a single top-level bullet. Two changes mean
  two files.
- No Markdown headings; the release adds those.
- Not empty.

## Releasing

```bash
node scripts/assemble-changelog.mjs
```

That rewrites `CHANGELOG.md` and removes the fragments; commit both together.
`--dry-run` shows what it would move, `--check` only validates.

Editing `CHANGELOG.md` directly still works and still merges through the union
driver, which is how pull requests opened before this landed continue to work.
New changes should use a fragment.
