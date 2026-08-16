import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "codex-router-gemini-"));
const codexHome = path.join(root, "codex");
const stateDir = path.join(root, "state");
const envPath = path.join(root, "gemini", ".env");
const CALLER_KEY = "test-gemini-caller-capability-with-sufficient-length";

process.env.CODEX_HOME = codexHome;
process.env.CODEX_ROUTER_STATE_DIR = stateDir;
process.env.MODEL_ROUTER_GEMINI_ENV = envPath;
process.env.MODEL_ROUTER_STATE_OWNER_OVERRIDE = "1";

const { writePrivateFile } = await import("../src/file-security.mjs");
writePrivateFile(path.join(stateDir, "caller-secret"), `${CALLER_KEY}\n`);

const { GEMINI_CATALOG_PATH } = await import("../src/paths.mjs");
const {
  geminiCatalogDrift,
  geminiDefaultModel,
  geminiIntegrationStatus,
  publishGeminiIntegration,
  removeGeminiIntegration,
} = await import("../src/gemini-config-manager.mjs");

// The real routed set reads provider selection, the picker state, and the
// ChatGPT session, none of which a temp home has. What is under test here is
// the document this manager writes, so the set is injected.
const MODELS = [
  { slug: "vendor/small", displayName: "Small", contextWindow: 128000, priority: 1 },
  { slug: "vendor/large", displayName: "Large", contextWindow: 262144, priority: 5 },
];
const routedModels = (models = MODELS) => () => ({ models, engine: undefined });

test.after(() => rmSync(root, { recursive: true, force: true }));

test("the highest-priority routed model is the default", () => {
  assert.equal(geminiDefaultModel(MODELS), "vendor/large");
  assert.equal(geminiDefaultModel([]), undefined);
});

test("the default is stable when priorities tie", () => {
  assert.equal(geminiDefaultModel([{ slug: "b/one" }, { slug: "a/two" }]), "a/two");
});

test("a publish writes the caller capability, the key, and a routed default", () => {
  const result = publishGeminiIntegration({ routedModels: routedModels() });
  const document = readFileSync(envPath, "utf8");
  assert.ok(document.includes("GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:"));
  assert.ok(document.includes(`/_codex-router/${CALLER_KEY}/gemini`));
  assert.ok(document.includes(`GEMINI_API_KEY=${CALLER_KEY}`));
  assert.ok(document.includes("GEMINI_MODEL=vendor/large"));
  assert.equal(result.defaultModel, "vendor/large");
});

test("the document holding the caller key is owner-only", { skip: process.platform === "win32" }, () => {
  assert.equal(statSync(envPath).mode & 0o777, 0o600);
});

test("republishing is byte-identical", () => {
  const first = readFileSync(envPath, "utf8");
  publishGeminiIntegration({ routedModels: routedModels() });
  assert.equal(readFileSync(envPath, "utf8"), first);
});

test("status never prints the complete base URL", () => {
  // It carries the caller capability, and status output reaches doctor, the
  // tray, and support bundles.
  const status = geminiIntegrationStatus();
  assert.ok(status.baseUrl.includes("[REDACTED]"));
  assert.ok(!status.baseUrl.includes(CALLER_KEY));
  assert.equal(status.baseUrlManaged, true);
  assert.equal(status.installed, true);
  assert.equal(status.documentReadable, true);
  assert.equal(status.defaultModel, "vendor/large");
  assert.deepEqual(status.publishedModels, ["vendor/small", "vendor/large"]);
});

test("opting out of the default model omits the key rather than blanking it", () => {
  publishGeminiIntegration({ routedModels: routedModels(), setDefaultModel: false });
  const document = readFileSync(envPath, "utf8");
  assert.ok(!document.includes("GEMINI_MODEL"));
  assert.ok(document.includes("GEMINI_API_KEY="));
});

test("a user's own lines survive a publish and come back on removal", () => {
  removeGeminiIntegration();
  const mine = ["# my notes", "", "MY_TOOL=1", ""].join("\n");
  writePrivateFile(envPath, mine);
  publishGeminiIntegration({ routedModels: routedModels() });
  assert.ok(readFileSync(envPath, "utf8").startsWith(mine));
  removeGeminiIntegration();
  assert.equal(readFileSync(envPath, "utf8"), mine);
});

test("a document the router created entirely is removed, not left empty", () => {
  rmSync(envPath, { force: true });
  publishGeminiIntegration({ routedModels: routedModels() });
  removeGeminiIntegration();
  assert.equal(geminiIntegrationStatus().envExists, false);
  assert.equal(geminiIntegrationStatus().installed, false);
});

test("an assignment the router did not write stops the publish and names the line", () => {
  const mine = ["# mine", "GEMINI_API_KEY=my-real-google-key", ""].join("\n");
  writePrivateFile(envPath, mine);
  assert.throws(
    () => publishGeminiIntegration({ routedModels: routedModels() }),
    /GEMINI_API_KEY \(line 2\)/,
  );
  // Refused with the file untouched: a refusal costs a command, a wrong guess
  // rewrites a document whose only copy is on the user's disk.
  assert.equal(readFileSync(envPath, "utf8"), mine);
  rmSync(envPath, { force: true });
});

test("drift is reported against the models the last publish advertised", () => {
  publishGeminiIntegration({ routedModels: routedModels() });
  const drift = geminiCatalogDrift({ routedModels: routedModels([{ slug: "vendor/small" }]) });
  assert.deepEqual(drift.missing, ["vendor/large"]);
  assert.equal(drift.defaultMissing, true);
  assert.deepEqual(drift.added, []);
});

test("no published catalog means no drift to report", () => {
  removeGeminiIntegration();
  rmSync(GEMINI_CATALOG_PATH, { force: true });
  assert.equal(geminiCatalogDrift({ routedModels: routedModels() }), undefined);
});
