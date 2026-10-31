// OpenCode Zen free-lane wire: public client fingerprint + /inference/v1.
//
// OpenCode answers FreeTierError on free ids unless the request looks like its
// own CLI. The shape below is the documented v2 public client fingerprint used
// by the no-login reference plugin (Ebony-Vinyl/dsh-our-free-model,
// docs/free-lane-wire.md and src/upstream.js): User-Agent
// `opencode/latest/2.0.26/cli`, Authorization Bearer public, the paired session
// headers, official `read`/`shell` tool definitions, and an <env> block. There
// is no per-user secret and no login; the credential is the pooled public
// bearer every anonymous free caller uses.
//
// Re-verified against live opencode.ai on 2026-11-01: /zen/v1/chat/completions
// still answers FreeTierError for free ids; /inference/v1/chat/completions with
// this fingerprint clears the client gate (FreeUsageLimitError / RegionError
// when the IP is exhausted or geo-blocked, never FreeTierError).

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { STATE_DIR } from "./paths.mjs";

export const OPENCODE_FREE_CLIENT_UA = "opencode/latest/2.0.26/cli";
export const OPENCODE_FREE_INFERENCE_BASE = "https://opencode.ai/inference/v1";
export const OPENCODE_FREE_PUBLIC_BEARER = "public";

const OPENCODE_FREE_LANE_PROVIDER_IDS = new Set([
  "free-opencode",
  "opencode-free",
  "opencode-free-responses",
]);

export function isOpenCodeFreeLaneProvider(provider) {
  return Boolean(provider && OPENCODE_FREE_LANE_PROVIDER_IDS.has(provider.id));
}

const FINGERPRINT_TOOL_DEFINITIONS = Object.freeze({
  read: Object.freeze({
    description:
      "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.",
    parameters: Object.freeze({
      type: "object",
      properties: Object.freeze({
        path: Object.freeze({ type: "string", description: "File or directory to read" }),
        offset: Object.freeze({
          type: "integer",
          minimum: 0,
          description: "The line or directory entry to start reading from (1-based)",
        }),
        limit: Object.freeze({
          type: "integer",
          minimum: 0,
          description:
            "The maximum number of lines or directory entries to read (defaults to and capped at 2000)",
        }),
      }),
      required: Object.freeze(["path"]),
      additionalProperties: false,
    }),
  }),
  shell: Object.freeze({
    description:
      "Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.",
    parameters: Object.freeze({
      type: "object",
      properties: Object.freeze({
        command: Object.freeze({ type: "string", description: "Shell command string to execute" }),
        workdir: Object.freeze({
          type: "string",
          description:
            "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead.",
        }),
        timeout: Object.freeze({
          type: "integer",
          minimum: 0,
          description:
            "Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default.",
        }),
        background: Object.freeze({
          type: "boolean",
          description:
            "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion.",
        }),
      }),
      required: Object.freeze(["command"]),
      additionalProperties: false,
    }),
  }),
});

export const FINGERPRINT_TOOLS = Object.freeze(["read", "shell"]);

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
export const SESSION_DESCENDING_RE = /^[0-9a-f]{9}f[c-f][0-9a-f]$/;

export function isCanonicalOpenCodeFreeSession(id) {
  return typeof id === "string" &&
    SESSION_RE.test(id.trim()) &&
    SESSION_DESCENDING_RE.test(id.trim().slice(4, 16));
}

function base62From(bytes) {
  let out = "";
  for (const byte of bytes) out += BASE62[byte % 62];
  return out;
}

let lastStamp = 0;
let seq = 0;

