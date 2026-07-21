import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { grokOAuthStatus, grokSessionEntry } from "./grok-oauth-status.mjs";
import { kimiOAuthStatus } from "./oauth-status.mjs";
import { PROVIDERS } from "./model-registry.mjs";
import { resolveProviderCredential } from "./provider-credentials.mjs";
import { VERSION } from "./version.mjs";

const REQUEST_TIMEOUT_MS = 8_000;

function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function resetTimestamp(value) {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds / 1_000 : undefined;
}

function quotaMetric(label, detail) {
  const limit = numberValue(detail?.limit);
  const used = numberValue(detail?.used);
  const remaining = numberValue(detail?.remaining);
  if (!Number.isFinite(limit) || limit <= 0) return undefined;
  const resolvedUsed = Number.isFinite(used)
    ? used
    : Number.isFinite(remaining)
      ? Math.max(0, limit - remaining)
      : undefined;
  if (!Number.isFinite(resolvedUsed)) return undefined;
  const usedPercent = Math.max(0, Math.min(100, (resolvedUsed / limit) * 100));
  return {
    kind: "quota",
    label,
    usedPercent,
    remainingPercent: 100 - usedPercent,
    used: resolvedUsed,
    limit,
    remaining: Number.isFinite(remaining) ? remaining : Math.max(0, limit - resolvedUsed),
    unit: "requests",
    ...(resetTimestamp(detail?.resetTime ?? detail?.reset_time ?? detail?.resetAt) !== undefined
      ? { resetAt: resetTimestamp(detail?.resetTime ?? detail?.reset_time ?? detail?.resetAt) }
      : {}),
  };
}

export function kimiQuotaMetrics(payload) {
  const weekly = payload?.usage || payload?.usages?.find((entry) => entry?.scope === "FEATURE_CODING")?.detail;
  const limits = payload?.limits ||
    payload?.usages?.find((entry) => entry?.scope === "FEATURE_CODING")?.limits;
  return [
    quotaMetric("Weekly quota", weekly),
    quotaMetric("5-hour limit", limits?.[0]?.detail),
  ].filter(Boolean);
}

export function deepSeekBalanceMetrics(payload) {
  if (!Array.isArray(payload?.balance_infos)) return [];
  const preferred = payload.balance_infos.find((entry) => entry?.currency === "USD") ||
    payload.balance_infos[0];
  const value = numberValue(preferred?.total_balance);
  if (!preferred || !Number.isFinite(value)) return [];
  const paid = numberValue(preferred.topped_up_balance);
  const granted = numberValue(preferred.granted_balance);
  return [{
    kind: "balance",
    label: "API balance",
    value,
    currency: preferred.currency || "USD",
    detail: [
      Number.isFinite(paid) ? `Paid ${paid.toFixed(2)}` : undefined,
      Number.isFinite(granted) ? `Granted ${granted.toFixed(2)}` : undefined,
    ].filter(Boolean).join(" · "),
    available: payload.is_available !== false,
  }];
}

export function kimiApiBalanceMetrics(payload, currency = "USD") {
  const data = payload?.data;
  const value = numberValue(data?.available_balance);
  if (!data || !Number.isFinite(value)) return [];
  const cash = numberValue(data.cash_balance);
  const voucher = numberValue(data.voucher_balance);
  return [{
    kind: "balance",
    label: "API balance",
    value,
    currency,
    detail: [
      Number.isFinite(cash) ? `Cash ${cash.toFixed(2)}` : undefined,
      Number.isFinite(voucher) ? `Voucher ${voucher.toFixed(2)}` : undefined,
    ].filter(Boolean).join(" · "),
    available: payload.status !== false && (payload.code === undefined || payload.code === 0),
  }];
}


