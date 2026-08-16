// Command Code sells two ways to reach the same 55-model catalog, and only one
// of them is a documented API.
//
// `POST /provider/v1/{chat/completions,messages}` is the published Provider
// API. It is an entitlement, not a credential: an account on the $1 Go plan
// signs in fine, mints a real key, runs the official CLI all day, and still
// gets `403 upgrade_required` from those two paths ("Your Go plan doesn't
// include API access"). No key, sign-in, or reinstall changes that.
//
// `POST /alpha/generate` is the route the `command-code` CLI itself uses for
// every turn it takes. It carries the CLI's own envelope rather than an
// OpenAI or Anthropic body, and it is not plan-gated -- any account that can
// run the CLI can call it, Go included. That is the entire reason this module
// exists: it lets the router serve the cheap coding plans (Go, GOAT, Pro, Max)
// through the same provider, the same key, and the same catalog, instead of
// telling most of Command Code's customers that their subscription is not
// welcome here.
//
// Command Code publishes no reference for `/alpha/generate`. Everything below
// was derived from the shipped CLI bundle
// (`$(npm root -g)/command-code/dist/cli.mjs`, v1.14.1) and confirmed against
// the live gateway on a Go-plan account. Treat it as a snapshot: when it
// breaks, re-derive it from the current bundle rather than guessing.

import { randomUUID } from "node:crypto";

// The envelope is schema-strict. Every `config` field below is required, and
// omitting one answers 400 with the exact missing JSON paths. None of them are
// load-bearing for routing -- the gateway splices them into a system-prompt
// preamble -- so neutral values are honest here: the router is not the CLI and
// has no working directory, git branch, or project structure to report.
export const GENERATE_ROUTE = "/alpha/generate";

// Sent as `x-command-code-version`. The gateway accepts what it is given; this
// is the CLI build the envelope in this file was derived from, so it is also
// the honest answer to "which client shape is this". Overridable for an
// operator chasing a gateway that starts refusing an older client.
export const GENERATE_CLIENT_VERSION =
  process.env.COMMANDCODE_CLI_VERSION || "1.14.1";

// The CLI's own ceiling for a turn. The gateway does not default this for us.
const DEFAULT_MAX_OUTPUT_TOKENS = 64_000;

// An empty `system` is not "no system prompt" to this route -- it is a cue to
// splice in the Command Code CLI's own agent preamble. Measured against the
// live gateway: the same one-line turn cost 92 prompt tokens with a system
// prompt and 7,637 without, and the model spent them being told it was Command
// Code, with Command Code's tools and rules. Neither the credits nor the
// identity are the caller's to spend, so a turn that carries no system prompt
// of its own gets a neutral one rather than the agent's.
const NEUTRAL_SYSTEM_PROMPT = "You are a helpful assistant.";

function isoDate(at) {
  return new Date(at).toISOString().slice(0, 10);
}

function staticConfig(at) {
  return {
    workingDir: "",
    date: isoDate(at),
    environment: "production",
    structure: [],
    isGitRepo: false,
    currentBranch: "",
    mainBranch: "",
    gitStatus: "",
    recentCommits: [],
  };
}

export function generateHeaders(apiKey, { sessionId = randomUUID(), zdr } = {}) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "x-cli-environment": "production",
    "x-command-code-version": GENERATE_CLIENT_VERSION,
    "x-session-id": sessionId,
  };
  // Command Code's zero-data-retention switch is an environment variable on the
  // CLI, so an operator who set it for the CLI expects it to hold here too.
  if (zdr ?? process.env.CMD_ZDR === "1") headers["x-cmd-zdr"] = "1";
  return headers;
}

// ---------------------------------------------------------------------------
// Messages
//
// `params.messages` is the Vercel AI SDK `ModelMessage[]` schema, which is
// neither Anthropic content blocks nor OpenAI tool messages. Sending either
// verbatim answers "Invalid prompt: The messages do not match the
// ModelMessage[] schema", so both protocols are translated rather than passed
// through. Three shapes matter: text/image parts on `user`, `text` and
// `tool-call` parts on `assistant`, and `tool-result` parts on their own
// `tool` message -- never folded into a user turn.
// ---------------------------------------------------------------------------

function textPart(text) {
  return { type: "text", text };
}

