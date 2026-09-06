import { fileURLToPath } from "node:url";
import path from "node:path";

import { PROVIDERS, providerNeedsNoKey } from "./model-registry.mjs";
import { devinCliStatus } from "./devin-cli-status.mjs";
import { grokOAuthStatus } from "./grok-oauth-status.mjs";
import { antigravityOAuthStatus } from "./antigravity-oauth-status.mjs";
import { kimiOAuthStatus } from "./oauth-status.mjs";
import {
  effectiveProviderCredentialStatus,
  providerApiKeyAuthoritySnapshot,
} from "./provider-api-key-routing.mjs";
import {
  loginOauthProvider,
  providerNeedsCuration,
  removeApiCredential,
} from "./provider-onboarding.mjs";
import { credentialSetupHint } from "./provider-credentials.mjs";
import {
  canonicalProviderId,
  disableProvider,
  enableProvider,
  readProviderSelection,
} from "./provider-selection.mjs";
import {
  refreshTargetPickerIfInstalled,
  targetCli,
  targetPickerName,
  targetRestartHint,
} from "./target-integration.mjs";
import { withModelOverlayLock } from "./model-overlay-lock.mjs";
import { forgetProviderCatalogFamilyCache } from "./provider-catalogs.mjs";
import { restartRouterServiceIfInstalled } from "./router-restart.mjs";
import { activateAntigravityProbe } from "./antigravity-probe-activation.mjs";
import {
  boundedOperationChild,
  operationDeadlineFromEnvironment,
  remainingOperationMs,
  runOperationProcessTree,
} from "./process-tree.mjs";

const MAX_PROVIDER_OPERATION_MS = 11 * 60_000;

