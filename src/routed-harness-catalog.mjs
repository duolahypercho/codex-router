// What each routed harness is told about the router, and where it is told it.
//
// Five clients — opencode, pi, omp, Command Code, and Hermes Agent — all offer
// the same thing: a user-owned configuration document with a mapping of custom
// providers in it. That similarity is why they share one publisher
// (`routed-harness-manager.mjs`) instead of getting five near-identical
// managers; this file is the part that genuinely differs, and it is data.
//
// Two rules shape every entry below.
//
// **The wire is one the router already serves.** The caller endpoint answers
// `/v1/responses` and, behind the `/anthropic` leaf, the Anthropic Messages
// API (`claude-surface.mjs`). Nothing else. A harness that speaks Responses is
// pointed at the former; a harness that does not is pointed at the latter with
// `claude-model-id.mjs` ids, because that surface exists precisely so a
// non-Codex client can reach every routed model. No entry here invents a third
// protocol and hopes.
//
// **The capability is the URL, not the key.** The caller secret is a path
// segment (`caller-auth.mjs`), so a bearer is redundant: the request is already
// authorized by the time a header is read. Where a harness treats a keyless
// provider as first-class it is declared keyless; where a harness hides
// keyless models from its own picker, the same secret is repeated in the field
// it looks at. Both are noted per entry, because the difference is not
// cosmetic — it decides whether the models show up at all.

import { claudeModelId } from "./claude-model-id.mjs";

/** The single key the router owns inside each client's provider mapping. */
export const ROUTED_HARNESS_PROVIDER_ID = "codex-router";
export const ROUTED_HARNESS_DISPLAY_NAME = "Codex Router";

// The modalities the registry ever declares. Curated user models are
// hand-edited state and may say anything, so every adapter filters.
const MODALITIES = new Set(["text", "image"]);

function inputModalities(model) {
  const input = (model.inputModalities || ["text"]).map(String).filter((value) => MODALITIES.has(value));
  return input.length ? input : ["text"];
}

function contextWindow(model) {
  return Number.isInteger(model.contextWindow) && model.contextWindow > 0
    ? model.contextWindow
    : undefined;
}

function efforts(model, vocabulary) {
  const levels = Array.isArray(model.reasoningLevels) ? model.reasoningLevels : [];
  return [...new Set(levels.map((level) => String(level?.effort || "")).filter((effort) => vocabulary.has(effort)))];
}

/** The model a fresh session should start on: the highest priority routed one. */
export function routedHarnessDefaultModel(models) {
  return [...models].sort(
    (left, right) =>
      (right.priority ?? 0) - (left.priority ?? 0) ||
      String(left.slug).localeCompare(String(right.slug)),
  )[0];
}

// ---------------------------------------------------------------------------
// opencode
// ---------------------------------------------------------------------------

// opencode resolves a provider to an AI SDK package. `@ai-sdk/openai-compatible`
// is its Chat Completions client and `@ai-sdk/openai` its Responses client, and
// the router serves only the latter — so this is `@ai-sdk/openai` pointed at
// the caller base URL, not the "compatible" package the phrase
// "OpenAI-compatible endpoint" suggests.
//
// opencode's schema requires `output` beside `context` whenever `limit` is
// present and rejects the whole document otherwise: opencode 1.18 refused every
// model of a `{ context }`-only publish. The router has no per-model output cap
// to report, but it does know where Codex compacts (`autoCompact`). opencode
// compacts at `limit.input` less a small reserve when `input` is set, so
// `input` is that threshold and `output` is the headroom the registry leaves
// above it; opencode caps a single request at 32k either way. A model with no
// usable threshold publishes no limit, which opencode reads as unknown.
function opencodeLimit(model) {
  const context = contextWindow(model);
  const threshold = model.autoCompact;
  if (!context || !Number.isInteger(threshold) || threshold <= 0 || threshold >= context) return undefined;
  return { context, input: threshold, output: context - threshold };
}

