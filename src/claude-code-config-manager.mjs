import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertCallerSecret,
  claudeBaseUrl,
  isManagedClaudeBaseUrl,
  redactCallerUrl,
} from "./caller-auth.mjs";
import { claudeModelId } from "./claude-model-id.mjs";
import {
  CALLER_SECRET_PATH,
  CLAUDE_CATALOG_PATH,
  CLAUDE_LAUNCHER_PATH,
  PORTS,
  SOURCE_ROOT,
} from "./paths.mjs";
import { writePrivateFile, writePrivateJson } from "./file-security.mjs";
import { routedClientModels } from "./routed-client-models.mjs";
import { commandOnPath, spawnableCommand } from "./spawnable-command.mjs";
import { assertStateOwnership } from "./state-owner.mjs";
import { nodeRuntimePath } from "./cursor-config-manager.mjs";

const LAUNCHER_MARKER = "codex-router-claude-launcher";

function secret() {
  if (!existsSync(CALLER_SECRET_PATH)) throw new Error("The local router caller key is missing; run ./bin/doctor --fix.");
  return assertCallerSecret(readFileSync(CALLER_SECRET_PATH, "utf8").trim());
}

function launcherContents() {
  const node = nodeRuntimePath();
  const entry = path.join(SOURCE_ROOT, "src", "claude-code-launcher.mjs");
  if (process.platform === "win32") {
    return `@echo off\r\nREM ${LAUNCHER_MARKER}\r\n"${node}" "${entry}" %*\r\n`;
  }
  const quote = (value) => String(value).replaceAll("'", "'\\''");
  return `#!/bin/sh\n# ${LAUNCHER_MARKER}\nexec '${quote(node)}' '${quote(entry)}' "$@"\n`;
}

function assertLauncherOwnership() {
  if (existsSync(CLAUDE_LAUNCHER_PATH) && !readFileSync(CLAUDE_LAUNCHER_PATH, "utf8").includes(LAUNCHER_MARKER)) {
    throw new Error(`${CLAUDE_LAUNCHER_PATH} already exists and is not owned by codex-router; refusing to replace it.`);
  }
}

export function claudeCodeProbe({ environment = process.env } = {}) {
  const command = environment.CLAUDE_CODE_BIN || commandOnPath(process.platform === "win32" ? "claude.cmd" : "claude");
  if (!command) return { available: false, command: "claude", version: null };
  const spawnable = spawnableCommand(command, ["--version"]);
  const result = spawnSync(spawnable.command, spawnable.args, {
    ...spawnable.options,
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
  });
  return {
    available: result.status === 0,
    command,
    version: result.status === 0 ? String(result.stdout || result.stderr || "").trim() : null,
  };
}

export function claudeDefaultModel(models) {
  return [...models].sort((a, b) =>
    (b.priority ?? 0) - (a.priority ?? 0) || String(a.slug).localeCompare(String(b.slug)))[0];
}

export function publishClaudeIntegration({ routedModels = routedClientModels, probe = claudeCodeProbe } = {}) {
  assertStateOwnership("publish the Claude Code integration");
  const claude = probe();
  if (!claude.available) throw new Error("Claude Code is unavailable. Install the official `claude` CLI first.");
  const { models, engine } = routedModels();
  if (!models.length) throw new Error("No selected, credentialed models are available to publish to Claude Code.");
  assertLauncherOwnership();
  mkdirSync(path.dirname(CLAUDE_LAUNCHER_PATH), { recursive: true, mode: 0o700 });
  writePrivateFile(CLAUDE_LAUNCHER_PATH, launcherContents());
  if (process.platform !== "win32") chmodSync(CLAUDE_LAUNCHER_PATH, 0o700);
  const baseUrl = claudeBaseUrl(PORTS.router, secret());
  const published = models.map((model) => ({
    slug: String(model.slug),
    id: claudeModelId(model.slug),
    displayName: model.displayName || model.display_name || String(model.slug),
  }));
  const defaultModel = claudeModelId(claudeDefaultModel(models).slug);
  writePrivateJson(CLAUDE_CATALOG_PATH, {
    updatedAt: new Date().toISOString(),
    baseUrl,
    defaultModel,
    models: published,
  });
  return { claude, launcher: CLAUDE_LAUNCHER_PATH, models: published, engine, defaultModel, baseUrl: redactCallerUrl(baseUrl) };
}

function readCatalog() {
  try { return JSON.parse(readFileSync(CLAUDE_CATALOG_PATH, "utf8")); } catch { return undefined; }
}

export function removeClaudeIntegration() {
  assertStateOwnership("remove the Claude Code integration");
  if (existsSync(CLAUDE_LAUNCHER_PATH)) {
    assertLauncherOwnership();
    unlinkSync(CLAUDE_LAUNCHER_PATH);
  }
  if (existsSync(CLAUDE_CATALOG_PATH)) unlinkSync(CLAUDE_CATALOG_PATH);
  return { removed: true };
}

export function claudeIntegrationStatus() {
  const catalog = readCatalog();
  const launcherOwned = existsSync(CLAUDE_LAUNCHER_PATH) &&
    readFileSync(CLAUDE_LAUNCHER_PATH, "utf8").includes(LAUNCHER_MARKER);
  return {
    installed: Boolean(catalog && launcherOwned),
    launcher: CLAUDE_LAUNCHER_PATH,
    launcherOwned,
    claude: claudeCodeProbe(),
    baseUrl: catalog?.baseUrl ? redactCallerUrl(catalog.baseUrl) : null,
    baseUrlManaged: catalog?.baseUrl ? isManagedClaudeBaseUrl(catalog.baseUrl, PORTS.router) : false,
    defaultModel: catalog?.defaultModel || null,
    publishedModels: Array.isArray(catalog?.models) ? catalog.models : [],
    updatedAt: catalog?.updatedAt || null,
  };
}

export function claudeCatalogDrift({ routedModels = routedClientModels } = {}) {
  if (!existsSync(CLAUDE_CATALOG_PATH)) return undefined;
  const published = new Set(claudeIntegrationStatus().publishedModels.map((model) => model.slug));
  const routable = new Set(routedModels().models.map((model) => String(model.slug)));
  return {
    missing: [...published].filter((slug) => !routable.has(slug)),
    added: [...routable].filter((slug) => !published.has(slug)),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] || "status";
  const handlers = {
    install: () => publishClaudeIntegration(),
    status: () => claudeIntegrationStatus(),
    uninstall: () => removeClaudeIntegration(),
    drift: () => claudeCatalogDrift() || { installed: false },
  };
  if (!handlers[command]) {
    console.error("Usage: claude-code-config-manager install|status|uninstall|drift");
    process.exit(2);
  }
  try { process.stdout.write(`${JSON.stringify(handlers[command](), null, 2)}\n`); }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
