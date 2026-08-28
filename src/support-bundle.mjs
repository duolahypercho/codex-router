import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { redactCallerUrl } from "./caller-auth.mjs";
import { antigravityTokenPath } from "./antigravity-oauth-session.mjs";
import { readInstallManifest } from "./install-manifest.mjs";
import { redactProxyCredentials } from "./proxy-environment.mjs";
import { protectPrivateFile } from "./file-security.mjs";
import { detectLegacyInstallations } from "./legacy-migration.mjs";
import { PROVIDERS, providerNeedsNoKey } from "./model-registry.mjs";
import {
  CALLER_SECRET_PATH,
  CONFIG_PATH,
  INTERNAL_SECRET_PATH,
  LOG_PATH,
  SOURCE_ROOT,
  SUPPORT_DIR,
} from "./paths.mjs";
import {
  credentialPaths,
  credentialStatus,
  genericProviderCredentialPath,
} from "./provider-credentials.mjs";
import { providerSelectionStatus } from "./provider-selection.mjs";
import {
  readProviderCredentialStore,
  redactCredentialText,
} from "./provider-credential-store.mjs";
import { providerApiKeyPoolsSupportSnapshot } from "./provider-api-key-pool.mjs";
import { resolveStoredCredential } from "./provider-api-key-routing.mjs";

function runJson(script, args = []) {
  const result = spawnSync(
    process.execPath,
    [path.join(SOURCE_ROOT, "src", script), ...args],
    { cwd: SOURCE_ROOT, env: process.env, encoding: "utf8" },
  );
  try {
    return JSON.parse(result.stdout || "{}");
  } catch {
    return { error: result.stderr?.trim() || `exited with ${result.status}` };
  }
}

