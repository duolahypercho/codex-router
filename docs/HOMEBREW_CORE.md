# Homebrew core submission

Codex Router can be proposed to `Homebrew/homebrew-core` after the upstream
project and its formula meet Homebrew's acceptance requirements. There is no
application form: the submission is a pull request adding
`Formula/c/codex-router.rb` to `homebrew-core`.

## Before submitting

- Wait until the upstream repository is at least 30 days old. The repository
  was created on July 19, 2026, so submit no earlier than August 19, 2026.
- Publish a release that upstream explicitly identifies as stable. A beta or
  release candidate is not eligible. The tag, `package.json` version, source
  archive name, formula version, and release URL must agree.
- Confirm the repository still meets Homebrew's self-submission notability
  threshold: 90 forks, 90 watchers, or 225 stars.
- Confirm the release archive is immutable and that the formula contains its
  SHA-256 checksum.
- Run the formula audit on the generated formula:

  ```sh
  packaging/homebrew/check-core-readiness.sh
  ```

- After the release workflow regenerates the checked-in formula, run a clean
  source installation on both macOS and Linux. The CI workflow's manual
  `workflow_dispatch` path runs:

  ```sh
  packaging/homebrew/check-core-readiness.sh --install
  ```

  The install check intentionally refuses to replace an existing
  `codex-router` formula.
- Verify the stable release through the normal release workflow. It must
  regenerate `Formula/codex-router.rb` without drift.

## Prepare the Homebrew contribution

Fork `Homebrew/homebrew-core`, then create a branch from its current default
branch:

```sh
brew update
brew tap --force homebrew/core
cd "$(brew --repository homebrew/core)"
git switch -c codex-router-new-formula origin/HEAD
git remote add YOUR_USERNAME https://github.com/YOUR_USERNAME/homebrew-core.git
```

Copy the stable generated formula from this repository to
`Formula/c/codex-router.rb`. Do not copy a beta formula or add a `bottle` block;
Homebrew creates the bottle block after its builders pass.

Run Homebrew's submission checks from the `homebrew-core` checkout:

```sh
HOMEBREW_NO_INSTALL_FROM_API=1 brew install --build-from-source codex-router
brew test codex-router
brew audit --strict --new --online codex-router
brew style --fix --formula codex-router
brew lgtm --online
```

Commit the single formula and push it to the fork:

```sh
git add Formula/c/codex-router.rb
git commit -m "codex-router VERSION (new formula)"
git push -u YOUR_USERNAME codex-router-new-formula
```

Open a pull request from that branch to `Homebrew/homebrew-core:main` and
complete its checklist. If AI assisted with the formula or pull-request text,
disclose that assistance in the initial pull-request description, review all
generated work before requesting review, and answer maintainer feedback
yourself as required by Homebrew's contribution policy.
