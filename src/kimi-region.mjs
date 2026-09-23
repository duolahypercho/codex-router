import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { scanTomlDocument, tomlStringValue } from "./toml-structure.mjs";

// Kimi Code runs two deployments with separate accounts: mainland China on
// kimi.com and the global site on kimi.ai. The official CLI records which one
// a login belongs to in `<KIMI_CODE_HOME>/config.toml`
// (`providers."managed:kimi-code"`: `base_url` plus `oauth.key`/`oauth.oauth_host`)
// and stores a non-default login under a host-scoped credential file, so the
// router resolves the same environment instead of assuming kimi.com.
export const KIMI_REGION_PROFILES = Object.freeze({
  "mainland-cn": Object.freeze({
    ssoHost: "https://auth.kimi.com",
    apiBase: "https://api.kimi.com/coding/v1",
    siteBase: "https://www.kimi.com",
  }),
  global: Object.freeze({
    ssoHost: "https://auth.kimi.ai",
    apiBase: "https://api.kimi.ai/coding/v1",
    siteBase: "https://www.kimi.ai",
  }),
});

const DEFAULT_REGION = "mainland-cn";
const DEFAULT_CREDENTIAL_NAME = "kimi-code";
const SCOPED_CREDENTIAL_PREFIX = "kimi-code-env-";
const PROVIDER_TABLE = ["providers", "managed:kimi-code"];
const OAUTH_TABLE = [...PROVIDER_TABLE, "oauth"];
const SSO_HOST_KEYS = ["oauth_host", "oauthHost"];

function trimEndpoint(value) {
  return String(value).trim().replace(/\/+$/, "");
}

function regionForSsoHost(ssoHost) {
  const normalized = trimEndpoint(ssoHost);
  return Object.keys(KIMI_REGION_PROFILES).find(
    (region) => KIMI_REGION_PROFILES[region].ssoHost === normalized,
  );
}

export function kimiCodeHome(env = process.env) {
  return env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code");
}

function configuredProvider(home) {
  const file = path.join(home, "config.toml");
  if (!existsSync(file)) return {};
  try {
    const document = scanTomlDocument(readFileSync(file, "utf8"));
    // The CLI writes snake_case and also accepts hand-written camelCase.
    const value = (tablePath, ...keys) => {
      for (const key of keys) {
        const found = tomlStringValue(document, tablePath, key);
        if (typeof found === "string" && found.trim()) return found;
      }
      return undefined;
    };
    return {
      baseUrl: value(PROVIDER_TABLE, "base_url", "baseUrl"),
      oauthKey: value(OAUTH_TABLE, "key"),
      ssoHost: value(OAUTH_TABLE, ...SSO_HOST_KEYS),
    };
  } catch {
    // A config the structural scanner refuses is left to the official CLI;
    // the router falls back to the region marker and defaults.
    return {};
  }
}

function regionMarker(home) {
  try {
    const value = readFileSync(path.join(home, "region"), "utf8").trim();
    return Object.hasOwn(KIMI_REGION_PROFILES, value) ? value : undefined;
  } catch {
    return undefined;
  }
}

// Mirrors the official CLI's credential slot: the default hosts share
// `kimi-code.json`; any other (oauth_host, base_url) pair gets a hashed name.
function credentialName(oauthKey, ssoHost, apiBase) {
  if (typeof oauthKey === "string" && oauthKey) {
    if (oauthKey === "oauth/kimi-code" || oauthKey === DEFAULT_CREDENTIAL_NAME) {
      return DEFAULT_CREDENTIAL_NAME;
    }
    const name = oauthKey.startsWith("oauth/") ? oauthKey.slice("oauth/".length) : oauthKey;
    if (name && !name.includes("/") && !name.includes("\\") && !name.startsWith(".")) {
      return name;
    }
  }
  const defaults = KIMI_REGION_PROFILES[DEFAULT_REGION];
  if (ssoHost === defaults.ssoHost && apiBase === defaults.apiBase) {
    return DEFAULT_CREDENTIAL_NAME;
  }
  const digest = createHash("sha256")
    .update(JSON.stringify({ oauthHost: ssoHost, baseUrl: apiBase }))
    .digest("hex")
    .slice(0, 16);
  return `${SCOPED_CREDENTIAL_PREFIX}${digest}`;
}

// Resolution order matches the official CLI: environment overrides, then the
// persisted login in config.toml, then the install-channel region marker,
// then mainland China. The credential slot always follows the login the CLI
// recorded; router-side endpoint overrides only redirect the requests.
export function resolveKimiCodeEnvironment(env = process.env) {
  const home = kimiCodeHome(env);
  const envSsoHost = env.KIMI_CODE_OAUTH_HOST || env.KIMI_OAUTH_HOST;
  const envBaseUrl = env.KIMI_CODE_BASE_URL;
  const configured = configuredProvider(home);

  let region;
  if (envSsoHost) {
    region = regionForSsoHost(envSsoHost) || DEFAULT_REGION;
  } else if (configured.ssoHost && regionForSsoHost(configured.ssoHost)) {
    region = regionForSsoHost(configured.ssoHost);
  } else if (configured.oauthKey === "oauth/kimi-code") {
    region = DEFAULT_REGION;
  } else {
    region = regionMarker(home) || DEFAULT_REGION;
  }
  const profile = KIMI_REGION_PROFILES[region];

  const loginSsoHost = trimEndpoint(configured.ssoHost || profile.ssoHost);
  const loginApiBase = trimEndpoint(configured.baseUrl || profile.apiBase);
  const name = credentialName(configured.oauthKey, loginSsoHost, loginApiBase);
  return {
    region,
    oauthHost: trimEndpoint(envSsoHost || loginSsoHost),
    apiBase: trimEndpoint(envBaseUrl || loginApiBase),
    siteBase: profile.siteBase,
    home,
    credentialsPath: path.join(home, "credentials", `${name}.json`),
  };
}
