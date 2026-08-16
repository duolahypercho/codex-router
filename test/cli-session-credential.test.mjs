import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SESSION_KEY = "TEST_COMMANDCODE_SESSION_KEY";

// The signed-in session lives in the provider CLI's own directory, so every
// case runs against a throwaway home rather than the developer's real one.
function sessionRoot(apiKey) {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), "cli-session-credential-"));
  const sessionDirectory = path.join(testRoot, ".commandcode");
  mkdirSync(sessionDirectory, { recursive: true, mode: 0o700 });
  if (apiKey !== undefined) {
    writeFileSync(
      path.join(sessionDirectory, "auth.json"),
      typeof apiKey === "string"
        ? JSON.stringify({ apiKey, userName: "Test Account", userId: "u_test" })
        : apiKey.raw,
      { mode: 0o600 },
    );
  }
  return { testRoot, sessionDirectory };
}

function environment(testRoot, sessionDirectory, overrides = {}) {
  return {
    ...process.env,
    HOME: testRoot,
    USERPROFILE: testRoot,
    MODEL_ROUTER_TARGET: "codex",
    MODEL_ROUTER_STATE_DIR: path.join(testRoot, "state"),
    COMMANDCODE_CLI_HOME: sessionDirectory,
    // Onboarding asks npm where global binaries live, so a developer machine
    // with the real command-code CLI installed must not leak into these runs.
    npm_config_prefix: path.join(testRoot, "npm-global"),
    COMMAND_CODE_API_KEY: "",
    COMMANDCODE_API_KEY: "",
    ...overrides,
  };
}

// Runs inside a child process because the registry and credential modules read
// their environment once at import time.
function inspect(environmentValues, source) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: root,
    encoding: "utf8",
    env: environmentValues,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const REPORT_SOURCE = `
  const { PROVIDERS } = await import("./src/model-registry.mjs");
  const { credentialStatus, resolveProviderCredential } =
    await import("./src/provider-credentials.mjs");
  const report = {};
  for (const id of ["commandcode", "commandcode-messages"]) {
    const provider = PROVIDERS.get(id);
    report[id] = {
      ...credentialStatus(provider, { persistent: true }),
      value: resolveProviderCredential(provider)?.value,
    };
  }
  process.stdout.write(JSON.stringify(report));
`;

