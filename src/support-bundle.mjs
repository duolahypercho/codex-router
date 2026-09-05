import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { redactCallerUrl } from "./caller-auth.mjs";
import {
  antigravityTokenPath,
  validateAntigravityToken,
} from "./antigravity-oauth-session.mjs";
import { discoveryDisabled } from "./discovery-mode.mjs";
import { readInstallManifest } from "./install-manifest.mjs";
import { redactProxyCredentials } from "./proxy-environment.mjs";
import { protectPrivateFile } from "./file-security.mjs";
import {
  boundedOperationChild,
  operationDeadlineFromEnvironment,
  runOperationProcessTree,
} from "./process-tree.mjs";
import { detectLegacyInstallations } from "./legacy-migration.mjs";
import {
  PROVIDERS,
  RUNTIME_PROVIDERS,
  providerNeedsNoKey,
} from "./model-registry.mjs";
import { genericProviderConfigured } from "./generic-provider-readiness.mjs";
import {
  CALLER_SECRET_PATH,
  CONFIG_PATH,
  CURSOR_PUBLIC_SECRET_PATH,
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

const ANTIGRAVITY_RECORD_KEYS = new Set([
  "version",
  "managed_by",
  "session_generation",
  "project_revision",
  "client_id",
  "client_secret",
  "access_token",
  "refresh_token",
  "expires_at",
  "expires_in",
  "project_id",
  "project_source",
  "project_checked_at",
  "tier_id",
  "email",
  "token_type",
  "probe_version",
  "probe_verified_at",
  "probe_model",
  "probe_activation",
]);
const MAX_PRIVATE_SOURCE_BYTES = 64 * 1024;
const MAX_SUPPORT_BUNDLE_OPERATION_MS = 2 * 60_000;

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
  const metadata = lstatSync(target);
  return {
    path: target,
    exists: true,
    size: metadata.size,
    mode: (metadata.mode & 0o777).toString(8),
    modifiedAt: metadata.mtime.toISOString(),
  };
}

