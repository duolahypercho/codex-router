import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { commandOnPath, spawnableCommand } from "./spawnable-command.mjs";

// Cursor CLI is an *agent*, not an inference API. It has no OpenAI-compatible
// endpoint, no BYOK, and no way to be pointed at this router: `--endpoint`
// exists but speaks Cursor's own protocol, and Bedrock mode validates against
// Cursor's backend. So the integration runs the other way round -- the router
// drives `cursor-agent` as a local upstream and adapts it to chat-completions
// in cursor-cli-bridge.mjs. Everything in this module is the part that has to
// know about the binary itself: where it is, whether it is signed in, and
// which models the signed-in account may spend.

export const CURSOR_PROVIDER_ID = "cursor-cli";

// The official installer creates two symlinks in the same bin directory:
// `cursor-agent` and a bare `agent`. Only the first is ever probed. `agent` is
// a name half a dozen unrelated tools take, and resolving it off PATH would
// let whichever one is earlier become the thing the router spawns with the
// user's prompt on its stdin.
const BINARY_NAME = "cursor-agent";

// A model id reaches `--model` from the registry or the user's curated model
// file, so it is not attacker-supplied -- but it is the one request field that
// becomes an argv entry, and Cursor's own parameterized syntax
// (`claude-opus-4-8[context=1m,effort=high]`) means the charset cannot simply
// be alphanumerics. Pin it to exactly what Cursor documents rather than
// forwarding whatever arrived.
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9=,._-]*\])?$/;

export function validCursorModelId(value) {
  const id = String(value || "").trim();
  return MODEL_ID.test(id) && id.length <= 128 ? id : undefined;
}

/**
 * Where `cursor-agent` lives, or undefined when it is not installed.
 *
 * The installer drops the real binary under
 * `~/.local/share/cursor-agent/versions/<version>/` and symlinks it into
 * `~/.local/bin`, which is on PATH for an interactive shell but routinely is
 * not for a launchd or systemd service -- so the explicit fallback matters
 * more here than the PATH lookup does.
 */
export function cursorAgentPath({
  environment = process.env,
  platform = process.platform,
  exec,
} = {}) {
  if (environment.CURSOR_AGENT) return environment.CURSOR_AGENT;
  const discovered = commandOnPath(BINARY_NAME, {
    platform,
    ...(exec ? { exec } : {}),
  });
  if (discovered) return discovered;
  const home = environment.HOME || environment.USERPROFILE || os.homedir();
  const candidates =
    platform === "win32"
      ? [
          path.join(
            environment.LOCALAPPDATA || path.join(home, "AppData", "Local"),
            "cursor-agent",
            `${BINARY_NAME}.exe`,
          ),
          path.join(home, ".local", "bin", `${BINARY_NAME}.exe`),
          path.join(home, ".local", "bin", `${BINARY_NAME}.cmd`),
        ]
      : [
          path.join(home, ".local", "bin", BINARY_NAME),
          path.join(home, "bin", BINARY_NAME),
          "/usr/local/bin/cursor-agent",
          "/opt/homebrew/bin/cursor-agent",
        ];
  return candidates.find((candidate) => existsSync(candidate));
}

// `cursor-agent models` prints, with chalk decoration that disappears the
// moment stdout is not a TTY:
//
//   Available models
//
//   gpt-5 - GPT-5 (current, default)
//   sonnet-4-thinking - Claude Sonnet 4 (Thinking)
//
//   Tip: use --model <id> ...
//
// The id is the token before " - " and is exactly what `--model` accepts.
const HEADING = /^available models$/i;
const TIP = /^tip:/i;
// Chalk is off without a TTY, but NO_COLOR is not honored by every code path
// in every release, so strip SGR sequences rather than trusting that.
const ANSI = /\[[0-9;]*m/g;

export function parseCursorModels(output) {
  const ids = [];
  for (const raw of String(output || "").split(/\r?\n/)) {
    const line = raw.replace(ANSI, "").trim();
    if (!line || HEADING.test(line) || TIP.test(line)) continue;
    // ` - Display Name` is the description, and ` (current, default)` is the
    // marker suffix; the id is what survives both.
    const id = validCursorModelId(line.split(" - ")[0].replace(/\s*\(.*\)\s*$/, ""));
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

const AUTH_FAILURE = /authentication (?:required|failed)|not logged in|run ['"`]?(?:cursor-)?agent login/i;

/**
 * Installed / signed-in / which models, from one call.
 *
 * `cursor-agent status` answers only the middle question, and answering all
 * three separately means three process launches and two network round trips
 * for a doctor line. `models` fails closed with a recognizable authentication
 * error and otherwise returns the account's entitled model list, so it settles
 * every question a caller actually has.
 */
export function cursorCliStatus({
  environment = process.env,
  platform = process.platform,
  exec = execFileSync,
  timeoutMs = 20_000,
} = {}) {
  const binary = cursorAgentPath({ environment, platform });
  if (!binary) {
    return {
      installed: false,
      signedIn: false,
      models: [],
      detail: "cursor-agent is not installed",
      fix: "Install it with `curl https://cursor.com/install -fsS | bash`.",
    };
  }
  const { command, args, options } = spawnableCommand(binary, ["models"], platform);
  let stdout = "";
  let failure;
  try {
    stdout = String(
      exec(command, args, {
        ...options,
        encoding: "utf8",
        timeout: timeoutMs,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        // NO_COLOR is belt to the ANSI-stripping braces; both are cheap.
        env: { ...environment, NO_COLOR: "1" },
      }) || "",
    );
  } catch (error) {
    // execFileSync throws on a non-zero exit, and a non-zero exit is exactly
    // how `models` reports "not signed in" -- so the diagnostic lives in the
    // thrown result's streams, not in an exception message.
    failure = [error?.stdout, error?.stderr, error?.message]
      .map((value) => String(value || ""))
      .join("\n");
  }
  if (failure !== undefined) {
    const signedOut = AUTH_FAILURE.test(failure);
    return {
      installed: true,
      signedIn: false,
      models: [],
      binary,
      detail: signedOut
        ? "cursor-agent is installed but not signed in"
        : `cursor-agent could not list models: ${firstLine(failure)}`,
      fix: signedOut
        ? "Run `cursor-agent login` in an interactive terminal."
        : "Run `cursor-agent models` by hand to see what it reports.",
    };
  }
  const models = parseCursorModels(stdout);
  return {
    installed: true,
    signedIn: true,
    models,
    binary,
    detail: models.length
      ? `cursor-agent signed in with ${models.length} model(s)`
      : "cursor-agent is signed in but the account has no models",
    ...(models.length ? {} : { fix: "Check the plan on the Cursor dashboard." }),
  };
}

function firstLine(value) {
  return (
    String(value || "")
      .split(/\r?\n/)
      .map((line) => line.replace(ANSI, "").trim())
      .find(Boolean) || "no output"
  );
}
