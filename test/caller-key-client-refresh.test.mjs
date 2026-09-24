import assert from "node:assert/strict";
import test from "node:test";

import { callerBaseUrl, geminiBaseUrl } from "../src/caller-auth.mjs";
import { buildDshRoute } from "../src/dsh-catalog.mjs";
import { applyCredential, applyRouteToSettings } from "../src/dsh-config-manager.mjs";
import {
  refreshCodexCallerCapabilityContents,
  refreshCodexCallerCapabilityState,
  refreshDshCallerCapabilityDocuments,
  refreshGeminiCallerCapabilityDocuments,
} from "../src/caller-key-client-refresh.mjs";

const oldSecret = "o".repeat(48);
const newSecret = "n".repeat(48);
const oldBase = callerBaseUrl(4202, oldSecret);
const newBase = callerBaseUrl(4202, newSecret);
const secretFreeBase = "http://127.0.0.1:4202/v1";

test("Codex capability refresh changes only managed caller URLs", () => {
  const before = [
    `openai_base_url = ${JSON.stringify(oldBase)}`,
    'model_catalog_json = "C:/state/merged-models.json"',
    `# copied example must stay ${oldBase}`,
    "",
    "# BEGIN codex-router-provider-managed",
    "[model_providers.codex-router]",
    'name = "Codex Router (external models)"',
    `base_url = ${JSON.stringify(oldBase)}`,
    'wire_api = "responses"',
    "# END codex-router-provider-managed",
    "",
    "[desktop]",
    "ambient-suggestions-enabled = false",
    "",
  ].join("\n");
  const after = refreshCodexCallerCapabilityContents(before, newBase, { port: 4202 });
  assert.equal(after, before
    .replace(`openai_base_url = ${JSON.stringify(oldBase)}`, `openai_base_url = ${JSON.stringify(newBase)}`)
    .replace(`base_url = ${JSON.stringify(oldBase)}`, `base_url = ${JSON.stringify(newBase)}`));
  assert.ok(after.includes(`# copied example must stay ${oldBase}`));
});

test("Codex capability refresh updates the rollback-compatible signed provider block", () => {
  const before = [
    `openai_base_url = ${JSON.stringify(oldBase)}`,
    "",
    "# BEGIN codex-router-provider-managed",
    "[model_providers.codex-router]",
    `base_url = ${JSON.stringify(oldBase)}`,
    "# END codex-router-provider-managed",
    "",
    "# BEGIN codex-router-signed-provider-managed",
    "[model_providers.codex-router-signed]",
    `base_url = ${JSON.stringify(oldBase)}`,
    "# END codex-router-signed-provider-managed",
    "",
  ].join("\n");
  const after = refreshCodexCallerCapabilityContents(before, newBase, { port: 4202 });
  assert.equal((after.match(new RegExp(newSecret, "g")) || []).length, 3);
  assert.doesNotMatch(after, new RegExp(oldSecret));
  assert.deepEqual(
    refreshCodexCallerCapabilityState({
      version: 1,
      managedProvider: "codex-router-signed",
      previousPresent: true,
      previousModelProvider: "openai",
    }, newBase, { port: 4202 }),
    {
      version: 1,
      managedProvider: "codex-router-signed",
      previousPresent: true,
      previousModelProvider: "openai",
    },
  );
});

test("Codex capability state refresh preserves policy and ownership", () => {
  const before = {
    version: 3, mode: "provider-table", managedProvider: "example-provider",
    managedBaseUrl: oldBase, ownershipId: "a".repeat(32), previousProviderSections: ["x"],
    loginFree: true, previousModelPresent: true, previousModel: "keep-me",
  };
  assert.deepEqual(refreshCodexCallerCapabilityState(before, newBase, { port: 4202 }), {
    ...before, managedBaseUrl: newBase,
  });
});

