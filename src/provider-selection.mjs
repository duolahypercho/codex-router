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
import { targetCli } from "./target-integration.mjs";
import { kimiOAuthStatus } from "./oauth-status.mjs";
import { grokOAuthStatus } from "./grok-oauth-status.mjs";
import { credentialStatus } from "./provider-credentials.mjs";

const RETIRED_PROVIDER_ALIASES = new Map([["chatgpt-oauth", "grok-oauth"]]);

function providerIds() {
  return [...PROVIDERS.keys()];
}

// Protocol variants (registry `variantOf`) share their parent's credential and
// must never be selectable apart from it: the selection file stores only
// canonical parent ids, and every read expands a parent back into its family.
// That way a selection written before a variant existed still exposes it.
export function canonicalProviderId(id) {
  return PROVIDERS.get(id)?.variantOf || id;
}

function expandProviderIds(ids) {
  const selected = new Set(ids);
  for (const provider of PROVIDERS.values()) {
    if (provider.variantOf && selected.has(provider.variantOf)) {
      selected.add(provider.id);
    }
  }
  return [...selected];
}

// Trim, drop blanks, and rewrite retired ids to their successor. Shared by the
// strict write path and the tolerant read path so both resolve aliases the
// same way; only the handling of an id this build does not know differs.
function resolveProviderIds(values) {
  return values
    .map((value) => String(value).trim())
    .filter(Boolean)
    .map((value) => RETIRED_PROVIDER_ALIASES.get(value) || value);
}

// Write path: strict. Someone naming a provider -- on the CLI, in
// `install --providers`, in the guided picker, or through the tray -- gets a
// hard error for a typo instead of a silently narrower selection.
export function validateProviderIds(values) {
  const named = resolveProviderIds(values);
  for (const id of named) {
    if (!PROVIDERS.has(id)) throw new Error(`Unknown provider: ${id}`);
  }
  return [...new Set(named.map((id) => canonicalProviderId(id)))];
}

// Read path: tolerant. `PROVIDERS` is built from `config/` at module import, so
// the set of known ids is frozen for the life of the process while the
// selection file is rewritten by CLI runs that may come from another checkout.
// One id this build does not recognize -- version skew after an update, a
// renamed or removed provider -- must not take the whole router down, because
// this runs on every routed turn and as the first statement of /health.
function filterKnownProviderIds(values) {
  const known = [];
  const unknown = [];
  for (const id of resolveProviderIds(values)) {
    if (PROVIDERS.has(id)) known.push(canonicalProviderId(id));
    else unknown.push(id);
  }
  return { known: [...new Set(known)], unknown: [...new Set(unknown)] };
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
    } else if (provider.keyless || provider.authMode === "anonymous") {
      // Nothing to configure: local providers run on this machine, while
      // anonymous providers authenticate by the provider's free-model policy.
      // Reachability and rate limits remain health questions, not reasons to
      // hide a provider from the picker.
      configured.push(provider.id);
    } else if (credentialStatus(provider, { persistent: true }).configured) {
      configured.push(provider.id);
    }
  }
  return configured;
}

// `configuredProviderIds()` answers whether a provider can authenticate. The
// installer also needs a narrower answer: which configured providers may be
// enabled when the operator did not name any. Anonymous providers can
// authenticate without a key, but enabling one sends future prompts to a
// third-party endpoint, so it must be an explicit choice. Loopback keyless
// providers remain safe to include in the default.
export function defaultProviderIds() {
  return configuredProviderIds().filter(
    (id) => PROVIDERS.get(id)?.authMode !== "anonymous",
  );
}

// Never throws. Returns the providers to expose plus what had to be ignored, so
// doctor and the support bundle can report the damage while requests keep
// flowing. Degrading here matches every other state reader in the hot path
// (`readNativeAliases`, `readNativeRedirect`, the doctor's catalog read).
export function readProviderSelectionDetail() {
  if (
    process.env.MODEL_ROUTER_SHOW_ALL_MODELS === "1" ||
    (TARGET === "codex" && process.env.CODEX_ROUTER_SHOW_ALL_MODELS === "1")
  ) {
    return { providers: providerIds(), ignored: [], degraded: undefined };
  }
  if (!existsSync(PROVIDER_SELECTION_PATH)) {
    return { providers: providerIds(), ignored: [], degraded: undefined };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(PROVIDER_SELECTION_PATH, "utf8"));
  } catch (error) {
    return {
      providers: providerIds(),
      ignored: [],
      degraded: `Unreadable provider selection ${PROVIDER_SELECTION_PATH}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  if (parsed?.version !== 1 || !Array.isArray(parsed.providers)) {
    return {
      providers: providerIds(),
      ignored: [],
      degraded: `Invalid provider selection ${PROVIDER_SELECTION_PATH}: version/providers are invalid`,
    };
  }
  const { known, unknown } = filterKnownProviderIds(parsed.providers);
  // An explicitly empty list is a real choice -- disabling the last provider
  // writes `[]`, and hiding everything is supported -- so it stays empty.
  // A non-empty list that filters down to nothing is different: this build
  // recognizes none of the operator's choices, so their file says nothing
  // about the providers it does have. Falling back to the no-file default
  // leaves the install in the same coherent state as a fresh one instead of
  // stranding it with zero routable models, and the credential-aware catalog
  // still hides anything that cannot authenticate.
  if (known.length === 0 && unknown.length > 0) {
    return {
      providers: providerIds(),
      ignored: unknown,
      degraded: `Provider selection ${PROVIDER_SELECTION_PATH} names no provider this build knows (${
        unknown.join(", ")
      }); showing all providers until it is rewritten.`,
    };
  }
  return {
    providers: expandProviderIds(known),
    ignored: unknown,
    degraded: unknown.length
      ? `Provider selection ${PROVIDER_SELECTION_PATH} names unknown providers: ${unknown.join(", ")}`
      : undefined,
  };
}

export function readProviderSelection() {
  return readProviderSelectionDetail().providers;
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

// Enable/disable act on the whole variant family: toggling opencode-go (or any
// of its protocol variants) shows or hides every model that key can serve.
export function enableProvider(providerId) {
  const current = existsSync(PROVIDER_SELECTION_PATH)
    ? readProviderSelection()
    : defaultProviderIds();
  return writeProviderSelection([...current, providerId]);
}

export function disableProvider(providerId) {
  const target = canonicalProviderId(providerId);
  const current = existsSync(PROVIDER_SELECTION_PATH)
    ? readProviderSelection()
    : defaultProviderIds();
  return writeProviderSelection(
    current.filter((id) => canonicalProviderId(id) !== target),
  );
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
  const detail = readProviderSelectionDetail();
  return {
    path: PROVIDER_SELECTION_PATH,
    explicit: existsSync(PROVIDER_SELECTION_PATH),
    providers: detail.providers,
    ignored: detail.ignored,
    ...(detail.degraded ? { degraded: detail.degraded } : {}),
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
        : writeProviderSelection(defaultProviderIds());
      if (providers.length === 0) {
        throw new Error(
          `No provider credential is configured. Run ${
            targetCli("setup --guided")
          } before installing.`,
        );
      }
      const configured = new Set(configuredProviderIds());
      const missing = providers.filter((provider) => !configured.has(provider));
      if (missing.length) {
        throw new Error(
          `Selected providers need persistent authentication: ${missing.join(", ")}. Run ${
            targetCli("setup --guided")
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