test("a Command Code CLI sign-in authenticates the provider and its Messages variant", () => {
  const { testRoot, sessionDirectory } = sessionRoot(SESSION_KEY);
  try {
    const report = inspect(environment(testRoot, sessionDirectory), REPORT_SOURCE);
    for (const id of ["commandcode", "commandcode-messages"]) {
      assert.equal(report[id].configured, true);
      assert.equal(report[id].source, "Command Code CLI sign-in");
      assert.equal(report[id].persistent, true);
      assert.equal(report[id].value, SESSION_KEY);
    }
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("a stored key and an exported key both outrank the CLI sign-in", () => {
  const { testRoot, sessionDirectory } = sessionRoot(SESSION_KEY);
  try {
    const stored = spawnSync(
      process.execPath,
      [path.join(root, "src", "control.mjs"), "credential", "commandcode"],
      {
        cwd: root,
        encoding: "utf8",
        env: environment(testRoot, sessionDirectory),
        input: "TEST_COMMANDCODE_STORED_KEY\n",
      },
    );
    assert.equal(stored.status, 0, stored.stderr);

    const withStoredKey = inspect(environment(testRoot, sessionDirectory), REPORT_SOURCE);
    assert.equal(withStoredKey.commandcode.value, "TEST_COMMANDCODE_STORED_KEY");
    assert.match(withStoredKey.commandcode.source, /protected file/);

    const withEnvironmentKey = inspect(
      environment(testRoot, sessionDirectory, {
        COMMAND_CODE_API_KEY: "TEST_COMMANDCODE_ENV_KEY",
      }),
      REPORT_SOURCE,
    );
    assert.equal(withEnvironmentKey.commandcode.value, "TEST_COMMANDCODE_ENV_KEY");
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("an unusable session file leaves the provider unconfigured instead of failing", () => {
  for (const contents of [{ raw: "{ not json" }, { raw: "{}" }, { raw: '{"apiKey":"  "}' }]) {
    const { testRoot, sessionDirectory } = sessionRoot(contents);
    try {
      const report = inspect(environment(testRoot, sessionDirectory), REPORT_SOURCE);
      assert.equal(report.commandcode.configured, false);
      assert.equal(
        report.commandcode.setup,
        "Run `command-code login`, or run ./bin/provider-key commandcode set",
      );
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  }
});

test("onboarding offers sign-in beside the key field and reports which one is live", () => {
  const source = `
    const { providerOnboardingSnapshot } = await import("./src/provider-onboarding.mjs");
    const entry = providerOnboardingSnapshot().providers
      .find((provider) => provider.id === "commandcode");
    process.stdout.write(JSON.stringify(entry));
  `;
  const isolatedPath = process.platform === "win32"
    ? [
        path.join(process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows", "System32"),
      ].join(path.delimiter)
    : "/usr/bin:/bin";

  const empty = sessionRoot();
  try {
    const entry = inspect(
      environment(empty.testRoot, empty.sessionDirectory, { PATH: isolatedPath }),
      source,
    );
    assert.equal(entry.kind, "api");
    assert.equal(entry.signIn, true);
    assert.equal(entry.signedIn, false);
    assert.equal(entry.configured, false);
    assert.equal(entry.action, "add-key");
    // Without the official CLI on PATH the sign-in route starts by installing it.
    assert.equal(entry.cliInstalled, false);
    assert.equal(entry.signInAction, "install");
  } finally {
    rmSync(empty.testRoot, { recursive: true, force: true });
  }

  const signedIn = sessionRoot(SESSION_KEY);
  try {
    const entry = inspect(
      environment(signedIn.testRoot, signedIn.sessionDirectory, { PATH: isolatedPath }),
      source,
    );
    assert.equal(entry.configured, true);
    assert.equal(entry.signedIn, true);
    assert.equal(entry.action, "ready");
  } finally {
    rmSync(signedIn.testRoot, { recursive: true, force: true });
  }
});

// `command-code login` is an Ink interface that needs stdin in raw mode, so a
// piped spawn dies on "Raw mode is not supported" before it opens a browser.
// The tray has to hand it a terminal instead, and that is worth pinning: the
// regression is invisible until someone clicks Sign In.
//
// POSIX only: both stand-ins below are `#!/bin/sh` scripts on a hand-built
// PATH, which Windows can neither resolve (`where.exe` needs a PATHEXT
// extension) nor execute.
test("signing in without a terminal launches one rather than piping the CLI", {
  skip: process.platform === "win32" ? "the stand-in CLIs are POSIX shell scripts" : false,
}, () => {
  const { testRoot, sessionDirectory } = sessionRoot();
  try {
    const fakeBin = path.join(testRoot, "bin");
    mkdirSync(fakeBin, { recursive: true, mode: 0o700 });
    const pipedLog = path.join(testRoot, "piped.log");
    // Stands in for the real CLI. An entry here means the router spawned it
    // directly with pipes, which is exactly the path that cannot work.
    writeFileSync(
      path.join(fakeBin, "command-code"),
      `#!/bin/sh\necho piped >> ${JSON.stringify(pipedLog)}\n`,
      { mode: 0o700 },
    );
    // Stands in for Terminal.app, and finishes the sign-in the way a real
    // window would, so the test never opens one.
    writeFileSync(
      path.join(fakeBin, "launcher"),
      `#!/bin/sh\nprintf '{"apiKey":"TERMINAL_SIGNED_IN_KEY"}' > ${JSON.stringify(
        path.join(sessionDirectory, "auth.json"),
      )}\n`,
      { mode: 0o700 },
    );
    const result = spawnSync(
      process.execPath,
      [path.join(root, "src", "control.mjs"), "login", "commandcode"],
      {
        cwd: root,
        encoding: "utf8",
        env: environment(testRoot, sessionDirectory, {
          PATH: `${fakeBin}${path.delimiter}/usr/bin:/bin`,
          MODEL_ROUTER_TERMINAL_LAUNCHER: path.join(fakeBin, "launcher"),
        }),
        timeout: 60_000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(pipedLog), false, "the CLI must never be spawned with pipes");
    const row = JSON.parse(result.stdout).providers.find((p) => p.id === "commandcode");
    assert.equal(row.configured, true);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("a support bundle redacts a key that came from the CLI sign-in", () => {
  const { testRoot, sessionDirectory } = sessionRoot(SESSION_KEY);
  try {
    // Plant the session key somewhere the bundle genuinely copies from, so the
    // assertion proves redaction rather than mere absence.
    const stateDirectory = path.join(testRoot, "state");
    mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(
      path.join(stateDirectory, "router.log"),
      // Bare, so the generic log scrubber cannot catch it: only knowing the
      // session key itself removes this line's secret.
      `upstream rejected the credential ${SESSION_KEY} for commandcode\n`,
      { mode: 0o600 },
    );
    const source = `
      const { PROVIDERS } = await import("./src/model-registry.mjs");
      const { createSupportBundle } = await import("./src/support-bundle.mjs");
      const { readFileSync } = await import("node:fs");
      createSupportBundle({ output: process.env.BUNDLE_PATH, includeLogs: true });
      const contents = readFileSync(process.env.BUNDLE_PATH, "utf8");
      process.stdout.write(JSON.stringify({
        leaked: contents.includes(${JSON.stringify(SESSION_KEY)}),
        redacted: contents.includes("[REDACTED]"),
        source: JSON.parse(contents).credentialSources?.commandcode?.source,
        provider: PROVIDERS.get("commandcode").id,
      }));
    `;
    const report = inspect(
      environment(testRoot, sessionDirectory, {
        BUNDLE_PATH: path.join(testRoot, "bundle.json"),
      }),
      source,
    );
    assert.equal(report.leaked, false);
    assert.equal(report.redacted, true);
    assert.equal(report.source, "Command Code CLI sign-in");
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

test("a CLI session descriptor may not escape its own home directory", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cli-session-registry-"));
  try {
    const registry = JSON.parse(
      spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const { readRegistryDocument } = await import("./src/model-registry.mjs");
           process.stdout.write(JSON.stringify(readRegistryDocument("config")));`,
        ],
        { cwd: root, encoding: "utf8", env: process.env },
      ).stdout,
    );
    registry.providers = registry.providers.map((provider) =>
      provider.id === "commandcode"
        ? {
            ...provider,
            credential: {
              ...provider.credential,
              cliSession: { ...provider.credential.cliSession, directory: "../secrets" },
            },
          }
        : provider,
    );
    const registryPath = path.join(dir, "providers.json");
    writeFileSync(registryPath, JSON.stringify(registry));
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        "import('./src/model-registry.mjs').catch((e)=>{console.error(e.message);process.exit(1);})",
      ],
      { cwd: root, encoding: "utf8", env: { ...process.env, MODEL_ROUTER_REGISTRY: registryPath } },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /cliSession directory must be a single path segment/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Every Command Code plan is served, but not the same way and not on the same
// money: a Provider-plan account pays as it goes through the documented API,
// while a coding plan is served through the CLI's own route and spends the
// plan's credits against its 5-hour and weekly window caps. Which one an
// account gets is invisible at connect time, so the note has to reach the
// surfaces where someone decides to connect.
test("how a Command Code plan is billed is stated wherever it is connected", () => {
  const { testRoot, sessionDirectory } = sessionRoot(SESSION_KEY);
  const environmentValues = environment(testRoot, sessionDirectory);
  try {
    const enabled = spawnSync(
      process.execPath,
      [path.join(root, "src", "providers.mjs"), "enable", "commandcode"],
      { cwd: root, encoding: "utf8", env: environmentValues },
    );
    assert.equal(enabled.status, 0, enabled.stderr);
    assert.match(enabled.stdout, /Any Command Code plan works/);
    assert.match(enabled.stdout, /plan credits/);

    const doctor = spawnSync(process.execPath, [path.join(root, "src", "doctor.mjs"), "--json"], {
      cwd: root,
      encoding: "utf8",
      env: environmentValues,
      timeout: 120_000,
    });
    const planCheck = JSON.parse(doctor.stdout).checks.find((c) => c.name === "Command Code plan");
    assert.ok(planCheck, "doctor must raise the plan requirement for a selected provider");
    assert.equal(planCheck.status, "warn");

    const snapshot = spawnSync(
      process.execPath,
      [path.join(root, "src", "control.mjs"), "providers"],
      { cwd: root, encoding: "utf8", env: environmentValues },
    );
    const row = JSON.parse(snapshot.stdout).providers.find((p) => p.id === "commandcode");
    assert.match(row.planNote, /Any Command Code plan works/);
    // Providers without the gate must stay silent about plans.
    const deepseek = JSON.parse(snapshot.stdout).providers.find((p) => p.id === "deepseek");
    assert.equal("planNote" in deepseek, false);
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
});
