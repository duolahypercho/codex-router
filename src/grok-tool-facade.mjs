import { spawnSync } from "node:child_process";
import { jsonArgumentsAreUnambiguous, registerCustomToolRelays, registerFunctionRelays } from "./namespace-relay.mjs";
import {
  compileSearchReplaceArguments,
  compileWriteArguments,
  GROK_STRUCTURED_PATCH_CODEC,
  MAX_STRUCTURED_PATCH_BYTES,
} from "./grok-structured-patch.mjs";

export const GROK_EDIT_FACADE_ROUTE = "grok-oauth/grok-4.6";
export const SEARCH_REPLACE_TOOL_NAME = "search_replace";
export const WRITE_TOOL_NAME = "write";
export const READ_FILE_TOOL_NAME = "read_file";
export const GREP_TOOL_NAME = "grep";
export const LIST_DIR_TOOL_NAME = "list_dir";
export const RUN_TERMINAL_COMMAND_TOOL_NAME = "run_terminal_command";
export const GROK_FACADE_TOOL_NAMES = [
  SEARCH_REPLACE_TOOL_NAME,
  WRITE_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  GREP_TOOL_NAME,
  LIST_DIR_TOOL_NAME,
  RUN_TERMINAL_COMMAND_TOOL_NAME,
];
export const DEFAULT_READ_LIMIT = 400;
export const DEFAULT_HEAD_LIMIT = 10;
export const MAX_READ_LIMIT = 2000;

const pathSchema = { type: "string", minLength: 1, maxLength: 65536 };
const bodySchema = { type: "string", maxLength: MAX_STRUCTURED_PATCH_BYTES };
const objectSchema = (properties, required) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export const SEARCH_REPLACE_PARAMETERS = objectSchema({
  path: pathSchema,
  old_string: { ...bodySchema, minLength: 1 },
  new_string: bodySchema,
}, ["path", "old_string", "new_string"]);

export const WRITE_PARAMETERS = objectSchema({
  path: pathSchema,
  contents: bodySchema,
}, ["path", "contents"]);

const facadeCodec = {
  version: GROK_STRUCTURED_PATCH_CODEC.version,
  maxArgumentBytes: MAX_STRUCTURED_PATCH_BYTES,
};

export const SEARCH_REPLACE_CODEC = {
  ...facadeCodec,
  decodeArguments: compileSearchReplaceArguments,
  parameters: SEARCH_REPLACE_PARAMETERS,
  description() {
    return [
      "Replace exact text in an existing file.",
      "path is a workspace-relative file path. old_string must match one unique occurrence.",
      "One occurrence per call; call again for further replacements.",
    ].join(" ");
  },
};

export const WRITE_CODEC = {
  ...facadeCodec,
  decodeArguments: compileWriteArguments,
  parameters: WRITE_PARAMETERS,
  description() {
    return [
      "Create a new file with the given contents.",
      "Fails if the path already exists; change existing files with search_replace.",
    ].join(" ");
  },
};

const FACADE_TOOLS = [
  {
    name: SEARCH_REPLACE_TOOL_NAME,
    codec: SEARCH_REPLACE_CODEC,
  },
  {
    name: WRITE_TOOL_NAME,
    codec: WRITE_CODEC,
  },
];