/** Mint a gateway-shaped session id: descending time hex + base62 entropy. */
export function mintOpenCodeFreeSessionId(timestamp = Date.now()) {
  if (timestamp !== lastStamp) {
    lastStamp = timestamp;
    seq = 0;
  }
  seq += 1;
  const value = ~(BigInt(timestamp) * 0x1000n + BigInt(seq));
  let hex = "";
  for (let i = 0; i < 6; i += 1) {
    hex += Number((value >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, "0");
  }
  return `ses_${hex}${base62From(randomBytes(14))}`;
}

const SESSION_MAP_PATH = path.join(STATE_DIR, "opencode-free-sessions.json");
let sessions;

function loadSessions() {
  if (sessions !== undefined) return sessions;
  sessions = new Map();
  try {
    if (!existsSync(SESSION_MAP_PATH)) return sessions;
    const parsed = JSON.parse(readFileSync(SESSION_MAP_PATH, "utf8"));
    for (const [seed, id] of Object.entries(parsed?.sessions ?? {})) {
      if (typeof id === "string" && isCanonicalOpenCodeFreeSession(id)) sessions.set(seed, id);
    }
  } catch {
    // First run or unreadable store: start empty.
  }
  return sessions;
}

function rememberSession(seed, id) {
  loadSessions().set(seed, id);
  try {
    mkdirSync(path.dirname(SESSION_MAP_PATH), { recursive: true });
    const temp = `${SESSION_MAP_PATH}.tmp`;
    writeFileSync(
      temp,
      JSON.stringify({ version: 1, at: Date.now(), sessions: Object.fromEntries(sessions) }, null, 2),
    );
    renameSync(temp, SESSION_MAP_PATH);
  } catch {
    // Non-fatal: the id still works for this process.
  }
}

/** Map one downstream conversation onto one stable upstream free-lane session. */
export function openCodeFreeSessionForConversation(sessionId) {
  if (typeof sessionId === "string" && isCanonicalOpenCodeFreeSession(sessionId)) {
    return sessionId.trim();
  }
  const seed = typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : "global";
  const remembered = loadSessions().get(seed);
  if (remembered !== undefined && isCanonicalOpenCodeFreeSession(remembered)) return remembered;
  const minted = mintOpenCodeFreeSessionId();
  rememberSession(seed, minted);
  return minted;
}

function placeholderNote(names) {
  const list = names.map((name) => `\`${name}\``).join(" or ");
  return names.length > 1
    ? `Do not call the ${list} tools; they are placeholders that do nothing. Use the other tools you have been given instead.`
    : `Do not call the ${list} tool; it is a placeholder that does nothing. Use the other tools you have been given instead.`;
}

function toolNameOf(tool) {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return "";
  if (typeof tool.name === "string" && tool.name.trim()) return tool.name.trim();
  const fn = tool.function;
  if (fn && typeof fn === "object" && !Array.isArray(fn) && typeof fn.name === "string") {
    return fn.name.trim();
  }
  return "";
}

function fingerprintKey(name) {
  const trimmed = String(name ?? "").trim();
  return FINGERPRINT_TOOLS.includes(trimmed) ? trimmed : "";
}

function functionOf(tool) {
  return tool.function && typeof tool.function === "object" && !Array.isArray(tool.function)
    ? tool.function
    : null;
}

function definitionOf(tool, { claude, flat }) {
  const wrapper = claude || flat ? tool : functionOf(tool);
  if (wrapper === null || wrapper === undefined) return null;
  return { description: wrapper.description, schema: claude ? wrapper.input_schema : wrapper.parameters };
}

function carriesFingerprintDefinition(tool, name, shape) {
  const own = definitionOf(tool, shape);
  if (own === null) return false;
  const want = FINGERPRINT_TOOL_DEFINITIONS[name];
  return own.description === want.description &&
    JSON.stringify(own.schema) === JSON.stringify(want.parameters);
}

function withToolName(tool, name) {
  const fn = functionOf(tool);
  return fn ? { ...tool, function: { ...fn, name } } : { ...tool, name };
}

function fingerprintTool(name, { claude, flat }) {
  const { description, parameters } = FINGERPRINT_TOOL_DEFINITIONS[name];
  if (claude) return { name, description, input_schema: structuredClone(parameters) };
  if (flat) return { type: "function", name, description, parameters: structuredClone(parameters) };
  return {
    type: "function",
    function: { name, description, parameters: structuredClone(parameters) },
  };
}

function aliasesByOriginal(map) {
  return new Map([...map].map(([alias, original]) => [original, alias]));
}

function retargetToolChoice(body, map) {
  if (!body || typeof body !== "object" || map.size === 0) return;
  const choice = body.tool_choice;
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) return;
  const aliases = aliasesByOriginal(map);
  if (typeof choice.name === "string") {
    const alias = aliases.get(choice.name.trim());
    if (alias !== undefined) body.tool_choice = { ...choice, name: alias };
    return;
  }
  const fn = choice.function;
  if (fn && typeof fn === "object" && !Array.isArray(fn) && typeof fn.name === "string") {
    const alias = aliases.get(fn.name.trim());
    if (alias !== undefined) body.tool_choice = { ...choice, function: { ...fn, name: alias } };
  }
}

