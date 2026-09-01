import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CURSOR_TUNNEL_CONFIG_PATH,
  CURSOR_TUNNEL_STATE_PATH,
  PORTS,
} from "./paths.mjs";
import { writePrivateFile, writePrivateJson } from "./file-security.mjs";
import { spawnableCommand } from "./spawnable-command.mjs";

function readJson(target) {
  if (!existsSync(target)) return undefined;
  try { return JSON.parse(readFileSync(target, "utf8")); } catch { return undefined; }
}

export function cursorTunnelHostname(value) {
  const raw = String(value || "").trim().toLowerCase().replace(/\.$/, "");
  if (!raw || raw.length > 253 || raw.includes(":") || raw.includes("/")) {
    throw new Error("Enter a public hostname such as cursor-router.example.com, without https:// or a path.");
  }
  const labels = raw.split(".");
  if (
    labels.length < 2 ||
    labels.some((label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
  ) {
    throw new Error("Enter a valid public hostname such as cursor-router.example.com.");
  }
  return raw;
}

function executableCandidates(environment = process.env) {
  const executable = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
  return [
    environment.MODEL_ROUTER_CLOUDFLARED_BIN,
    ...String(environment.PATH || "").split(path.delimiter).filter(Boolean).map((entry) => path.join(entry, executable)),
    "/opt/homebrew/bin/cloudflared",
    "/usr/local/bin/cloudflared",
    "/usr/bin/cloudflared",
    process.platform === "win32" && environment.ProgramFiles
      ? path.join(environment.ProgramFiles, "cloudflared", "cloudflared.exe")
      : undefined,
  ].filter(Boolean);
}

export function findCloudflared({ environment = process.env, exists = existsSync } = {}) {
  return executableCandidates(environment).find((candidate) => path.isAbsolute(candidate) && exists(candidate));
}

export function cloudflaredHome(environment = process.env) {
  return environment.MODEL_ROUTER_CLOUDFLARED_HOME || path.join(os.homedir(), ".cloudflared");
}

function originCertificate(environment = process.env) {
  return environment.TUNNEL_ORIGIN_CERT || path.join(cloudflaredHome(environment), "cert.pem");
}

function originCertificateCredential(contents) {
  const matches = [...String(contents || "").matchAll(
    /-----BEGIN ARGO TUNNEL TOKEN-----\s*([A-Za-z0-9+/=\s]+?)\s*-----END ARGO TUNNEL TOKEN-----/g,
  )];
  if (matches.length !== 1) {
    throw new Error("Cloudflare authorization is unreadable; sign in again or use an existing hostname.");
  }
  let value;
  try {
    value = JSON.parse(Buffer.from(matches[0][1].replace(/\s+/g, ""), "base64").toString("utf8"));
  } catch {
    throw new Error("Cloudflare authorization is unreadable; sign in again or use an existing hostname.");
  }
  if (
    !/^[0-9a-f]{32}$/i.test(value?.zoneID || "") ||
    typeof value?.accountID !== "string" || !value.accountID ||
    typeof value?.apiToken !== "string" || !value.apiToken || value.apiToken.length > 16 * 1024
  ) {
    throw new Error("Cloudflare authorization does not identify a usable domain; add a domain to Cloudflare or use an existing hostname.");
  }
  if (value.endpoint && value.endpoint !== "fed") {
    throw new Error("This Cloudflare authorization endpoint needs an existing hostname.");
  }
  return value;
}

export async function discoverCursorTunnelHostname({
  environment = process.env,
  read = readFileSync,
  fetchImpl = globalThis.fetch,
  hostname = os.hostname(),
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("Cloudflare domain discovery is unavailable; use an existing hostname.");
  }
  const certificate = originCertificateCredential(read(originCertificate(environment), "utf8"));
  const apiOrigin = certificate.endpoint === "fed"
    ? "https://api.fed.cloudflare.com"
    : "https://api.cloudflare.com";
  let response;
  try {
    response = await fetchImpl(`${apiOrigin}/client/v4/zones/${certificate.zoneID}`, {
      headers: { Authorization: `Bearer ${certificate.apiToken}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("Could not resolve the Cloudflare domain; check your connection or use an existing hostname.");
  }
  let payload;
  try { payload = await response.json(); } catch {}
  if (!response.ok || payload?.success !== true) {
    throw new Error("Cloudflare did not allow domain discovery; sign in again or use an existing hostname.");
  }
  const zone = cursorTunnelHostname(payload?.result?.name);
  const device = createHash("sha256")
    .update(`${certificate.accountID}:${certificate.zoneID}:${hostname}`)
    .digest("hex")
    .slice(0, 8);
  return `codex-router-${device}.${zone}`;
}

function commandResult(binary, args, { runner = spawnSync, environment = process.env } = {}) {
  const spawnable = spawnableCommand(binary, args);
  const result = runner(spawnable.command, spawnable.args, {
    encoding: "utf8",
    env: environment,
    windowsHide: true,
    timeout: 120_000,
    ...spawnable.options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout || `cloudflared ${args.join(" ")} failed`).trim());
  }
  return String(result.stdout || "").trim();
}

function tunnelIdFromCreateOutput(output) {
  try {
    const parsed = JSON.parse(output);
    const value = parsed.id || parsed.ID || parsed.uuid || parsed.tunnel_id;
    if (typeof value === "string" && /^[0-9a-f-]{32,36}$/i.test(value)) return value;
  } catch {}
  const match = output.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
  if (match) return match[0];
  throw new Error("cloudflared created a tunnel but did not return its tunnel ID.");
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

function tunnelConfig({ id, hostname, credentialsFile }) {
  return [
    `tunnel: ${yamlString(id)}`,
    `credentials-file: ${yamlString(credentialsFile)}`,
    "ingress:",
    `  - hostname: ${yamlString(hostname)}`,
    `    service: ${yamlString(`http://127.0.0.1:${PORTS.cursorPublic}`)}`,
    "  - service: http_status:404",
    "",
  ].join("\n");
}

export function cursorTunnelStatus({ environment = process.env, exists = existsSync } = {}) {
  const state = readJson(CURSOR_TUNNEL_STATE_PATH);
  const binary = findCloudflared({ environment, exists });
  const loggedIn = exists(originCertificate(environment));
  const validState = Boolean(
    state?.version === 1 && state?.provider === "cloudflare" && state?.id && state?.hostname &&
    state?.credentialsFile && exists(CURSOR_TUNNEL_CONFIG_PATH) && exists(state.credentialsFile),
  );
  return {
    provider: "cloudflare",
    binaryInstalled: Boolean(binary),
    binary: binary || null,
    loggedIn,
    configured: validState,
    // Login is needed to create or change a tunnel. An existing connector uses
    // its tunnel credential directly and remains runnable if cert.pem is later
    // removed from this machine.
    ready: Boolean(binary && validState),
    hostname: validState ? state.hostname : null,
    origin: validState ? `https://${state.hostname}` : null,
    nextAction: !binary ? "install-cloudflared" : validState ? "ready" : !loggedIn ? "login" : "choose-hostname",
  };
}

export function provisionCursorTunnel({
  hostname,
  environment = process.env,
  exists = existsSync,
  runner = spawnSync,
} = {}) {
  const selectedHostname = cursorTunnelHostname(hostname);
  const existing = readJson(CURSOR_TUNNEL_STATE_PATH);
  if (exists(CURSOR_TUNNEL_STATE_PATH) && !existing) {
    throw new Error("The saved Cursor tunnel state is unreadable; refusing to create a second tunnel over it.");
  }
  if (existing) {
    if (existing.hostname !== selectedHostname) {
      throw new Error(
        `Cursor is already connected through ${existing.hostname}. Remove that managed tunnel configuration before choosing another hostname.`,
      );
    }
    const binary = findCloudflared({ environment, exists });
    if (!binary) throw new Error("cloudflared is unavailable; reinstall it and retry Cursor setup.");
    if (!existing.id || !existing.credentialsFile || !exists(existing.credentialsFile)) {
      throw new Error("The saved Cursor tunnel credential is missing; refusing to replace it or create a second tunnel.");
    }
    if (!exists(CURSOR_TUNNEL_CONFIG_PATH)) {
      writePrivateFile(CURSOR_TUNNEL_CONFIG_PATH, tunnelConfig({
        id: existing.id,
        hostname: selectedHostname,
        credentialsFile: existing.credentialsFile,
      }));
    }
    return { ...existing, origin: `https://${existing.hostname}`, created: false };
  }

  const binary = findCloudflared({ environment, exists });
  if (!binary) {
    throw new Error(
      "cloudflared is not installed. Install Cloudflare Tunnel, then run `cloudflared tunnel login` once and retry Cursor setup.",
    );
  }
  if (!exists(originCertificate(environment))) {
    throw new Error(
      "Cloudflare Tunnel is not signed in. Run `cloudflared tunnel login` once, choose the domain that owns this hostname, then retry.",
    );
  }

  const suffix = createHash("sha256").update(selectedHostname).digest("hex").slice(0, 10);
  const name = `codex-router-cursor-${suffix}`;
  let id;
  try {
    id = tunnelIdFromCreateOutput(commandResult(binary, ["tunnel", "create", "--output", "json", name], { runner, environment }));
    const credentialsFile = path.join(cloudflaredHome(environment), `${id}.json`);
    if (!exists(credentialsFile)) {
      throw new Error(`cloudflared did not write the tunnel credential at ${credentialsFile}.`);
    }
    commandResult(binary, ["tunnel", "route", "dns", id, selectedHostname], { runner, environment });
    writePrivateFile(CURSOR_TUNNEL_CONFIG_PATH, tunnelConfig({ id, hostname: selectedHostname, credentialsFile }));
    const state = {
      version: 1,
      provider: "cloudflare",
      id,
      name,
      hostname: selectedHostname,
      credentialsFile,
      configFile: CURSOR_TUNNEL_CONFIG_PATH,
      binary,
      createdAt: new Date().toISOString(),
    };
    writePrivateJson(CURSOR_TUNNEL_STATE_PATH, state);
    return { ...state, origin: `https://${selectedHostname}`, created: true };
  } catch (error) {
    if (existsSync(CURSOR_TUNNEL_CONFIG_PATH)) unlinkSync(CURSOR_TUNNEL_CONFIG_PATH);
    if (existsSync(CURSOR_TUNNEL_STATE_PATH)) unlinkSync(CURSOR_TUNNEL_STATE_PATH);
    if (id) {
      try { commandResult(binary, ["tunnel", "delete", "--force", id], { runner, environment }); } catch {}
    }
    throw error;
  }
}

export function cursorTunnelRunSpec({ environment = process.env, exists = existsSync } = {}) {
  const status = cursorTunnelStatus({ environment, exists });
  if (!status.ready) return undefined;
  const state = readJson(CURSOR_TUNNEL_STATE_PATH);
  return {
    command: status.binary,
    args: ["tunnel", "--config", CURSOR_TUNNEL_CONFIG_PATH, "run", state.id],
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] || "status";
  try {
    const result = command === "status"
      ? cursorTunnelStatus()
      : command === "setup"
        ? provisionCursorTunnel({ hostname: process.argv[3] })
        : command === "run-spec"
          ? cursorTunnelRunSpec()
          : undefined;
    if (!result) throw Object.assign(new Error("Usage: cursor-cloudflare-tunnel status|setup HOSTNAME|run-spec"), { usage: true });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error?.usage ? 2 : 1;
  }
}
