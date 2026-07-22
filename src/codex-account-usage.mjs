import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import readline from "node:readline";

const DEFAULT_TIMEOUT_MS = 10_000;
const APP_CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex";

function codexBinary() {
  if (process.env.CODEX_BINARY) return process.env.CODEX_BINARY;
  if (existsSync(APP_CODEX)) return APP_CODEX;
  return "codex";
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

function normalizeWindow(window) {
  if (!window || typeof window !== "object") return null;
  const usedPercent = clampPercent(window.usedPercent);
  return {
    usedPercent,
    remainingPercent: 100 - usedPercent,
    windowDurationMins: Number.isFinite(window.windowDurationMins)
      ? window.windowDurationMins
      : null,
    resetsAt: Number.isFinite(window.resetsAt) ? window.resetsAt : null,
  };
}

export function normalizeCodexAccountUsage(rateLimitResponse, usageResponse, now = new Date()) {
  const buckets = Array.isArray(usageResponse?.dailyUsageBuckets)
    ? usageResponse.dailyUsageBuckets
        .filter(
          (bucket) =>
            typeof bucket?.startDate === "string" &&
            /^\d{4}-\d{2}-\d{2}$/.test(bucket.startDate) &&
            Number.isFinite(bucket.tokens),
        )
        .map((bucket) => ({
          startDate: bucket.startDate,
          tokens: Math.max(0, Math.trunc(bucket.tokens)),
        }))
        .sort((left, right) => left.startDate.localeCompare(right.startDate))
    : [];
  const limits = rateLimitResponse?.rateLimits || {};
  const summary = usageResponse?.summary || {};
  return {
    fetchedAt: now.toISOString(),
    planType: typeof limits.planType === "string" ? limits.planType : null,
    limitId: typeof limits.limitId === "string" ? limits.limitId : null,
    primary: normalizeWindow(limits.primary),
    secondary: normalizeWindow(limits.secondary),
    dailyUsageBuckets: buckets,
    summary: {
      lifetimeTokens: Number.isFinite(summary.lifetimeTokens) ? summary.lifetimeTokens : null,
      peakDailyTokens: Number.isFinite(summary.peakDailyTokens) ? summary.peakDailyTokens : null,
      currentStreakDays: Number.isFinite(summary.currentStreakDays)
        ? summary.currentStreakDays
        : null,
    },
  };
}

export function readCodexAccountUsage({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const processHandle = spawn(codexBinary(), ["app-server"], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    const lines = readline.createInterface({ input: processHandle.stdout });
    const responses = new Map();
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      processHandle.kill();
      if (error) reject(error);
      else resolve(value);
    };
    const send = (message) => {
      processHandle.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const timer = setTimeout(
      () => finish(new Error("Codex account usage request timed out.")),
      timeoutMs,
    );

    processHandle.once("error", () => {
      finish(new Error("The Codex app-server could not be started."));
    });
    processHandle.once("exit", (code) => {
      if (!settled) finish(new Error(`Codex app-server exited before replying (${code ?? "signal"}).`));
    });
    lines.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id === 1) {
        if (message.error) {
          finish(new Error("Codex app-server initialization failed."));
          return;
        }
        send({ method: "initialized", params: {} });
        send({ id: 2, method: "account/rateLimits/read", params: null });
        send({ id: 3, method: "account/usage/read", params: null });
        return;
      }
      if (message.id !== 2 && message.id !== 3) return;
      if (message.error) {
        if (message.id === 2) {
          finish(new Error("Codex account limits are unavailable for this login."));
          return;
        }
        responses.set(3, { summary: {}, dailyUsageBuckets: [] });
      } else {
        responses.set(message.id, message.result);
      }
      if (responses.size === 2) {
        finish(undefined, normalizeCodexAccountUsage(responses.get(2), responses.get(3)));
      }
    });

    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: {
          name: "codex_router_tray",
          title: "Model Router Tray",
          version: "0.4.0",
        },
        capabilities: { experimentalApi: true },
      },
    });
  });
}
