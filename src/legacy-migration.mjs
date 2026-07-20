import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { redactCallerUrl } from "./caller-auth.mjs";
import { protectPrivateFile } from "./file-security.mjs";
import {
  CODEX_HOME,
  CONFIG_PATH,
  LEGACY_SERVICE_LABEL,
  LEGACY_STATE_DIR,
  LAUNCH_AGENTS_DIR,
  MIGRATIONS_DIR,
  MERGED_CATALOG_PATH,
  PROTOTYPE_SERVICE_LABEL,
  SERVICE_LABEL,
  SOURCE_ROOT,
} from "./paths.mjs";

const launchctl = "/bin/launchctl";
const skipLaunchctl = process.env.CODEX_ROUTER_SKIP_LAUNCHCTL === "1";

export const LEGACY_VARIANTS = Object.freeze([
  Object.freeze({
    id: "kimi-router-0.x",
    label: LEGACY_SERVICE_LABEL,
    stateDir: LEGACY_STATE_DIR,
  }),
  Object.freeze({
    id: "kimi-proxy-prototype",
    label: PROTOTYPE_SERVICE_LABEL,
    stateDir: path.join(CODEX_HOME, "kimi-proxy"),
  }),
]);

function launchAgentPath(label) {
  return path.join(LAUNCH_AGENTS_DIR, `${label}.plist`);
}

function configText() {
  return existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf8") : "";
}

