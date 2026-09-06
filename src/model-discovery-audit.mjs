import {
  appendFileSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { discoverProviderModels } from "./model-discovery.mjs";
import { MODEL_CATALOG_METADATA_SOURCES } from "./model-catalog-metadata.mjs";
import { PROVIDERS } from "./model-registry.mjs";
import {
  providerCatalogKind,
  providerCatalogRouteIds,
  providerCatalogSources,
} from "./provider-catalogs.mjs";
import { resolveProviderCredential } from "./provider-credentials.mjs";

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function normalizeRequestedProviders(value) {
  const ids = String(value || "all")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return ids.length ? [...new Set(ids)] : ["all"];
}

function canonicalProviderIds(providers) {
  return [...providers.values()]
    .filter((provider) => !provider.variantOf && providerCatalogSources(provider.id, providers).length)
    .map((provider) => provider.id)
    .sort();
}

// One provider card may own several endpoints, while protocol variants on the
// same endpoint must be queried only once. Keep that grouping identical to the
// Control Center so the weekly report and the list a user opens cannot drift.
export function auditCatalogSourceIds(requested = "all", providers = PROVIDERS) {
  const requestedIds = normalizeRequestedProviders(requested);
  const roots = requestedIds.includes("all")
    ? canonicalProviderIds(providers)
    : requestedIds;
  const sourceIds = [];
  for (const id of roots) {
    const provider = providers.get(id);
    if (!provider) throw new Error(`Unknown provider: ${id}`);
    const sources = providerCatalogSources(id, providers);
    if (!sources.length) throw new Error(`${provider.displayName} does not expose a discoverable model catalog.`);
    // An explicit endpoint variant such as opencode-zen means that endpoint;
    // selecting its canonical provider card means every distinct endpoint the
    // card owns. Same-endpoint variants fold to the source descriptor above.
    const exact = provider.variantOf && sources.find((source) => (
      providerCatalogRouteIds(source.id, providers).includes(id)
    ));
    sourceIds.push(...(exact ? [exact.id] : sources.map((source) => source.id)));
  }
  return [...new Set(sourceIds)].sort();
}

function defaultReadiness(provider) {
  if (providerCatalogKind(provider) === "devin") {
    return {
      ready: false,
      reason: "This catalog requires a local Devin CLI session and cannot use a repository API-key secret.",
    };
  }
  if (provider.credential?.resolver) {
    return {
      ready: false,
      reason: "This catalog requires local Google Cloud ADC and cannot use a repository API-key secret.",
    };
  }
  if (provider.kind !== "openai-compatible") {
    return { ready: false, reason: "This provider has no repository-auditable model endpoint." };
  }
  return resolveProviderCredential(provider)
    ? { ready: true }
    : { ready: false, reason: "No repository secret is configured for this provider." };
}

function secretValues(provider, credentialResolver) {
  if (provider.kind !== "openai-compatible") return [];
  try {
    const credential = credentialResolver(provider);
    return typeof credential?.value === "string" && credential.value
      ? [credential.value]
      : [];
  } catch {
    return [];
  }
}

export function redactAuditError(error, secrets = []) {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (secret.length >= 4) message = message.split(secret).join("[redacted]");
  }
  return message
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/((?:api[_ -]?key|access[_ -]?token|authorization)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
    .slice(0, 1_000);
}

function sortedStrings(values) {
  return [...new Set(Array.isArray(values) ? values.map(String) : [])].sort();
}

function safeDiscoveryResult(result) {
  const blocked = Object.fromEntries(
    Object.entries(result.blocked || {}).sort(([left], [right]) => left.localeCompare(right)),
  );
  const contextLengths = Object.fromEntries(
    Object.entries(result.contextLengths || {}).sort(([left], [right]) => left.localeCompare(right)),
  );
  const metadata = Object.fromEntries(
    Object.entries(result.metadata || {}).sort(([left], [right]) => left.localeCompare(right)),
  );
  return {
    models: sortedStrings(result.discovered),
    registered: sortedStrings(result.registered),
    unregistered: sortedStrings(result.unregistered),
    addable: sortedStrings(result.addable),
    blocked,
    unavailable: sortedStrings(result.unavailable),
    contextLengths,
    metadata,
    ...(Array.isArray(result.free) ? { free: sortedStrings(result.free) } : {}),
  };
}

function auditSummary(results) {
  const succeeded = results.filter(({ status }) => status === "succeeded");
  return {
    catalogs: results.length,
    succeeded: succeeded.length,
    skipped: results.filter(({ status }) => status === "skipped").length,
    failed: results.filter(({ status }) => status === "failed").length,
    models: succeeded.reduce((total, result) => total + result.models.length, 0),
    unregistered: succeeded.reduce((total, result) => total + result.unregistered.length, 0),
    unavailable: succeeded.reduce((total, result) => total + result.unavailable.length, 0),
  };
}

export async function auditProviderModels({
  requested = "all",
  providers = PROVIDERS,
  discover = (providerId) => discoverProviderModels(providerId, { refresh: true, cache: false }),
  readiness = defaultReadiness,
  credentialResolver = resolveProviderCredential,
  generatedAt = new Date().toISOString(),
} = {}) {
  const sources = auditCatalogSourceIds(requested, providers);
  const results = [];
  for (const providerId of sources) {
    const provider = providers.get(providerId);
    const available = await readiness(provider);
    if (!available?.ready) {
      results.push({
        provider: providerId,
        displayName: provider.displayName,
        status: "skipped",
        reason: available?.reason || "This catalog is not configured for repository discovery.",
      });
      continue;
    }
    try {
      const result = await discover(providerId);
      results.push({
        provider: providerId,
        displayName: provider.displayName,
        status: "succeeded",
        sources: [...(MODEL_CATALOG_METADATA_SOURCES[providerId] || [])],
        ...safeDiscoveryResult(result),
      });
    } catch (error) {
      results.push({
        provider: providerId,
        displayName: provider.displayName,
        status: "failed",
        error: redactAuditError(error, secretValues(provider, credentialResolver)),
      });
    }
  }
  return {
    version: 1,
    generatedAt,
    requested: normalizeRequestedProviders(requested),
    results,
    summary: auditSummary(results),
    note: "This audit reports provider catalogs only. It never edits the registry or lists an unverified model in Codex.",
  };
}

function markdownCell(value) {
  return String(value ?? "").replaceAll("|", "\\|").replace(/\s+/g, " ").trim();
}

function summarizeIds(ids, limit = 8) {
  const values = Array.isArray(ids) ? ids : [];
  const visible = values.slice(0, limit).join(", ");
  return values.length > limit ? `${visible} (+${values.length - limit} more)` : visible;
}

export function renderAuditMarkdown(audit) {
  const lines = [
    "## Provider model audit",
    "",
    `Generated: ${audit.generatedAt}`,
    "",
    "| Provider | Status | Models | New | Unavailable | Detail |",
    "| --- | --- | ---: | ---: | ---: | --- |",
  ];
  for (const result of audit.results) {
    const detail = result.status === "failed"
      ? result.error
      : result.status === "skipped"
        ? result.reason
        : result.unregistered.length
          ? summarizeIds(result.unregistered)
          : "No catalog drift";
    lines.push(
      `| ${markdownCell(result.provider)} | ${result.status} | ${result.models?.length ?? 0} | ` +
        `${result.unregistered?.length ?? 0} | ${result.unavailable?.length ?? 0} | ${markdownCell(detail)} |`,
    );
  }
  lines.push(
    "",
    `Succeeded: ${audit.summary.succeeded}; skipped: ${audit.summary.skipped}; failed: ${audit.summary.failed}.`,
    `Discovered models: ${audit.summary.models}; new candidates: ${audit.summary.unregistered}; unavailable registered IDs: ${audit.summary.unavailable}.`,
    "",
    audit.note,
    "",
  );
  return lines.join("\n");
}

function fixtureDiscovery(fixtureDirectory) {
  return async (providerId) => {
    const fixture = path.join(fixtureDirectory, `${providerId}.json`);
    const payload = JSON.parse(readFileSync(fixture, "utf8"));
    return discoverProviderModels(providerId, {
      cache: false,
      fixture: true,
      loadPayload: async () => payload,
    });
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    process.stdout.write(`Usage: model-discovery-audit.mjs [--provider all|ID[,ID...]]
  [--output FILE] [--summary FILE] [--fixture-dir DIR] [--generated-at ISO]
  [--store-cache] [--fail-on-error] [--fail-on-skipped]

Audits each canonical provider catalog and writes a credential-free JSON report.
Missing credentials are skipped during an all-provider audit. The command never
edits the registry or curates discovered model IDs. --store-cache records the
same live answers in the current installation's private catalog cache.
`);
    return;
  }
  for (const name of ["--provider", "--output", "--summary", "--fixture-dir", "--generated-at"]) {
    if (args.includes(name) && (!option(args, name) || option(args, name).startsWith("--"))) {
      throw new Error(`${name} requires a value.`);
    }
  }
  const fixtureDirectory = option(args, "--fixture-dir");
  const generatedAt = option(args, "--generated-at") || new Date().toISOString();
  if (Number.isNaN(Date.parse(generatedAt))) throw new Error("--generated-at must be an ISO date-time.");
  const audit = await auditProviderModels({
    requested: option(args, "--provider") || "all",
    ...(fixtureDirectory
      ? {
          discover: fixtureDiscovery(path.resolve(fixtureDirectory)),
          readiness: () => ({ ready: true }),
        }
      : args.includes("--store-cache")
        ? {
            discover: (providerId) => discoverProviderModels(providerId, {
              refresh: true,
              cache: true,
            }),
          }
      : {}),
    generatedAt: new Date(generatedAt).toISOString(),
  });
  const serialized = `${JSON.stringify(audit, null, 2)}\n`;
  const output = option(args, "--output");
  if (output) writeFileSync(path.resolve(output), serialized, { encoding: "utf8", mode: 0o600 });
  else process.stdout.write(serialized);
  const summary = option(args, "--summary");
  if (summary) appendFileSync(path.resolve(summary), renderAuditMarkdown(audit), "utf8");
  if (args.includes("--fail-on-error") && audit.summary.failed) process.exitCode = 1;
  if (args.includes("--fail-on-skipped") && audit.summary.skipped) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`codex-router model-discovery-audit: ${redactAuditError(error)}`);
    process.exit(1);
  });
}
