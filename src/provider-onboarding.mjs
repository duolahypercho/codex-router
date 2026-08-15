import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  grokCliFailureMessage,
  grokCliPath,
  grokCliPreflight,
} from "./grok-cli.mjs";
import { cliSessionPath, cliSessionStatus } from "./cli-session-credential.mjs";
import { grokOAuthStatus } from "./grok-oauth-status.mjs";
import { KIMI_CLI_NPM_PACKAGE } from "./kimi-oauth-onboarding.mjs";
import { MODELS, PROVIDERS } from "./model-registry.mjs";
import { kimiOAuthStatus } from "./oauth-status.mjs";
import { STATE_DIR } from "./paths.mjs";
import {
  apiProvider,
  credentialLabel,
  credentialStatus,
  removeProviderCredential,
  writeProviderCredential,
} from "./provider-credentials.mjs";
import { disableProvider } from "./provider-selection.mjs";
import {
  npmGlobalBinary,
  npmInstallGlobal,
  spawnEnvironment,
} from "./npm-global-install.mjs";
import { commandOnPath, spawnableCommand } from "./spawnable-command.mjs";

const SIGN_IN_CLIS = Object.freeze({
  "kimi-oauth": {
    executable: "kimi",
    npmPackage: KIMI_CLI_NPM_PACKAGE,
    loginArgs: ["login"],
    candidates: [path.join(os.homedir(), ".npm-global", "bin", "kimi")],
  },
  "grok-oauth": {
    executable: "grok",
    npmPackage: "@xai-official/grok",
    loginArgs: ["login", "--oauth"],
  },
  // Command Code ships `cmd`, `cmdc`, `commandcode`, and `command-code` from
  // one package. Only `command-code` is unambiguous everywhere — `cmd` is the
  // Windows shell — so the tray always drives that name.
  commandcode: {
    executable: "command-code",
    npmPackage: "command-code",
    loginArgs: ["login"],
    candidates: [path.join(os.homedir(), ".npm-global", "bin", "command-code")],
    // `command-code login` draws an Ink interface and puts stdin in raw mode,
    // which a piped stdio pair cannot provide: spawned from the tray it dies
    // on "Raw mode is not supported" before it ever opens the browser. It has
    // to be handed a real terminal.
    needsTerminal: true,
  },
});

function commandPath(name) {
  // Not the finder's first line: on Windows that is the extensionless npm
  // shim, and every caller here goes on to spawn what it gets back.
  return commandOnPath(name);
}

// A registry entry can declare a CLI session before anyone teaches this module
// how to install and run that CLI. Callers check first so the missing half
// degrades to "key only" instead of throwing mid-install.
export function hasSignInCli(providerId) {
  return Object.hasOwn(SIGN_IN_CLIS, providerId);
}

export function oauthCliPath(providerId) {
  const cli = SIGN_IN_CLIS[providerId];
  if (!cli) throw new Error(`Unknown OAuth provider: ${providerId}`);
  if (providerId === "grok-oauth") return grokCliPath();
  const discovered = commandPath(cli.executable);
  if (discovered) return discovered;
  const candidate = (cli.candidates || []).find((path) => existsSync(path));
  if (candidate) return candidate;
  // Last resort, because it costs an npm spawn: ask npm where it actually
  // installs global binaries. A custom prefix is invisible to both PATH (the
  // tray's is the bare system one) and to any list of guessed directories.
  return npmGlobalBinary(cli.executable);
}

export function oauthLoginArgs(providerId) {
  const cli = SIGN_IN_CLIS[providerId];
  if (!cli) throw new Error(`Unknown OAuth provider: ${providerId}`);
  return [...cli.loginArgs];
}

function oauthConfigured(providerId) {
  if (providerId === "kimi-oauth") return kimiOAuthStatus().configured;
  if (providerId === "grok-oauth") return grokOAuthStatus().configured;
  const provider = PROVIDERS.get(providerId);
  return provider ? cliSessionStatus(provider).configured : false;
}

