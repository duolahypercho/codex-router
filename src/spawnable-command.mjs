// Windows resolves a bare command name through PATHEXT, so the file a lookup
// reports and the file Node can actually spawn are routinely different. Two
// separate failures come out of that gap, and both used to be re-implemented
// (or forgotten) at every call site:
//
//   1. `where.exe grok` on an npm global install lists the extensionless POSIX
//      shim before the batch shim that works:
//        ...\npm\grok       <- sh script, listed first, NOT spawnable
//        ...\npm\grok.cmd   <- the batch shim Windows can run
//      Taking the first line hands Node a file it cannot execute.
//
//   2. A .cmd/.bat shim is a batch script, so Windows needs cmd.exe to run it.
//      Node has refused to spawn one without a shell since the CVE-2024-27980
//      fix (18.20.2 / 20.12.2 / 21.7.3), and reports EINVAL when asked.
//
// Both failures surface as a spawn error the caller then misreads as something
// else entirely -- "signed out", "blocked by Windows application control", or a
// silently skipped check. Resolution and spawning therefore live together here,
// so a caller that gets the path right also gets the launch right.
import { execFileSync } from "node:child_process";

export const WINDOWS_SPAWNABLE_EXTENSIONS = [".exe", ".com", ".cmd", ".bat"];

// Ordered by preference: a real executable is spawned directly, and only a
// batch shim has to pay for a cmd.exe hop.
export function preferSpawnablePath(paths, platform = process.platform) {
  const found = (paths || []).map((value) => String(value).trim()).filter(Boolean);
  if (platform !== "win32") return found[0];
  for (const extension of WINDOWS_SPAWNABLE_EXTENSIONS) {
    const match = found.find((value) => value.toLowerCase().endsWith(extension));
    if (match) return match;
  }
  return found[0];
}

// `which`/`where.exe` for a command name, returning an entry Node can spawn
// rather than whichever one the finder happened to print first.
export function commandOnPath(
  name,
  { platform = process.platform, exec = execFileSync } = {},
) {
  const finder = platform === "win32" ? "where.exe" : "which";
  try {
    const output = exec(finder, [name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    return preferSpawnablePath(String(output || "").split(/\r?\n/), platform) || undefined;
  } catch {
    return undefined;
  }
}

export function isWindowsBatchShim(binary, platform = process.platform) {
  return platform === "win32" && /\.(cmd|bat)$/i.test(String(binary || ""));
}

// cmd.exe does not use the standard command-line parser, so an argument list
// cannot simply be joined with spaces -- which is exactly what Node's
// `shell: true` does, silently splitting any argument that contains one. The
// escaping below is the form npm's own `cross-spawn` uses: quote the argument,
// preserve backslash runs ahead of a quote, then neutralize every character
// cmd.exe would otherwise act on.
//
// Exactly one shim shape needs a second round of `^` escaping: the cmd-shim
// npm generates under `node_modules/.bin`, which re-enters cmd.exe to reach
// the real program, so the first interpreter consumes one layer before the
// second ever sees it. Applying that second layer to an ordinary batch file
// instead corrupts the line -- Windows answers "The syntax of the command is
// incorrect", which is how this was caught.
const CMD_SHIM_PATTERN = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i;

export function needsDoubleEscape(binary) {
  return CMD_SHIM_PATTERN.test(String(binary || ""));
}
const CMD_META_CHARACTERS = /([()\][%!^"`<>&|;, *?])/g;

// Escaping is the wrong last line of defence for a character that cannot occur
// in a real path to begin with. Windows forbids " < > | ? * and every control
// character in a file name, and those are exactly the ones that could end the
// quoted span or start a second command if the escaping above were ever wrong.
// (`&`, `^`, `%`, `!`, `(`, `)` and spaces are legal -- "C:\Program Files
// (x86)" is an ordinary path -- so those are escaped, not rejected.)
//
// The binary path reaching here comes from CODEX_BIN, LOCALAPPDATA, or PATH.
// Anyone who can set those already chooses which program runs, so this is not
// the boundary that stops an attacker who has them; it is what keeps a
// mistyped or hostile value from becoming a second command instead of a plain
// "that is not a path" error.
const PATH_ILLEGAL_ON_WINDOWS = /["<>|?*\u0000-\u001f]/;

export function assertSpawnablePath(binary) {
  if (PATH_ILLEGAL_ON_WINDOWS.test(String(binary))) {
    throw new Error(
      "Refusing to run a Windows path containing characters no file name may hold. " +
        "Check CODEX_BIN, GROK_CLI, or whatever set this command path.",
    );
  }
  return binary;
}

export function escapeWindowsShellCommand(value) {
  return String(value).replace(CMD_META_CHARACTERS, "^$1");
}

// An argument holding nothing cmd.exe or the child's parser would act on is
// passed through bare. Wrapping it in quotes anyway is invisible to a real
// program -- argv parsing strips them -- but a batch file that compares `%1`
// textually sees the quotes and stops matching, and shims that inspect their
// own arguments are common enough that quoting everything breaks them. Bare is
// also simply what a person typing the command would produce.
const SAFE_BARE_ARGUMENT = /^[A-Za-z0-9_@+=:.\/\\-]+$/;

export function escapeWindowsShellArgument(value, doubleEscape = false) {
  let escaped = String(value);
  if (SAFE_BARE_ARGUMENT.test(escaped)) return escaped;
  // Backslashes are literal unless they precede a quote, where each one has to
  // be doubled so the quote it escapes survives as data.
  escaped = escaped.replace(/(\\*)"/g, '$1$1\\"');
  escaped = escaped.replace(/(\\*)$/, "$1$1");
  escaped = `"${escaped}"`;
  escaped = escaped.replace(CMD_META_CHARACTERS, "^$1");
  if (doubleEscape) escaped = escaped.replace(CMD_META_CHARACTERS, "^$1");
  return escaped;
}

// Turns a resolved binary and its arguments into something Node can spawn on
// this platform. Callers spread the result:
//
//   const { command, args, options } = spawnableCommand(binary, ["login"]);
//   spawnSync(command, args, { ...options, encoding: "utf8" });
//
// Everything except a Windows batch shim passes through untouched.
export function spawnableCommand(binary, args = [], platform = process.platform) {
  const argumentList = [...args];
  if (!isWindowsBatchShim(binary, platform)) {
    return { command: binary, args: argumentList, options: {} };
  }
  assertSpawnablePath(binary);
  const doubleEscape = needsDoubleEscape(binary);
  const line = [
    escapeWindowsShellCommand(binary),
    ...argumentList.map((argument) => escapeWindowsShellArgument(argument, doubleEscape)),
  ].join(" ");
  return {
    command: process.env.ComSpec || "cmd.exe",
    // `/d` skips AutoRun commands, `/s` makes cmd.exe strip only the outer
    // quote pair and take the rest verbatim, and verbatim arguments stop Node
    // from re-quoting a line that is already escaped for cmd.exe.
    args: ["/d", "/s", "/c", `"${line}"`],
    options: { windowsVerbatimArguments: true },
  };
}
