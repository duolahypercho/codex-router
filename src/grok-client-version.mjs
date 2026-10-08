import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { grokCliPath } from "./grok-cli.mjs";
import { spawnableCommand } from "./spawnable-command.mjs";

const execute = promisify(execFile);

// Cache only a successful CLI probe, briefly: a failed startup probe must
// neither impersonate the router's version nor poison the process lifetime.
export function createGrokClientVersionReader({
  environment = process.env,
  platform = process.platform,
  resolveCli = () => grokCliPath({ environment, platform }),
  run = execute,
  now = Date.now,
  cacheMs = 60_000,
} = {}) {
  let cached;
  let expiresAt = 0;
  let pending;
  return async function readVersion() {
    if (cached && now() < expiresAt) return cached;
    if (pending) return pending;
    pending = (async () => {
      try {
        const executable = resolveCli();
        if (!executable) throw new Error("missing CLI");
        const target = spawnableCommand(executable, ["--version"], platform);
        const { XAI_API_KEY: _apiKey, ...env } = environment;
        const { stdout } = await run(target.command, target.args, {
          ...target.options,
          env,
          encoding: "utf8",
          timeout: 5_000,
          maxBuffer: 16_384,
          windowsHide: true,
        });
        const version = String(stdout).match(/^grok\s+(\d+\.\d+\.\d+)\b/im)?.[1];
        if (!version) throw new Error("unrecognized CLI version");
        cached = version;
        expiresAt = now() + cacheMs;
        return version;
      } catch {
        // Do not expose command output, paths, or environment in the error.
        const error = new Error("Cannot determine the installed Grok CLI version. Check GROK_CLI and run `grok --version`, then retry.");
        error.code = "grok_cli_version_unavailable";
        error.status = 503;
        throw error;
      }
    })();
    try {
      return await pending;
    } finally {
      pending = undefined;
    }
  };
}
