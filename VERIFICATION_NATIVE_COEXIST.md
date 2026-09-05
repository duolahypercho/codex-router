# Native Catalog Coexistence - Verification Guide

This document outlines how to verify that the router correctly picks up **any and all new native OpenAI/Codex models** without requiring uninstall. The solution is completely general — it works for GPT-6 Astra, GPT-7, o5, or any future native model that appears in the signed-in account's catalog.

## Core Mechanism

The router now uses a safe in-place refresh when:
1. Router is installed and routing is active
2. Signed-in mode (not login-free)
3. `models_cache.json` exists and is valid
4. `models_cache.json` contains only native models (no routed slugs)

**Key insight**: The fingerprint-based drift detection (`nativeCatalogIsReusable()`) automatically triggers recapture whenever `models_cache.json` changes. This means ANY new native model causes an automatic refresh on the next catalog publish — no model-specific logic needed.

## How It Works (General for All Native Models)

1. **Fingerprint tracking**: Every time the router captures the native catalog, it computes and stores a SHA-256 fingerprint of `models_cache.json` in `native-models.json` as `native_source_fingerprint`.

2. **Automatic drift detection**: On every catalog publish, `nativeCatalogIsReusable()` compares:
   - Current fingerprint of `models_cache.json`
   - Stored `native_source_fingerprint` from last capture
   - If they differ → automatic recapture triggered

3. **Safe in-place refresh**: When conditions are met (see above), the recapture happens without rewriting `config.toml`:
   - Reads `models_cache.json` directly
   - Merges with bundled catalog
   - Publishes merged catalog with ALL models (existing + new natives + routed)

4. **Result**: Every new native model that Codex adds to `models_cache.json` is automatically picked up on the next catalog operation, regardless of which model or how many.

**No hardcoded model names. No special cases. Just general fingerprint-based change detection.**

When these conditions are met, `refresh-catalog` skips rewriting `config.toml` and just runs `catalog.mjs --refresh-native`, which:
- Reads the account cache directly
- Merges with bundled catalog
- Updates `native-models.json` with the new fingerprint
- Publishes the merged catalog with the new native models

## Manual Verification Steps

### Setup
1. Install router with at least one provider configured
2. Sign in to Codex (not login-free mode)
3. Verify router is active: `bin/model-router codex doctor`
4. Note the current models: `codex debug models | jq '.models[].slug'`

### Simulate New Native Model

**Important**: The examples below use "GPT-6 Astra" and "gpt-test-new-native" as *reproduction examples only*. The implementation is completely general and works for ANY native model that appears in the account's catalog — GPT-7, o5, claude-next via OpenAI, etc.

Since we can't force OpenAI to release a new model on demand, we have two verification approaches:

#### Option A: Add a test model to models_cache.json
```bash
# Backup the current cache
cp ~/.codex/models_cache.json ~/.codex/models_cache.json.backup

# Add a fake native model to the cache (manually edit the JSON)
# Add an entry like:
# {
#   "slug": "gpt-test-new-native",
#   "name": "Test New Native",
#   "visibility": "list",
#   ...other required fields...
# }

# Verify it's recognized as native-only (no routed slugs)
node -e "
  const fs = require('fs');
  const cache = JSON.parse(fs.readFileSync('${HOME}/.codex/models_cache.json', 'utf8'));
  const routedSlugs = new Set(['grok-oauth/grok-4-5', /* add known routed slugs */]);
  const hasRouted = cache.models.some(m => routedSlugs.has(m.slug));
  console.log('Cache is safe for refresh:', !hasRouted);
"
```

#### Option B: Wait for real OpenAI update
When OpenAI releases **any new native model** (GPT-6 Astra, GPT-7, o5, etc.):
1. Use Codex CLI or desktop normally
2. Codex will update its `models_cache.json` automatically with the new model(s)
3. The new model(s) will appear there with native slugs

### Test Refresh
```bash
# Run refresh
bin/model-router codex refresh-catalog

# Verify the output says it ran in-place
# (should NOT show config disable/enable steps)

# Check that merged-models.json was updated
cat ~/.local/share/codex-router/codex/state/merged-models.json | jq '.models[] | select(.slug == "gpt-test-new-native")'

# Check that native-models.json has the new fingerprint
cat ~/.local/share/codex-router/codex/state/native-models.json | jq .native_source_fingerprint
```