function privateText(target) {
  let descriptor;
  try {
    const metadata = lstatSync(target);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.size > MAX_PRIVATE_SOURCE_BYTES
    ) return { status: "unsafe" };
    descriptor = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.size > MAX_PRIVATE_SOURCE_BYTES ||
      opened.dev !== metadata.dev ||
      opened.ino !== metadata.ino
    ) return { status: "unsafe" };
    const buffer = Buffer.alloc(MAX_PRIVATE_SOURCE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_PRIVATE_SOURCE_BYTES) return { status: "unsafe" };
    return {
      status: "readable",
      contents: buffer.subarray(0, length).toString("utf8"),
    };
  } catch (error) {
    return error?.code === "ENOENT" ? { status: "absent" } : { status: "unsafe" };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function discoveredValues(values) {
  return [...values].filter((value) => value.length > 0);
}

function unsafeSecretDiscovery(values) {
  return { status: "unsafe", values: discoveredValues(values) };
}

function knownLocalSecrets() {
  // In no-discovery mode, reading a credential merely so a later redactor can
  // recognize its value would still violate the operator's promise. The
  // bundle therefore omits logs below (the only arbitrary text it can copy)
  // and relies on structural redaction for the remaining generated fields.
  if (discoveryDisabled()) return { status: "disabled", values: [] };
  const values = new Set();
  const files = [CALLER_SECRET_PATH, INTERNAL_SECRET_PATH, CURSOR_PUBLIC_SECRET_PATH];
  for (const provider of PROVIDERS.values()) {
    if (provider.kind !== "openai-compatible") continue;
    // A keyless provider holds no secret, so there is nothing to collect and
    // nothing to redact for it.
    if (providerNeedsNoKey(provider)) continue;
    files.push(...credentialPaths(provider));
    for (const name of provider.credential?.environment || []) {
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
  for (const target of new Set(files)) {
    const source = privateText(target);
    if (source.status === "unsafe") return unsafeSecretDiscovery(values);
    const value = source.status === "readable" ? source.contents.trim() : "";
    if (value) values.add(value);
  }
  const oauthSource = privateText(antigravityTokenPath());
  if (oauthSource.status === "unsafe") return unsafeSecretDiscovery(values);
  if (oauthSource.status === "readable") {
    try {
      const token = JSON.parse(oauthSource.contents);
      validateAntigravityToken(token);
      if (Object.keys(token).some((key) => !ANTIGRAVITY_RECORD_KEYS.has(key))) {
        throw new Error("unsupported Antigravity OAuth credential field");
      }
      // This router's operator-owned OAuth pair is kept in the same private
      // record as the tokens. Treat the client id as private too: although
      // OAuth client ids are public identifiers, the setup contract promises
      // neither half of the pair will escape through logs or support output.
      for (const field of ["client_id", "client_secret", "access_token", "refresh_token"]) {
        const value = token[field];
        if (typeof value === "string" && value.trim()) values.add(value.trim());
      }
    } catch {
      // An invalid credential may contain a value that an old log copied
      // verbatim. Without a trustworthy parse there is no complete redaction
      // set, so the caller must omit the arbitrary log text altogether.
      return unsafeSecretDiscovery(values);
    }
  }
  return {
    status: "safe",
    values: discoveredValues(values),
  };
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

function redactBundle(contents, knownSecrets) {
  return redactCredentialText(redactCallerUrl(contents), knownSecrets);
}

export function redactSupportBundleObjectForTests(value, knownSecrets = []) {
  if (typeof value === "string") return redactCredentialText(value, knownSecrets);
  if (Array.isArray(value)) {
    return value.map((item) => redactSupportBundleObjectForTests(item, knownSecrets));
  }
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    const compactKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    const secretField =
      compactKey === "authorization" ||
      compactKey === "password" ||
      compactKey.endsWith("token") ||
      compactKey.endsWith("secret") ||
      compactKey.endsWith("apikey") ||
      compactKey.endsWith("key");
    output[key] = secretField
      ? "[REDACTED]"
      : redactSupportBundleObjectForTests(child, knownSecrets);
  }
  return output;
}

function outputOption() {
  const index = process.argv.indexOf("--output");
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error("--output requires a path.");
  return value;
}

export function createSupportBundle(options = {}) {
  // An arbitrary historical log may contain a credential that was rotated or
  // deleted before this bundle discovers current values. There is no safe
  // epoch proof for the existing log file, so support bundles never copy it.
  const secretDiscovery = knownLocalSecrets();
  const includeLogs = false;
  const credentialSources = {};
  for (const provider of PROVIDERS.values()) {
    if (provider.kind !== "openai-compatible") continue;
    const status = credentialStatus(provider);
    credentialSources[provider.id] = status.configured
      ? { configured: true, source: status.source, persistent: status.persistent }
      : { configured: false };
  }
  for (const provider of RUNTIME_PROVIDERS.values()) {
    if (provider.generic !== true) continue;
    const configured = genericProviderConfigured(provider.id);
    credentialSources[provider.id] = configured
      ? {
          configured: true,
          source: provider.credentialRef ? "bound credential reference" : "not required",
          persistent: Boolean(provider.credentialRef),
        }
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
    privacy: "Log contents are always omitted because historical logs cannot be proven free of rotated or deleted credentials; credential values, prompts, and response bodies are also excluded.",
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
  };

  mkdirSync(SUPPORT_DIR, { recursive: true, mode: 0o700 });
  chmodSync(SUPPORT_DIR, 0o700);
  const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const target = path.resolve(
    options.output || path.join(SUPPORT_DIR, `codex-router-support-${timestamp}.json`),
  );
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const serialized = redactBundle(
    `${JSON.stringify(redactSupportBundleObjectForTests(bundle, secretDiscovery.values), null, 2)}\n`,
    secretDiscovery.values,
  );
  writeFileSync(target, serialized, {
    encoding: "utf8",
    mode: 0o600,
  });
  protectPrivateFile(target);
  return { path: target, includedLogs: includeLogs };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!boundedOperationChild(process.env, {
    maximumMs: MAX_SUPPORT_BUNDLE_OPERATION_MS,
  })) {
    const deadline = operationDeadlineFromEnvironment(process.env, {
      timeoutMs: MAX_SUPPORT_BUNDLE_OPERATION_MS,
      maximumMs: MAX_SUPPORT_BUNDLE_OPERATION_MS,
    });
    try {
      const result = await runOperationProcessTree(
        process.execPath,
        [fileURLToPath(import.meta.url), ...process.argv.slice(2)],
        {
          cwd: SOURCE_ROOT,
          env: process.env,
          childEnvironment: {
            CODEX_ROUTER_OPERATION_CHILD: "1",
          },
          deadline,
          stdio: "inherit",
        },
      );
      process.exitCode = result.status ?? 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  } else {
  try {
    // Keep the historical switch parse-compatible for scripts and older UI
    // builds, but never let it change the log-free privacy boundary.
    const known = new Set(["--help", "--include-logs", "--output"]);
    for (let index = 2; index < process.argv.length; index += 1) {
      const argument = process.argv[index];
      if (!known.has(argument)) throw new Error(`Unknown option: ${argument}`);
      if (argument === "--output") index += 1;
    }
    if (process.argv.includes("--help")) {
      process.stdout.write(`Usage: support-bundle [--output PATH]

Creates a mode-600 JSON diagnostic bundle without credential values.
Log contents are always excluded because historical logs may contain private
prompts, responses, or credentials that have since been rotated or deleted.
`);
    } else {
      const result = createSupportBundle({
        output: outputOption(),
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
  }
}