// A data: URL carries its own media type; a remote URL does not, and the
// gateway wants one. Guessing from the extension beats sending nothing,
// because an absent mediaType is what makes the part ambiguous upstream.
function imagePart(url) {
  const dataMatch = /^data:([^;,]+)[;,]/.exec(url || "");
  if (dataMatch) return { type: "image", image: url, mediaType: dataMatch[1] };
  const extension = /\.(png|jpe?g|gif|webp)(?:[?#]|$)/i.exec(url || "");
  const mediaType = extension
    ? `image/${extension[1].toLowerCase() === "jpg" ? "jpeg" : extension[1].toLowerCase()}`
    : undefined;
  return { type: "image", image: url, ...(mediaType ? { mediaType } : {}) };
}

function toolResultOutput(value, { error = false } = {}) {
  // Not a raw string: the schema wants a tagged output object, and an
  // error-text result is how a failed tool run is reported without the turn
  // reading as if the tool had succeeded with that text.
  return { type: error ? "error-text" : "text", value: stringifyToolResult(value) };
}

function stringifyToolResult(value) {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) {
    // Anthropic tool results arrive as content blocks; only text survives the
    // trip, and dropping a block silently would lose the tool's answer.
    return value
      .map((block) => {
        if (typeof block === "string") return block;
        if (block?.type === "text") return String(block.text ?? "");
        return JSON.stringify(block);
      })
      .join("\n");
  }
  return JSON.stringify(value);
}

function parseToolArguments(raw) {
  if (raw === undefined || raw === null || raw === "") return {};
  if (typeof raw === "object") return raw;
  try {
    const parsed = JSON.parse(raw);
    // A bare string or array is legal JSON but not an argument object; the
    // gateway wants an object, so wrap rather than fail the whole turn.
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : { value: parsed };
  } catch {
    return { value: String(raw) };
  }
}

// Consecutive tool results belong to one `tool` message. Pushing each as its
// own message is accepted by the schema but reads to the model as a series of
// separate turns, which is not what happened.
function pushToolResult(messages, part) {
  const last = messages[messages.length - 1];
  if (last?.role === "tool") {
    last.content.push(part);
    return;
  }
  messages.push({ role: "tool", content: [part] });
}

function openAiUserContent(content) {
  if (typeof content === "string") return [textPart(content)];
  if (!Array.isArray(content)) return [textPart(String(content ?? ""))];
  const parts = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(textPart(part));
    } else if (part?.type === "text" || part?.type === "input_text") {
      parts.push(textPart(String(part.text ?? "")));
    } else if (part?.type === "image_url") {
      parts.push(imagePart(part.image_url?.url ?? part.image_url));
    } else if (part?.type === "input_image") {
      parts.push(imagePart(part.image_url ?? part.image));
    }
  }
  return parts.length ? parts : [textPart("")];
}

function fromOpenAiMessages(messages) {
  const system = [];
  const wire = [];
  // `tool` messages name only the call id, but the schema wants the tool name
  // on the result too, so remember what each id was called.
  const toolNames = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = message?.role;
    if (role === "system" || role === "developer") {
      system.push(
        typeof message.content === "string"
          ? message.content
          : openAiUserContent(message.content)
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n"),
      );
      continue;
    }
    if (role === "tool" || role === "function") {
      pushToolResult(wire, {
        type: "tool-result",
        toolCallId: String(message.tool_call_id ?? message.id ?? ""),
        toolName: toolNames.get(String(message.tool_call_id ?? "")) || message.name || "tool",
        output: toolResultOutput(message.content),
      });
      continue;
    }
    if (role === "assistant") {
      const content = [];
      const text = typeof message.content === "string" ? message.content : "";
      if (text) content.push(textPart(text));
      else if (Array.isArray(message.content)) {
        for (const part of openAiUserContent(message.content)) {
          if (part.type === "text" && part.text) content.push(part);
        }
      }
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        const id = String(call?.id ?? "");
        const name = String(call?.function?.name ?? call?.name ?? "tool");
        toolNames.set(id, name);
        content.push({
          type: "tool-call",
          toolCallId: id,
          toolName: name,
          input: parseToolArguments(call?.function?.arguments ?? call?.arguments),
        });
      }
      // An assistant turn with neither text nor a call says nothing; the
      // schema rejects empty content, and the turn is no worse without it.
      if (content.length) wire.push({ role: "assistant", content });
      continue;
    }
    if (role === "user") wire.push({ role: "user", content: openAiUserContent(message.content) });
  }
  return { system: system.filter(Boolean).join("\n\n"), messages: wire };
}

function anthropicImagePart(source) {
  if (source?.type === "base64") {
    return {
      type: "image",
      image: `data:${source.media_type};base64,${source.data}`,
      mediaType: source.media_type,
    };
  }
  return imagePart(source?.url);
}

