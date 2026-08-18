import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { closeSync, openSync, readSync, writeSync } from "node:fs";

import {
  VALID_STRATEGIES,
  DEFAULT_STRATEGY,
  getPool,
  listPools,
  getStrategy,
  setStrategy,
  strategyLabel,
  addCredential,
  removeCredential,
  resetCooldowns,
  credentialPoolStatus,
  POOL_PATH,
} from "./credential-pool.mjs";
import { PROVIDERS } from "./model-registry.mjs";
import { credentialStatus } from "./provider-credentials.mjs";

const providerId = process.argv[2];
const command = process.argv[3];

function usage() {
  console.error(`Usage:
  credential-pool.mjs list [provider]                 - List pools or one provider's pool
  credential-pool.mjs add <provider> [--label L] [--api-key KEY]
                                                     - Add a credential to a provider's pool
  credential-pool.mjs remove <provider> <index|id>   - Remove a credential by 1-based index or id
  credential-pool.mjs strategy <provider> [strategy] - Show or set rotation strategy
  credential-pool.mjs reset <provider|--all>          - Clear cooldowns / exhaustion
  credential-pool.mjs status [provider]               - Alias for list

Strategies: ${VALID_STRATEGIES.join(", ")} (default: ${DEFAULT_STRATEGY})

Examples:
  credential-pool.mjs list
  credential-pool.mjs list deepseek
  credential-pool.mjs add deepseek --label backup --api-key sk-...
  credential-pool.mjs add openrouter   # hidden prompt
  credential-pool.mjs strategy deepseek round_robin
  credential-pool.mjs reset deepseek
  credential-pool.mjs remove deepseek 2`);
  process.exit(2);
}

function optionValue(name) {
  const idx = process.argv.indexOf(name);
  return idx === -1 ? undefined : process.argv[idx + 1];
}

function hasFlag(name) {
  return process.argv.includes(name);
}

// Hidden prompt — copied from src/provider-key.mjs so this CLI does not depend
// on a shared helper that might change its TTY contract. The logic is small
// and self-contained.
const WINDOWS_HIDDEN_PROMPT_SCRIPT = [
  "$secret = Read-Host $env:CODEX_ROUTER_PROMPT_LABEL -AsSecureString",
  "$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)",
  "try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }",
].join("; ");

function windowsHiddenPromptArgs(script = WINDOWS_HIDDEN_PROMPT_SCRIPT) {
  return [
    "-NoLogo",
    "-NoProfile",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ];
}

function powerShellStartupError(failures) {
  return (
    failures.find((error) => error?.code !== "ENOENT") ||
    new Error(
      "PowerShell is required for hidden API-key input, but neither powershell.exe nor pwsh.exe could be started.",
    )
  );
}

function hiddenPrompt(label) {
  if (process.platform === "win32") {
    const args = windowsHiddenPromptArgs();
    const failures = [];
    for (const executable of ["powershell.exe", "pwsh.exe"]) {
      try {
        return execFileSync(executable, args, {
          encoding: "utf8",
          env: { ...process.env, CODEX_ROUTER_PROMPT_LABEL: label },
          stdio: ["inherit", "pipe", "inherit"],
        });
      } catch (error) {
        failures.push(error);
      }
    }
    throw powerShellStartupError(failures);
  }
  let descriptor;
  try {
    descriptor = openSync("/dev/tty", "r+");
  } catch {
    throw new Error("An interactive terminal is required to enter an API key.");
  }
  let terminalState;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (terminalState) {
      try {
        execFileSync("/bin/stty", [terminalState], {
          stdio: [descriptor, "ignore", descriptor],
        });
      } catch {}
    }
    try {
      writeSync(descriptor, "\n");
    } catch {}
  };
  const interrupted = (signal) => {
    cleanup();
    process.exit(signal === "SIGHUP" ? 129 : signal === "SIGINT" ? 130 : 143);
  };
  const handlers = new Map(
    ["SIGHUP", "SIGINT", "SIGTERM"].map((signal) => [
      signal,
      () => interrupted(signal),
    ]),
  );
  try {
    terminalState = execFileSync("/bin/stty", ["-g"], {
      encoding: "utf8",
      stdio: [descriptor, "pipe", descriptor],
    }).trim();
    for (const [signal, handler] of handlers) process.on(signal, handler);
    writeSync(descriptor, `${label}: `);
    execFileSync("/bin/stty", ["-echo"], {
      stdio: [descriptor, "ignore", descriptor],
    });
    const chunks = [];
    const byte = Buffer.alloc(1);
    while (readSync(descriptor, byte, 0, 1) === 1) {
      if (byte[0] === 10 || byte[0] === 13) break;
      chunks.push(Buffer.from(byte));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    cleanup();
    try {
      closeSync(descriptor);
    } catch {}
  }
}

function formatPoolStatus(status, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return;
  }
  if (!status.exists) {
    process.stdout.write(`${status.provider}: no credential pool (single-credential mode). Single credential ${credentialStatus(status.provider).configured ? "is configured" : "is not configured"}.\n`);
    process.stdout.write(`  Strategy (when pool is created): ${status.strategy} — ${strategyLabel(status.strategy)}\n`);
    return;
  }
  process.stdout.write(
    `${status.provider} (strategy: ${status.strategy} — ${strategyLabel(status.strategy).split(" — ")[1] || status.strategy}) — ${status.healthy}/${status.total} healthy:\n`,
  );
  for (const cred of status.credentials) {
    const health = cred.healthy ? "ok" : `cooldown until ${cred.cooldownUntil}`;
    const retry = cred.hasRetried429 ? " (has retried 429 once)" : "";
    process.stdout.write(
      `  #${cred.index}  ${cred.id}  ${cred.label}  ${cred.source}  requests=${cred.requestCount}  status=${cred.lastStatus}  ${health}${retry}\n`,
    );
  }
}