export function grokCreditsMetrics(payload) {
  const config = payload?.config;
  if (!config || typeof config !== "object") return [];

  const metrics = [];
  const usagePct = numberValue(config.creditUsagePercent ?? config.credit_usage_percent);
  const period = config.currentPeriod || config.current_period || {};
  const periodType = String(period.type || period.period_type || "");
  const periodEnd = period.end || config.billingPeriodEnd || config.billing_period_end;
  const label = periodType.includes("WEEKLY")
    ? "Weekly limit"
    : periodType.includes("MONTHLY")
      ? "Monthly limit"
      : "Usage limit";

  if (Number.isFinite(usagePct)) {
    const usedPercent = Math.max(0, Math.min(100, usagePct));
    metrics.push({
      kind: "quota",
      label,
      usedPercent,
      remainingPercent: 100 - usedPercent,
      used: usedPercent,
      limit: 100,
      remaining: Math.max(0, 100 - usedPercent),
      unit: "percent",
      ...(resetTimestamp(periodEnd) !== undefined ? { resetAt: resetTimestamp(periodEnd) } : {}),
    });
  }

  const prepaidRaw = numberValue(
    config.prepaidBalance?.val ??
      config.prepaid_balance?.val ??
      config.prepaidBalance ??
      config.prepaid_balance,
  );
  if (Number.isFinite(prepaidRaw) && Math.abs(prepaidRaw) > 0) {
    metrics.push({
      kind: "balance",
      label: "Prepaid credits",
      value: Math.abs(prepaidRaw) / 100,
      currency: "USD",
      detail: "Purchased credits remaining",
      available: true,
    });
  }

  const onDemandCap = numberValue(
    config.onDemandCap?.val ?? config.on_demand_cap?.val ?? config.onDemandCap ?? config.on_demand_cap,
  );
  const onDemandUsed = numberValue(
    config.onDemandUsed?.val ?? config.on_demand_used?.val ?? config.onDemandUsed ?? config.on_demand_used,
  );
  if (Number.isFinite(onDemandCap) && Math.abs(onDemandCap) > 0) {
    const cap = Math.abs(onDemandCap) / 100;
    const used = Number.isFinite(onDemandUsed) ? Math.abs(onDemandUsed) / 100 : 0;
    metrics.push({
      kind: "balance",
      label: "Pay-as-you-go",
      value: Math.max(0, cap - used),
      currency: "USD",
      detail: `$${used.toFixed(2)} used of $${cap.toFixed(2)} limit`,
      available: true,
    });
  }

  return metrics;
}