test("Codex capability refresh leaves secret-free auth-command routes unchanged", () => {
  const before = [
    `openai_base_url = ${JSON.stringify(secretFreeBase)}`,
    "",
    "# BEGIN codex-router-provider-managed",
    "[model_providers.codex-router]",
    `base_url = ${JSON.stringify(secretFreeBase)}`,
    "[model_providers.codex-router.auth]",
    'command = "/usr/bin/node"',
    '# END codex-router-provider-managed',
    "",
  ].join("\n");
  assert.equal(
    refreshCodexCallerCapabilityContents(before, secretFreeBase, { port: 4202 }),
    before,
  );
  const state = { managedBaseUrl: secretFreeBase, loginFree: true, ownershipId: "a".repeat(32) };
  assert.deepEqual(
    refreshCodexCallerCapabilityState(state, secretFreeBase, { port: 4202 }),
    state,
  );
});

test("DSH capability refresh preserves route models and default policy byte-for-byte", () => {
  const route = buildDshRoute({
    baseUrl: oldBase,
    models: [{ slug: "vendor/model", displayName: "Keep Model", contextWindow: 131072, reasoningLevels: [] }],
  });
  const settings = applyRouteToSettings("agent-default-model:\n  provider: keep\n  model: keep-model\n", route);
  const credentials = applyCredential("refs:\n  OTHER: keep\n", "CODEX_ROUTER_CALLER_KEY", oldSecret);
  const refreshed = refreshDshCallerCapabilityDocuments({ settings, credentials, baseUrl: newBase, secret: newSecret, port: 4202 });
  assert.equal(refreshed.settings, settings.replace(oldBase, newBase));
  assert.equal(refreshed.credentials, credentials.replace(oldSecret, newSecret));
  assert.match(refreshed.settings, /keep-model/);
  assert.match(refreshed.settings, /vendor\/model/);
});

test("Gemini capability refresh preserves whether a default model was published", () => {
  const oldGemini = geminiBaseUrl(4202, oldSecret);
  const newGemini = geminiBaseUrl(4202, newSecret);
  const withoutDefault = [
    "USER_SETTING=keep", "# BEGIN codex-router-gemini",
    `GOOGLE_GEMINI_BASE_URL=${oldGemini}`, `GEMINI_API_KEY=${oldSecret}`,
    "# END codex-router-gemini", "",
  ].join("\n");
  const catalog = { updatedAt: "keep", baseUrl: oldGemini, defaultModel: null, models: ["vendor/model"] };
  const first = refreshGeminiCallerCapabilityDocuments({ document: withoutDefault, published: catalog, baseUrl: newGemini, secret: newSecret, port: 4202 });
  assert.ok(!first.document.includes("GEMINI_MODEL="));
  assert.deepEqual(first.published, { ...catalog, baseUrl: newGemini });
  assert.match(first.document, /USER_SETTING=keep/);

  const withDefault = withoutDefault.replace("# END codex-router-gemini", "GEMINI_MODEL=vendor/model\n# END codex-router-gemini");
  const second = refreshGeminiCallerCapabilityDocuments({
    document: withDefault,
    published: { ...catalog, defaultModel: "vendor/model" },
    baseUrl: newGemini, secret: newSecret, port: 4202,
  });
  assert.match(second.document, /GEMINI_MODEL=vendor\/model/);
});
test("DSH capability refresh rejects a replacement outside the managed caller surface", () => {
  const route = buildDshRoute({ baseUrl: oldBase, models: [{ slug: "vendor/model", reasoningLevels: [] }] });
  const settings = applyRouteToSettings("", route);
  const credentials = applyCredential("", "CODEX_ROUTER_CALLER_KEY", oldSecret);
  assert.throws(() => refreshDshCallerCapabilityDocuments({
    settings, credentials, baseUrl: "https://example.com/v1", secret: newSecret, port: 4202,
  }), /invalid DeepSeek Harness caller capability URL/i);
});