export function posixSingleQuote(value) {
  if (typeof value !== "string" || !value || value.includes("\0") || /[\r\n]/u.test(value)) {
    return undefined;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function parseFacadeObject(argumentsText) {
  if (typeof argumentsText !== "string" || !jsonArgumentsAreUnambiguous(argumentsText)) {
    return undefined;
  }
  try {
    const value = JSON.parse(argumentsText);
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

function parseExactObject(argumentsText, required, optional = []) {
  const value = parseFacadeObject(argumentsText);
  if (!value) return undefined;
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return undefined;
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) return undefined;
  }
  return value;
}

function terminateUnixPath(filePath) {
  if (typeof filePath !== "string" || !filePath) return undefined;
  if (filePath.startsWith("-")) return `./${filePath}`;
  return filePath;
}

function powershellLiteral(value) {
  if (typeof value !== "string" || value.includes("\0") || /[\r\n]/.test(value)) return undefined;
  return `'${value.replace(/'/g, "''")}'`;
}

function powershellEncodedCommand(script) {
  if (typeof script !== "string" || script.includes("\0")) return undefined;
  return `powershell -NoProfile -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
}

function decodePowershellEncodedCommand(command) {
  const match = /^powershell -NoProfile -EncodedCommand ([A-Za-z0-9+/=]+)$/u.exec(
    typeof command === "string" ? command.trim() : "",
  );
  if (!match) return undefined;
  try {
    return Buffer.from(match[1], "base64").toString("utf16le");
  } catch {
    return undefined;
  }
}

function withWorkdir(payload, workdir) {
  if (typeof workdir === "string" && workdir) payload.workdir = workdir;
  return JSON.stringify(payload);
}

function fileReadCommand(filePath, offset, limit, workdir, platform = process.platform) {
  if (platform === "win32") {
    const literal = powershellLiteral(filePath);
    if (!literal) return undefined;
    const skip = offset - 1;
    const cmd = powershellEncodedCommand(
      `Get-Content -LiteralPath ${literal} | Select-Object -Skip ${skip} -First ${limit}`,
    );
    if (!cmd) return undefined;
    return withWorkdir({ cmd }, workdir);
  }
  const posixPath = terminateUnixPath(filePath);
  const quoted = posixSingleQuote(posixPath);
  if (!quoted) return undefined;
  const end = offset + limit - 1;
  return withWorkdir({ cmd: `sed -n '${offset},${end}p' ${quoted}` }, workdir);
}

export function compileReadFileCommand(argumentsText, workdir, platform = process.platform) {
  const value = parseExactObject(argumentsText, ["target_file"], ["offset", "limit"]);
  if (!value || typeof value.target_file !== "string") return undefined;
  const offset = value.offset === undefined ? 1 : value.offset;
  const limit = value.limit === undefined ? DEFAULT_READ_LIMIT : value.limit;
  if (!Number.isInteger(offset) || offset < 1) return undefined;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_READ_LIMIT) return undefined;
  return fileReadCommand(value.target_file, offset, limit, workdir, platform);
}

export function compileGrepCommand(argumentsText, workdir, platform = process.platform) {
  const value = parseExactObject(argumentsText, ["pattern"], ["path", "glob"]);
  if (!value || typeof value.pattern !== "string" || value.pattern.length === 0) return undefined;
  const quote = platform === "win32" ? powershellLiteral : posixSingleQuote;
  const pattern = quote(value.pattern);
  if (!pattern) return undefined;
  const path = value.path === undefined ? "." : value.path;
  const quotedPath = quote(terminateUnixPath(path) || path);
  if (!quotedPath) return undefined;
  let cmd = `rg --line-number --color never --max-count 50 -e ${pattern}`;
  if (Object.hasOwn(value, "glob")) {
    if (typeof value.glob !== "string" || !value.glob) return undefined;
    const glob = quote(value.glob);
    if (!glob) return undefined;
    cmd += ` --glob ${glob}`;
  }
  cmd += ` -- ${quotedPath}`;
  if (platform === "win32") {
    cmd = powershellEncodedCommand(`${cmd} | Select-Object -First 50`);
    if (!cmd) return undefined;
  } else {
    cmd = `set -o pipefail; ${cmd} | head -n 50`;
  }
  return withWorkdir({ cmd }, workdir);
}

const READ_FILE_PARAMETERS = objectSchema({
  target_file: pathSchema,
  offset: { type: "integer", minimum: 1 },
  limit: { type: "integer", minimum: 1, maximum: MAX_READ_LIMIT },
}, ["target_file"]);

const GREP_PARAMETERS = objectSchema({
  pattern: { type: "string", minLength: 1, maxLength: 65536 },
  path: pathSchema,
  glob: { type: "string", minLength: 1, maxLength: 1024 },
}, ["pattern"]);

const LIST_DIR_PARAMETERS = objectSchema({
  target_directory: pathSchema,
}, []);

const RUN_TERMINAL_COMMAND_PARAMETERS = objectSchema({
  command: { type: "string", minLength: 1, maxLength: MAX_STRUCTURED_PATCH_BYTES },
  working_directory: pathSchema,
}, ["command"]);

let ripgrepCached;

function ripgrepAvailable() {
  if (ripgrepCached !== undefined) return ripgrepCached;
  try {
    const result = spawnSync("rg", ["--version"], { encoding: "utf8", timeout: 3000, windowsHide: true });
    ripgrepCached = result.status === 0;
  } catch {
    ripgrepCached = false;
  }
  return ripgrepCached;
}

function isOrdinaryExecFunction(tool) {
  if (tool?.type !== "function") return false;
  const params = tool.parameters;
  if (!params || typeof params !== "object" || Array.isArray(params)) return false;
  const properties = params.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return false;
  const cmd = properties.cmd;
  if (!cmd || (cmd.type && cmd.type !== "string")) return false;
  const required = params.required;
  if (Array.isArray(required) && required.some((key) => key !== "cmd" && key !== "workdir")) return false;
  if (params.additionalProperties === false && properties.workdir === undefined) return false;
  return true;
}

function ordinaryExecNamed(tool, name, namespace) {
  if (!isOrdinaryExecFunction(tool) || tool.name !== name) return false;
  if (namespace === undefined) return tool.namespace === undefined;
  return tool.namespace === namespace;
}

export function nativeExecRelayTarget(tools, namespaces) {
  if (!Array.isArray(tools)) return undefined;
  const exact = tools.find((tool) => ordinaryExecNamed(tool, "exec_command"));
  if (exact) return { nativeName: "exec_command" };
  if (!(namespaces instanceof Map)) return undefined;
  const owners = [];
  for (const [namespace, names] of namespaces) {
    if (typeof namespace !== "string" || !namespace || !(names instanceof Set) || !names.has("exec_command")) {
      continue;
    }
    const flattened = `${namespace}__exec_command`;
    if (tools.some((tool) => ordinaryExecNamed(tool, flattened) || ordinaryExecNamed(tool, "exec_command", namespace))) {
      owners.push(namespace);
    }
  }
  if (owners.length !== 1) return undefined;
  return { nativeName: "exec_command", nativeNamespace: owners[0] };
}

export function compileListDirCommand(argumentsText, workdir, platform = process.platform) {
  const value = argumentsText === undefined || argumentsText === ""
    ? {}
    : parseExactObject(argumentsText, [], ["target_directory"]);
  if (!value) return undefined;
  const directory = value.target_directory === undefined ? "." : value.target_directory;
  if (typeof directory !== "string" || !directory) return undefined;
  if (platform === "win32") {
    const literal = powershellLiteral(directory);
    if (!literal) return undefined;
    const cmd = powershellEncodedCommand(`Get-ChildItem -LiteralPath ${literal}`);
    if (!cmd) return undefined;
    return withWorkdir({ cmd }, workdir);
  }
  const quoted = posixSingleQuote(terminateUnixPath(directory) || directory);
  if (!quoted) return undefined;
  return withWorkdir({ cmd: `ls -la ${quoted}` }, workdir);
}

export function rewriteGrokFacadeToolChoice(toolChoice, installed) {
  if (!toolChoice || typeof toolChoice !== "object") return toolChoice;
  const offered = (name) => !(installed instanceof Set) || installed.has(name);
  if (toolChoice.namespace) return toolChoice;
  if (toolChoice.type === "function" && (toolChoice.name === "exec_command" || toolChoice.name === "shell_command")) {
    return offered(RUN_TERMINAL_COMMAND_TOOL_NAME)
      ? { ...toolChoice, name: RUN_TERMINAL_COMMAND_TOOL_NAME }
      : toolChoice;
  }
  if (toolChoice.type === "function" && toolChoice.name === "apply_patch") {
    return offered(SEARCH_REPLACE_TOOL_NAME)
      ? { ...toolChoice, name: SEARCH_REPLACE_TOOL_NAME }
      : toolChoice;
  }
  if (toolChoice.type === "allowed_tools" && Array.isArray(toolChoice.tools)) {
    return { ...toolChoice, tools: toolChoice.tools.map((choice) => rewriteGrokFacadeToolChoice(choice, installed)) };
  }
  return toolChoice;
}

export const SHELL_NOT_EDITOR_COMMAND =
  "printf '%s\\n' 'use write or search_replace; shell is not a file editor' >&2; exit 1";

function unquotedOrPosix(token) {
  if (typeof token !== "string") return undefined;
  const trimmed = token.trim();
  return unquotePosix(trimmed) ?? (/^[\w./@+-]+$/u.test(trimmed) ? trimmed : undefined);
}

function unquotedFileRedirect(command) {
  let i = 0;
  while (i < command.length) {
    const char = command[i];
    if (char === "\\" && i + 1 < command.length) {
      i += 2;
      continue;
    }
    if (char === "'") {
      i += 1;
      while (i < command.length && command[i] !== "'") i += 1;
      i += 1;
      continue;
    }
    if (char === '"') {
      i += 1;
      while (i < command.length && command[i] !== '"') {
        if (command[i] === "\\") i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (char === ">") {
      const after = command.slice(i + 1);
      if (after.startsWith(">") || !/^&(?:[0-9]|-)/.test(after)) return true;
    }
    i += 1;
  }
  return false;
}

function pathOperand(rest) {
  const trimmed = typeof rest === "string" ? rest.trim() : "";
  if (!trimmed) return { none: true };
  if (trimmed.startsWith("-- ")) return { path: trimmed.slice(3).trim() };
  if (trimmed === "--") return { none: true };
  if (trimmed.startsWith("-")) return { option: true };
  return { path: trimmed };
}

function unquotePosixWord(value) {
  if (typeof value !== "string" || !value.startsWith("'")) return undefined;
  let index = 1;
  let out = "";
  while (index < value.length) {
    if (value.startsWith(`'\\''`, index)) {
      out += "'";
      index += 4;
      continue;
    }
    if (value[index] === "'") {
      index += 1;
      return index === value.length ? out : undefined;
    }
    out += value[index];
    index += 1;
  }
  return undefined;
}

