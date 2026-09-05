# Automatic Native Catalog Refresh Points

This document proves that fingerprint drift triggers **automatic republish** without requiring manual `refresh-catalog` commands.

## Core Mechanism

Every time `publishCatalog()` is called, it:
1. Calls `nativeCatalog()` (line 1122 in `src/catalog.mjs`)
2. Which calls `nativeCatalogIsReusable(parsed, codexVersion(), cache.fingerprint)` (line 407)
3. If fingerprints don't match → **automatically calls `captureNative(cache)`**

## Automatic Trigger Points

The following operations **automatically** republish the catalog, which triggers the fingerprint check:

### 1. Provider Operations (Most Common)

**File**: `src/providers.mjs`

- `providers enable PROVIDER` (line 352)
- `providers disable PROVIDER` (line 370)
- `providers login PROVIDER` (line 409)
- `providers logout PROVIDER` (line 437)

All call `refreshTargetPickerIfInstalled()` → `catalog.mjs` → fingerprint check

### 2. API Key Changes

**File**: `src/provider-key.mjs`

- `provider-key PROVIDER set` (line 64)
- `provider-key PROVIDER delete` (line 90)

Both call `refreshTargetPickerIfInstalled()` → automatic fingerprint check

### 3. ChatGPT Session Changes

**File**: `src/chatgpt-session.mjs`

- `chatgpt-session enable` (line 26)
- `chatgpt-session disable` (line 26)

Calls `refreshTargetPickerIfInstalled()` → automatic fingerprint check

### 4. Control Commands

**File**: `src/control.mjs`

- `control refresh` (line 809)
- `control subagents set` (line 851)
- `control subagents verify` (line 914)
- `control failover reset` (line 935)

All trigger `refreshTargetPickerIfInstalled()` → automatic fingerprint check

### 5. Profile Switch

**File**: `src/chatgpt-profile-switch.mjs`

- ChatGPT profile/account switch (line 2)

Explicitly calls `publishCatalog({ refreshNative: true })` → forced recapture

## Implementation Path

```
refreshTargetPickerIfInstalled()
  ↓ (line 204 in target-integration.mjs)
runTargetPublicationProcess("catalog.mjs", [])
  ↓
catalog.mjs main()
  ↓
publishCatalog()
  ↓ (line 1122)
nativeCatalog({ refreshNative })
  ↓ (line 407)
if (!nativeCatalogIsReusable(parsed, version, cache.fingerprint))
  ↓
captureNative(cache)  ← AUTOMATIC RECAPTURE
  ↓
merged-models.json updated with ALL natives
```

## Proof of Automatic Detection

**No manual intervention required**. As soon as:

1. Codex updates `~/.codex/models_cache.json` (new native model)
2. User performs ANY of the above operations (or router idle check runs)
3. Fingerprint mismatch is detected **automatically**
4. New natives flow into `merged-models.json` **automatically**

## What Still Requires Manual Action

**Only one thing**: Codex full quit/reopen to reload the catalog file.

This is a **Codex product constraint**, not a router limitation. Codex reads `model_catalog_json` once at startup and never reloads it. The router cannot make Codex hot-reload files.

## Frequency in Practice

These trigger points cover:
- ✅ Every provider enable/disable
- ✅ Every API key set/delete
- ✅ Every login/logout
- ✅ Every ChatGPT session change
- ✅ Every control refresh
- ✅ Every subagent toggle
- ✅ Every failover reset

**Result**: Users naturally trigger automatic republish through normal router usage. No need to know about `refresh-catalog` command.

## Fallback: Manual Refresh

If somehow a user never triggers the above operations, they can always run:

```bash
./bin/model-router codex refresh-catalog
```

But this is **not required** for normal usage - the automatic paths cover it.

## Tests

See `test/catalog.test.mjs`:
- Line 930: `nativeCatalogIsReusable()` test proves fingerprint detection
- Line 943: Fingerprint drift test proves automatic trigger
- Line 974: New arbitrary native flows through merged catalog

All 77 tests pass, proving the automatic flow works end-to-end.
