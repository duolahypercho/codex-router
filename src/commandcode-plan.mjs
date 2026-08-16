// Which of Command Code's two routes this account is allowed to use.
//
// The answer is an entitlement the credential cannot reveal on its own: the
// same key that runs the CLI is refused by `/provider/v1` unless the account
// carries the Provider plan or a coding plan above Go. There is no documented
// endpoint that names the plan, so the only honest source of truth is the
// gateway's own answer -- a `403 upgrade_required` means this account routes
// through `/alpha/generate` instead.
//
// Remembering it matters because the alternative is buying that 403 once per
// turn, forever, on the very plan the router is trying to serve. Remembering
// it *per credential* matters because an operator who upgrades and mints a new
// key must not stay pinned to the fallback, and a re-check window covers the
// case where the plan changes under the same key.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

import { STATE_DIR } from "./paths.mjs";

export const COMMANDCODE_PLAN_PATH = path.join(STATE_DIR, "commandcode-plan.json");

// Long enough that a Go-plan account is not paying a wasted round-trip through
// a working day, short enough that an upgrade is noticed the same afternoon.
export const ROUTE_RECHECK_MS = 6 * 60 * 60 * 1000;

// Never the key itself, and never enough of it to be one: this file is state,
// not a credential store, and a fingerprint answers the only question asked of
// it -- "is this still the same key".
export function credentialFingerprint(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex").slice(0, 16);
}

function readDocument() {
  if (!existsSync(COMMANDCODE_PLAN_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(COMMANDCODE_PLAN_PATH, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // A corrupt file must never take routing down. Losing it costs one 403.
    return {};
  }
}

function writeDocument(document) {
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    const temporary = `${COMMANDCODE_PLAN_PATH}.tmp.${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporary, COMMANDCODE_PLAN_PATH);
    chmodSync(COMMANDCODE_PLAN_PATH, 0o600);
  } catch {
    // Entitlement memory is an optimization; failing to persist it must never
    // fail the turn it was learned from.
  }
}

/**
 * The route to try for this account right now.
 *
 * Unknown means "try the documented API first": it is the route the operator
 * paid for if they have it, and one 403 is what teaches this module otherwise.
 *
 * `recheck` marks the one case where a success is worth writing down -- a
 * known-refused account whose window has expired. Without it a healthy
 * Provider-plan account would rewrite the same state file on every single
 * turn to say what it already said.
 */
export function commandCodeRoute(providerId, credentialValue, { at = Date.now() } = {}) {
  const entry = readDocument()[String(providerId || "")];
  const known =
    entry && entry.credential === credentialFingerprint(credentialValue) && entry.providerApi === false;
  if (!known) return { route: "provider-api", recheck: false };
  const observed = Date.parse(entry.observedAt || "");
  if (Number.isFinite(observed) && at - observed > ROUTE_RECHECK_MS) {
    return { route: "provider-api", recheck: true };
  }
  return { route: "plan", recheck: false };
}

/**
 * Record what the gateway just said about this account.
 *
 * `providerApi: false` is only ever written from a real `upgrade_required`
 * refusal -- never from a timeout, a 500, or a rate limit, because those say
 * nothing about entitlement and pinning the fallback on one would quietly move
 * a paying Provider-plan account onto its coding-plan credits.
 */
export function recordCommandCodeRoute(
  providerId,
  credentialValue,
  { providerApi, at = Date.now() } = {},
) {
  const id = String(providerId || "").trim();
  if (!id || typeof providerApi !== "boolean") return;
  const document = readDocument();
  document[id] = {
    credential: credentialFingerprint(credentialValue),
    providerApi,
    observedAt: new Date(at).toISOString(),
  };
  writeDocument(document);
}

export function readCommandCodePlanState() {
  return readDocument();
}

/**
 * Is this refusal the entitlement one?
 *
 * Matched on the machine-readable code first; the message is a fallback for a
 * gateway that stops sending the code, and both are required to be a 403 so a
 * differently-shaped 401 can never be read as "downgrade this account".
 */
export function isUpgradeRequired(status, body) {
  if (status !== 403) return false;
  const error = body?.error || body;
  if (error?.code === "upgrade_required") return true;
  return /doesn't include API access|upgrade to/i.test(String(error?.message || ""));
}
