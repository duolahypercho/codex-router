import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const stateDir = mkdtempSync(path.join(os.tmpdir(), "commandcode-plan-test-"));
process.env.MODEL_ROUTER_STATE_DIR = stateDir;

const {
  COMMANDCODE_PLAN_PATH,
  ROUTE_RECHECK_MS,
  commandCodeRoute,
  isUpgradeRequired,
  readCommandCodePlanState,
  recordCommandCodeRoute,
} = await import("../src/commandcode-plan.mjs");

const AT = Date.parse("2026-08-16T09:00:00.000Z");

function forget() {
  rmSync(COMMANDCODE_PLAN_PATH, { force: true });
}

// The documented API is what the operator paid for if they have it, so an
// account nobody has heard a refusal from tries it first.
test("an unknown account tries the documented API", () => {
  forget();
  assert.deepEqual(commandCodeRoute("commandcode", "key-a", { at: AT }), {
    route: "provider-api",
    recheck: false,
  });
});

test("a refused account routes through the plan without asking again", () => {
  forget();
  recordCommandCodeRoute("commandcode", "key-a", { providerApi: false, at: AT });
  assert.deepEqual(commandCodeRoute("commandcode", "key-a", { at: AT + 60_000 }), {
    route: "plan",
    recheck: false,
  });
});

// An operator who upgrades mints a new key, and the old answer says nothing
// about it.
test("a different credential is a different question", () => {
  forget();
  recordCommandCodeRoute("commandcode", "key-a", { providerApi: false, at: AT });
  assert.equal(commandCodeRoute("commandcode", "key-b", { at: AT }).route, "provider-api");
});

test("the refusal is re-checked once its window comes due", () => {
  forget();
  recordCommandCodeRoute("commandcode", "key-a", { providerApi: false, at: AT });
  assert.deepEqual(commandCodeRoute("commandcode", "key-a", { at: AT + ROUTE_RECHECK_MS + 1 }), {
    route: "provider-api",
    recheck: true,
  });
  recordCommandCodeRoute("commandcode", "key-a", { providerApi: true, at: AT + ROUTE_RECHECK_MS + 2 });
  assert.deepEqual(commandCodeRoute("commandcode", "key-a", { at: AT + ROUTE_RECHECK_MS + 3 }), {
    route: "provider-api",
    recheck: false,
  });
});

test("the state file records a fingerprint and never the key", () => {
  forget();
  recordCommandCodeRoute("commandcode", "user_supersecret_value", { providerApi: false, at: AT });
  const raw = readFileSync(COMMANDCODE_PLAN_PATH, "utf8");
  assert.doesNotMatch(raw, /supersecret/);
  const entry = readCommandCodePlanState().commandcode;
  assert.match(entry.credential, /^[0-9a-f]{16}$/);
  assert.equal(entry.providerApi, false);
  assert.equal(entry.observedAt, new Date(AT).toISOString());
});

test("a corrupt state file costs one 403, not routing", () => {
  forget();
  recordCommandCodeRoute("commandcode", "key-a", { providerApi: false, at: AT });
  rmSync(COMMANDCODE_PLAN_PATH, { force: true });
  assert.equal(commandCodeRoute("commandcode", "key-a", { at: AT }).route, "provider-api");
});

// Only a real entitlement refusal may pin the fallback. Reading a timeout, a
// 500, or a rate limit as one would quietly move a paying Provider-plan
// account onto its coding-plan credits.
test("only the entitlement refusal counts as one", () => {
  assert.equal(
    isUpgradeRequired(403, {
      error: {
        message: "Your Go plan doesn't include API access. Upgrade to Provider or higher.",
        type: "permission_error",
        code: "upgrade_required",
      },
    }),
    true,
  );
  // The message alone still identifies it if the code ever stops being sent.
  assert.equal(
    isUpgradeRequired(403, { error: { message: "Your Go plan doesn't include API access." } }),
    true,
  );
  assert.equal(isUpgradeRequired(403, { error: { message: "Forbidden" } }), false);
  assert.equal(isUpgradeRequired(401, { error: { code: "upgrade_required" } }), false);
  assert.equal(isUpgradeRequired(429, undefined), false);
  assert.equal(isUpgradeRequired(403, undefined), false);
});

test("a non-boolean verdict is never written down", () => {
  forget();
  recordCommandCodeRoute("commandcode", "key-a", { at: AT });
  assert.deepEqual(readCommandCodePlanState(), {});
});
