# Chinese UI integration / 简繁中文整合

## Code and provenance

The fork integration combines:

- #839 and its CI correction through `70f9b2a`;
- the shared menu foundation through `f0811d8`;
- the semantic Simplified/Traditional candidate through `5fc67c8`, which adapts
  @coolka-hsu's #857 at `d795cb9` and retains that contribution in Git history;
- upstream `54e8f702f089399df94f305c244abc9f8722c168`, including the now-merged
  #836 Usage/cache/tray changes and #853 custom-endpoint workflow.

These are normal merges, not a force-reset of either contributor's history.
The original `codex/improve-simplified-chinese-ui` PR branch is deliberately
separate from `codex/chinese-ui-integration` until promotion is authorized.

## Implemented presentation

The eight Control Center pages share typed semantic English, Simplified Chinese
and Traditional Chinese catalogs. React context is separate from the pure
translation engine. The panel, native menus, Swift tray and widget retain their
platform-specific rendering and storage contracts, with independent Chinese
resources rather than a runtime character conversion. Existing partial language
overlays continue to fall back to English.

Upstream integration preserves both the new data dependencies and the translator
memo dependencies. Custom-endpoint add/edit/remove, raw model-name entry, catalog
filtering, credential placeholders and diagnostic notices use localized messages.
Usage keeps selected-account grouping and the distinction between missing cache
telemetry and a measured zero. Unknown provider diagnostics and technical IDs
remain unchanged. The earlier 54-message draft was removed: live copy belongs
in the real typed catalogs, not a second unused documentation catalog.

Locale resolution distinguishes a declared script from text inside private-use
or extension subtags. Old `zh-CN`, `chinese` and widget snapshot values continue
to mean Simplified Chinese. Traditional selection is additive.

## Validation status

The pre-upstream candidate `5fc67c8` passed the fork matrix in Actions run
35643066962: root tests on Linux/macOS/Windows, Control Center build/tests on
Linux/Windows, and Swift tray/widget tests on macOS. **Those are baseline results,
not validation of the subsequent upstream integration.**

For this integration, root syntax, Control Center type checks/build and focused
localization/source tests have been executed locally. The final cross-platform
matrix and browser scenarios must validate the exact published code tree before
it is presented as release-ready. Fork-only transport/verification workflows
remain on the separate validation branch, never in this application branch.

No paid provider probes, production credential access, upstream merge, release,
or original PR history rewrite are part of this work.

## Verification and promotion

See `docs/LOCALIZATION.md` for contributor guidance and commands. In addition to
full root tests, run the compiled renderer scenarios for all three languages,
including custom-endpoint mutation payloads, cancelled dialogs, cache telemetry,
language switching and reload persistence. Use real macOS Swift/widget tests and
platform packaging checks rather than treating mocked lifecycle tests as a native
build.

After verification, the original PR can be updated with a normal fast-forward of
its existing branch to the completed integration. Stop and reconcile if either
remote branch has moved; do not use a force push. The upstream maintainer still
owns approval of fork-triggered workflows and the eventual PR merge.
