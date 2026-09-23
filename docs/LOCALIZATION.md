# Chinese interface localization

## Ownership and scope

English is the source language. Simplified Chinese (`zh-CN`) and Traditional
Chinese (`zh-TW`) are separately maintained translations of the same semantic
message keys. Traditional Chinese terminology follows the Taiwan interface;
`zh-Hant`, Hong Kong and Macao system locales select that interface as a fallback,
not a claim that a separate regional translation exists.

This integration adapts the Traditional Chinese Control Center and panel work
by @coolka-hsu in PR #857 (d795cb9), and preserves the Simplified Chinese desktop,
native menu and widget work from PR #839. Neither contributor's language is a
runtime conversion of the other.

Provider authentication, routing decisions, quotas, secrets, submitted effort
IDs and user-owned content are outside the presentation layer. New diagnostic
copy in the current main branch is mapped only at its display boundary. Upstream PRs #836 (Usage and tray fixes) and #853 (custom endpoints) are now
merged in main at 54e8f70 and retained through a normal merge. Their new
presentation copy uses this same semantic catalog; their backend behavior,
credential validation and quota calculations remain upstream-owned.

## Control Center

- Add a descriptive, stable key to `src/locales/en.ts`, then add the same key to
  `zh-CN.ts` and `zh-TW.ts`. `satisfies Record<keyof typeof en, string>` detects
  omissions and unexpected keys during TypeScript checking.
- Keep `i18n.ts`, its dictionaries and formatters framework-independent. React
  context and hooks live in `i18n-react.ts`; root tests must not require the
  renderer package to be installed.
- Render with the existing `Translate` function (`t("section.intent", values)`).
  Bind translators to the selected language; include `t` or language in memo
  dependencies when they build presentation text. Do not create a second
  English-as-key dictionary for new components.
- Translate complete messages with named parameters. Do not concatenate English
  plural suffixes, translated sentence fragments, or translated enum values.
  Add distinct singular/plural messages where the English source requires them.
- Format dates and numbers with the resolved interface locale. Keep identifiers,
  paths, commands, credentials and unknown diagnostics unchanged. The backend
  display adapter is an exact allowlist, not a general text replacement engine.
- Interpolation is one pass. Missing values stay visibly unresolved; inserted
  values are not parsed again. Render ordinary text nodes, never translated HTML.
- Preserve existing language storage values. Explicit script subtags take
  precedence over region subtags (`zh-Hant-CN` remains Traditional). A selected
  language remains usable in memory when storage access is denied.

The older locale overlays intentionally fall back to English for newly covered
messages. Their existing translations must not be erased or treated as complete.
`ui-text.ts` is a compatibility adapter backed by the same semantic catalog, not
an independent translation store.

## Native menus, macOS and widget

The renderer sends a validated language identifier to Electron's existing trusted
IPC boundary. There is one native-menu writer; roles, shortcuts and callbacks
remain unchanged. Do not install a competing label-writing IPC channel.

Native Swift presentation uses `RouterMessageKey` for new parameterized messages,
with complete English, Simplified and Traditional message tables. Existing
`routerLocalized` callers retain their table and printf contract. The persisted
`chinese` value and old widget snapshots still mean Simplified Chinese; the new
`traditionalChinese` value is additive. Widget bundle metadata has independent
`zh-Hans` and `zh-Hant` resources in both the Xcode project and `project.yml`.

## Verification

From the repository root with the lockfile's supported Node version:

```sh
npm ci
npm run check
node --test test/chinese-i18n-contract.test.mjs
npm test
npm --prefix apps/control-center ci
npm --prefix apps/control-center run check
npm --prefix apps/control-center run build
npm --prefix apps/control-center test
```

Install the matching Playwright browser before renderer tests. On macOS also run
`swift test` in `apps/macos/ModelRouterTray` and the widget Xcode test scheme.

Regression coverage must prove actual English / Simplified / Traditional output,
placeholder parity, unknown-key and missing-value behavior, locale resolution,
selection persistence, technical-ID preservation, menu callbacks, and round trips
between languages. Expected UI strings should be independent of the production
catalog; copying the implementation into the oracle only checks itself.
