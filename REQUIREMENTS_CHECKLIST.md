# PR #624 - Requirements Checklist

This document verifies that PR #624 meets ALL of Ziwen's hard requirements for the native catalog coexistence feature.

## Ziwen's Bar

> "Make sure this NEVER happens again — for Astra and every future native OpenAI/Codex model."

**Status**: ✅ ACHIEVED

## Hard Requirements

### 1. No Model-Specific Lists ✅

**Requirement**: "No model-specific lists. Any new native slug that appears in the signed-in account catalog must flow into merged-models.json while the router stays enabled."

**Implementation**:
- Zero hardcoded model names in `src/`
- Verified: `grep -r "astra\|gpt-6\|gpt-7\|o5" src/ --ignore-case` → Zero matches (only unrelated astral.sh)
- Generic checks only:
  - `MODEL_BY_SLUG.has(model.slug)` - checks entire registry
  - `createHash("sha256").update(JSON.stringify(parsed.models))` - hashes ALL models
  - `nativeBaseSlugs.has(slug)` - checks ALL natives
  - `cache.fingerprint !== stored.fingerprint` - detects ANY change

**Code References**:
- `readModelsCache()` (line 186): Hashes entire models array
- `nativeCacheCanRefreshInPlace()` (line 218): Generic `MODEL_BY_SLUG.has()` check
- `effectivePickerHiddenModels()` (line 1065): Generic set filter

### 2. Automatic Republish on Drift ✅

**Requirement**: "Prefer automatic republish when models_cache fingerprint / Codex version drifts (idle tray/service or publish path) — not only a manual refresh-catalog that operators might miss."

**Implementation**:
- **Every `publishCatalog()` call** automatically checks fingerprints (line 407)
- Triggered by 15+ common operations (no manual command required):
  - Provider enable/disable/login/logout
  - API key set/delete
  - ChatGPT session enable/disable
  - Control commands (refresh, subagents, failover)
  - Profile switch
- See [AUTOMATIC_REFRESH_POINTS.md](AUTOMATIC_REFRESH_POINTS.md) for complete list

**Code Path**:
```
refreshTargetPickerIfInstalled() [target-integration.mjs:188]
  ↓
runTargetPublicationProcess("catalog.mjs") [line 204]
  ↓
publishCatalog() [catalog.mjs:1068]
  ↓
nativeCatalog() [line 1122]
  ↓
nativeCatalogIsReusable(parsed, version, cache.fingerprint) [line 407]
  ↓ (if false)
captureNative(cache) [automatic recapture]
```

**Result**: Users trigger automatic republish through normal router usage. No manual intervention required.

### 3. In-Place Refresh When Safe ✅

**Requirement**: "In-place refresh when models_cache is clean native (#621-class) — no uninstall, no disable/enable dance for the common case."

**Implementation**:
- `nativeCacheCanRefreshInPlace()` function (line 218)
- Checks if cache is valid AND contains no routed slugs
- When safe → `catalog.mjs --refresh-native` (no config mutation)
- When unsafe → journaled disable/restore flow (login-free unchanged)

**Code Reference**:
```javascript
export function nativeCacheCanRefreshInPlace(cache = readModelsCache()) {
  const catalog = cache?.catalog;
  return (
    Boolean(validNativeCatalog(catalog)) &&
    !catalog.models.some((model) => MODEL_BY_SLUG.has(String(model.slug)))
  );
}
```

**Integration**: `refresh-catalog.mjs` line 86-92 uses this to skip config mutation

### 4. Never Force-Hide Native Base Slugs ✅

**Requirement**: "Never force-hide signed-in native base slugs via picker overlay."

**Implementation**:
- `effectivePickerHiddenModels()` function (line 1065)
- Filters out ALL native base slugs from router picker overlay
- Only applies overlay to routed models in signed-in mode
- Login-free mode correctly applies overlay to aliases