async function main() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.length === 0 || hasFlag("--help") || hasFlag("-h")) usage();

  // Support both `credential-pool list deepseek` and `credential-pool deepseek list`
  // by normalizing to: <provider> <command> vs <command> [provider]
  // The requested spec is: commands to list/add/remove/strategy/reset — with
  // provider as first arg for most. We'll support both orderings.
  let cmd = rawArgs[0];
  let target = rawArgs[1];

  // If first token is a known provider id and second token is a known command,
  // swap them: `deepseek list` -> `list deepseek`
  const knownCommands = new Set(["list", "status", "add", "remove", "strategy", "reset"]);
  if (PROVIDERS.has(cmd) && knownCommands.has(target)) {
    const tmp = cmd;
    cmd = target;
    target = tmp;
    // Shift remaining args
    rawArgs[0] = cmd;
    rawArgs[1] = target;
  }

  const asJson = hasFlag("--json");
  // For commands that read provider from argv[1] position, re-derive.
  // list/status can be without provider -> show all
  if (cmd === "list" || cmd === "status") {
    const provider = target && !target.startsWith("-") ? target : undefined;
    if (provider) {
      if (!PROVIDERS.has(provider) && !PROVIDERS.has(provider.toLowerCase())) {
        console.error(`Unknown provider: ${provider}`);
        process.exit(1);
      }
      const status = credentialPoolStatus(provider);
      formatPoolStatus(status, asJson);
    } else {
      const pools = listPools();
      if (!pools.length) {
        if (asJson) {
          process.stdout.write(`${JSON.stringify({ pools: [] }, null, 2)}\n`);
        } else {
          process.stdout.write(`No credential pools configured. Each provider is in single-credential mode.\nAdd a second credential with: credential-pool add <provider>\n`);
        }
        return;
      }
      for (const pool of pools) {
        const status = credentialPoolStatus(pool.id);
        formatPoolStatus(status, asJson);
        if (!asJson) process.stdout.write("\n");
      }
    }
    return;
  }

  if (cmd === "add") {
    const provider = target;
    if (!provider) {
      console.error("Usage: credential-pool add <provider> [--label L] [--api-key KEY]");
      process.exit(2);
    }
    const label = optionValue("--label") || optionValue("--name");
    let apiKey = optionValue("--api-key") || optionValue("--key");
    if (!apiKey) {
      // Fallback to environment or prompt
      const providerObj = PROVIDERS.get(provider);
      const promptLabel = providerObj?.credential?.prompt || `${provider} API key`;
      process.stderr.write(`Enter ${promptLabel} (input hidden):\n`);
      apiKey = hiddenPrompt(promptLabel);
    }
    try {
      const result = addCredential(provider, apiKey, { label });
      process.stdout.write(`Added credential "${result.credential.label}" (${result.credential.id}) to ${result.provider} pool at index #${result.index}. Total: ${credentialPoolStatus(provider).total}\n`);
      if (asJson) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
    return;
  }

  if (cmd === "remove") {
    const provider = target;
    const identifier = rawArgs[2] || optionValue("--id") || optionValue("--index");
    if (!provider || !identifier) {
      console.error("Usage: credential-pool remove <provider> <index|id>");
      process.exit(2);
    }
    try {
      const result = removeCredential(provider, identifier);
      process.stdout.write(`Removed credential ${result.removed.label || result.removed.id} from ${result.provider} pool. Remaining: ${result.remaining}\n`);
      if (asJson) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
    return;
  }

  if (cmd === "strategy") {
    const provider = target;
    if (!provider) {
      console.error("Usage: credential-pool strategy <provider> [strategy]");
      process.exit(2);
    }
    const newStrategy = rawArgs[2] && !rawArgs[2].startsWith("-") ? rawArgs[2] : optionValue("--set");
    if (newStrategy) {
      try {
        const result = setStrategy(provider, newStrategy);
        process.stdout.write(`Set ${result.provider} rotation strategy to ${result.strategy} — ${strategyLabel(result.strategy).split(" — ")[1] || result.strategy}\n`);
        if (asJson) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    } else {
      const current = getStrategy(provider);
      if (asJson) {
        process.stdout.write(`${JSON.stringify({ provider, strategy: current }, null, 2)}\n`);
      } else {
        process.stdout.write(`${provider} rotation strategy: ${current} — ${strategyLabel(current).split(" — ")[1] || current}\n`);
      }
    }
    return;
  }

  if (cmd === "reset") {
    const provider = target;
    if (!provider) {
      console.error("Usage: credential-pool reset <provider|--all>");
      process.exit(2);
    }
    if (provider === "--all" || provider === "all") {
      const result = resetCooldowns(undefined);
      process.stdout.write(`Reset cooldowns for all pools: ${result.reset} credential(s) reset.\n`);
      if (asJson) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      try {
        const result = resetCooldowns(provider);
        process.stdout.write(`Reset cooldowns for ${result.provider}: ${result.reset} credential(s) reset.\n`);
        if (asJson) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    }
    return;
  }

  usage();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
