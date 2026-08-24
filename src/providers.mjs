import { fileURLToPath } from "node:url";
import path from "node:path";

import { PROVIDERS, providerNeedsNoKey } from "./model-registry.mjs";
import { devinCliStatus } from "./devin-cli-status.mjs";
import { grokOAuthStatus } from "./grok-oauth-status.mjs";
import { antigravityOAuthStatus } from "./antigravity-oauth-status.mjs";
import { kimiOAuthStatus } from "./oauth-status.mjs";
import { credentialStatus } from "./provider-credentials.mjs";
import {
  loginOauthProvider,
  providerNeedsCuration,
} from "./provider-onboarding.mjs";
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
import { runGenericProviderCli } from "./generic-providers.mjs";

function providersCommand(action, providerId) {
  return process.platform === "win32"
    ? `.\\codex-router.ps1 providers ${action} ${providerId}`
    : `./bin/providers ${action} ${providerId}`;
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

function configured(provider) {
  if (provider.kind === "oauth") {
    return Boolean(SIGN_IN_STATUS[provider.id]?.status().configured);
  }
  return providerNeedsNoKey(provider)
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

async function main() {
  const command = process.argv[2] || "list";
  const providerId = process.argv[3];
  if (command === "generic") {
    await runGenericProviderCli(process.argv.slice(3));
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
    await loginOauthProvider(provider.id);
    if (readProviderSelection().includes(provider.id)) {
      process.stdout.write(`${provider.displayName} sign-in completed; the provider remains enabled.\n`);
    } else {
      process.stdout.write(
        `${provider.displayName} sign-in completed. Run \`${providersCommand("enable", provider.id)}\` to add its models without changing any other provider.\n`,
      );
    }
    // The forwarder that serves these models is spawned only when a session
    // exists, so a router that started before this sign-in has none. Say so
    // here rather than leaving the first routed turn to fail on a port nothing
    // is listening on.
    process.stdout.write(
      `The Antigravity forwarder starts with the router service; run \`${targetCli("control service restart")}\` so it picks up this session.\n`,
    );
    return;
  }
  if (!provider || !["enable", "disable"].includes(command)) {
    throw new Error(
      "Usage: providers [list [--json]|login antigravity-oauth|enable ID|disable ID|generic ...]",
    );
  }
  if (command === "enable" && !configured(provider)) {
    const keySetup = `run \`${targetCli(`provider-key ${provider.id} set`)}\``;
    const setup = provider.kind === "oauth"
      ? SIGN_IN_STATUS[provider.id]?.setup || "sign in with the provider CLI"
      : keySetup;
    throw new Error(`${provider.displayName} is not configured; ${setup} first.`);
  }
  let providers;
  let refreshed;
  await withModelOverlayLock(async () => {
    providers = command === "enable"
      ? enableProvider(providerId)
      : disableProvider(providerId);
    refreshed = refreshTargetPickerIfInstalled();
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
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