function opencodeProvider({ models, baseUrl, secret }) {
  return {
    npm: "@ai-sdk/openai",
    name: ROUTED_HARNESS_DISPLAY_NAME,
    options: {
      baseURL: baseUrl,
      // opencode passes this straight to the SDK, which always sends a bearer.
      // The path capability is what actually authorizes the call; repeating the
      // secret here costs nothing and avoids an SDK that refuses to construct a
      // client with no key at all.
      apiKey: secret,
    },
    models: Object.fromEntries(models.map((model) => {
      const limit = opencodeLimit(model);
      return [String(model.slug), {
        name: String(model.displayName || model.slug),
        ...(limit ? { limit } : {}),
      }];
    })),
  };
}

// ---------------------------------------------------------------------------
// pi
// ---------------------------------------------------------------------------

// pi loads `models.json` regardless of auth, but a provider with no resolvable
// key leaves every model listed and unselectable in `/model`. So the secret is
// repeated in `apiKey` with `authHeader` to send it. pi reads `$NAME` as an
// environment variable and `!cmd` as a command; a caller secret matches
// `[A-Za-z0-9_-]+` and can never begin with either, so it is always a literal.
function piProvider({ models, baseUrl, secret }) {
  return {
    baseUrl,
    api: "openai-responses",
    apiKey: secret,
    authHeader: true,
    models: models.map((model) => {
      const context = contextWindow(model);
      return {
        id: String(model.slug),
        name: String(model.displayName || model.slug),
        reasoning: efforts(model, PI_EFFORTS).length > 0,
        input: inputModalities(model),
        ...(context ? { contextWindow: context } : {}),
      };
    }),
  };
}

const PI_EFFORTS = new Set(["low", "medium", "high"]);

// ---------------------------------------------------------------------------
// omp (oh-my-pi)
// ---------------------------------------------------------------------------

// omp validates a full custom provider as needing `baseUrl`, an `api`, and a
// key *unless* `auth: none` — and it treats an `auth: none` provider as
// available rather than hiding it, which is the one case in this file where a
// harness's keyless path and its picker agree. So the secret stays in the URL
// and nowhere else.
const OMP_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);

