import { execFileSync, spawn } from "node:child_process";
import readline from "node:readline";

import { findCodexBinary } from "./codex-binary.mjs";
import { discoveryDisabled } from "./discovery-mode.mjs";
import { spawnableCommand } from "./spawnable-command.mjs";

const DEFAULT_TIMEOUT_MS = 10_000;

// This used to keep its own two-line search -- an undocumented CODEX_BINARY
// override, a hardcoded macOS app path, then the bare name "codex". None of
// the three finds a Windows install: the bundled Desktop CLI lives under a
// version-hashed %LOCALAPPDATA% directory, and a bare "codex" resolves to the
// extensionless npm shim that Node cannot spawn. The panel reported "the Codex
// app-server could not be started" on every Windows machine. Use the same
// discovery the rest of the router uses, and keep CODEX_BINARY working for
// anyone who set it.
function codexBinary() {
  return process.env.CODEX_BINARY || findCodexBinary();
}

// Killing a child that was reached through cmd.exe kills the shell, not the
// app-server behind it. On a timeout that left a Codex process holding the
// pipe for as long as the session lived, once per poll.
function killProcessTree(child, viaShell) {
  if (!viaShell || process.platform !== "win32" || !child.pid) {
    child.kill();
    return;
  }
  try {
    execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } catch {
    child.kill();
  }
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

function optionalTokenCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : undefined;
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
          ...(optionalTokenCount(bucket.inputTokens) !== undefined
            ? { inputTokens: optionalTokenCount(bucket.inputTokens) }
            : {}),
          ...(optionalTokenCount(bucket.cachedInputTokens) !== undefined
            ? { cachedInputTokens: optionalTokenCount(bucket.cachedInputTokens) }
            : {}),
          ...(optionalTokenCount(bucket.outputTokens) !== undefined
            ? { outputTokens: optionalTokenCount(bucket.outputTokens) }
            : {}),
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

export function readCodexAccountUsage({
  timeoutMs = DEFAULT_TIMEOUT_MS,
  binary = codexBinary(),
  platform = process.platform,
  codexHome = process.env.CODEX_HOME,
  spawnImpl = spawn,
} = {}) {
  return new Promise((resolve, reject) => {
    // The app-server answers with the signed-in ChatGPT account's usage, which
    // makes this a live credential probe against the real CODEX_HOME -- the
    // same class of read codexAuthStatus() refuses. The tray polls this every
    // 30 seconds, so an unguarded spawn here would quietly break the
    // --no-discovery promise in the background.
    if (discoveryDisabled()) {
      reject(new Error("Credential discovery is disabled (--no-discovery); the Codex account is not read."));
      return;
    }
    if (!binary) {
      reject(new Error("The Codex app-server could not be started: no Codex binary was found."));
      return;
    }
    const target = spawnableCommand(binary, ["app-server"], platform);
    const processHandle = spawnImpl(target.command, target.args, {
      ...target.options,
      env: codexHome ? { ...process.env, CODEX_HOME: codexHome } : process.env,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    const lines = readline.createInterface({ input: processHandle.stdout });
    const responses = new Map();
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      killProcessTree(processHandle, Boolean(target.options.windowsVerbatimArguments));
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
          title: "Codex Router Tray",
          version: "0.4.0",
        },
        capabilities: { experimentalApi: true },
      },
    });
  });
}