function providerOperationContext(command) {
  if (!["login", "probe", "disconnect"].includes(command)) return {};
  const deadline = operationDeadlineFromEnvironment(process.env, {
    timeoutMs: MAX_PROVIDER_OPERATION_MS,
    maximumMs: MAX_PROVIDER_OPERATION_MS,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => {
    const error = new Error("The provider operation exceeded its absolute deadline.");
    error.code = "router_operation_timeout";
    controller.abort(error);
  }, remainingOperationMs(deadline));
  timer.unref?.();
  return {
    deadline,
    signal: controller.signal,
    dispose: () => clearTimeout(timer),
  };
}
import {
  GENERIC_PROVIDERS_PATH,
  getGenericProvider,
  runGenericProviderCli,
  updateGenericProvider,
} from "./generic-providers.mjs";
import { genericProviderConfigured } from "./generic-provider-readiness.mjs";
import {
  addGenericProviderCredentialReference,
  readProviderCredentialStore,
  removeCredentialReference,
} from "./provider-credential-store.mjs";
import {
  genericProviderCredentialPath,
  removeGenericProviderCredential,
  writeGenericProviderCredential,
} from "./provider-credentials.mjs";
import { PROVIDER_CREDENTIAL_STORE_PATH } from "./paths.mjs";
import { promptForSecret } from "./secret-prompt.mjs";
import {
  applyModelOverlayPublication,
  transactModelOverlayMutation,
} from "./model-overlay-publication.mjs";
import {
  USER_MODELS_PATH,
  readUserModels,
  writeUserModels,
} from "./user-models.mjs";
import {
  MODEL_PICKER_STATE_PATH,
  forgetModelVisibility,
} from "./model-picker-state.mjs";
import {
  removeSearchSidecarBindingsForProvider,
  SEARCH_SIDECARS_PATH,
} from "./search-sidecar-state.mjs";

function providersCommand(action, providerId) {
  return process.platform === "win32"
    ? `.\\codex-router.ps1 providers ${action} ${providerId}`
    : `./bin/providers ${action} ${providerId}`;
}

function antigravityProbeOptions(flags) {
  const allowed = new Set(["--live", "--yes", "--provision-project"]);
  const unknown = flags.find((flag) => !allowed.has(flag));
  if (unknown) {
    throw new Error(
      `Unknown Antigravity probe option: ${unknown}. ` +
        "Usage: providers probe antigravity-oauth --live --yes [--provision-project]",
    );
  }
  return {
    live: flags.includes("--live"),
    confirmed: flags.includes("--yes"),
    allowOnboard: flags.includes("--provision-project"),
  };
}

// One entry per OAuth vendor keeps adding a provider a registry-plus-map
// change instead of another branch in a nested conditional.
const SIGN_IN_STATUS = Object.freeze({
  "kimi-oauth": { status: kimiOAuthStatus, setup: "run `kimi login`" },
  "grok-oauth": { status: grokOAuthStatus, setup: "run `grok login --oauth`" },
  "antigravity-oauth": {
    status: antigravityOAuthStatus,
    setup: `run \`${providersCommand("login", "antigravity-oauth")}\``,
  },
  "devin-cli": { status: devinCliStatus, setup: "run `devin auth login`" },
});

function configured(provider, poolAuthoritySnapshot) {
  if (provider.kind === "oauth") {
    return Boolean(SIGN_IN_STATUS[provider.id]?.status().configured);
  }
  return providerNeedsNoKey(provider)
    ? true
    : effectiveProviderCredentialStatus(provider, {
        persistent: true,
        poolAuthoritySnapshot,
      }).configured;
}

function list() {
  const selected = new Set(readProviderSelection());
  const poolAuthoritySnapshot = providerApiKeyAuthoritySnapshot();
  // Protocol variants follow their parent's selection and credential, so the
  // catalog shows one row per family instead of three opencode Go entries.
  return [...PROVIDERS.values()]
    .filter((provider) => !provider.variantOf)
    .map((provider) => ({
      id: provider.id,
      name: provider.displayName,
      visible: selected.has(provider.id),
      configured: configured(provider, poolAuthoritySnapshot),
    }));
}

const GENERIC_MUTATIONS = new Set(["add", "edit", "enable", "disable", "remove"]);

async function runGenericCredentialCommand(args, {
  prompt = promptForSecret,
  transact = transactModelOverlayMutation,
  applyPublication = applyModelOverlayPublication,
} = {}) {
  const providerId = String(args[1] || "").trim();
  const action = args[2] || "status";
  const json = args.includes("--json");
  if (!providerId || !["status", "set", "remove"].includes(action)) {
    throw new Error("Usage: providers generic credential PROVIDER status|set|remove [--json]");
  }
  const unexpected = args.slice(3).filter((arg) => arg !== "--json");
  if (unexpected.length) throw new Error(`Unknown generic credential option: ${unexpected[0]}`);
  const descriptor = getGenericProvider(providerId);
  const status = () => ({
    providerId,
    credentialRef: descriptor.credentialRef || null,
    configured: genericProviderConfigured(providerId),
  });
  if (action === "status") {
    const result = status();
    process.stdout.write(json
      ? `${JSON.stringify(result, null, 2)}\n`
      : `${providerId} credential is ${result.configured ? "configured" : "not configured"}.\n`);
    return result;
  }

  const value = action === "set"
    ? prompt(`${descriptor.displayName} API key`)
    : undefined;
  let credentialId = descriptor.credentialRef;
  await transact({
    files: [
      GENERIC_PROVIDERS_PATH,
      PROVIDER_CREDENTIAL_STORE_PATH,
      genericProviderCredentialPath(providerId),
    ],
    mutate: async () => {
      if (action === "set") {
        const existing = readProviderCredentialStore().credentials.find(
          (credential) => credential.id === credentialId,
        );
        if (existing && (
          existing.providerType !== "generic" ||
          existing.providerId !== providerId ||
          existing.kind !== "api_key" ||
          existing.state !== "active"
        )) {
          throw new Error(
            existing.state !== "active"
              ? `Credential reference ${credentialId} is inactive; remove it before setting a replacement.`
              : `Credential reference ${credentialId} belongs to another provider boundary.`,
          );
        }
        if (!existing) {
          const created = addGenericProviderCredentialReference({
            ...(credentialId ? { id: credentialId } : {}),
            providerId,
            label: `${descriptor.displayName} API key`,
          });
          credentialId = created.id;
        }
        writeGenericProviderCredential(providerId, value);
        updateGenericProvider(providerId, { credentialRef: credentialId });
      } else {
        removeGenericProviderCredential(providerId);
        if (credentialId) removeCredentialReference(credentialId);
        updateGenericProvider(providerId, { credentialRef: undefined });
        credentialId = undefined;
      }
    },
    applyPublication,
  });
  const result = {
    providerId,
    credentialRef: credentialId || null,
    configured: action === "set" && genericProviderConfigured(providerId),
  };
  process.stdout.write(json
    ? `${JSON.stringify(result, null, 2)}\n`
    : `${providerId} credential ${action === "set" ? "saved to protected local storage" : "removed"}. ${targetRestartHint()}\n`);
  return result;
}

export async function runGenericCommand(args, dependencies) {
  const action = args[0] || "list";
  if (action === "credential") return runGenericCredentialCommand(args, dependencies);
  if (!GENERIC_MUTATIONS.has(action)) {
    return runGenericProviderCli(args);
  }
  const providerId = String(args[1] || "").trim();
  const noApply = args.includes("--no-apply");
  let output = "";
  let result;
  let routedModels = [];
  await transactModelOverlayMutation({
    files: [
      GENERIC_PROVIDERS_PATH,
      USER_MODELS_PATH,
      MODEL_PICKER_STATE_PATH,
      SEARCH_SIDECARS_PATH,
      ...(action === "remove"
        ? [PROVIDER_CREDENTIAL_STORE_PATH, genericProviderCredentialPath(providerId)]
        : []),
    ],
    mutate: async () => {
      // Read after the cross-process overlay lock is held. A curation command
      // may have committed while this command was queued, and descriptor
      // removal must not leave those newly added routes or picker decisions
      // behind.
      routedModels = readUserModels().filter((model) => model?.provider === providerId);
      const removedProvider = action === "remove" ? getGenericProvider(providerId) : undefined;
      if (noApply && routedModels.length > 0) {
        throw new Error(
          `--no-apply is unsafe while ${providerId} has ${routedModels.length} curated model route(s); rerun without it so the running route cannot drift.`,
        );
      }
      result = await runGenericProviderCli(args, {
        output: { write: (chunk) => { output += String(chunk); } },
      });
      if (action !== "remove") return;
      const allModels = readUserModels();
      writeUserModels(allModels.filter((model) => model?.provider !== providerId));
      forgetModelVisibility(routedModels.map((model) => model.slug));
      removeSearchSidecarBindingsForProvider(providerId);
      removeGenericProviderCredential(providerId);
      if (removedProvider?.credentialRef) removeCredentialReference(removedProvider.credentialRef);
    },
    restart: !noApply,
    applyPublication: noApply
      ? async () => ({ published: false })
      : applyModelOverlayPublication,
  });
  process.stdout.write(output);
  const json = args.includes("--json");
  if (noApply) {
    if (!json) {
      process.stdout.write("Saved generic provider state without publishing an unused route.\n");
    }
    return result;
  }
  if (action === "remove") {
    if (!json) {
      process.stdout.write(
        `Removed ${routedModels.length} curated model route(s) and their picker decisions.\n`,
      );
    }
  } else {
    if (!json) {
      process.stdout.write(
        `Republished the routing plane (${routedModels.length} curated model route(s)) and reloaded the installed router if present.\n`,
      );
    }
  }
  return result;
}

async function main() {
  const command = process.argv[2] || "list";
  const operation = providerOperationContext(command);
  try {
  const providerId = process.argv[3];
  if (command === "generic") {
    await runGenericCommand(process.argv.slice(3));
    return;
  }
  if (command === "list") {
    const providers = list();
    if (process.argv.includes("--json")) {
      process.stdout.write(`${JSON.stringify({ providers }, null, 2)}\n`);
    } else {
      for (const provider of providers) {
        process.stdout.write(
          `${provider.visible ? "SHOW" : "HIDE"} ${provider.id.padEnd(12)} ${provider.configured ? "ready" : "setup needed"}  ${provider.name}\n`,
        );
      }
    }
    return;
  }
  // Toggling a protocol variant toggles its whole family, so report the
  // canonical provider the user actually changed.
  const provider = PROVIDERS.get(canonicalProviderId(providerId ?? ""));
  if (command === "login") {
    if (provider?.id !== "antigravity-oauth") {
      throw new Error("Usage: providers login antigravity-oauth");
    }
    // Antigravity is the one OAuth provider whose browser flow belongs to the
    // router. Kimi and Grok retain their official CLI sessions, which need a
    // real terminal instead of a child with piped stdio.
    await loginOauthProvider(provider.id, operation);
    await withModelOverlayLock(() => refreshTargetPickerIfInstalled(operation));
    process.stdout.write(
      `${provider.displayName} sign-in completed with the operator-owned OAuth client. ` +
        `The route remains disabled until an explicit live compatibility test succeeds.\n` +
        `Run \`${providersCommand("probe", provider.id)} --live --yes\`; this sends a small prompt and uses provider quota.\n`,
    );
    return;
  }
  if (command === "probe") {
    if (provider?.id !== "antigravity-oauth") {
      throw new Error("Usage: providers probe antigravity-oauth --live --yes [--provision-project]");
    }
    const { probeAntigravity } = await import("./antigravity-oauth-probe.mjs");
    const refreshInstalledClients = ({
      signal = operation.signal,
      deadline = operation.deadline,
    } = {}) => withModelOverlayLock(async () => {
      await forgetProviderCatalogFamilyCache(provider.id);
      return refreshTargetPickerIfInstalled({ signal, deadline });
    });
    const { result, refreshed } = await activateAntigravityProbe({
      probe: probeAntigravity,
      probeOptions: antigravityProbeOptions(process.argv.slice(4)),
      // Probe invalidation happens before its first provider request. Publish
      // that fail-closed state immediately so a previous proof cannot remain
      // advertised while the explicit re-probe is in flight or fails.
      withdraw: refreshInstalledClients,
      // A successful managed restart waits for start.mjs, which conditionally
      // spawns and health-gates this forwarder before router health succeeds.
      restart: () => restartRouterServiceIfInstalled(operation),
      publish: refreshInstalledClients,
      signal: operation.signal,
      deadline: operation.deadline,
    });
    process.stdout.write(
      `${provider.displayName} accepted the truthful Codex Router live probe with ${result.model}.\n`,
    );
    if (!readProviderSelection().includes(provider.id)) {
      process.stdout.write(
        `Run \`${providersCommand("enable", provider.id)}\` to add its models without changing any other provider.\n`,
      );
    }
    process.stdout.write(
      "The managed router service restarted and confirmed the verified Antigravity boundary.\n",
    );
    if (refreshed) process.stdout.write(`${targetRestartHint()}\n`);
    return;
  }
  if (command === "disconnect") {
    if (provider?.id !== "antigravity-oauth") {
      throw new Error("Usage: providers disconnect antigravity-oauth");
    }
    await withModelOverlayLock(async () => {
      await removeApiCredential(provider.id);
      // removeApiCredential also withdraws the selection. Republish even when
      // the credential vanished first, or installed clients can retain a
      // stale Antigravity route after an otherwise successful disconnect.
      await refreshTargetPickerIfInstalled(operation);
    });
    process.stdout.write(
      `${provider.displayName} disconnected; its operator OAuth client, session, live proof, and picker selection were removed.\n`,
    );
    return;
  }
  if (!provider || !["enable", "disable"].includes(command)) {
    throw new Error(
      "Usage: providers [list [--json]|login antigravity-oauth|probe antigravity-oauth --live --yes [--provision-project]|disconnect antigravity-oauth|enable ID|disable ID|generic ...]",
    );
  }
  if (command === "enable" && !configured(provider)) {
    const keySetup = `run \`${targetCli(`provider-key ${provider.id} set`)}\``;
    const oauthStatus = provider.kind === "oauth"
      ? SIGN_IN_STATUS[provider.id]?.status()
      : undefined;
    const setup = provider.kind === "oauth"
      ? oauthStatus?.setup || SIGN_IN_STATUS[provider.id]?.setup || "sign in with the provider CLI"
      : provider.credential?.resolver
        ? credentialSetupHint(provider)
        : keySetup;
    throw new Error(`${provider.displayName} is not configured; ${setup} first.`);
  }
  let providers;
  let refreshed;
  await withModelOverlayLock(async () => {
    providers = command === "enable"
      ? enableProvider(providerId)
      : disableProvider(providerId);
    refreshed = await refreshTargetPickerIfInstalled();
  });
  // "shown in the model picker" is false for a catalog-only provider with no
  // curated models: enabling it changes nothing the user can see. Say what
  // actually happened, and name the step that makes it true.
  const uncurated = command === "enable" && providerNeedsCuration(providerId);
  const visibility = uncurated
    ? `is enabled, but ships no preselected models so the ${targetPickerName()} model picker stays empty`
    : `is now ${command === "enable" ? "shown" : "hidden"} in the ${targetPickerName()} model picker`;
  process.stdout.write(
    `${provider.displayName} ${visibility}. Enabled providers: ${providers.join(", ") || "none"}.${refreshed ? ` ${targetRestartHint()}` : ""}\n`,
  );
  if (command === "enable" && provider.planNote) {
    process.stdout.write(`${provider.planNote}\n`);
  }
  if (uncurated) {
    process.stdout.write(
      `Run ./bin/curate-models ${providerId} in an interactive terminal to choose its models.\n`,
    );
  }
  } finally {
    operation.dispose?.();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] || "list";
  const needsBoundary = ["login", "probe", "disconnect"].includes(command);
  const execute = async () => {
    if (needsBoundary && !boundedOperationChild(process.env, {
      maximumMs: MAX_PROVIDER_OPERATION_MS,
    })) {
      const deadline = operationDeadlineFromEnvironment(process.env, {
        timeoutMs: MAX_PROVIDER_OPERATION_MS,
        maximumMs: MAX_PROVIDER_OPERATION_MS,
      });
      const result = await runOperationProcessTree(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
        cwd: process.cwd(),
        env: process.env,
        childEnvironment: {
          CODEX_ROUTER_OPERATION_CHILD: "1",
        },
        deadline,
        stdio: "inherit",
      });
      if (result.status !== 0) process.exitCode = result.status ?? 1;
      return;
    }
    await main();
  };
  execute().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