function ompProvider({ models, baseUrl }) {
  return {
    baseUrl,
    api: "openai-responses",
    auth: "none",
    models: models.map((model) => {
      const context = contextWindow(model);
      return {
        id: String(model.slug),
        name: String(model.displayName || model.slug),
        reasoning: efforts(model, OMP_EFFORTS).length > 0,
        input: inputModalities(model),
        ...(context ? { contextWindow: context } : {}),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Command Code
// ---------------------------------------------------------------------------

// Command Code's BYOK wire is Chat Completions or Anthropic Messages; it has no
// Responses client. The router's Anthropic surface is the one it can reach, so
// the ids are `claude-model-id.mjs` ids and the base URL is the `/anthropic`
// leaf. `apiKey: false` is Command Code's own spelling for a keyless endpoint —
// and the only correct value here, because it refuses a pasted raw secret in
// that field outright. Its loader reads `name`, `contextWindow`, and
// `reasoningEfforts` per model; a model with no efforts is non-reasoning by
// omission, so nothing else is written.
const COMMANDCODE_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

function commandCodeProvider({ models, baseUrl }) {
  return {
    name: ROUTED_HARNESS_DISPLAY_NAME,
    api: "anthropic-messages",
    baseURL: baseUrl,
    apiKey: false,
    models: Object.fromEntries(models.map((model) => {
      const context = contextWindow(model);
      const reasoning = efforts(model, COMMANDCODE_EFFORTS);
      return [claudeModelId(model.slug), {
        name: String(model.displayName || model.slug),
        ...(context ? { contextWindow: context } : {}),
        ...(reasoning.length ? { reasoningEfforts: reasoning } : {}),
      }];
    })),
  };
}

// ---------------------------------------------------------------------------
// Hermes Agent
// ---------------------------------------------------------------------------

// Hermes names a custom endpoint's wire as `chat_completions`,
// `anthropic_messages`, or `codex_responses`. `codex_responses` is its xAI
// path rather than a generic Responses client, so this takes the Anthropic
// surface for the same reason Command Code does. `discover_models: false`
// matters: without it Hermes probes the endpoint's own catalog and would
// replace the published list with whatever that probe returned.
function hermesProvider({ models, baseUrl }) {
  return {
    name: ROUTED_HARNESS_DISPLAY_NAME,
    api: baseUrl,
    transport: "anthropic_messages",
    discover_models: false,
    models: Object.fromEntries(models.map((model) => {
      const context = contextWindow(model);
      return [claudeModelId(model.slug), context ? { context_length: context } : {}];
    })),
  };
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

const HARNESSES = Object.freeze([
  Object.freeze({
    id: "opencode",
    displayName: "opencode",
    ownership: "opencode",
    description: "The opencode terminal agent, publishing every model selected in this router.",
    docsUrl: "https://opencode.ai/docs/config/",
    siteUrl: "https://opencode.ai/",
    // `opencode-ai` declares one binary, named `opencode`, on every platform.
    executables: Object.freeze(["opencode"]),
    binEnv: "OPENCODE_BIN",
    npmPackage: "opencode-ai@latest",
    format: "json",
    documentKey: "OPENCODE_CONFIG_PATH",
    providerPath: Object.freeze(["provider", ROUTED_HARNESS_PROVIDER_ID]),
    baseUrlPath: Object.freeze(["options", "baseURL"]),
    // opencode also reads a JSONC sibling. This router re-serializes JSON and
    // would delete the comments in one, so a document it cannot round-trip
    // blocks publication with an explanation instead of being rewritten.
    conflictSiblings: Object.freeze(["opencode.jsonc"]),
    // The only harness here whose default-model key is a plain string in the
    // same document. The others keep theirs in a second file or behind a
    // mapping whose schema changes shape on first use, and guessing wrong there
    // costs a user their configured model for no gain.
    defaultModelPath: Object.freeze(["model"]),
    defaultModelValue: (model) => `${ROUTED_HARNESS_PROVIDER_ID}/${model.slug}`,
    wire: "responses",
    buildProvider: opencodeProvider,
    restartHint: "opencode reads its configuration when a session starts; the next `opencode` run picks this up.",
  }),
  Object.freeze({
    id: "pi",
    displayName: "pi",
    ownership: "pi",
    description: "Mario Zechner's pi coding agent, publishing every model selected in this router.",
    docsUrl: "https://pi.dev/docs/latest/models",
    siteUrl: "https://pi.dev/",
    executables: Object.freeze(["pi"]),
    binEnv: "PI_BIN",
    npmPackage: "@mariozechner/pi-coding-agent@latest",
    format: "json",
    documentKey: "PI_MODELS_PATH",
    providerPath: Object.freeze(["providers", ROUTED_HARNESS_PROVIDER_ID]),
    baseUrlPath: Object.freeze(["baseUrl"]),
    wire: "responses",
    buildProvider: piProvider,
    restartHint: "pi reads `models.json` at startup; the next `pi` run picks this up.",
  }),
  Object.freeze({
    id: "omp",
    displayName: "omp",
    ownership: "omp",
    description: "The omp (oh-my-pi) terminal agent, publishing every model selected in this router.",
    docsUrl: "https://github.com/can1357/oh-my-pi/blob/main/docs/models.md",
    siteUrl: "https://omp.sh/",
    // can1357/oh-my-pi, the project the `omp` command names. A fork published
    // as `@oh-labs/oh-omp` installs an `oh-omp` binary that reads `~/.oh-omp`,
    // so detecting both while writing into one home was wrong for the other.
    executables: Object.freeze(["omp"]),
    binEnv: "OMP_BIN",
    // `@oh-my-pi/pi-coding-agent` runs on Bun (`#!/usr/bin/env bun`, engines
    // `bun>=1.3.14`), so an `npm install -g` without Bun leaves an `omp` that
    // cannot start. Its supported installs are a `curl | sh` script, Homebrew,
    // and Bun itself, none of which this router runs on somebody's behalf.
    npmPackage: undefined,
    format: "yaml",
    documentKey: "OMP_MODELS_PATH",
    providerPath: Object.freeze(["providers", ROUTED_HARNESS_PROVIDER_ID]),
    baseUrlPath: Object.freeze(["baseUrl"]),
    wire: "responses",
    buildProvider: ompProvider,
    restartHint: "omp reloads `models.yml` on its next run.",
  }),
  Object.freeze({
    id: "commandcode",
    displayName: "Command Code",
    ownership: "commandcode",
    description: "Command Code's CLI as a BYOK client of this router's Anthropic surface.",
    docsUrl: "https://commandcode.ai/docs/byok",
    siteUrl: "https://commandcode.ai/",
    // `cmd` is taken by the Windows command shell, so Command Code ships as
    // `cmdc` there. `command-code` is the full name and works everywhere.
    executables: Object.freeze(
      process.platform === "win32"
        ? ["command-code", "cmdc"]
        : ["command-code", "cmd"],
    ),
    binEnv: "COMMANDCODE_BIN",
    npmPackage: "command-code@latest",
    // `providers.json` BYOK support first shipped in 1.30.0; 1.29.0 and earlier
    // never read the file, so publishing into an older CLI changes nothing it
    // can see. Setup updates such a CLI, and status reports it.
    minimumVersion: "1.30.0",
    format: "json",
    documentKey: "COMMANDCODE_PROVIDERS_PATH",
    providerPath: Object.freeze(["provider", ROUTED_HARNESS_PROVIDER_ID]),
    baseUrlPath: Object.freeze(["baseURL"]),
    wire: "anthropic",
    buildProvider: commandCodeProvider,
    restartHint: "Command Code applies `providers.json` live; reopen `/model` to see the routed models.",
  }),
  Object.freeze({
    id: "hermes",
    displayName: "Hermes Agent",
    ownership: "nousresearch",
    description: "Nous Research's Hermes Agent as a named custom provider on this router.",
    docsUrl: "https://hermes-agent.nousresearch.com/docs/integrations/providers",
    siteUrl: "https://hermes-agent.nousresearch.com/",
    executables: Object.freeze(["hermes"]),
    binEnv: "HERMES_BIN",
    // Hermes installs from its own shell script rather than a package
    // registry. Running a remote installer is not something this router does
    // on a user's behalf, so the row asks them to install it and then
    // publishes into the client they already have.
    npmPackage: undefined,
    format: "yaml",
    documentKey: "HERMES_CONFIG_PATH",
    providerPath: Object.freeze(["providers", ROUTED_HARNESS_PROVIDER_ID]),
    // Hermes names the endpoint `api`; `base_url` and `url` are accepted
    // aliases, but the wizard writes `api`, so that is what ours writes too.
    baseUrlPath: Object.freeze(["api"]),
    wire: "anthropic",
    buildProvider: hermesProvider,
    restartHint: "Hermes reads `config.yaml` at startup; restart `hermes` (or its gateway) to pick this up.",
  }),
]);

export const ROUTED_HARNESS_IDS = Object.freeze(HARNESSES.map((harness) => harness.id));

/** One harness definition, or undefined for an id this router does not publish. */
export function routedHarness(id) {
  return HARNESSES.find((harness) => harness.id === String(id || ""));
}

/** Every harness definition, in the order the Harness tab lists them. */
export function routedHarnesses() {
  return HARNESSES;
}

/** The harness definition for `id`, or a thrown error naming the valid set. */
export function assertRoutedHarness(id) {
  const harness = routedHarness(id);
  if (!harness) {
    throw new Error(`Unknown routed harness "${id}". Expected one of: ${ROUTED_HARNESS_IDS.join(", ")}.`);
  }
  return harness;
}