function singleOperandPath(rest) {
  const operand = pathOperand(rest);
  if (operand.option || operand.none) return operand;
  const raw = operand.path;
  const posix = unquotePosixWord(raw);
  if (posix !== undefined) return posix ? { path: posix } : { multi: true };
  if (raw.startsWith("'") || raw.startsWith('"') || /\s/.test(raw)) return { multi: true };
  if (!/^[\w./@+-]+$/u.test(raw)) return { multi: true };
  return { path: raw };
}

function singleLineCommand(command) {
  const trimmed = command.trim();
  if (!trimmed || /[\n;&|]/.test(trimmed) || trimmed.includes("&&") || trimmed.includes("||")) {
    return undefined;
  }
  return trimmed;
}

function standalonePathRead(command) {
  const trimmed = command.trim();
  let match = /^Path\(['"]([^'"]+)['"]\)\.read_text\(\)\s*$/u.exec(trimmed);
  if (match) return match[1];
  match = /^from pathlib import Path\s*\nPath\(['"]([^'"]+)['"]\)\.read_text\(\)\s*$/u.exec(trimmed);
  if (match) return match[1];
  match = /^from pathlib import Path\s*\np=Path\(['"]([^'"]+)['"]\)\s*\nprint\(p\.read_text\(\)\)\s*$/u.exec(trimmed);
  if (match) return match[1];
  return undefined;
}