export function providerOnboardingSnapshot() {
  // Protocol variants share their parent's key and selection, so onboarding
  // surfaces (tray, guided setup) offer one entry per family.
  const selectable = [...PROVIDERS.values()].filter((provider) => !provider.variantOf);
  return {
    providers: selectable.map((provider) => {
      if (provider.kind === "oauth") {
        const cliPath = oauthCliPath(provider.id);
        const cli = provider.id === "grok-oauth"
          ? grokCliPreflight({ executable: cliPath })
          : { installed: Boolean(cliPath), runnable: Boolean(cliPath) };
        const cliInstalled = cli.installed;
        const configured = oauthConfigured(provider.id);
        return {
          id: provider.id,
          displayName: provider.displayName,
          kind: "oauth",
          configured,
          cliInstalled,
          cliRunnable: cli.runnable,
          action: !cliInstalled
            ? "install"
            : !cli.runnable
              ? "blocked"
              : configured
                ? "ready"
                : "login",
        };
      }
      const configured = provider.keyless || provider.authMode === "anonymous"
        ? true
        : credentialStatus(provider, { persistent: true }).configured;
      const entry = {
        id: provider.id,
        displayName: provider.displayName,
        kind: "api",
        ...(provider.credential?.label ? { credentialLabel: credentialLabel(provider) } : {}),
        configured,
        action: configured ? "ready" : "add-key",
        // Carried to the tray so the plan requirement is visible at the
        // moment someone decides to connect, not after Codex 403s.
        ...(provider.planNote ? { planNote: provider.planNote } : {}),
      };
      if (provider.authMode === "anonymous") {
        entry.kind = "anonymous";
        // Guided setup pre-checks every `ready` row. An off-box endpoint must
        // be chosen explicitly even though it needs no API key.
        entry.action = "anonymous";
        entry.credentialLabel = "No API key";
        entry.anonymousNote = provider.anonymousNote;
        return entry;
      }
      // A provider whose CLI mints its key through a browser sign-in keeps the
      // key field (people with a Studio key still paste it) and gains a second
      // route. The tray needs both states to label the row honestly: whether
      // the CLI is present, and whether the key in play came from the session.
      const session = cliSessionStatus(provider);
      if (!session.supported || !hasSignInCli(provider.id)) return entry;
      const cliInstalled = Boolean(oauthCliPath(provider.id));
      return {
        ...entry,
        signIn: true,
        signedIn: session.configured,
        cliInstalled,
        signInAction: !cliInstalled ? "install" : session.configured ? "ready" : "login",
      };
    }),
  };
}

// npm and every CLI it installs globally start with `#!/usr/bin/env node`, so
// they die instantly unless node is on PATH. The tray is launched by launchd
// with the bare system PATH, which has no node on it — the failure there was
// `env: node: No such file or directory` behind a generic "could not install".
// Whatever node is running this file is by definition a working one, so put
// its directory in front for the child.
export function installOauthCli(providerId) {
  const cli = SIGN_IN_CLIS[providerId];
  if (!cli) throw new Error(`Unknown OAuth provider: ${providerId}`);
  if (providerId === "grok-oauth") {
    const preflight = grokCliPreflight();
    if (preflight.installed) {
      if (!preflight.runnable) throw new Error(grokCliFailureMessage(preflight));
      return;
    }
  } else if (oauthCliPath(providerId)) {
    return;
  }
  npmInstallGlobal(cli.npmPackage, { label: `the official ${cli.executable} CLI` });
  if (providerId === "grok-oauth") {
    const preflight = grokCliPreflight();
    if (!preflight.runnable) throw new Error(grokCliFailureMessage(preflight));
  } else if (!oauthCliPath(providerId)) {
    // The install reported success, so the binary exists somewhere npm knows
    // about and this router does not. Name the search so it is fixable.
    throw new Error(
      `npm installed ${cli.npmPackage}, but no \`${cli.executable}\` was found on PATH or in npm's global bin directory.`,
    );
  }
}

// A browser sign-in is slow by nature — the operator has to switch apps, log
// in, and authorize — but it must not be able to wedge the tray forever if the
// CLI waits on a terminal it will never get.
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const TERMINAL_LOGIN_TIMEOUT_MS = 3 * 60_000;
const POLL_INTERVAL_MS = 1_500;
const WAIT_HANDLE = new Int32Array(new SharedArrayBuffer(4));