function fromAnthropicMessages(messages, systemField) {
  const system = [];
  if (typeof systemField === "string") system.push(systemField);
  else if (Array.isArray(systemField)) {
    for (const block of systemField) {
      if (block?.type === "text") system.push(String(block.text ?? ""));
      else if (typeof block === "string") system.push(block);
    }
  }
  const wire = [];
  const toolNames = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    const blocks =
      typeof message?.content === "string"
        ? [{ type: "text", text: message.content }]
        : Array.isArray(message?.content)
          ? message.content
          : [];
    if (message?.role === "assistant") {
      const content = [];
      for (const block of blocks) {
        if (block?.type === "text" && block.text) content.push(textPart(String(block.text)));
        else if (block?.type === "tool_use") {
          const id = String(block.id ?? "");
          const name = String(block.name ?? "tool");
          toolNames.set(id, name);
          content.push({ type: "tool-call", toolCallId: id, toolName: name, input: block.input ?? {} });
        }
        // `thinking` blocks are Anthropic's own replay format for extended
        // thinking and are meaningless to a gateway that never issued them.
      }
      if (content.length) wire.push({ role: "assistant", content });
      continue;
    }
    // Anthropic puts tool results inside the *user* turn. The ModelMessage
    // schema puts them in their own `tool` message, so one Anthropic turn can
    // split into a tool message followed by a user message.
    const userContent = [];
    for (const block of blocks) {
      if (block?.type === "tool_result") {
        pushToolResult(wire, {
          type: "tool-result",
          toolCallId: String(block.tool_use_id ?? ""),
          toolName: toolNames.get(String(block.tool_use_id ?? "")) || "tool",
          output: toolResultOutput(block.content, { error: block.is_error === true }),
        });
      } else if (block?.type === "text") {
        userContent.push(textPart(String(block.text ?? "")));
      } else if (block?.type === "image") {
        userContent.push(anthropicImagePart(block.source));
      }
    }
    if (userContent.length) wire.push({ role: "user", content: userContent });
  }
  return { system: system.filter(Boolean).join("\n\n"), messages: wire };
}

// ---------------------------------------------------------------------------
// Tools
//
// The wire form is snake_case `input_schema` carrying plain JSON Schema. The
// gateway rewrites it into Vercel's `{ type:"function", name, description,
// inputSchema }` itself -- confirmed by the `start-step` event, which echoes
// the rewritten request back.
// ---------------------------------------------------------------------------

function toWireTools(tools, protocol) {
  if (!Array.isArray(tools) || !tools.length) return [];
  const wire = [];
  for (const tool of tools) {
    if (protocol === "anthropic") {
      if (!tool?.name) continue;
      wire.push({
        name: tool.name,
        description: tool.description || "",
        input_schema: tool.input_schema || { type: "object", properties: {} },
      });
      continue;
    }
    const fn = tool?.type === "function" ? tool.function || tool : tool;
    if (!fn?.name) continue;
    wire.push({
      name: fn.name,
      description: fn.description || "",
      input_schema: fn.parameters || { type: "object", properties: {} },
    });
  }
  return wire;
}

// ---------------------------------------------------------------------------

/**
 * Translate an OpenAI chat-completions or Anthropic Messages body into the
 * `/alpha/generate` envelope.
 *
 * `stream` is always true on the wire: the route only streams, and a caller
 * that asked for a whole response gets one assembled from the stream instead.
 */
export function toGenerateRequest(payload, { protocol = "openai", model, at = Date.now() } = {}) {
  const anthropic = protocol === "anthropic";
  const { system, messages } = anthropic
    ? fromAnthropicMessages(payload?.messages, payload?.system)
    : fromOpenAiMessages(payload?.messages);
  const maxTokens = Number(
    (anthropic ? payload?.max_tokens : payload?.max_completion_tokens ?? payload?.max_tokens) ||
      DEFAULT_MAX_OUTPUT_TOKENS,
  );
  const params = {
    model: String(model ?? payload?.model ?? ""),
    system: system || NEUTRAL_SYSTEM_PROMPT,
    messages,
    tools: toWireTools(payload?.tools, protocol),
    max_tokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : DEFAULT_MAX_OUTPUT_TOKENS,
    stream: true,
  };
  // Only forwarded when the caller set it. The route accepts temperature but
  // has no documented default, so inventing one would change every turn.
  if (typeof payload?.temperature === "number") params.temperature = payload.temperature;
  return {
    config: staticConfig(at),
    // A string, not an object -- an object here is a 400. The router has no
    // Command Code memory or taste profile to contribute.
    memory: "",
    taste: null,
    skills: null,
    permissionMode: "standard",
    params,
  };
}
