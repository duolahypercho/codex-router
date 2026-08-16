// A second slug for a native GPT model, carrying the context window OpenAI
// documents for it rather than the one Codex ships.
//
// Codex publishes one window per native model, and it is not always the
// model's. OpenAI documents GPT-5.6 Sol at 1,050,000 tokens; the catalog Codex
// captures on this machine declares 272,000 (openai/codex#31860, #32806). The
// gap is a deliberate product decision -- every turn resends the whole
// conversation, and a prompt above 272,000 input tokens is billed at a higher
// rate for the *entire* request -- so it is not the router's to overturn for
// everyone. What the router can offer is the choice, which is what the
// documented `model_context_window` / `model_auto_compact_token_limit` pair in
// `config.toml` does for a single install, and what these entries do for the
// picker.
//
// Each variant republishes its base entry under a new slug with the documented
// window and a compaction limit below it. Nothing about the upstream model
// changes: chatgpt.com has never heard of `gpt-5.6-sol-1m`, so the router
// rewrites the slug back to its base before the turn leaves
// (`nativeContextVariantBase`). The only difference is how much history Codex
// keeps before it compacts.
//
// They ship hidden. A model that costs more per turn than the one it shadows
// must be switched on deliberately, in the tray under OpenAI, and never
// arrive switched on in an update.

export const NATIVE_CONTEXT_VARIANTS = Object.freeze([
  Object.freeze({
    slug: "gpt-5.6-sol-1m",
    baseSlug: "gpt-5.6-sol",
    displayName: "GPT-5.6-Sol (1M context)",
    description:
      "Latest frontier agentic coding model, running at its documented 1M-token " +
      "context window. Turns above 272K input tokens bill at a higher rate.",
    contextWindow: 1_000_000,
    // Compaction starts here, leaving headroom below the window so a long turn
    // has somewhere to land. Mirrors the documented
    // `model_auto_compact_token_limit` guidance for this model.
    autoCompact: 900_000,
  }),
]);

export const NATIVE_CONTEXT_VARIANT_SLUGS = Object.freeze(
  NATIVE_CONTEXT_VARIANTS.map((variant) => variant.slug),
);

const BASE_BY_VARIANT = new Map(
  NATIVE_CONTEXT_VARIANTS.map((variant) => [variant.slug, variant.baseSlug]),
);

// The upstream model a variant slug stands for, or undefined for every slug
// that is already its own model. The request path asks this on the way out, so
// it must stay a pure lookup over the checked-in list: a variant that resolved
// through disk state could send a turn to a model the operator never picked.
export function nativeContextVariantBase(slug) {
  return BASE_BY_VARIANT.get(String(slug ?? ""));
}

function variantEntry(base, variant) {
  return {
    ...base,
    slug: variant.slug,
    display_name: variant.displayName,
    description: variant.description,
    context_window: variant.contextWindow,
    max_context_window: variant.contextWindow,
    auto_compact_token_limit: variant.autoCompact,
    // Announcement copy belongs to the model OpenAI shipped, not to a window
    // the router republished. Both cards would otherwise fire for what the
    // operator sees as one model.
    availability_nux: null,
    upgrade: null,
  };
}

// Appends every variant whose base the capture actually shipped as a listed
// model. A base that is missing, hidden, or unlisted (a signed-out capture, or
// a model OpenAI withdrew) produces nothing: a picker row whose upstream the
// account cannot pick is a row that fails on its first turn.
//
// `enabled: false` is how a login-free install opts out. There, Codex only
// displays native slugs from a server-delivered allowlist, so a synthesized
// slug would take an alias slot and then be invisible -- costing a routed
// model its own slot for nothing.
export function withNativeContextVariants(models, { enabled = true } = {}) {
  const list = Array.isArray(models) ? models : [];
  if (!enabled) return list;
  const bySlug = new Map(list.map((model) => [String(model?.slug), model]));
  const derived = [];
  for (const variant of NATIVE_CONTEXT_VARIANTS) {
    if (bySlug.has(variant.slug)) continue;
    const base = bySlug.get(variant.baseSlug);
    if (!base || base.visibility !== "list") continue;
    derived.push(variantEntry(base, variant));
  }
  return derived.length ? [...list, ...derived] : list;
}
