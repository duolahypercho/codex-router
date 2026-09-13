import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  compileStructuredPatchArguments,
  MAX_STRUCTURED_PATCH_BYTES,
  StructuredPatchError,
} from "./grok-structured-patch.mjs";
import { GROK_PATCH_HOOK_PREFIX } from "./grok-patch-hook-transport.mjs";

// JSON escaping can expand the 1 MiB argument string sixfold. Reserve room
// for the native event metadata as well; reject the complete event above 8 MiB.
export const MAX_GROK_PATCH_HOOK_INPUT_BYTES = MAX_STRUCTURED_PATCH_BYTES * 8;

const ADD_FILE_HEADER = "*** Add File:";
const UPDATE_FILE_HEADER = "*** Update File:";
const DELETE_FILE_HEADER = "*** Delete File:";
const ADD_FILE_EXISTS_REASON = "file exists; use search_replace";
const PATH_OUTSIDE_REASON = "path is outside the workspace";
const TRAILING_NEWLINE_REASON = "trailing newline cannot be preserved";
const OLD_STRING_NOT_FOUND_REASON = "old_string not found";
const OLD_STRING_NOT_UNIQUE_REASON = "old_string is not unique; narrow the match";
const OLD_STRING_FILE_TOO_LARGE_REASON = "file too large to verify unique match";

function patchWorkingDirectory(event) {
  const cwd = event?.cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : process.cwd();
}

function inspectWorkspacePath(cwd, target) {
  if (typeof cwd !== "string" || typeof target !== "string" || !cwd || !target) return "outside";
  if (cwd.includes("\0") || target.includes("\0")) return "outside";
  let root;
  try {
    root = realpathSync(cwd);
  } catch {
    return "outside";
  }
  const candidate = resolve(root, target);
  if (pathEscapesWorkspace(relative(root, candidate))) return "outside";
  const relativePath = relative(root, candidate);
  const parts = relativePath === "" ? [] : relativePath.split(sep);
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part || part === ".") continue;
    current = join(current, part);
    let info;
    try {
      info = lstatSync(current);
    } catch {
      return "missing";
    }
    if (info.isSymbolicLink()) return "outside";
  }
  return "exists";
}

function openRelative(dirFd, name, flags) {
  if (typeof name !== "string" || !name || name === "." || name === ".." || /[\\/\0]/.test(name)) {
    throw new Error("invalid path component");
  }
  if (process.platform === "linux") {
    return openSync(`/proc/self/fd/${dirFd}/${name}`, flags);
  }
  const dirPath = realpathSync(`/dev/fd/${dirFd}`);
  return openSync(join(dirPath, name), flags);
}

function openWorkspaceFile(cwd, target) {
  if (inspectWorkspacePath(cwd, target) !== "exists") return undefined;
  let root;
  try {
    root = realpathSync(cwd);
  } catch {
    return undefined;
  }
  const candidate = resolve(root, target);
  if (process.platform !== "linux") {
    try {
      return openSync(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    } catch {
      return undefined;
    }
  }
  const parts = relative(root, candidate).split(sep).filter((part) => part && part !== ".");
  let fd;
  try {
    fd = openSync(root, constants.O_RDONLY | (constants.O_DIRECTORY || 0));
    for (let index = 0; index < parts.length; index += 1) {
      const last = index === parts.length - 1;
      const flags = last
        ? constants.O_RDONLY | (constants.O_NOFOLLOW || 0)
        : constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0);
      const next = openRelative(fd, parts[index], flags);
      closeSync(fd);
      fd = next;
    }
    return fd;
  } catch {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    }
    return undefined;
  }
}

function readWorkspaceFile(cwd, target) {
  const fd = openWorkspaceFile(cwd, target);
  if (fd === undefined) return undefined;
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) return undefined;
    if (info.size > MAX_STRUCTURED_PATCH_BYTES) return { tooLarge: true };
    const buffer = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < info.size) {
      const n = readSync(fd, buffer, offset, info.size - offset, offset);
      if (n === 0) break;
      offset += n;
    }
    return { contents: buffer.toString("utf8") };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
}

function pathEscapesWorkspace(relativePath) {
  return relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);
}

function openedPath(fd) {
  try {
    if (process.platform === "linux") return realpathSync(`/proc/self/fd/${fd}`);
    if (process.platform === "darwin") return realpathSync(`/dev/fd/${fd}`);
  } catch {
    return undefined;
  }
  return undefined;
}

