- **The native catalog now defers to the account's own model list, so a plan is
  no longer offered models it cannot call.** `mergeNativeCatalogs` appended
  every bundled-only model from `codex debug models --bundled`, which ships
  every model the build can address. On a Free ChatGPT account those entries
  are exactly the published ones, so GPT-6.1 Sol appeared in the picker and
  every turn answered "This model isn't available". Capture now passes
  `includeBundledOnly: false` whenever a valid account catalog was read, and
  keeps the bundled list as the whole capture only when there is no account
  catalog to defer to. Bundled data still backfills schema fields for the slugs
  both lists share, which is what it was merged for (#1098).
