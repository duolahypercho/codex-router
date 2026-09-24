- **Changelog entries are written as fragments, so pull requests stop
  conflicting on `CHANGELOG.md`.** Every change appended its bullet to the top
  of the same `## Unreleased` section, so two branches that shared no source
  file still collided there. `.gitattributes` answered that with
  `CHANGELOG.md merge=union`, which resolves a local `git merge` and does
  nothing on GitHub, because GitHub's server-side merge does not run
  `.gitattributes` merge drivers — so a pull request reported CONFLICTING on
  github.com while merging cleanly on a maintainer's machine, and every merge
  to `main` re-conflicted every other open pull request. A change now writes
  `changelog.d/<short-slug>.md` instead, and two pull requests writing two
  files have nothing to collide on.
  `node scripts/assemble-changelog.mjs` folds the fragments into
  `## Unreleased` at release and deletes them; `npm run check` validates their
  shape so a malformed one is caught in review rather than by whoever cuts the
  release. Editing `CHANGELOG.md` directly still works, and the union driver
  stays, so pull requests opened before this are unaffected.