function serviceLoaded(label) {
  if (process.platform !== "darwin" || skipLaunchctl) return false;
  try {
    execFileSync(launchctl, ["print", `gui/${process.getuid()}/${label}`], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function rootValues(contents, key) {
  const firstTable = contents.search(/^\s*\[/m);
  const root = firstTable === -1 ? contents : contents.slice(0, firstTable);
  return [...root.matchAll(new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, "gm"))]
    .map((match) => match[1]);
}

export function detectLegacyInstallations() {
  const contents = configText();
  const installations = LEGACY_VARIANTS.map((variant) => {
    const plistPath = launchAgentPath(variant.label);
    const catalogPath = path.join(variant.stateDir, "merged-models.json");
    const configReference = contents.includes(catalogPath);
    const plistPresent = existsSync(plistPath);
    const loaded = serviceLoaded(variant.label);
    return {
      ...variant,
      catalogPath,
      configReference,
      plistPath,
      plistPresent,
      loaded,
      detected: configReference || plistPresent || loaded,
    };
  }).filter((variant) => variant.detected);

  const openaiBaseUrls = rootValues(contents, "openai_base_url");
  const modelCatalogs = rootValues(contents, "model_catalog_json");
  const knownCatalogs = new Set([
    MERGED_CATALOG_PATH,
    ...LEGACY_VARIANTS.map((variant) => path.join(variant.stateDir, "merged-models.json")),
  ]);
  const unknownCatalog = modelCatalogs.find((catalog) => !knownCatalogs.has(catalog));
  const unknownConflict = Boolean(unknownCatalog);

  return {
    installations,
    unknownConflict,
    config: {
      openaiBaseUrl: openaiBaseUrls[0]
        ? redactCallerUrl(openaiBaseUrls[0])
        : null,
      modelCatalogJson: unknownCatalog || modelCatalogs[0] || null,
    },
  };
}

function safeTimestamp() {
  return `${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}-${process.pid}`;
}

function writeProtectedJson(target, value) {
  const temporary = `${target}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  protectPrivateFile(temporary);
  renameSync(temporary, target);
  protectPrivateFile(target);
}

function stopService(label) {
  if (process.platform !== "darwin" || skipLaunchctl) return;
  const service = `gui/${process.getuid()}/${label}`;
  try {
    execFileSync(launchctl, ["bootout", service], { stdio: "ignore" });
  } catch {
    // The service may already be stopped.
  }
  try {
    execFileSync(launchctl, ["disable", service], { stdio: "ignore" });
  } catch {
    // The service may never have been enabled.
  }
}

export function applyKnownMigrations() {
  const detected = detectLegacyInstallations();
  if (detected.unknownConflict) {
    throw new Error(
      `An unknown model catalog is configured at ${detected.config.modelCatalogJson}; refusing automatic migration.`,
    );
  }
  if (detected.installations.length === 0) return { migrated: false };

  const snapshotDir = path.join(MIGRATIONS_DIR, safeTimestamp());
  mkdirSync(snapshotDir, { recursive: true, mode: 0o700 });
  chmodSync(snapshotDir, 0o700);
  let configBackup;
  if (existsSync(CONFIG_PATH)) {
    configBackup = path.join(snapshotDir, "config.toml.before-migration");
    copyFileSync(CONFIG_PATH, configBackup);
    protectPrivateFile(configBackup);
  }

  const services = detected.installations.map((installation) => {
    const plistBackup = installation.plistPresent
      ? path.join(snapshotDir, `${installation.label}.plist`)
      : null;
    return {
      id: installation.id,
      label: installation.label,
      originalPlist: installation.plistPath,
      plistBackup,
      stateDir: installation.stateDir,
      stateRetained: existsSync(installation.stateDir),
      wasLoaded: installation.loaded,
    };
  });

  const snapshot = {
    version: 1,
    createdAt: new Date().toISOString(),
    snapshotDir,
    configBackup: configBackup || null,
    services,
    newServiceLabel: SERVICE_LABEL,
  };
  const manifestPath = path.join(snapshotDir, "migration.json");
  writeProtectedJson(manifestPath, snapshot);
  mkdirSync(MIGRATIONS_DIR, { recursive: true, mode: 0o700 });
  writeProtectedJson(path.join(MIGRATIONS_DIR, "latest.json"), {
    version: 1,
    manifestPath,
  });

  try {
    for (const service of services) {
      stopService(service.label);
      if (service.plistBackup && existsSync(service.originalPlist)) {
        renameSync(service.originalPlist, service.plistBackup);
        protectPrivateFile(service.plistBackup);
      }
    }
    execFileSync(
      process.execPath,
      [path.join(SOURCE_ROOT, "src", "config-manager.mjs"), "disable"],
      { stdio: "ignore", env: process.env },
    );
  } catch (error) {
    try {
      rollbackLatestMigration({ removeNewService: false });
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `Legacy migration failed and automatic restoration also failed. Snapshot: ${manifestPath}`,
      );
    }
    throw error;
  }
  return { migrated: true, manifestPath, snapshot };
}

export function latestMigration() {
  const latestPath = path.join(MIGRATIONS_DIR, "latest.json");
  if (!existsSync(latestPath)) return undefined;
  const latest = JSON.parse(readFileSync(latestPath, "utf8"));
  if (!latest?.manifestPath || !existsSync(latest.manifestPath)) return undefined;
  return JSON.parse(readFileSync(latest.manifestPath, "utf8"));
}

export function rollbackLatestMigration(options = {}) {
  const snapshot = latestMigration();
  if (!snapshot) throw new Error("No legacy-router migration snapshot is available.");
  if (
    options.removeNewService !== false &&
    process.platform === "darwin" &&
    !skipLaunchctl
  ) {
    try {
      execFileSync(
        process.execPath,
        [path.join(SOURCE_ROOT, "src", "service.mjs"), "uninstall"],
        { stdio: "ignore", env: process.env },
      );
    } catch {
      // Restoration can continue when the new service was never installed.
    }
  }
  if (snapshot.configBackup && existsSync(snapshot.configBackup)) {
    copyFileSync(snapshot.configBackup, CONFIG_PATH);
    protectPrivateFile(CONFIG_PATH);
  }
  for (const service of snapshot.services || []) {
    if (service.plistBackup && existsSync(service.plistBackup)) {
      mkdirSync(path.dirname(service.originalPlist), { recursive: true });
      copyFileSync(service.plistBackup, service.originalPlist);
      chmodSync(service.originalPlist, 0o644);
    }
    if (
      process.platform === "darwin" &&
      !skipLaunchctl &&
      service.wasLoaded &&
      existsSync(service.originalPlist)
    ) {
      try {
        execFileSync(launchctl, ["enable", `gui/${process.getuid()}/${service.label}`], {
          stdio: "ignore",
        });
        execFileSync(
          launchctl,
          ["bootstrap", `gui/${process.getuid()}`, service.originalPlist],
          { stdio: "ignore" },
        );
      } catch {
        // The caller can retry service restoration after inspecting the snapshot.
      }
    }
  }
  return snapshot;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const command = process.argv[2] || "detect";
    if (command === "detect") {
      process.stdout.write(`${JSON.stringify(detectLegacyInstallations(), null, 2)}\n`);
    } else if (command === "assert-clear") {
      const detected = detectLegacyInstallations();
      if (detected.unknownConflict) {
        throw new Error(
          `Another router owns ${detected.config.modelCatalogJson}; it must be handled manually.`,
        );
      }
      if (detected.installations.length) {
        throw new Error(
          `A recognized older router (${detected.installations.map((item) => item.id).join(", ")}) must be migrated first. Run ./bin/setup --migrate-known.`,
        );
      }
      process.stdout.write(`${JSON.stringify({ clear: true })}\n`);
    } else if (command === "apply" && process.argv.includes("--yes")) {
      process.stdout.write(`${JSON.stringify(applyKnownMigrations(), null, 2)}\n`);
    } else if (command === "rollback" && process.argv.includes("--yes")) {
      process.stdout.write(`${JSON.stringify(rollbackLatestMigration(), null, 2)}\n`);
    } else {
      console.error(
        "Usage: legacy-migration.mjs detect|assert-clear|apply --yes|rollback --yes",
      );
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
