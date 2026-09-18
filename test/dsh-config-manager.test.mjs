import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildDshRoute } from "../src/dsh-catalog.mjs";
import {
  applyCredential,
  applyDefaultModel,
  applyRouteToSettings,
  removeCredential,
  removeRouteFromSettings,
} from "../src/dsh-config-manager.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = "http://127.0.0.1:4202/_codex-router/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/v1";
const ROUTE = buildDshRoute({
  baseUrl: BASE_URL,
  models: [
    {
      slug: "vendor/model",
      displayName: "Vendor Model",
      contextWindow: 262144,
      inputModalities: ["text"],
      reasoningLevels: [{ effort: "high" }],
    },
  ],
});

// A settings document with somebody else's work in every position the router
// writes near: a leading comment, another adapter's section, a hand-written
// sibling route with its own annotation, and a section that follows ours.
const USER_SETTINGS = [
  "# my harness settings",
  "llm-deepseek:",
  "  apiKeyEnv: DEEPSEEK_API_KEY",
  "",
  "llm-pi-ai:",
  "  providers:",
  "    # a route I added by hand",
  "    my-proxy:",
  "      api: openai-completions",
  "      baseURL: https://proxy.example/v1",
  "      models:",
  "        - id: foo",
  "",
  "agent-default-model:",
  "  provider: deepseek-official",
  "  model: deepseek-v4-flash",
  "",
].join("\n");

test("publishing preserves every other section, route, and comment", () => {
  const after = applyRouteToSettings(USER_SETTINGS, ROUTE);
  assert.ok(after.includes("# my harness settings"));
  assert.ok(after.includes("llm-deepseek:"));
  assert.ok(after.includes("    # a route I added by hand"));
  assert.ok(after.includes("    my-proxy:"));
  assert.ok(after.includes("agent-default-model:"));
  assert.ok(after.includes("    codex-router:"));
});

test("an apostrophe elsewhere in the document does not move the route", () => {
  // A plain scalar carrying an apostrophe used to read as an unterminated
  // quoted scalar, which hid every key after it from the scan. The route then
  // landed past the end of `providers:` -- here, inside the block scalar that
  // follows -- so the harness never saw a route and the user's value grew four
  // lines of YAML.
  const settings = [
    "llm-pi-ai:",
    "  providers:",
    "    my-proxy:",
    "      api: openai-completions",
    "      note: don't edit this by hand",
    "theme: dark",
    "instructions: |",
    "  it's fine to edit this",
    "",
  ].join("\n");
  const after = applyRouteToSettings(settings, ROUTE);
  const lines = after.split("\n");
  assert.equal(lines.indexOf("    codex-router:"), lines.indexOf("      note: don't edit this by hand") + 1);
  assert.ok(lines.indexOf("    codex-router:") < lines.indexOf("theme: dark"));
  assert.ok(after.includes("instructions: |\n  it's fine to edit this\n"));
  assert.equal(removeRouteFromSettings(after), settings);
});

test("publishing twice is byte-identical", () => {
  const once = applyRouteToSettings(USER_SETTINGS, ROUTE);
  assert.equal(applyRouteToSettings(once, ROUTE), once);
});

test("removing the route restores the document exactly", () => {
  const after = applyRouteToSettings(USER_SETTINGS, ROUTE);
  assert.equal(removeRouteFromSettings(after), USER_SETTINGS);
});

test("a fresh document round-trips to empty", () => {
  const after = applyRouteToSettings("", ROUTE);
  assert.ok(after.startsWith("llm-pi-ai:\n  providers:\n    codex-router:\n"));
  // The keys publishing created are removed with it: an `llm-pi-ai:` holding
  // nothing reads as null to the adapter's section schema, not as "no routes".
  assert.equal(removeRouteFromSettings(after), "");
});

test("publishing follows the indentation the document already uses", () => {
  const wide = ["llm-pi-ai:", "    providers:", "        other:", "            api: x", ""].join("\n");
  const after = applyRouteToSettings(wide, ROUTE);
  assert.ok(after.includes("\n        codex-router:\n"));
  assert.ok(after.includes("\n          api: \"openai-responses\"\n"));
});

test("an inline providers mapping is refused rather than rewritten", () => {
  assert.throws(
    () => applyRouteToSettings("llm-pi-ai:\n  providers: {}\n", ROUTE),
    /inline value rather than a block/,
  );
});

