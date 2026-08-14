import { fileURLToPath } from "node:url";
import path from "node:path";

import { PROVIDERS } from "./model-registry.mjs";
import { cliSessionDescriptor } from "./cli-session-credential.mjs";
import { grokOAuthStatus } from "./grok-oauth-status.mjs";
import { kimiOAuthStatus } from "./oauth-status.mjs";
import { credentialStatus } from "./provider-credentials.mjs";
import { providerNeedsCuration } from "./provider-onboarding.mjs";
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

// One entry per OAuth vendor keeps adding a provider a registry-plus-map
// change instead of another branch in a nested conditional.
const SIGN_IN_STATUS = Object.freeze({
  "kimi-oauth": { status: kimiOAuthStatus, setup: "run `kimi login`" },
  "grok-oauth": { status: grokOAuthStatus, setup: "run `grok login --oauth`" },
});

function configured(provider) {
  if (provider.kind === "oauth") {
    return Boolean(SIGN_IN_STATUS[provider.id]?.status().configured);
  }
  return provider.keyless || provider.authMode === "anonymous"
    ? true
    : credentialStatus(provider, { persistent: true }).configured;
}

function list() {
  const selected = new Set(readProviderSelection());
  // Protocol variants follow their parent's selection and credential, so the
  // catalog shows one row per family instead of three opencode Go entries.
  return [...PROVIDERS.values()]
    .filter((provider) => !provider.variantOf)
    .map((provider) => ({
      id: provider.id,
      name: provider.displayName,
      visible: selected.has(provider.id),
      configured: configured(provider),
    }));
}

function main() {
  const command = process.argv[2] || "list";
  const providerId = process.argv[3];
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
  if (!provider || !["enable", "disable"].includes(command)) {
    throw new Error("Usage: providers [list [--json]|enable ID|disable ID]");
  }
  if (command === "enable" && !configured(provider)) {
    const session = cliSessionDescriptor(provider);
    const keySetup = `run \`${targetCli(`provider-key ${provider.id} set`)}\``;
    const setup = provider.kind === "oauth"
      ? SIGN_IN_STATUS[provider.id]?.setup || "sign in with the provider CLI"
      : session
        ? `run \`${session.loginCommand}\` or ${keySetup}`
        : keySetup;
    throw new Error(`${provider.displayName} is not configured; ${setup} first.`);
  }
  const providers = command === "enable"
    ? enableProvider(providerId)
    : disableProvider(providerId);
  const refreshed = refreshTargetPickerIfInstalled();
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
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