async function requestJson(url, key, headers = {}, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${key}`,
      ...headers,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function deepSeekAccount(fetchImpl) {
  const credential = resolveProviderCredential("deepseek");
  if (!credential) return { status: "not-configured", source: "official-api", metrics: [] };
  const configuredBase = process.env.DEEPSEEK_API_BASE_URL?.trim();
  if (configuredBase && new URL(configuredBase).origin !== "https://api.deepseek.com") {
    return localOnly("Account balance is unavailable for a custom DeepSeek endpoint");
  }
  const payload = await requestJson(
    "https://api.deepseek.com/user/balance",
    credential.value,
    {},
    fetchImpl,
  );
  const metrics = deepSeekBalanceMetrics(payload);
  if (!metrics.length) throw new Error("balance response did not include a usable currency");
  return { status: "available", source: "official-api", metrics };
}

async function kimiApiAccount(fetchImpl) {
  const provider = PROVIDERS.get("kimi-api");
  const credential = resolveProviderCredential(provider);
  if (!credential) return { status: "not-configured", source: "official-api", metrics: [] };
  const baseURL = (process.env[provider.baseUrlEnv] || provider.baseUrl).replace(/\/+$/, "");
  const host = new URL(baseURL).hostname;
  if (!new Set(["api.moonshot.ai", "api.moonshot.cn"]).has(host)) {
    return localOnly("Account balance is unavailable for a custom Kimi API endpoint");
  }
  const payload = await requestJson(`${baseURL}/users/me/balance`, credential.value, {}, fetchImpl);
  const currency = baseURL.includes("moonshot.cn") ? "CNY" : "USD";
  const metrics = kimiApiBalanceMetrics(payload, currency);
  if (!metrics.length) throw new Error("balance response was incomplete");
  return { status: "available", source: "official-api", metrics };
}

function asciiHeader(value, fallback) {
  const cleaned = String(value || "").replace(/[^\u0020-\u007e]/g, "").trim();
  return cleaned || fallback;
}

async function kimiOAuthAccount(fetchImpl) {
  const status = kimiOAuthStatus();
  if (!status.configured) return { status: "not-configured", source: "official-api", metrics: [] };
  const credential = JSON.parse(readFileSync(status.credentialsPath, "utf8"));
  const accessToken = typeof credential.access_token === "string" ? credential.access_token : "";
  if (!accessToken) throw new Error("Kimi CLI session is incomplete");
  const expiresAt = numberValue(credential.expires_at);
  if (Number.isFinite(expiresAt) && expiresAt <= Date.now() / 1_000) {
    throw new Error("Kimi CLI session has expired; run `kimi login`");
  }
  const home = path.dirname(path.dirname(status.credentialsPath));
  const devicePath = path.join(home, "device_id");
  const deviceId = existsSync(devicePath) ? readFileSync(devicePath, "utf8").trim() : "";
  const payload = await requestJson(
    "https://api.kimi.com/coding/v1/usages",
    accessToken,
    {
      "User-Agent": `codex-router/${VERSION}`,
      "X-Msh-Platform": "codex",
      "X-Msh-Version": VERSION,
      "X-Msh-Device-Name": asciiHeader(os.hostname(), "Mac"),
      "X-Msh-Device-Model": asciiHeader(`${os.type()} ${os.arch()}`, "Mac"),
      "X-Msh-Os-Version": asciiHeader(os.release(), "unknown"),
      ...(deviceId ? { "X-Msh-Device-Id": asciiHeader(deviceId, "unknown") } : {}),
    },
    fetchImpl,
  );
  const metrics = kimiQuotaMetrics(payload);
  if (!metrics.length) throw new Error("quota response was incomplete");
  return { status: "available", source: "official-api", metrics };
}


async function grokOAuthAccount(fetchImpl) {
  const status = grokOAuthStatus();
  if (!status.configured) {
    return { status: "not-configured", source: "official-cli", metrics: [] };
  }

  let auth;
  try {
    auth = JSON.parse(readFileSync(status.authPath, "utf8"));
  } catch {
    throw new Error("Grok CLI session file is invalid; run `grok login --oauth`");
  }
  const session = grokSessionEntry(auth);
  const accessToken = typeof session?.key === "string" ? session.key : "";
  if (!accessToken) throw new Error("Grok CLI session is incomplete; run `grok login --oauth`");

  const expiresAt = Date.parse(session.expires_at || "");
  if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
    throw new Error("Grok CLI session has expired; run `grok login --oauth`");
  }

  const baseURL = (
    process.env.GROK_CLI_CHAT_PROXY_BASE_URL || "https://cli-chat-proxy.grok.com/v1"
  ).replace(/\/+$/, "");
  const host = new URL(baseURL).hostname;
  if (host !== "cli-chat-proxy.grok.com") {
    return localOnly("Account billing is unavailable for a custom Grok proxy endpoint");
  }

  const payload = await requestJson(
    `${baseURL}/billing?format=credits`,
    accessToken,
    {
      "X-XAI-Token-Auth": "xai-grok-cli",
      ...(typeof session.user_id === "string" && session.user_id
        ? { "x-userid": session.user_id }
        : {}),
      "x-grok-client-version": VERSION,
      "x-grok-client-mode": "headless",
      "User-Agent": `codex-router/${VERSION}`,
    },
    fetchImpl,
  );
  const metrics = grokCreditsMetrics(payload);
  if (!metrics.length) throw new Error("Grok billing response was incomplete");
  return { status: "available", source: "official-cli", metrics };
}

function localOnly(message) {
  return { status: "local-only", source: "local-router", metrics: [], message };
}

async function accountUsageFor(providerId, fetchImpl) {
  try {
    if (providerId === "deepseek") return await deepSeekAccount(fetchImpl);
    if (providerId === "kimi-api") return await kimiApiAccount(fetchImpl);
    if (providerId === "kimi-oauth") return await kimiOAuthAccount(fetchImpl);
    if (providerId === "grok-oauth") return await grokOAuthAccount(fetchImpl);
    if (providerId === "grok-api") {
      return resolveProviderCredential("grok-api")
        ? localOnly("xAI API account balance is unavailable; showing router traffic")
        : { status: "not-configured", source: "official-api", metrics: [] };
    }
    return localOnly("Showing router traffic");
  } catch (error) {
    return {
      status: "unavailable",
      source: "official-api",
      metrics: [],
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function providerAccountUsageSnapshot({
  fetchImpl = fetch,
  providerIds = [...PROVIDERS.keys()],
} = {}) {
  const enabled = new Set(providerIds);
  const entries = await Promise.all(
    [...PROVIDERS.keys()].map(async (id) => [
      id,
      enabled.has(id)
        ? await accountUsageFor(id, fetchImpl)
        : { status: "disabled", source: "none", metrics: [] },
    ]),
  );
  return Object.fromEntries(entries);
}