test("a settings document this build cannot read plainly is refused untouched", () => {
  assert.throws(() => applyRouteToSettings("a: 1\na: 2\n", ROUTE), /defined twice/);
});

test("publishing beside a route key this reader cannot register is refused", () => {
  // `children` holds only the mapping keys the lexer registered, so a provider
  // id carrying a slash is invisible there while its own `baseURL` is hoisted
  // into `providers`. The indent copied off "the first sibling" was then that
  // hoisted child's, and the route went in two columns too deep -- nested
  // inside the user's provider, where the harness never looks, while every
  // status read agreed the publish had worked.
  const settings = [
    "llm-pi-ai:",
    "  providers:",
    "    openrouter/free:",
    "      api: openai-completions",
    "      baseURL: https://openrouter.ai/api/v1",
    "",
  ].join("\n");
  assert.throws(
    () => applyRouteToSettings(settings, ROUTE),
    /line 3 \(openrouter\/free:\) is not a mapping entry this reader can account for/,
  );
});

test("publishing into a providers: written as a sequence is refused", () => {
  // Splicing a mapping entry beside sequence items produced a settings file no
  // YAML reader would take back, and the harness reads this file on every run.
  const settings = [
    "llm-pi-ai:",
    "  providers:",
    "    - id: my-proxy",
    "      baseURL: https://proxy.example/v1",
    "",
  ].join("\n");
  assert.throws(
    () => applyRouteToSettings(settings, ROUTE),
    /line 3 \(- id: my-proxy\) is not a mapping entry this reader can account for/,
  );
});

test("removing the route leaves a sibling the reader cannot register in place", () => {
  // An install published by an earlier build already has this on disk. The
  // sequence registers no keys at all, so `providers.children.size` was 1 --
  // ours -- and the collapse took `llm-pi-ai` with it: 143 bytes of somebody
  // else's routes replaced by an empty file.
  const published = [
    "llm-pi-ai:",
    "  providers:",
    "    - id: my-proxy",
    "      baseURL: https://proxy.example/v1",
    "    codex-router:",
    '      baseURL: "http://127.0.0.1:4202/v1"',
    "",
  ].join("\n");
  const after = removeRouteFromSettings(published);
  assert.ok(after.includes("    - id: my-proxy"));
  assert.ok(after.includes("      baseURL: https://proxy.example/v1"));
  assert.ok(!after.includes("codex-router"));
});

test("removing the route leaves the user's own comment in place", () => {
  // `endIndex` stops before a trailing comment block, so a note the user wrote
  // above our key is inside the parent's range without being inside ours. One
  // comment line was enough to empty the whole file.
  const published = [
    "llm-pi-ai:",
    "  providers:",
    "    # my own routes live in providers.d",
    "    codex-router:",
    '      baseURL: "http://127.0.0.1:4202/v1"',
    "",
  ].join("\n");
  const after = removeRouteFromSettings(published);
  assert.ok(after.includes("    # my own routes live in providers.d"));
  assert.ok(!after.includes("codex-router"));
});

test("a credentials envelope this reader cannot account for is refused untouched", () => {
  // `refs` holding an entry the key grammar declines registers no sibling, so
  // the indent fell back to `refs.indent + 2` while the entries on disk sat at
  // four. That mixed-indent block is not YAML any parser reads back, and the
  // whole file is the harness's credential store -- every adapter's key, not
  // just ours.
  const credentials = ["version: 1", "refs:", "    other/ref: sk-other", ""].join("\n");
  assert.throws(
    () => applyCredential(credentials, "CODEX_ROUTER_CALLER_KEY", "sk-ours"),
    /is not a mapping entry this reader can account for/,
  );
});

test("a credential is set beside the user's other keys and removed cleanly", () => {
  const before = "# keys\nDEEPSEEK_API_KEY: sk-aaa\nOPENAI_API_KEY: sk-bbb\n";
  const after = applyCredential(before, "CODEX_ROUTER_CALLER_KEY", "secret-value");
  assert.ok(after.includes("DEEPSEEK_API_KEY: sk-aaa"));
  assert.ok(after.includes('CODEX_ROUTER_CALLER_KEY: "secret-value"'));
  assert.equal(applyCredential(after, "CODEX_ROUTER_CALLER_KEY", "secret-value"), after);
  assert.equal(removeCredential(after, "CODEX_ROUTER_CALLER_KEY"), before);
});