function commandVersion(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function fileMetadata(target) {
  if (!existsSync(target)) return { path: target, exists: false };
  const metadata = statSync(target);
  return {
    path: target,
    exists: true,
    size: metadata.size,
    mode: (metadata.mode & 0o777).toString(8),
    modifiedAt: metadata.mtime.toISOString(),
  };
}

function privateText(target) {
  try {
    const metadata = lstatSync(target);
    if (metadata.isSymbolicLink() || !metadata.isFile()) return undefined;
    return readFileSync(target, "utf8");
  } catch {
    return undefined;
  }
}

function redactLogs(contents) {
  return redactCredentialText(redactCallerUrl(contents));
}

function logTail() {
  if (!existsSync(LOG_PATH)) return null;
  const lines = readFileSync(LOG_PATH, "utf8").split(/\r?\n/);
  return redactLogs(lines.slice(-200).join("\n"));
}

function knownLocalSecrets() {
  const values = new Set();
  const files = [CALLER_SECRET_PATH, INTERNAL_SECRET_PATH];
  for (const provider of PROVIDERS.values()) {
    if (provider.kind !== "openai-compatible") continue;
    // A keyless provider holds no secret, so there is nothing to collect and
    // nothing to redact for it.
    if (providerNeedsNoKey(provider)) continue;
    files.push(...credentialPaths(provider));
    for (const name of provider.credential.environment) {
      const value = process.env[name]?.trim();
      if (value) values.add(value);
    }
  }
  for (const entry of readProviderCredentialStore().credentials) {
    if (entry.providerType !== "generic") continue;
    try {
      files.push(genericProviderCredentialPath(entry.providerId));
    } catch {
      // Invalid generic metadata is already ignored by the fail-closed store reader.
    }
  }
  for (const target of files) {
    const value = privateText(target)?.trim();
    if (value) values.add(value);
  }
  // Not a provider credential and not stored in the state directory, but a
  // working secret all the same, and one the service definition now carries so
  // the background forwarder can refresh a token.
  const clientSecret = process.env.ANTIGRAVITY_CLIENT_SECRET?.trim();
  if (clientSecret) values.add(clientSecret);
  const oauthPath = antigravityTokenPath();
  const oauthContents = privateText(oauthPath);
  if (oauthContents !== undefined) {
    try {
      const token = JSON.parse(oauthContents);
      for (const field of ["access_token", "refresh_token"]) {
        const value = token?.[field];
        if (typeof value === "string" && value.trim()) values.add(value.trim());
      }
    } catch {
      // An invalid credential is reported by doctor; never copy it into a
      // support bundle merely to discover whether it contains a secret.
    }
  }
  return [...values].filter((value) => value.length >= 8);
}

// The manifest records the proxy the service was installed with so a later
// repair can restore it. That file is owner-only, but this bundle exists to be
// handed to somebody else, and a proxy URL may carry `user:password@`. The
// host and port stay -- they are the diagnostic value -- and only the
// credential is removed, from past installs as well as the current one.
function sharableInstallManifest() {
  const manifest = readInstallManifest();
  if (!manifest) return { installed: false };
  const scrub = (entry) => (entry && entry.proxyEnvironment
    ? { ...entry, proxyEnvironment: redactProxyCredentials(entry.proxyEnvironment) }
    : entry);
  return {
    ...manifest,
    current: scrub(manifest.current),
    history: Array.isArray(manifest.history) ? manifest.history.map(scrub) : manifest.history,
  };
}

function redactBundle(contents) {
  return redactCredentialText(redactCallerUrl(contents), knownLocalSecrets());
}

function outputOption() {
  const index = process.argv.indexOf("--output");
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error("--output requires a path.");
  return value;
}

export function createSupportBundle(options = {}) {
  const credentialSources = {};
  for (const provider of PROVIDERS.values()) {
    if (provider.kind !== "openai-compatible") continue;
    const status = credentialStatus(provider);
    credentialSources[provider.id] = status.configured
      ? { configured: true, source: status.source, persistent: status.persistent }
      : { configured: false };
  }
  let selection;
  try {
    selection = providerSelectionStatus();
  } catch (error) {
    selection = { error: error instanceof Error ? error.message : String(error) };
  }
  const packageJson = JSON.parse(readFileSync(path.join(SOURCE_ROOT, "package.json"), "utf8"));
  const bundle = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    privacy: options.includeLogs
      ? "Includes a redacted log tail that may still contain prompts or provider responses."
      : "Credential values, prompts, response bodies, and log contents are excluded.",
    runtime: {
      platform: process.platform,
      release: os.release(),
      architecture: process.arch,
      node: process.version,
      packageVersion: packageJson.version,
      gitCommit: commandVersion("git", ["-C", SOURCE_ROOT, "rev-parse", "HEAD"]),
      python: commandVersion(
        path.join(
          SOURCE_ROOT,
          ".venv",
          process.platform === "win32" ? "Scripts" : "bin",
          process.platform === "win32" ? "python.exe" : "python",
        ),
        ["--version"],
      ),
    },
    doctor: runJson("doctor.mjs", ["--json"]),
    config: runJson("config-manager.mjs", ["status"]),
    service: runJson("service.mjs", ["status"]),
    selection,
    credentialSources,
    apiKeyPools: providerApiKeyPoolsSupportSnapshot({
      resolveCredential: (providerId, credentialId) => {
        const provider = PROVIDERS.get(providerId);
        return provider ? resolveStoredCredential(provider, credentialId) : undefined;
      },
    }),
    ownership: detectLegacyInstallations(),
    install: sharableInstallManifest(),
    files: {
      config: fileMetadata(CONFIG_PATH),
      log: fileMetadata(LOG_PATH),
    },
    ...(options.includeLogs ? { redactedLogTail: logTail() } : {}),
  };

  mkdirSync(SUPPORT_DIR, { recursive: true, mode: 0o700 });
  chmodSync(SUPPORT_DIR, 0o700);
  const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const target = path.resolve(
    options.output || path.join(SUPPORT_DIR, `codex-router-support-${timestamp}.json`),
  );
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const serialized = redactBundle(`${JSON.stringify(bundle, null, 2)}\n`);
  writeFileSync(target, serialized, {
    encoding: "utf8",
    mode: 0o600,
  });
  protectPrivateFile(target);
  return { path: target, includedLogs: Boolean(options.includeLogs) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const known = new Set(["--help", "--include-logs", "--output"]);
    for (let index = 2; index < process.argv.length; index += 1) {
      const argument = process.argv[index];
      if (!known.has(argument)) throw new Error(`Unknown option: ${argument}`);
      if (argument === "--output") index += 1;
    }
    if (process.argv.includes("--help")) {
      process.stdout.write(`Usage: support-bundle [--include-logs] [--output PATH]

Creates a mode-600 JSON diagnostic bundle without credential values.
Logs are excluded by default because they may contain prompts or responses.
`);
    } else {
      const result = createSupportBundle({
        includeLogs: process.argv.includes("--include-logs"),
        output: outputOption(),
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
