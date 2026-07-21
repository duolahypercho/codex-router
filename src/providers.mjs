import { fileURLToPath } from "node:url";
import path from "node:path";

import { PROVIDERS } from "./model-registry.mjs";
import { grokOAuthStatus } from "./grok-oauth-status.mjs";
import { kimiOAuthStatus } from "./oauth-status.mjs";
import { credentialStatus } from "./provider-credentials.mjs";
import {
  disableProvider,
  enableProvider,
  readProviderSelection,
} from "./provider-selection.mjs";
import {
  refreshTargetPickerIfInstalled,
  targetCli,
  targetPickerName,
} from "./target-integration.mjs";

function configured(provider) {
  return provider.kind === "oauth"
    ? provider.id === "kimi-oauth"
      ? kimiOAuthStatus().configured
      : provider.id === "grok-oauth" && grokOAuthStatus().configured
    : credentialStatus(provider, { persistent: true }).configured;
}

function list() {
  const selected = new Set(readProviderSelection());
  return [...PROVIDERS.values()].map((provider) => ({
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
  const provider = PROVIDERS.get(providerId);
  if (!provider || !["enable", "disable"].includes(command)) {
    throw new Error("Usage: providers [list [--json]|enable ID|disable ID]");
  }
  if (command === "enable" && !configured(provider)) {
    const setup = provider.kind === "oauth"
      ? provider.id === "grok-oauth"
        ? "run `grok login`"
        : "run `kimi login`"
      : `run \`${targetCli(`provider-key ${provider.id} set`)}\``;
    throw new Error(`${provider.displayName} is not configured; ${setup} first.`);
  }
  const providers = command === "enable"
    ? enableProvider(providerId)
    : disableProvider(providerId);
  const refreshed = refreshTargetPickerIfInstalled();
  process.stdout.write(
    `${provider.displayName} is now ${command === "enable" ? "shown" : "hidden"} in the ${targetPickerName()} model picker. Enabled providers: ${providers.join(", ") || "none"}.${refreshed ? ` Fully quit and reopen ${targetPickerName()}.` : ""}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