function unquotedCommandText(command) {
  let out = "";
  let index = 0;
  while (index < command.length) {
    const char = command[index];
    if (char === "\\" && index + 1 < command.length) {
      out += " ";
      index += 2;
      continue;
    }
    if (char === "'") {
      index += 1;
      while (index < command.length && command[index] !== "'") index += 1;
      index += 1;
      out += " ";
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

export function classifyShellCommand(command) {
  if (typeof command !== "string" || command.includes("\0")) return { kind: "process" };
  const exposed = unquotedCommandText(command);
  if (
    /\.write_text\b|\btee\s|open\([^)]*['\"]w/.test(exposed) ||
    /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|writeSync)\s*\(/.test(exposed) ||
    /\b(?:Set-Content|Add-Content|Out-File|Set-Item|Clear-Content)\b/i.test(exposed) ||
    /(?:^|[\s;|&])sed(?:\s+-[A-Za-z]*i[A-Za-z0-9.]*|\s+--in-place\b)/.test(exposed) ||
    /(?:^|[\s;|&])perl(?:\s+-[A-Za-z]*i[A-Za-z]*)/.test(exposed)
  ) {
    return { kind: "write" };
  }
  if (unquotedFileRedirect(command)) {
    return { kind: "write" };
  }
  const standalone = standalonePathRead(command);
  if (standalone) return { kind: "read_file", args: { target_file: standalone } };
  const encodedScript = decodePowershellEncodedCommand(command);
  if (encodedScript) return classifyShellCommand(encodedScript);
  const pipedGrep = /^(?:set -o pipefail; )?rg --line-number --color never --max-count 50 -e (.+?)(?: --glob (.+))? -- (.+?) \| (head -n 50|Select-Object -First 50)$/u.exec(command.trim());
  if (pipedGrep) {
    const quote = pipedGrep[4].startsWith("Select-Object") ? unquotePowershell : unquotePosix;
    const pattern = quote(pipedGrep[1]);
    const path = quote(pipedGrep[3]);
    if (pattern && path) {
      const args = { pattern, path };
      if (pipedGrep[2]) {
        const glob = quote(pipedGrep[2]);
        if (glob) args.glob = glob;
      }
      return { kind: "grep", args };
    }
  }
  const psRead = /^Get-Content -LiteralPath ('(?:''|[^']*)') \| Select-Object -Skip (\d+) -First (\d+)$/u.exec(command.trim());
  if (psRead) {
    const target_file = unquotePowershell(psRead[1]);
    if (target_file) {
      return {
        kind: "read_file",
        args: { target_file, offset: Number(psRead[2]) + 1, limit: Number(psRead[3]) },
      };
    }
  }
  const psList = /^Get-ChildItem -LiteralPath ('(?:''|[^']*)')$/u.exec(command.trim());
  if (psList) {
    const target_directory = unquotePowershell(psList[1]);
    if (target_directory) return { kind: "list_dir", args: { target_directory } };
  }
  const line = singleLineCommand(command);
  if (!line) return { kind: "process" };
  const sed = /^sed -n '(\d+),(\d+)p'(?: --)? (.+)$/u.exec(line);
  if (sed) {
    const target_file = unquotedOrPosix(sed[3]);
    if (!target_file) return { kind: "process" };
    return {
      kind: "read_file",
      args: { target_file, offset: Number(sed[1]), limit: Number(sed[2]) - Number(sed[1]) + 1 },
    };
  }
  const cat = /^cat(?:\s+(.*))?$/u.exec(line);
  if (cat) {
    const operand = singleOperandPath(cat[1]);
    if (operand.option || operand.none || operand.multi) return { kind: "process" };
    return { kind: "read_file", args: { target_file: operand.path } };
  }
  const head = /^head(?:\s+(.*))?$/u.exec(line);
  if (head) {
    const operand = singleOperandPath(head[1]);
    if (operand.option || operand.none || operand.multi) return { kind: "process" };
    return { kind: "read_file", args: { target_file: operand.path, offset: 1, limit: DEFAULT_HEAD_LIMIT } };
  }
  const rg = /^(?:rg|grep) (?:-[nI]+\s+)?(.+)$/u.exec(line);
  if (rg && !/\snode_modules\/.*dist/.test(line)) {
    // Keep raw rg as grep only when it's a simple `rg -n pattern path` or our canonical form.
    const canonical = /^rg --line-number --color never --max-count 50 -e (.+?)(?: --glob (.+))? -- (.+?)(?: \| head -n 50)?$/u.exec(line);
    if (canonical) {
      const pattern = unquotePosix(canonical[1]);
      const path = unquotePosix(canonical[3]);
      if (!pattern || !path) return { kind: "process" };
      const args = { pattern, path };
      if (canonical[2]) {
        const glob = unquotePosix(canonical[2]);
        if (!glob) return { kind: "process" };
        args.glob = glob;
      }
      return { kind: "grep", args };
    }
    const simple = /^rg -n (\S+) (.+)$/u.exec(line);
    if (simple) {
      const pattern = unquotedOrPosix(simple[1]);
      const path = unquotedOrPosix(simple[2]);
      if (pattern && path) return { kind: "grep", args: { pattern, path } };
    }
  }
  const canonicalLs = /^ls -la (.+)$/u.exec(line);
  if (canonicalLs) {
    const operand = singleOperandPath(canonicalLs[1]);
    if (operand.path) return { kind: "list_dir", args: { target_directory: operand.path } };
  }
  const ls = /^ls(?:\s+(.*))?$/u.exec(line);
  if (ls) {
    const operand = singleOperandPath(ls[1]);
    if (operand.option || operand.multi) return { kind: "process" };
    const target_directory = operand.none ? "." : operand.path;
    if (!target_directory) return { kind: "process" };
    return { kind: "list_dir", args: { target_directory } };
  }
  return { kind: "process" };
}

export function compileRunTerminalCommand(argumentsText, platform = process.platform) {
  const value = parseExactObject(argumentsText, ["command"], ["working_directory"]);
  if (!value || typeof value.command !== "string" || !value.command) return undefined;
  if (value.command.includes("\0")) return undefined;
  if (Object.hasOwn(value, "working_directory") && (typeof value.working_directory !== "string" || value.working_directory.length === 0)) {
    return undefined;
  }
  const workdir = value.working_directory;
  const classified = classifyShellCommand(value.command);
  if (classified.kind === "read_file") {
    return compileReadFileCommand(JSON.stringify(classified.args), workdir, platform);
  }
  if (classified.kind === "grep") {
    return compileGrepCommand(JSON.stringify(classified.args), workdir, platform);
  }
  if (classified.kind === "list_dir") {
    return compileListDirCommand(JSON.stringify(classified.args), workdir, platform);
  }
  if (classified.kind === "write") {
    return JSON.stringify({ cmd: SHELL_NOT_EDITOR_COMMAND });
  }
  return withWorkdir({ cmd: value.command }, workdir);
}

function unquotePosix(value) {
  if (typeof value !== "string" || !value.startsWith("'") || !value.endsWith("'")) return undefined;
  return value.slice(1, -1).replace(/'\\''/g, "'");
}

function unquotePowershell(value) {
  if (typeof value !== "string" || value.length < 2 || !value.startsWith("'") || !value.endsWith("'")) {
    return undefined;
  }
  return value.slice(1, -1).replace(/''/g, "'");
}

function parseExecPayload(argumentsText) {
  const value = parseFacadeObject(argumentsText);
  if (!value || typeof value.cmd !== "string") return undefined;
  return value;
}

export function encodeExecCommandHistory(argumentsText) {
  const value = parseExecPayload(argumentsText);
  if (!value) return undefined;
  if (typeof value.workdir === "string" && value.workdir) {
    return {
      name: RUN_TERMINAL_COMMAND_TOOL_NAME,
      arguments: JSON.stringify({ command: value.cmd, working_directory: value.workdir }),
    };
  }
  const classified = classifyShellCommand(value.cmd);
  if (classified.kind === "read_file") {
    return { name: READ_FILE_TOOL_NAME, arguments: JSON.stringify(classified.args) };
  }
  if (classified.kind === "grep") {
    return { name: GREP_TOOL_NAME, arguments: JSON.stringify(classified.args) };
  }
  if (classified.kind === "list_dir") {
    const args = classified.args?.target_directory === "." ? {} : classified.args;
    return { name: LIST_DIR_TOOL_NAME, arguments: JSON.stringify(args ?? {}) };
  }
  const encoded = { command: value.cmd };
  if (typeof value.workdir === "string" && value.workdir) encoded.working_directory = value.workdir;
  return { name: RUN_TERMINAL_COMMAND_TOOL_NAME, arguments: JSON.stringify(encoded) };
}

function isNativeExecHistory(item, nativeExec) {
  const target = nativeExec && typeof nativeExec === "object"
    ? nativeExec
    : { nativeName: "exec_command" };
  if (item?.type !== "function_call" || typeof item.name !== "string" || !target.nativeName) return false;
  if (target.nativeNamespace) {
    if (item.namespace === target.nativeNamespace && item.name === target.nativeName) return true;
    return item.namespace === undefined && item.name === `${target.nativeNamespace}__${target.nativeName}`;
  }
  return item.namespace === undefined && item.name === target.nativeName;
}

function facadeAliasOffered(name, installed) {
  return !(installed instanceof Set) || installed.has(name);
}

export function encodeGrokFacadeHistory(input, nativeExec, installed) {
  if (!Array.isArray(input)) return input;
  let changed = false;
  const routed = input.map((item) => {
    if (item?.type !== "function_call" || typeof item.name !== "string") return item;
    if (isNativeExecHistory(item, nativeExec)) {
      const encoded = encodeExecCommandHistory(item.arguments);
      if (!encoded || !facadeAliasOffered(encoded.name, installed)) return item;
      changed = true;
      const { name: _name, arguments: _arguments, namespace: _namespace, ...rest } = item;
      return { ...rest, name: encoded.name, arguments: encoded.arguments };
    }
    if (item.namespace === undefined && item.name === "apply_patch") {
      const value = parseFacadeObject(item.arguments);
      if (!value) return item;
      if (Object.hasOwn(value, "old_string") || Object.hasOwn(value, "contents")) {
        const name = Object.hasOwn(value, "contents") ? WRITE_TOOL_NAME : SEARCH_REPLACE_TOOL_NAME;
        if (!facadeAliasOffered(name, installed)) return item;
        changed = true;
        const { name: _name, namespace: _namespace, ...rest } = item;
        return { ...rest, name, arguments: item.arguments };
      }
      if (typeof value.input === "string" && value.input.includes("*** Begin Patch")) {
        return item;
      }
    }
    return item;
  });
  return changed ? routed : input;
}

function hideNativeTools(tools, nativeExec, installed, existing) {
  const hide = new Set(["shell_command"]);
  const readCollided = existing instanceof Set && (
    existing.has(READ_FILE_TOOL_NAME) || existing.has(GREP_TOOL_NAME) || existing.has(LIST_DIR_TOOL_NAME)
  );
  if (installed instanceof Set && installed.has(RUN_TERMINAL_COMMAND_TOOL_NAME) && !readCollided) {
    hide.add("exec_command");
    if (nativeExec?.nativeNamespace) hide.add(`${nativeExec.nativeNamespace}__exec_command`);
  }
  return tools.filter((tool) => {
    if (typeof tool?.name !== "string" || !hide.has(tool.name)) return true;
    return tool.type === "custom";
  });
}

export function grokEditFacadeEnabled(route, structuredPatch) {
  return structuredPatch === true && route?.slug === GROK_EDIT_FACADE_ROUTE;
}

export function applyGrokEditFacade(tools, namespaces, route, structuredPatch, options = {}) {
  if (!grokEditFacadeEnabled(route, structuredPatch) || !Array.isArray(tools)) return tools;
  const existing = new Set(
    tools
      .map((tool) => (typeof tool?.name === "string" ? tool.name : ""))
      .filter(Boolean),
  );
  const aliases = [];
  const extra = [];
  const allowWrite = options.patchHook === true;
  const installed = options.installed instanceof Set ? options.installed : new Set();
  for (const tool of FACADE_TOOLS) {
    if (existing.has(tool.name)) continue;
    if ((tool.name === WRITE_TOOL_NAME || tool.name === SEARCH_REPLACE_TOOL_NAME) && !allowWrite) continue;
    aliases.push({
      providerName: tool.name,
      nativeName: "apply_patch",
      codec: tool.codec,
    });
    extra.push({
      type: "function",
      name: tool.name,
      description: tool.codec.description(),
      parameters: tool.codec.parameters,
    });
    installed.add(tool.name);
  }
  const nativeExec = nativeExecRelayTarget(tools, namespaces);
  const functionRelays = [];
  if (nativeExec) {
    if (!existing.has(READ_FILE_TOOL_NAME)) {
      functionRelays.push({
        providerName: READ_FILE_TOOL_NAME,
        nativeName: nativeExec.nativeName,
        nativeNamespace: nativeExec.nativeNamespace,
        rewriteArguments: compileReadFileCommand,
        maxArgumentBytes: MAX_STRUCTURED_PATCH_BYTES,
      });
      extra.push({
        type: "function",
        name: READ_FILE_TOOL_NAME,
        description: "Read a bounded slice of a local file. Defaults to 400 lines.",
        parameters: READ_FILE_PARAMETERS,
      });
      installed.add(READ_FILE_TOOL_NAME);
    }
    if (!existing.has(GREP_TOOL_NAME) && ripgrepAvailable()) {
      functionRelays.push({
        providerName: GREP_TOOL_NAME,
        nativeName: nativeExec.nativeName,
        nativeNamespace: nativeExec.nativeNamespace,
        rewriteArguments: compileGrepCommand,
        maxArgumentBytes: MAX_STRUCTURED_PATCH_BYTES,
      });
      extra.push({
        type: "function",
        name: GREP_TOOL_NAME,
        description: "Search local file contents with a regex. Optional path and glob.",
        parameters: GREP_PARAMETERS,
      });
      installed.add(GREP_TOOL_NAME);
    }
    if (!existing.has(LIST_DIR_TOOL_NAME)) {
      functionRelays.push({
        providerName: LIST_DIR_TOOL_NAME,
        nativeName: nativeExec.nativeName,
        nativeNamespace: nativeExec.nativeNamespace,
        rewriteArguments: compileListDirCommand,
        maxArgumentBytes: MAX_STRUCTURED_PATCH_BYTES,
      });
      extra.push({
        type: "function",
        name: LIST_DIR_TOOL_NAME,
        description: "List a local directory.",
        parameters: LIST_DIR_PARAMETERS,
      });
      installed.add(LIST_DIR_TOOL_NAME);
    }
    if (!existing.has(RUN_TERMINAL_COMMAND_TOOL_NAME)) {
      functionRelays.push({
        providerName: RUN_TERMINAL_COMMAND_TOOL_NAME,
        nativeName: nativeExec.nativeName,
        nativeNamespace: nativeExec.nativeNamespace,
        rewriteArguments: compileRunTerminalCommand,
        maxArgumentBytes: MAX_STRUCTURED_PATCH_BYTES,
      });
      extra.push({
        type: "function",
        name: RUN_TERMINAL_COMMAND_TOOL_NAME,
        description: "Run a shell command for git, tests, and installs.",
        parameters: RUN_TERMINAL_COMMAND_PARAMETERS,
      });
      installed.add(RUN_TERMINAL_COMMAND_TOOL_NAME);
    }
  }
  if (aliases.length && !registerCustomToolRelays(namespaces, aliases)) {
    return tools;
  }
  if (functionRelays.length && !registerFunctionRelays(namespaces, functionRelays)) {
    return aliases.length ? [...tools, ...extra.filter((tool) => tool.name === SEARCH_REPLACE_TOOL_NAME || tool.name === WRITE_TOOL_NAME)] : tools;
  }
  if (extra.length === 0) return hideNativeTools(tools, nativeExec, installed, existing);
  return hideNativeTools([...tools, ...extra], nativeExec, installed, existing);
}