// Hands the CLI a real terminal window and waits for the credential it writes.
// The tray has no terminal to lend, and a login this router cannot see the end
// of is a login the operator would have to come back and repeat.
// Reconnecting starts from an already-valid session, so "is it configured?"
// is true before the operator has done anything. Waiting for the CLI to
// rewrite the file is what actually distinguishes a finished sign-in.
function sessionWrittenAt(providerId) {
  const file = cliSessionPath(PROVIDERS.get(providerId));
  if (!file || !existsSync(file)) return 0;
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function signedInSince(providerId, before) {
  return sessionWrittenAt(providerId) > before && oauthConfigured(providerId);
}

function signInThroughTerminal(providerId, executable) {
  const cli = SIGN_IN_CLIS[providerId];
  const before = sessionWrittenAt(providerId);
  // Terminal.app rather than the operator's preferred terminal: it is always
  // present, and `open -a` needs no Automation consent the way driving a
  // specific app with AppleScript would. The override exists so tests (and
  // anyone whose environment cannot use `open`) can point at another launcher —
  // which is also the only way this route works off macOS, where there is no
  // `open -a Terminal` to fall back to.
  const launcher = process.env.MODEL_ROUTER_TERMINAL_LAUNCHER;
  if (process.platform !== "darwin" && !launcher) {
    throw new Error(
      `${cli.executable} signs in through an interactive terminal. Run \`${cli.executable} ${cli.loginArgs.join(" ")}\` in one, then reopen this.`,
    );
  }
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const script = path.join(STATE_DIR, `sign-in-${providerId}.command`);
  const quoted = [executable, ...cli.loginArgs]
    .map((part) => `'${part.replaceAll("'", "'\\''")}'`)
    .join(" ");
  writeFileSync(script, `#!/bin/sh\nexec ${quoted}\n`, { encoding: "utf8", mode: 0o700 });
  const opened = launcher
    ? spawnSync(launcher, [script], { encoding: "utf8", env: spawnEnvironment() })
    : spawnSync("/usr/bin/open", ["-a", "Terminal", script], {
        encoding: "utf8",
        env: spawnEnvironment(),
      });
  if (opened.error || opened.status !== 0) {
    throw new Error(`Could not open Terminal to run ${cli.executable}.`);
  }
  const deadline = Date.now() + TERMINAL_LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (signedInSince(providerId, before)) return;
    // A short blocking sleep: this runs in the one-shot control process the
    // tray spawned, which has nothing else to do while the operator signs in.
    Atomics.wait(WAIT_HANDLE, 0, 0, POLL_INTERVAL_MS);
  }
  throw new Error(
    `Still waiting on ${cli.executable} in the Terminal window. Finish signing in there — the tray picks it up on its own.`,
  );
}

export function loginOauthProvider(providerId) {
  const executable = oauthCliPath(providerId);
  if (!executable) throw new Error("Install the provider CLI before signing in.");
  if (providerId === "grok-oauth") {
    const preflight = grokCliPreflight({ executable });
    if (!preflight.runnable) throw new Error(grokCliFailureMessage(preflight));
  }
  // With a terminal of our own (guided setup) the CLI can simply inherit it.
  if (SIGN_IN_CLIS[providerId].needsTerminal && !process.stdin.isTTY) {
    signInThroughTerminal(providerId, executable);
    return;
  }
  // The CLI itself is another `#!/usr/bin/env node` script, so signing in needs
  // the same PATH repair the install did.
  const login = spawnableCommand(executable, oauthLoginArgs(providerId));
  const result = spawnSync(login.command, login.args, {
    ...login.options,
    encoding: "utf8",
    env: spawnEnvironment(),
    timeout: LOGIN_TIMEOUT_MS,
  });
  // A sign-in the operator never finished and one the CLI could not run look
  // the same from here, so say both are possible rather than blaming them.
  if (result.signal === "SIGTERM") {
    throw new Error(
      `${executable} did not finish signing in within 10 minutes. Run it in a terminal to see what it is waiting for.`,
    );
  }
  if (result.error || result.status !== 0) {
    // Carry the CLI's own last line: a cancelled sign-in and a CLI that could
    // not start look identical without it.
    throw new Error(
      `Provider sign-in was cancelled or did not complete. ${installFailureDetail(result)}`.trim(),
    );
  }
  if (!oauthConfigured(providerId)) {
    throw new Error("Sign-in finished without a usable OAuth session. Please try again.");
  }
}

export function saveApiCredential(providerId, value) {
  writeProviderCredential(providerId, value);
}

// Deleting the managed key files cannot reach a key that also lives in the
// macOS Keychain or the environment, so report what still resolves afterwards
// instead of claiming the provider is disconnected.
export function removeApiCredential(providerId) {
  const provider = apiProvider(providerId);
  const removedFiles = removeProviderCredential(provider);
  if (removedFiles) disableProvider(provider.id);
  const remaining = credentialStatus(provider, { persistent: true });
  return {
    provider: provider.id,
    displayName: provider.displayName,
    removedFiles,
    stillConfigured: remaining.configured === true,
    remainingSource: remaining.configured ? remaining.source : undefined,
  };
}

// Catalog-only providers (gemini-api, openrouter, groq, ...) ship no
// preselected models, so a stored key still leaves the picker empty. Callers
// use this to name the curation step instead of reporting a provider that
// looks enabled but shows nothing.
export function providerNeedsCuration(providerId, models = MODELS) {
  return !models.some((model) => model.provider === providerId);
}