test("rotating a credential replaces the value in place", () => {
  const first = applyCredential("", "CODEX_ROUTER_CALLER_KEY", "one");
  const second = applyCredential(first, "CODEX_ROUTER_CALLER_KEY", "two");
  assert.equal(second, 'refs:\n  CODEX_ROUTER_CALLER_KEY: "two"\n');
});

test("a credentials file holding nested mappings is not a credentials file", () => {
  assert.throws(
    () => applyCredential("provider:\n  key: value\n", "CODEX_ROUTER_CALLER_KEY", "x"),
    /nested mapping/,
  );
});

// --- the harness's `version`/`refs` credentials envelope ---------------------
//
// Current harness builds wrap the reference map in an envelope; the builds this
// integration was first written against kept it at the document root. Writing
// into the wrong one of the two fails silently -- the harness resolves
// `apiKeyEnv` under `refs`, finds nothing, and the route 401s -- so every shape
// the router can meet is exercised here, and every document it emits is parsed
// back by a real YAML parser rather than matched with a regular expression.

// A hand-rolled structural lexer can emit a mixed-indent block that reads fine
// to the eye and that no parser accepts. PyYAML is the arbiter when it is here;
// when it is not, the indentation assertions below still stand on their own.
const YAML_PARSER = (() => {
  try {
    execFileSync("python3", ["-c", "import yaml"], { stdio: "ignore" });
    return "python3";
  } catch {
    return undefined;
  }
})();

function parseYaml(text) {
  const output = execFileSync(
    YAML_PARSER,
    ["-c", "import sys, yaml, json; json.dump(yaml.safe_load(sys.stdin.read()), sys.stdout)"],
    { input: text, encoding: "utf8" },
  );
  return JSON.parse(output);
}

// What the harness will actually read out of the document, or the parser's
// refusal to read it at all.
function refsOf(text) {
  if (!YAML_PARSER) return undefined;
  return parseYaml(text)?.refs;
}

// The column an entry sits at, which must match its siblings exactly: `refs`'
// own column plus two is the mistake this asserts against.
function columnOf(text, key) {
  const line = text.split("\n").find((candidate) => candidate.trimStart().startsWith(`${key}:`));
  assert.ok(line !== undefined, `no line for ${key} in:\n${text}`);
  return line.length - line.trimStart().length;
}

test("a reference is set inside the envelope, beside the harness's own", () => {
  const before = "# harness credentials\nversion: 1\nrefs:\n  OTHER_KEY: existing\n";
  const after = applyCredential(before, "CODEX_ROUTER_CALLER_KEY", "secret-value");
  assert.equal(
    after,
    "# harness credentials\nversion: 1\nrefs:\n  OTHER_KEY: existing\n" +
      '  CODEX_ROUTER_CALLER_KEY: "secret-value"\n',
  );
  if (YAML_PARSER) {
    assert.deepEqual(refsOf(after), {
      OTHER_KEY: "existing",
      CODEX_ROUTER_CALLER_KEY: "secret-value",
    });
  }
  assert.equal(applyCredential(after, "CODEX_ROUTER_CALLER_KEY", "secret-value"), after);
  assert.equal(removeCredential(after, "CODEX_ROUTER_CALLER_KEY"), before);
});

test("a reference follows the indentation the envelope already uses", () => {
  // Four spaces is the shape that turned a two-space assumption into a
  // document PyYAML rejects outright -- and the file is the harness's whole
  // credential store, so the loss would be every adapter's key, not ours.
  const before = "version: 1\nrefs:\n    OTHER_KEY: existing\n";
  const after = applyCredential(before, "CODEX_ROUTER_CALLER_KEY", "secret-value");
  assert.equal(columnOf(after, "CODEX_ROUTER_CALLER_KEY"), columnOf(after, "OTHER_KEY"));
  assert.equal(columnOf(after, "CODEX_ROUTER_CALLER_KEY"), 4);
  if (YAML_PARSER) {
    assert.deepEqual(refsOf(after), {
      OTHER_KEY: "existing",
      CODEX_ROUTER_CALLER_KEY: "secret-value",
    });
  }
  assert.equal(applyCredential(after, "CODEX_ROUTER_CALLER_KEY", "secret-value"), after);
  assert.equal(removeCredential(after, "CODEX_ROUTER_CALLER_KEY"), before);
});