// Grok subagents emit whole-file Add File for paths that already exist.
// Router compile cannot see the worktree; this client hook can existsSync.
function addFileTargetProblem(patch, event) {
  const cwd = patchWorkingDirectory(event);
  for (const rawLine of patch.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    let target;
    let add = false;
    if (line.startsWith(ADD_FILE_HEADER)) {
      target = line.slice(ADD_FILE_HEADER.length).trim();
      add = true;
    } else if (line.startsWith(UPDATE_FILE_HEADER)) {
      target = line.slice(UPDATE_FILE_HEADER.length).trim();
    } else if (line.startsWith(DELETE_FILE_HEADER)) {
      target = line.slice(DELETE_FILE_HEADER.length).trim();
    } else continue;
    const status = inspectWorkspacePath(cwd, target);
    if (status === "outside") return PATH_OUTSIDE_REASON;
    if (add && status === "exists") return ADD_FILE_EXISTS_REASON;
  }
  return undefined;
}

function deny(reason) {
  return { hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: reason,
  } };
}

function exactLineOccurrences(contents, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while (index <= contents.length) {
    const found = contents.indexOf(needle, index);
    if (found === -1) break;
    const startOk = found === 0 || contents[found - 1] === "\n";
    const end = found + needle.length;
    const endOk = needle.endsWith("\n") || end === contents.length || contents[end] === "\n";
    if (startOk && endOk) count += 1;
    index = found + 1;
  }
  return count;
}

function searchReplaceMatchProblem(raw, event) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (typeof value.old_string !== "string" || typeof value.path !== "string") return undefined;
  const cwd = patchWorkingDirectory(event);
  const file = readWorkspaceFile(cwd, value.path);
  if (!file) return OLD_STRING_NOT_FOUND_REASON;
  if (file.tooLarge) return OLD_STRING_FILE_TOO_LARGE_REASON;
  const count = exactLineOccurrences(file.contents, value.old_string);
  if (count === 0) return OLD_STRING_NOT_FOUND_REASON;
  if (count > 1) return OLD_STRING_NOT_UNIQUE_REASON;
  if (!file.contents.endsWith("\n") && !value.old_string.endsWith("\n")) {
    return TRAILING_NEWLINE_REASON;
  }
  return undefined;
}

// This adapter only serializes. Native apply_patch still validates the patch
// and enforces its permissions. If this hook fails or is absent, the original
// prefixed envelope cannot be a native patch; this is not a general guarantee
// that the client's hook failures deny arbitrary native tool invocations.
export function adaptHookInput(event) {
  const command = event?.tool_input?.command;
  if (event?.model !== "grok-oauth/grok-4.6" || event?.tool_name !== "apply_patch" ||
      typeof command !== "string") return {};
  if (command.startsWith(GROK_PATCH_HOOK_PREFIX)) {
    try {
      const raw = command.slice(GROK_PATCH_HOOK_PREFIX.length);
      const matchProblem = searchReplaceMatchProblem(raw, event);
      if (matchProblem) return deny(matchProblem);
      const patch = compileStructuredPatchArguments(raw);
      const addProblem = addFileTargetProblem(patch, event);
      if (addProblem) return deny(addProblem);
      return { hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { command: patch },
      } };
    } catch (error) {
      if (!(error instanceof StructuredPatchError)) throw error;
      // Only a bounded codec identifier enters feedback, never argument text or
      // arbitrary exception messages. The client may separately echo the command.
      const code = typeof error.code === "string" && /^[a-z_]{1,64}$/u.test(error.code)
        ? error.code : "invalid_arguments";
      return { hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `Invalid structured apply_patch arguments (${code}). Correct the structured arguments and retry this tool.`,
      } };
    }
  }
  const addProblem = addFileTargetProblem(command, event);
  if (addProblem) return deny(addProblem);
  return {};
}

export async function readHookInput(stream) {
  // A fixed byte buffer also bounds bookkeeping when stdin arrives one byte
  // at a time. Decode only after accumulation so split Unicode stays intact.
  const input = Buffer.allocUnsafe(MAX_GROK_PATCH_HOOK_INPUT_BYTES);
  let bytes = 0;
  for await (const chunk of stream) {
    if (!(chunk instanceof Uint8Array)) throw new TypeError("hook input must be a byte stream");
    if (chunk.byteLength > input.length - bytes) throw new Error("hook event exceeds input bound");
    input.set(chunk, bytes);
    bytes += chunk.byteLength;
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(input.subarray(0, bytes));
  return JSON.parse(text);
}
