import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PROVIDERS } from "./model-registry.mjs";
import { kimiOAuthStatus } from "./oauth-status.mjs";
import { NATIVE_CATALOG_PATH, SOURCE_ROOT } from "./paths.mjs";
import { credentialStatus } from "./provider-credentials.mjs";
import {
  disableProvider,
  enableProvider,
  readProviderSelection,
} from "./provider-selection.mjs";

function configured(provider) {
  return provider.kind === "oauth"
    ? provider.id === "kimi-oauth" && kimiOAuthStatus().configured
    : credentialStatus(provider, { persistent: true }).configured;
}

function refreshCatalog() {
  if (!existsSync(NATIVE_CATALOG_PATH)) return false;
  execFileSync(process.execPath, [path.join(SOURCE_ROOT, "src", "catalog.mjs")], {
    stdio: "inherit",
  });
  return true;
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
      ? "run `kimi login`"
      : `run \`./bin/provider-key ${provider.id} set\``;
    throw new Error(`${provider.displayName} is not configured; ${setup} first.`);
  }
  const providers = command === "enable"
    ? enableProvider(providerId)
    : disableProvider(providerId);
  const refreshed = refreshCatalog();
  process.stdout.write(
    `${provider.displayName} is now ${command === "enable" ? "shown" : "hidden"} in the Codex model picker. Enabled providers: ${providers.join(", ") || "none"}.${refreshed ? " Fully quit and reopen Codex." : ""}\n`,
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