test("a first install on a current harness writes inside the envelope, not beside it", () => {
  // `version` with no `refs` yet is exactly the state a first install meets,
  // and the one where guessing the legacy shape fails silently at request time.
  const before = "version: 1\n";
  const after = applyCredential(before, "CODEX_ROUTER_CALLER_KEY", "secret-value");
  assert.equal(after, 'version: 1\nrefs:\n  CODEX_ROUTER_CALLER_KEY: "secret-value"\n');
  if (YAML_PARSER) {
    const parsed = parseYaml(after);
    assert.deepEqual(parsed.refs, { CODEX_ROUTER_CALLER_KEY: "secret-value" });
    assert.ok(!("CODEX_ROUTER_CALLER_KEY" in parsed));
  }
  assert.equal(applyCredential(after, "CODEX_ROUTER_CALLER_KEY", "secret-value"), after);
  // Removing the only reference takes the envelope key it emptied with it: a
  // valueless `refs:` reads as null, not as "no references".
  assert.equal(removeCredential(after, "CODEX_ROUTER_CALLER_KEY"), before);
});

test("an absent credentials document adopts the current envelope shape", () => {
  const after = applyCredential("", "CODEX_ROUTER_CALLER_KEY", "secret-value");
  assert.equal(after, 'refs:\n  CODEX_ROUTER_CALLER_KEY: "secret-value"\n');
  if (YAML_PARSER) {
    assert.deepEqual(parseYaml(after), { refs: { CODEX_ROUTER_CALLER_KEY: "secret-value" } });
  }
  assert.equal(applyCredential(after, "CODEX_ROUTER_CALLER_KEY", "secret-value"), after);
  assert.equal(removeCredential(after, "CODEX_ROUTER_CALLER_KEY"), "");
});

test("an envelope holding no references yet is filled in rather than duplicated", () => {
  const after = applyCredential("version: 1\nrefs:\n", "CODEX_ROUTER_CALLER_KEY", "secret-value");
  assert.equal(after, 'version: 1\nrefs:\n  CODEX_ROUTER_CALLER_KEY: "secret-value"\n');
  if (YAML_PARSER) {
    assert.deepEqual(parseYaml(after).refs, { CODEX_ROUTER_CALLER_KEY: "secret-value" });
  }
  assert.equal(applyCredential(after, "CODEX_ROUTER_CALLER_KEY", "secret-value"), after);
  // The emptied `refs:` is pruned, so this comes back as `version: 1` rather
  // than as the valueless key it started from. Both parse to a harness with no
  // references; an empty mapping is the one of the two the router never leaves
  // behind, here and in `removeRouteFromSettings` alike.
  assert.equal(removeCredential(after, "CODEX_ROUTER_CALLER_KEY"), "version: 1\n");
});

test("a legacy root-level credentials document is written in its own shape", () => {
  const before = "# keys\nDEEPSEEK_API_KEY: sk-aaa\n";
  const after = applyCredential(before, "CODEX_ROUTER_CALLER_KEY", "secret-value");
  assert.equal(after, '# keys\nDEEPSEEK_API_KEY: sk-aaa\nCODEX_ROUTER_CALLER_KEY: "secret-value"\n');
  if (YAML_PARSER) {
    assert.deepEqual(parseYaml(after), {
      DEEPSEEK_API_KEY: "sk-aaa",
      CODEX_ROUTER_CALLER_KEY: "secret-value",
    });
  }
  assert.equal(applyCredential(after, "CODEX_ROUTER_CALLER_KEY", "secret-value"), after);
  assert.equal(removeCredential(after, "CODEX_ROUTER_CALLER_KEY"), before);
});

test("a reference a pre-envelope build left at the root is moved, not copied", () => {
  // The state a router build that only knew the flat shape leaves on a current
  // harness. The stray copy is ours and the harness never reads it; leaving it
  // would put a second copy of the caller key on disk that no uninstall finds.
  const before = 'version: 1\nrefs:\n  OTHER_KEY: existing\nCODEX_ROUTER_CALLER_KEY: "stale"\n';
  const after = applyCredential(before, "CODEX_ROUTER_CALLER_KEY", "secret-value");
  assert.ok(!after.includes("stale"));
  assert.equal(
    after,
    'version: 1\nrefs:\n  OTHER_KEY: existing\n  CODEX_ROUTER_CALLER_KEY: "secret-value"\n',
  );
  if (YAML_PARSER) {
    const parsed = parseYaml(after);
    assert.ok(!("CODEX_ROUTER_CALLER_KEY" in parsed));
    assert.deepEqual(parsed.refs, {
      OTHER_KEY: "existing",
      CODEX_ROUTER_CALLER_KEY: "secret-value",
    });
  }
  assert.equal(
    removeCredential(before, "CODEX_ROUTER_CALLER_KEY"),
    "version: 1\nrefs:\n  OTHER_KEY: existing\n",
  );
});

