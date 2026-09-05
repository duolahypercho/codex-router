import { existsSync, readFileSync } from "node:fs";
import { NATIVE_CATALOG_PATH, CONFIG_PATH } from "./paths.mjs";
import { nativeCatalogIsReusable, readModelsCache } from "./catalog.mjs";
import { codexBinaryFingerprint, codexVersion } from "./codex-binary.mjs";
import { refreshNativeAccountCatalog } from "./native-account-catalog.mjs";
import { discoveryDisabled } from "./discovery-mode.mjs";

// Marker pattern from config-manager.mjs to detect managed Codex config
const managedMarkerPattern = /^# BEGIN codex-router$/m;

/**
 * Check if Codex integration is installed (has managed config).
 * Same logic as target-integration.mjs codexIntegrationInstalled().
 */
function codexIntegrationInstalled() {
  if (!existsSync(CONFIG_PATH)) return false;
  try {
    return managedMarkerPattern.test(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    // Fail closed: if config exists but cannot be read, assume not installed.
    // This is conservative for drift detection - missing a check is safer than
    // attempting republish when integration state is unknown.
    return false;
  }
}

/**
 * Check if native catalog drift requires republish, without blocking startup.
 * Returns true if drift detected (fingerprint/version mismatch).
 */
export function nativeCatalogDriftDetected() {
  // models_cache.json is account-derived. The discovery kill-switch applies
  // to the comparison just as it does to the live refresh that precedes it.
  if (discoveryDisabled()) return false;
  // Only applies when Codex integration is active
  if (!codexIntegrationInstalled() && !existsSync(NATIVE_CATALOG_PATH)) {
    return false;
  }

  try {
    const cache = readModelsCache();
    if (!cache.catalog) {
      // No models_cache.json or invalid - nothing to compare
      return false;
    }

    // If no stored catalog exists yet, no drift to detect
    if (!existsSync(NATIVE_CATALOG_PATH)) {
      return false;
    }

    // Read the stored native catalog
    const parsed = JSON.parse(readFileSync(NATIVE_CATALOG_PATH, "utf8"));

    // Check account-cache, CLI-version, and installed-binary identity.
    const version = codexVersion();
    const binaryFingerprint = codexBinaryFingerprint();
    return !nativeCatalogIsReusable(
      parsed,
      version,
      cache.fingerprint,
      binaryFingerprint,
    );
  } catch {
    // Any error means we can't reliably detect drift
    return false;
  }
}

/**
 * Asynchronously republish catalog if native drift detected.
 * Runs in background after startup, does not block.
 */
export async function republishOnNativeDrift({
  refreshAccountCatalog = refreshNativeAccountCatalog,
  refreshTargetPicker,
} = {}) {
  // model_catalog_json stops Codex's own account cache writer. Refresh the
  // fixed ChatGPT account endpoint first; on any failure the updater leaves
  // the prior cache untouched and the local drift comparison remains safe.
  await refreshAccountCatalog();
  if (!nativeCatalogDriftDetected()) {
    return false;
  }

  try {
    // Dynamic import to avoid startup dependency
    const refresh = refreshTargetPicker || (
      await import("./target-integration.mjs")
    ).refreshTargetPickerIfInstalled;
    await refresh();
    console.error(
      "[codex-router] Native catalog drift detected and republished automatically."
    );
    return true;
  } catch (error) {
    console.error(
      `[codex-router] Native catalog drift detected but republish failed: ${error.message}`
    );
    return false;
  }
}
