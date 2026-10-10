import { usesHy4NonceMarkup } from "./leaked-tool-call-recovery.mjs";

// Text can legitimately quote these delimiters. Destructive interpretation is
// an explicit route contract, independent of transport or reasoning replay.
export const REASONING_TAG_POLICIES = Object.freeze([
  "preserve",
  "legacy-inline",
  "hy4-nonce",
]);

export function reasoningTagPolicyKnown(value) {
  return typeof value === "string" && REASONING_TAG_POLICIES.includes(value);
}

export function reasoningTagPolicyProblem(route) {
  if (route?.reasoningTagPolicy === undefined) return undefined;
  if (!reasoningTagPolicyKnown(route.reasoningTagPolicy)) {
    return "has an invalid reasoningTagPolicy; expected preserve, legacy-inline, or hy4-nonce";
  }
  if (route.reasoningTagPolicy === "hy4-nonce" && !usesHy4NonceMarkup(route)) {
    return "may only use reasoningTagPolicy hy4-nonce on a verified Hy4 Preview route";
  }
  return undefined;
}

function defaultPolicy(route) {
  // #654 captured the nonce-suffixed leak on commandcode/hy4-preview. The
  // existing strict family gate also serves the Hy4 tool-markup repair; bare
  // tags have no evidenced destructive meaning under this nonce contract.
  if (usesHy4NonceMarkup(route)) return "hy4-nonce";
  // #600's live capture and end-to-end verification identify this exact route.
  // Neither other Qwen models nor the qwen38-community endpoint inherit that
  // observation merely because their name or request profile looks similar.
  // https://github.com/duolahypercho/codex-router/pull/600
  if (route?.provider === "qwen-plan" && route?.upstreamModel === "qwen3.8-flash") {
    return "legacy-inline";
  }
  return "preserve";
}

// Undefined means no transform: preserve even literal complete tags exactly.
// Responses upstreams may opt in when a captured leak proves they need it;
// protocol names alone neither enable cleaning nor certify compatibility.
export function reasoningTagOptionsForRoute(route) {
  const problem = reasoningTagPolicyProblem(route);
  if (problem) throw new TypeError(`Route ${route?.slug || "<unknown>"} ${problem}`);
  const policy = route?.reasoningTagPolicy ?? defaultPolicy(route);
  if (policy === "preserve") return undefined;
  return {
    plainDelimiters: policy === "legacy-inline",
    // An operator cannot lend Hy4's orphan-prefix deletion to another family.
    // Explicit legacy-inline on Hy4 opts into bare tags as well as its nonce.
    nonceDelimiters: usesHy4NonceMarkup(route),
  };
}