test("a nested document under refs is refused rather than edited", () => {
  // `refs` present is not enough to make a file a credential store. The
  // envelope adds one legal level of nesting and not one byte more.
  assert.throws(
    () =>
      applyCredential(
        "version: 1\nrefs:\n  server:\n    host: example.com\n",
        "CODEX_ROUTER_CALLER_KEY",
        "x",
      ),
    /"refs\.server" holds a nested mapping/,
  );
});

test("an inline refs mapping is refused rather than extended", () => {
  assert.throws(
    () => applyCredential("version: 1\nrefs: {}\n", "CODEX_ROUTER_CALLER_KEY", "x"),
    /inline value rather than a block/,
  );
});

test("every credentials shape the router writes parses back as YAML", { skip: !YAML_PARSER }, () => {
  const shapes = [
    "",
    "version: 1\n",
    "version: 1\nrefs:\n",
    "version: 1\nrefs:\n  OTHER_KEY: existing\n",
    "version: 1\nrefs:\n    OTHER_KEY: existing\n",
    "version: 1\nrefs:\n      OTHER_KEY: existing\n",
    "# comment\nversion: 1\nrefs:\n  A: 1\n  B: 2\n",
    "DEEPSEEK_API_KEY: sk-aaa\n",
    "",
  ];
  for (const before of shapes) {
    const after = applyCredential(before, "CODEX_ROUTER_CALLER_KEY", "secret-value");
    const parsed = parseYaml(after);
    const stored = parsed?.refs?.CODEX_ROUTER_CALLER_KEY ?? parsed?.CODEX_ROUTER_CALLER_KEY;
    assert.equal(stored, "secret-value", `shape did not round-trip: ${JSON.stringify(before)}`);
    assert.equal(
      applyCredential(after, "CODEX_ROUTER_CALLER_KEY", "secret-value"),
      after,
      `shape is not idempotent: ${JSON.stringify(before)}`,
    );
    parseYaml(removeCredential(after, "CODEX_ROUTER_CALLER_KEY"));
  }
});

test("the default model selection names the router route", () => {
  const after = applyDefaultModel(USER_SETTINGS, { model: "vendor/model" });
  assert.ok(after.includes('agent-default-model:\n  provider: "codex-router"\n  model: "vendor/model"\n'));
  assert.ok(after.includes("llm-deepseek:"));
  assert.ok(!after.includes("deepseek-v4-flash"));
});

// --- end to end, against sandboxed harness and state directories ------------

const CALLER_SECRET = "a".repeat(48);

function sandbox() {
  const dshHome = mkdtempSync(path.join(os.tmpdir(), "dsh-home-"));
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "dsh-state-"));
  writeFileSync(path.join(stateDir, "caller-secret"), `${CALLER_SECRET}\n`, { mode: 0o600 });
  writeFileSync(
    path.join(stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: ["deepseek"] })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(path.join(stateDir, "deepseek-api-key.secret"), "sk-test\n", { mode: 0o600 });
  return { dshHome, stateDir };
}

function manage(command, { dshHome, stateDir }) {
  const output = execFileSync(
    process.execPath,
    [path.join(root, "src", "dsh-config-manager.mjs"), ...command.split(" ")],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        DSH_HOME: dshHome,
        MODEL_ROUTER_STATE_DIR: stateDir,
        MODEL_ROUTER_ALLOW_FOREIGN_STATE: "1",
      },
    },
  );
  return JSON.parse(output);
}

