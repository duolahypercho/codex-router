import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { protectPrivateFile } from "./file-security.mjs";
import { PROVIDER_SELECTION_PATH, STATE_DIR, TARGET } from "./paths.mjs";
import { LISTED_MODELS, PROVIDERS } from "./model-registry.mjs";
import { kimiOAuthStatus } from "./oauth-status.mjs";
import { grokOAuthStatus } from "./grok-oauth-status.mjs";
import { credentialStatus } from "./provider-credentials.mjs";

const RETIRED_PROVIDER_ALIASES = new Map([["chatgpt-oauth", "grok-oauth"]]);

function providerIds() {
  return [...PROVIDERS.keys()];
}

export function validateProviderIds(values) {
  const ids = [
    ...new Set(
      values
        .map((value) => String(value).trim())
        .filter(Boolean)
        .map((value) => RETIRED_PROVIDER_ALIASES.get(value) || value),
    ),
  ];
  for (const id of ids) {
    if (!PROVIDERS.has(id)) throw new Error(`Unknown provider: ${id}`);
  }
  return ids;
}

export function configuredProviderIds() {
  const configured = [];
  for (const provider of PROVIDERS.values()) {
    if (provider.kind === "oauth") {
      if (provider.id === "kimi-oauth" && kimiOAuthStatus().configured) {
        configured.push(provider.id);
      } else if (provider.id === "grok-oauth" && grokOAuthStatus().configured) {
        configured.push(provider.id);
      }
    } else if (credentialStatus(provider, { persistent: true }).configured) {
      configured.push(provider.id);
    }
  }
  return configured;
}

export function readProviderSelection() {
  if (
    process.env.MODEL_ROUTER_SHOW_ALL_MODELS === "1" ||
    (TARGET === "codex" && process.env.CODEX_ROUTER_SHOW_ALL_MODELS === "1")
  ) {
    return providerIds();
  }
  if (!existsSync(PROVIDER_SELECTION_PATH)) return providerIds();
  try {
    const parsed = JSON.parse(readFileSync(PROVIDER_SELECTION_PATH, "utf8"));
    if (parsed?.version !== 1 || !Array.isArray(parsed.providers)) {
      throw new Error("version/providers are invalid");
    }
    return validateProviderIds(parsed.providers);
  } catch (error) {
    throw new Error(
      `Invalid provider selection ${PROVIDER_SELECTION_PATH}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function writeProviderSelection(values) {
  const providers = validateProviderIds(values);
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  chmodSync(STATE_DIR, 0o700);
  const temporary = `${PROVIDER_SELECTION_PATH}.tmp.${process.pid}`;
  writeFileSync(
    temporary,
    `${JSON.stringify({ version: 1, providers }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  protectPrivateFile(temporary);
  renameSync(temporary, PROVIDER_SELECTION_PATH);
  protectPrivateFile(PROVIDER_SELECTION_PATH);
  return providers;
}

export function enableProvider(providerId) {
  const current = existsSync(PROVIDER_SELECTION_PATH)
    ? readProviderSelection()
    : configuredProviderIds();
  return writeProviderSelection([...current, providerId]);
}

export function disableProvider(providerId) {
  if (!existsSync(PROVIDER_SELECTION_PATH)) {
    return writeProviderSelection(configuredProviderIds().filter((id) => id !== providerId));
  }
  const next = readProviderSelection().filter((id) => id !== providerId);
  return writeProviderSelection(next);
}

export function selectedListedModels() {
  const selected = new Set(readProviderSelection());
  return LISTED_MODELS.filter((model) => selected.has(model.provider));
}

export function selectedConfiguredListedModels() {
  const selected = new Set(readProviderSelection());
  const configured = new Set(configuredProviderIds());
  return LISTED_MODELS.filter(
    (model) => selected.has(model.provider) && configured.has(model.provider),
  );
}

export function providerSelectionStatus() {
  return {
    path: PROVIDER_SELECTION_PATH,
    explicit: existsSync(PROVIDER_SELECTION_PATH),
    providers: readProviderSelection(),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const command = process.argv[2] || "status";
    if (command === "status") {
      process.stdout.write(`${JSON.stringify(providerSelectionStatus(), null, 2)}\n`);
    } else if (command === "set") {
      const values = process.argv.slice(3).flatMap((value) => value.split(","));
      process.stdout.write(
        `${JSON.stringify({ providers: writeProviderSelection(values) }, null, 2)}\n`,
      );
    } else if (command === "ensure-configured") {
      const providers = existsSync(PROVIDER_SELECTION_PATH)
        ? readProviderSelection()
        : writeProviderSelection(configuredProviderIds());
      if (providers.length === 0) {
        throw new Error(
          `No provider credential is configured. Run ${
            TARGET === "cursor"
              ? "./bin/model-router cursor setup --guided"
              : "./bin/setup --guided"
          } before installing.`,
        );
      }
      const configured = new Set(configuredProviderIds());
      const missing = providers.filter((provider) => !configured.has(provider));
      if (missing.length) {
        throw new Error(
          `Selected providers need persistent authentication: ${missing.join(", ")}. Run ${
            TARGET === "cursor"
              ? "./bin/model-router cursor setup --guided"
              : "./bin/setup --guided"
          }.`,
        );
      }
      process.stdout.write(`${JSON.stringify({ providers }, null, 2)}\n`);
    } else {
      console.error(
        "Usage: provider-selection.mjs status|set [provider,...]|ensure-configured",
      );
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