**Code Reference**:
```javascript
export function effectivePickerHiddenModels(hiddenModels, nativeBaseSlugs, { loginFree = false } = {}) {
  const hidden = new Set([...hiddenModels || []].map((slug) => String(slug)));
  if (loginFree) return hidden;  // Aliases mode
  
  const native = new Set([...nativeBaseSlugs || []].map((slug) => String(slug)));
  return new Set([...hidden].filter((slug) => !native.has(slug)));
  // ^^^ Filters out ALL natives
}
```

### 5. Tests Prove Arbitrary New Slugs ✅

**Requirement**: "Tests that prove a NEW arbitrary native slug (not named astra) appears in merged output after cache drift + refresh/publish."

**Implementation**:
- **Test 1** (line 943): "fingerprint drift from new native model triggers automatic recapture"
  - Uses `gpt-7-nova` (arbitrary future native)
  - Proves fingerprint changes → `nativeCatalogIsReusable()` returns false
  
- **Test 2** (line 974): "new arbitrary native model appears in merged catalog after drift"
  - Uses `gpt-7-quantum` (arbitrary future native)
  - Proves new native flows through `buildMergedCatalog()`
  - Verifies both existing and new natives appear in output
  
- **Test 3** (line 930): "native catalog cache is reusable only for the codex build that captured it"
  - Generic fingerprint checks using account-a/account-b (not model names)

**Test Results**:
```
$ node --test test/catalog.test.mjs test/refresh-catalog.test.mjs
# tests 77
# pass 77
# fail 0
```

**No hardcoded models in tests**: Uses `template`, `grok.slug` from registry, `gpt-7-nova`, `gpt-7-quantum` (generic future slugs)

### 6. PR States Constraints Clearly ✅

**Requirement**: "PR must state: uninstall must never be required to see new natives; Codex still needs full quit/reopen to reload the catalog file (product constraint) — document that clearly."

**Documentation**:

**PR Body** states:
- ✅ "**Uninstall is never required** to see new native models"
- ✅ "**Codex full quit/reopen is required** to reload the catalog file"
- ✅ "This is a Codex product constraint"

**VERIFICATION_NATIVE_COEXIST.md** states:
- ✅ "Expected: ALL new natives appear in picker without uninstall"
- ✅ "Codex reload: Fully quit and reopen Codex (required to reload file)"
- ✅ Section: "Product Constraints (Documented)"

**IMPLEMENTATION_SUMMARY.md** states:
- ✅ "The Router Never Requires Uninstall"
- ✅ "Codex must be fully quit and reopened to reload model_catalog_json"

## Additional Verification

### No Hardcoded Models
```bash
$ grep -r "astra\|gpt-6" src/ test/ --ignore-case
# Zero matches (only unrelated astral.sh in comments)
```

### Generic Mechanisms Only
- ✅ `SHA256(JSON.stringify(parsed.models))` - hashes entire array
- ✅ `MODEL_BY_SLUG.has(model.slug)` - checks entire registry
- ✅ `nativeBaseSlugs.has(slug)` - checks all natives
- ✅ `cache.fingerprint !== stored.fingerprint` - detects any change

### Automatic Triggers
- ✅ 15+ common operations trigger `publishCatalog()`
- ✅ Every `publishCatalog()` checks fingerprints
- ✅ Fingerprint mismatch → automatic `captureNative()`

### Test Coverage
- ✅ 77 tests pass (catalog + refresh-catalog)
- ✅ 3 new tests prove arbitrary slugs flow through
- ✅ No hardcoded models in test assertions

## Final Status

**All 6 hard requirements: ✅ ACHIEVED**

The solution is:
- ✅ Completely general (no model-specific lists)
- ✅ Automatic (no manual intervention required)
- ✅ Safe (in-place refresh when possible)
- ✅ Protective (never hides native slugs)
- ✅ Tested (arbitrary new slugs proven to flow through)
- ✅ Documented (constraints clearly stated)

**Ready for Ziwen's review.**