test("install writes both documents owner-only, and uninstall takes them back out", () => {
  const box = sandbox();
  try {
    const installed = manage("install", box);
    assert.ok(installed.models > 0);
    assert.equal(installed.route, "codex-router");

    const settingsPath = path.join(box.dshHome, "settings.yaml");
    const credentialsPath = path.join(box.dshHome, ".credentials.yaml");
    const settings = readFileSync(settingsPath, "utf8");
    assert.ok(settings.includes("    codex-router:"));
    assert.ok(settings.includes('api: "openai-responses"'));
    // The base URL carries the caller capability, so the document must hold
    // the real one -- this is the file the harness authenticates from -- and
    // the secret in it must be the one the router actually accepts.
    assert.ok(settings.includes(`/_codex-router/${CALLER_SECRET}/v1"`));
    const credentials = readFileSync(credentialsPath, "utf8");
    assert.ok(credentials.includes(`CODEX_ROUTER_CALLER_KEY: ${JSON.stringify(CALLER_SECRET)}`));
    if (process.platform !== "win32") {
      // Both carry local authentication: the settings document holds the
      // caller capability inside its base URL, the other holds the key it
      // references.
      assert.equal(statSync(settingsPath).mode & 0o777, 0o600);
      assert.equal(statSync(credentialsPath).mode & 0o777, 0o600);
    }

    const status = manage("status", box);
    assert.equal(status.routeInstalled, true);
    assert.equal(status.credentialInstalled, true);
    assert.equal(status.publishedModels, status.routableModels);
    // Never the whole capability, in any surface a person can copy out.
    assert.ok(!status.baseUrl.includes("aaaaaaaa"));
    assert.ok(status.baseUrl.includes("[REDACTED]"));

    manage("uninstall", box);
    const after = manage("status", box);
    assert.equal(after.routeInstalled, false);
    assert.equal(after.credentialInstalled, false);
  } finally {
    rmSync(box.dshHome, { recursive: true, force: true });
    rmSync(box.stateDir, { recursive: true, force: true });
  }
});

// `status()` deciding where the credential lives differently from the writer is
// the failure this integration cannot afford: it reports installed, the harness
// reads nothing, and every request 401s with no diagnostic on either side.
test("status finds the credential wherever the writer put it, in every shape", () => {
  const shapes = {
    "no credentials document at all": undefined,
    "a current harness with no references yet": "version: 1\n",
    "an empty envelope": "version: 1\nrefs:\n",
    "an envelope with the harness's own key": "version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-aaa\n",
    "an envelope indented four spaces": "version: 1\nrefs:\n    DEEPSEEK_API_KEY: sk-aaa\n",
    "a legacy root-level document": "DEEPSEEK_API_KEY: sk-aaa\n",
    "an empty file": "",
  };
  for (const [name, initial] of Object.entries(shapes)) {
    const box = sandbox();
    const credentialsPath = path.join(box.dshHome, ".credentials.yaml");
    try {
      if (initial !== undefined) writeFileSync(credentialsPath, initial, { mode: 0o600 });
      assert.equal(manage("status", box).credentialInstalled, false, `${name}: before install`);

      manage("install", box);
      const after = readFileSync(credentialsPath, "utf8");
      assert.equal(manage("status", box).credentialInstalled, true, `${name}: after install`);
      if (YAML_PARSER) {
        // The harness resolves `apiKeyEnv` through `refs` when the envelope is
        // there and at the root when it is not. Whichever this document is,
        // the key has to be where that lookup will find it.
        const parsed = parseYaml(after);
        const enveloped = parsed && typeof parsed === "object" && "refs" in parsed;
        const stored = enveloped
          ? parsed.refs?.CODEX_ROUTER_CALLER_KEY
          : parsed?.CODEX_ROUTER_CALLER_KEY;
        assert.equal(stored, CALLER_SECRET, `${name}: not where the harness reads`);
      }

      manage("uninstall", box);
      assert.equal(manage("status", box).credentialInstalled, false, `${name}: after uninstall`);
      // Whatever else the file held is still the user's, and the secret is
      // gone rather than left behind in a corner the writer stopped using.
      const remaining = readFileSync(credentialsPath, "utf8");
      assert.ok(!remaining.includes(CALLER_SECRET), `${name}: secret left behind`);
      if (initial?.includes("DEEPSEEK_API_KEY")) {
        assert.ok(remaining.includes("DEEPSEEK_API_KEY: sk-aaa"), `${name}: lost another key`);
      }
    } finally {
      rmSync(box.dshHome, { recursive: true, force: true });
      rmSync(box.stateDir, { recursive: true, force: true });
    }
  }
});