function aliasHistoryToolCalls(body, map) {
  if (!body || typeof body !== "object" || map.size === 0) return;
  const aliases = aliasesByOriginal(map);

  if (Array.isArray(body.input)) {
    body.input = body.input.map((item) =>
      item?.type === "function_call" && aliases.has(item.name)
        ? { ...item, name: aliases.get(item.name) }
        : item
    );
  }
  if (Array.isArray(body.messages)) {
    body.messages = body.messages.map((message) => {
      if (message === null || typeof message !== "object") return message;
      let next = message;
      if (Array.isArray(message.content)) {
        const content = message.content.map((block) =>
          block?.type === "tool_use" && aliases.has(block.name)
            ? { ...block, name: aliases.get(block.name) }
            : block
        );
        next = { ...next, content };
      }
      if (Array.isArray(message.tool_calls)) {
        next = {
          ...next,
          tool_calls: message.tool_calls.map((call) =>
            aliases.has(call?.function?.name)
              ? { ...call, function: { ...call.function, name: aliases.get(call.function.name) } }
              : call
          ),
        };
      }
      return next;
    });
  }
}

function appendSystemContext(body, { claude, flat }, note) {
  if (flat) {
    body.instructions = typeof body.instructions === "string" && body.instructions.trim() !== ""
      ? `${body.instructions}\n\n${note}`
      : note;
    return;
  }
  if (claude) {
    body.system = Array.isArray(body.system)
      ? [...body.system, { type: "text", text: note }]
      : typeof body.system === "string" && body.system !== ""
        ? `${body.system}\n\n${note}`
        : note;
    return;
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const first = messages[0];
  if (first?.role === "system" && typeof first.content === "string") {
    body.messages = [{ ...first, content: `${first.content}\n\n${note}` }, ...messages.slice(1)];
    return;
  }
  if (first?.role === "system" && Array.isArray(first.content)) {
    body.messages = [
      { ...first, content: [...first.content, { type: "text", text: note }] },
      ...messages.slice(1),
    ];
    return;
  }
  body.messages = [{ role: "system", content: note }, ...messages];
}

function noteInjectedTools(body, shape, names) {
  appendSystemContext(body, shape, placeholderNote(names));
}

export function ensureOpenCodeFreeLaneEnvironment(body, style, environment = {}) {
  const shape = { flat: style === true, claude: style === "claude" };
  const textOf = (value) =>
    typeof value === "string"
      ? value
      : Array.isArray(value)
        ? value.map((part) => part?.text ?? "").join("\n")
        : "";
  const existing = shape.flat
    ? textOf(body.instructions)
    : shape.claude
      ? textOf(body.system)
      : (Array.isArray(body.messages) ? body.messages : [])
        .filter((message) => message?.role === "system" || message?.role === "developer")
        .map((message) => textOf(message.content))
        .join("\n");
  if (/<env>[\s\S]*?<\/env>/i.test(existing)) return;
  const line = (value) => String(value).replace(/[\r\n<>]/g, " ");
  const cwd = environment.directory ?? process.cwd();
  const platform = environment.platform ?? process.platform;
  appendSystemContext(
    body,
    shape,
    `Here is some useful information about the environment you are running in:\n<env>\n  Working directory: ${line(cwd)}\n  Platform: ${line(platform)}\n</env>`,
  );
}

const FREE_LANE_TOOL_ALIASES = Object.freeze({
  subagent_fork: "conversation_delegate",
  working_directory: "workspace_directory",
});

/**
 * Satisfy the v2 free-tier fingerprint gate on body.tools.
 * @param {object} body mutated in place
 * @param {boolean|"claude"} style true = Responses, false = Chat, "claude" = Messages
 * @returns {Map<string, string>} sent name -> caller's name
 */
export function applyOpenCodeFreeFingerprint(body, style) {
  const flat = style === true;
  const claude = style === "claude";
  const shape = { claude, flat };
  const map = new Map();
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const taken = new Set(tools.map(toolNameOf).filter((name) => name !== ""));
  const seen = new Set();
  const present = new Set();
  const out = [];
  const compatibilityAliases = [];

  for (const tool of tools) {
    const name = toolNameOf(tool);
    const compatibilityBase = Object.hasOwn(FREE_LANE_TOOL_ALIASES, name)
      ? FREE_LANE_TOOL_ALIASES[name]
      : undefined;
    if (compatibilityBase !== undefined) {
      let alias = compatibilityBase;
      for (let i = 2; taken.has(alias); i += 1) alias = `${compatibilityBase}${i}`;
      taken.add(alias);
      map.set(alias, name);
      compatibilityAliases.push({ alias, original: name });
      out.push(withToolName(tool, alias));
      continue;
    }
    const key = fingerprintKey(name);
    if (key === "") {
      out.push(tool);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    if (carriesFingerprintDefinition(tool, key, shape)) {
      out.push(tool);
      present.add(key);
      continue;
    }
    let alias = `${key}_client`;
    for (let i = 2; taken.has(alias); i += 1) alias = `${key}_client${i}`;
    taken.add(alias);
    map.set(alias, name);
    out.push(withToolName(tool, alias));
  }

  const injected = [];
  for (const name of FINGERPRINT_TOOLS) {
    if (present.has(name)) continue;
    out.push(fingerprintTool(name, shape));
    injected.push(name);
  }

  body.tools = out;
  retargetToolChoice(body, map);
  aliasHistoryToolCalls(body, map);
  ensureOpenCodeFreeLaneEnvironment(body, style);
  if (injected.length > 0) noteInjectedTools(body, shape, injected);
  if (compatibilityAliases.length > 0) {
    appendSystemContext(
      body,
      shape,
      `Tool name mapping for this request: ${compatibilityAliases
        .map(({ alias, original }) => `use \`${alias}\` for \`${original}\``)
        .join("; ")}. These tools retain their original behavior and parameters.`,
    );
  }
  if (
    body.tool_choice === "none" ||
    (body.tool_choice !== null &&
      typeof body.tool_choice === "object" &&
      body.tool_choice.type === "none")
  ) {
    delete body.tool_choice;
  }
  if (flat && !body.tool_choice) body.tool_choice = "auto";
  return map;
}

/** Headers the free-tier gate fingerprints a genuine CLI by. */
export function openCodeFreeLaneHeaders({ session, stream, accept } = {}) {
  const id = typeof session === "string" && session.trim()
    ? openCodeFreeSessionForConversation(session)
    : mintOpenCodeFreeSessionId();
  return {
    Authorization: `Bearer ${OPENCODE_FREE_PUBLIC_BEARER}`,
    "User-Agent": OPENCODE_FREE_CLIENT_UA,
    "x-opencode-client": "cli",
    "x-opencode-session": id,
    "x-opencode-session-id": id,
    "x-session-affinity": id,
    "x-session-id": id,
    "x-opencode-project": "global",
    Accept: accept ?? (stream ? "text/event-stream" : "*/*"),
  };
}

/**
 * Apply free-lane headers onto an upstream header bag. Wins over any earlier
 * User-Agent / Authorization / session merge. Does not send x-opencode-request
 * (v1-only; v2 answers FreeTierError when it is present).
 */
export function applyOpenCodeFreeLaneHeaders(
  target,
  { provider, requestHeaders, body, fallback } = {},
) {
  if (!isOpenCodeFreeLaneProvider(provider)) return false;
  const seed =
    (typeof requestHeaders === "object" &&
      (requestHeaders["x-codex-thread-id"] ||
        requestHeaders["X-Codex-Thread-Id"] ||
        requestHeaders["x-thread-id"])) ||
    fallback ||
    // Stable seed from the conversation when no thread header is present.
    conversationSeed(body) ||
    "global";
  const stream = Boolean(
    body &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      (body.stream === true ||
        (typeof body === "string" && /"stream"\s*:\s*true/.test(body))),
  );
  Object.assign(target, openCodeFreeLaneHeaders({ session: String(seed), stream }));
  // Never leak a v1 request id onto the free lane.
  delete target["x-opencode-request"];
  delete target["X-Opencode-Request"];
  return true;
}

function conversationSeed(body) {
  let payload = body;
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    try {
      payload = JSON.parse(Buffer.from(body).toString("utf8"));
    } catch {
      return undefined;
    }
  } else if (typeof body === "string") {
    try {
      payload = JSON.parse(body);
    } catch {
      return undefined;
    }
  }
  if (!payload || typeof payload !== "object") return undefined;
  const items = Array.isArray(payload.messages)
    ? payload.messages
    : Array.isArray(payload.input)
      ? payload.input
      : [];
  if (!items.length) return undefined;
  const digest = createHash("sha256")
    .update(JSON.stringify(items.slice(0, 2)))
    .digest("hex")
    .slice(0, 32);
  return `conv-${digest}`;
}

/** Fingerprint style for the route the free lane is about to call. */
export function openCodeFreeFingerprintStyle(route) {
  if (route === "/responses") return true;
  if (route === "/messages") return "claude";
  return false;
}

/** Whether this payload still looks like a free-tier client-gate refusal. */
export function isOpenCodeFreeTierError(status, bodyText) {
  if (status !== 403) return false;
  const text = String(bodyText || "");
  return /FreeTierError/i.test(text) || /only be used from within OpenCode/i.test(text);
}
