import {
  apiProvider,
  credentialLabel,
  credentialSetupHint,
  credentialStatus,
  primaryCredentialPath,
  writeProviderCredential,
} from "./provider-credentials.mjs";
import { providerNeedsCuration, removeApiCredential } from "./provider-onboarding.mjs";
import { withProviderCatalogCacheTransaction } from "./model-catalog-cache.mjs";
import { providerCatalogFamilyCacheIds } from "./provider-catalogs.mjs";
import { enableProvider } from "./provider-selection.mjs";
import { withModelOverlayLock } from "./model-overlay-lock.mjs";
import { promptForSecret } from "./secret-prompt.mjs";
import {
  refreshTargetPickerIfInstalled,
  targetCli,
  targetPickerName,
  targetRestartHint,
} from "./target-integration.mjs";

const providerId = process.argv[2];
const command = process.argv[3] || "status";

if (!providerId || !new Set(["status", "set", "remove"]).has(command)) {
  console.error("Usage: provider-key.mjs PROVIDER status|set|remove");
  process.exit(2);
}

const provider = apiProvider(providerId);
const credentialType = credentialLabel(provider);
const credentialNoun = credentialType === "API key" ? "key" : credentialType.toLowerCase();

export {
  powerShellStartupError,
  WINDOWS_HIDDEN_PROMPT_SCRIPT,
  windowsHiddenPromptArgs,
} from "./secret-prompt.mjs";

if (command === "status") {
  const status = credentialStatus(provider);
  const credentialLabel = provider.credential?.resolver ? "authentication" : "key";
  process.stdout.write(
    status.configured
      ? `${provider.displayName} ${credentialNoun} is configured via ${status.source}.${
          status.persistent
            ? ""
            : ` This environment-only ${credentialNoun} is not inherited by the background service; run the set command to save it securely.`
        }\n`
      : `${provider.displayName} ${credentialNoun} is not configured.\n`,
  );
  if (!status.configured) process.exitCode = 1;
} else if (command === "set") {
  if (provider.credential?.resolver) {
    throw new Error(`${provider.displayName} does not accept API keys; ${credentialSetupHint(provider)}`);
  }
  const value = promptForSecret(provider.credential.prompt || `${provider.displayName} API key`);
  let target;
  let refreshed;
  await withModelOverlayLock(async () => {
    await withProviderCatalogCacheTransaction((catalog) => {
      target = writeProviderCredential(provider, value);
      catalog.forget(providerCatalogFamilyCacheIds(provider.id));
    });
    enableProvider(provider.id);
    refreshed = await refreshTargetPickerIfInstalled();
  });
  process.stdout.write(
    `${provider.displayName} ${credentialNoun} saved to protected local storage at ${target}. The provider is enabled.${
      refreshed ? ` ${targetRestartHint()}` : ""
    }\n`,
  );
  if (providerNeedsCuration(provider.id)) {
    process.stdout.write(
      `${provider.displayName} ships no preselected models. Run \`${targetCli(`curate-models ${provider.id}`)}\` ` +
        `in an interactive terminal to choose which of its models appear in the picker.\n`,
    );
  }
} else {
  let removal;
  let refreshed;
  await withModelOverlayLock(async () => {
    // Deletion and withdrawal are intentionally one plain lock scope. There
    // is no rollback of credential files, so a publication failure leaves the
    // coherent result (credential gone, provider disabled) rather than a
    // selection restored next to a deleted secret.
    removal = await withProviderCatalogCacheTransaction(async (catalog) => {
      const result = await removeApiCredential(provider.id);
      if (result.removedFiles) catalog.forget(providerCatalogFamilyCacheIds(provider.id));
      return result;
    });
    refreshed = removal.removedFiles ? await refreshTargetPickerIfInstalled() : false;
  });
  process.stdout.write(
    removal.removedFiles
      ? `Removed ${removal.removedFiles} managed ${provider.displayName} ${credentialNoun} file${removal.removedFiles === 1 ? "" : "s"} and disabled the provider.${
          refreshed ? ` ${targetRestartHint()}` : ""
        }\n`
      : `No managed ${provider.displayName} ${credentialNoun} file exists.\n`,
  );
  if (removal.stillConfigured) {
    process.stdout.write(
      `A ${provider.displayName} ${credentialNoun} is still available from ${removal.remainingSource}; remove it there to fully disconnect.\n`,
    );
  }
}