test("install refuses when no provider is selected rather than publishing nothing", () => {
  const box = sandbox();
  writeFileSync(
    path.join(box.stateDir, "enabled-providers.json"),
    `${JSON.stringify({ version: 1, providers: [] })}\n`,
    { mode: 0o600 },
  );
  try {
    assert.throws(() => manage("install", box), /No routed models/);
  } finally {
    rmSync(box.dshHome, { recursive: true, force: true });
    rmSync(box.stateDir, { recursive: true, force: true });
  }
});

// A default model is the user's own choice. The router may take it over only
// when asked, and giving it back must never overwrite a choice made since.
function settingsOf(box) {
  return readFileSync(path.join(box.dshHome, "settings.yaml"), "utf8");
}

test("uninstall gives back a default the router took over", () => {
  const box = sandbox();
  try {
    manage("install --set-default-model", box);
    assert.match(settingsOf(box), /agent-default-model:\n  provider: "codex-router"/);
    manage("uninstall", box);
    // The sandbox document has no default of its own, so taking ours out
    // leaves none -- not one pointing at a route that was just removed.
    assert.doesNotMatch(settingsOf(box), /provider: "codex-router"/);
  } finally {
    rmSync(box.dshHome, { recursive: true, force: true });
    rmSync(box.stateDir, { recursive: true, force: true });
  }
});

test("uninstall leaves a default the user chose after the router took over", () => {
  const box = sandbox();
  try {
    manage("install --set-default-model", box);
    // The harness's own Models page writes this same key. Somebody switching
    // to a non-routed model afterwards must not have that undone by an
    // uninstall restoring a snapshot taken before they chose it.
    const chosen = 'agent-default-model:\n  provider: "deepseek-official"\n  model: "deepseek-v4-flash"\n';
    const settingsPath = path.join(box.dshHome, "settings.yaml");
    writeFileSync(
      settingsPath,
      settingsOf(box).replace(
        /agent-default-model:\n(?:  .*\n)+/,
        chosen,
      ),
      "utf8",
    );

    const result = manage("uninstall", box);
    assert.equal(result.defaultModelRestored, false);
    const after = settingsOf(box);
    assert.match(after, /provider: "deepseek-official"/);
    assert.match(after, /model: "deepseek-v4-flash"/);
  } finally {
    rmSync(box.dshHome, { recursive: true, force: true });
    rmSync(box.stateDir, { recursive: true, force: true });
  }
});

test("uninstall removes a router-owned default even with no snapshot to restore", () => {
  const box = sandbox();
  try {
    manage("install --set-default-model", box);
    // Consume the snapshot the way a first uninstall does, then put the
    // router's default back. Leaving it would point the harness at a provider
    // this very uninstall removed.
    manage("uninstall", box);
    manage("install --set-default-model", box);
    rmSync(path.join(box.stateDir, "dsh-default-model.json"), { force: true });

    manage("uninstall", box);
    const after = settingsOf(box);
    assert.doesNotMatch(after, /provider: "codex-router"/);
    assert.doesNotMatch(after, /agent-default-model:/);
  } finally {
    rmSync(box.dshHome, { recursive: true, force: true });
    rmSync(box.stateDir, { recursive: true, force: true });
  }
});

test("caller capability refresh changes only the installed DSH route and credential", () => {
  const box = sandbox();
  try {
    manage("install --set-default-model", box);
    const settingsPath = path.join(box.dshHome, "settings.yaml");
    const credentialsPath = path.join(box.dshHome, ".credentials.yaml");
    const beforeSettings = readFileSync(settingsPath, "utf8");
    const beforeCredentials = readFileSync(credentialsPath, "utf8");
    const nextSecret = "b".repeat(48);
    writeFileSync(path.join(box.stateDir, "caller-secret"), `${nextSecret}\n`, { mode: 0o600 });
    const result = manage("caller-capability-refresh", box);
    assert.equal(result.refreshed, true);
    const afterSettings = readFileSync(settingsPath, "utf8");
    const afterCredentials = readFileSync(credentialsPath, "utf8");
    assert.equal(afterSettings, beforeSettings.replaceAll(CALLER_SECRET, nextSecret));
    assert.equal(afterCredentials, beforeCredentials.replaceAll(CALLER_SECRET, nextSecret));
    assert.match(afterSettings, /agent-default-model:/);
  } finally {
    rmSync(box.dshHome, { recursive: true, force: true });
    rmSync(box.stateDir, { recursive: true, force: true });
  }
});