### Test in Codex
```bash
# Fully quit Codex (not just close window)
pkill -9 -i codex  # or use Activity Monitor

# Reopen Codex
codex  # or use Codex Desktop app

# Create a new task and check picker
# ANY new native model should appear (Astra, GPT-7, o5, etc.)
```

### Cleanup
```bash
# Restore original cache if you edited it
mv ~/.codex/models_cache.json.backup ~/.codex/models_cache.json

# Re-run refresh to get back to original state
bin/model-router codex refresh-catalog
```

## Automated Test Coverage

The following scenarios are covered by automated tests:

### `test/catalog.test.mjs`
- ✅ `nativeCacheCanRefreshInPlace()` identifies safe caches (native-only)
- ✅ `nativeCacheCanRefreshInPlace()` rejects contaminated caches (with routed slugs)
- ✅ `nativeCacheCanRefreshInPlace()` rejects invalid/empty caches
- ✅ `nativeCatalogIsReusable()` triggers refresh on fingerprint mismatch
- ✅ `effectivePickerHiddenModels()` excludes native base slugs in signed-in mode
- ✅ `effectivePickerHiddenModels()` applies overlay to all in login-free mode

### `test/refresh-catalog.test.mjs`
- ✅ In-place refresh avoids config mutation when cache is safe
- ✅ Traditional refresh (with config disable/enable) still works when cache is unsafe
- ✅ Restore logic works correctly on catalog failure
- ✅ Login-free mode still uses journaled transport flow
- ✅ Pending refresh resumes correctly

## Expected Outcomes

### Success Criteria
1. ✅ New native model appears in `merged-models.json` after refresh
2. ✅ New native model appears in Codex picker after quit/reopen
3. ✅ Router remains installed and active throughout
4. ✅ No uninstall or disable/enable required
5. ✅ Routed models still work correctly
6. ✅ No config.toml writes when cache is safe

### Failure Modes (Handled)
- **Contaminated cache**: Refresh falls back to traditional disable/enable flow
- **Invalid cache**: Falls back to bundled catalog
- **Catalog capture fails**: Reuses previous capture with warning
- **Windows EPERM**: Avoided by not rewriting config.toml when safe

## Known Limitations

1. **Codex restart required**: Codex only reads `model_catalog_json` at startup. The router cannot make Codex hot-reload the catalog. Users must fully quit and reopen.

2. **Automatic trigger**: The current implementation requires manual `refresh-catalog`. Future enhancements could:
   - Auto-refresh on tray/service idle
   - Auto-refresh during catalog publish paths
   - Watch `models_cache.json` for changes

3. **Doctor check**: The stale-catalog warning in `doctor` could be strengthened to:
   - Detect fingerprint mismatch
   - Recommend running `refresh-catalog`
   - Show which new models are available

4. **No second injection API**: Codex's `model_catalog_json` *replaces* the catalog. There is no way to "inject" routed models while leaving native catalog completely untouched. This is a fundamental Codex architecture constraint (PR #169).

## Diagnostic Commands

```bash
# Check if cache is safe for in-place refresh
node -p "require('./src/catalog.mjs').nativeCatalogCanRefreshInPlace()"

# Check current native catalog fingerprint
cat ~/.local/share/codex-router/codex/state/native-models.json | jq .native_source_fingerprint

# Check models_cache.json fingerprint
node -p "const crypto = require('crypto'); const fs = require('fs'); const cache = JSON.parse(fs.readFileSync(process.env.HOME + '/.codex/models_cache.json', 'utf8')); crypto.createHash('sha256').update(JSON.stringify(cache.models)).digest('hex')"

# List all models in merged catalog
cat ~/.local/share/codex-router/codex/state/merged-models.json | jq '.models[].slug'

# Check if router is active
bin/model-router codex doctor | grep "Codex routing"
```

## References

- PR #621: Original safe refresh implementation (config-free refresh when cache is safe)
- PR #169: Custom catalog injection (why there's no second injection API)
- Original issue: User had to uninstall to see new native models (GPT Astra was the reproduction case)
- `src/catalog.mjs`: Core catalog logic, native cache handling, **fingerprint-based drift detection**
- `src/refresh-catalog.mjs`: Refresh orchestration with in-place path
- `src/native-catalog-freshness.mjs`: Fingerprint drift detection (general for all models)
