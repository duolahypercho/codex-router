import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

import { HeaderlessSseDetector } from "./sse-prefix.mjs";
import { coerceFunctionCallArguments } from "./tool-arguments.mjs";
import { providerToolSchema } from "./tool-schema-root.mjs";
import {
  buildInterruptAgentCall,
  filterAlreadyInterrupted,
  formatSseBlock,
  interruptTargetFromCall,
} from "./subagent-completion.mjs";

// The Codex client ships most of its toolset as `type: "namespace"` entries:
// the collaboration runtime, the app toolset (threads, automations,
// navigation), and every MCP server (node_repl, peekaboo, github, ...).
//
// LiteLLM's Responses -> Chat Completions bridge drops namespace tools, which
// is how the app sends all of those to the model. A routed chat-completions
// provider would therefore see none of them: no collaboration tools, no
// threads, and no `mcp__node_repl__js` -- the runtime the in-app browser and
// computer-use skills drive. This module is the one relay for all of it:
//
//   1. flattenNamespaceTools        -- namespace entries -> plain
//                                      `<namespace>__<tool>` functions the
//                                      provider accepts
//   2. flattenNamespacedHistory     -- stored calls renamed to the flattened
//                                      form so the model's transcript matches
//                                      its tool list
//   3. NamespaceToolCallTransform   -- function calls coming back restored to
//                                      the app's native `{name, namespace}`
//                                      shape so the client dispatches them
//
// The router only relays definitions and results; it never executes an app
// tool itself. Namespace names themselves may contain the delimiter
// (`mcp__codex_apps__github`), so restoration always resolves through the map
// built from the exact tools that were flattened -- never by splitting names.

export const NAMESPACE_DELIMITER = "__";

// Metadata derived from the request's exact tool schema. Keeping it beside the
// Map in a WeakMap preserves the Map's public shape for existing callers while
// letting the response path validate model-generated overrides.
const SPAWN_AGENT_MODELS = new WeakMap();

function schemaStringValues(schema, values = new Set()) {
  if (!schema || typeof schema !== "object") return values;
  if (typeof schema.const === "string") values.add(schema.const);
  if (Array.isArray(schema.enum)) {
    for (const value of schema.enum) if (typeof value === "string") values.add(value);
  }
  for (const keyword of ["anyOf", "oneOf", "allOf"]) {
    if (!Array.isArray(schema[keyword])) continue;
    for (const branch of schema[keyword]) schemaStringValues(branch, values);
  }
  return values;
}

// A fresh local thread inherits the routed session model when the caller did
// not choose one. Follow-up messages intentionally keep the target thread's
// settings, and cloud tasks require model omission, so neither is rewritten.
export const SPAWN_MODEL_TOOLS = new Set(["create_thread"]);
const SPAWN_TOOL_PREFIX = `codex_app${NAMESPACE_DELIMITER}`;

function isSpawnModelCall(item) {
  if (!item || typeof item.name !== "string") return false;
  // Flattened form the router sends to chat-completions bridges:
  // `codex_app__create_thread`.
  if (item.name.startsWith(SPAWN_TOOL_PREFIX)) {
    return SPAWN_MODEL_TOOLS.has(item.name.slice(SPAWN_TOOL_PREFIX.length));
  }
  // Native namespace form openai-responses providers keep:
  // `{ name: "create_thread", namespace: "codex_app" }`.
  if (item.namespace === "codex_app") return SPAWN_MODEL_TOOLS.has(item.name);
  return false;
}

// Inject the session model into local create_thread calls that omitted it.
// `model` is the routed session's model (route.slug). Returns a rewritten
// item when the call is one of SPAWN_MODEL_TOOLS, carries no explicit model,
// and a session model is available; otherwise returns the item untouched.
export function injectSessionModelForSpawnCalls(item, model) {
  if (!isSpawnModelCall(item)) return item;
  if (typeof model !== "string" || !model) return item;
  if (typeof item.arguments !== "string") return item;
  let args;
  try {
    args = JSON.parse(item.arguments);
  } catch {
    return item;
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) return item;
  if (args.model !== undefined) return item;
  if (args.target?.type === "chatgptWorkCloud") return item;
  return { ...item, arguments: JSON.stringify({ ...args, model }) };
}

const MAX_JSON_CAPTURE_BYTES = 64 * 1024 * 1024;

// Flatten every namespace entry into plain functions named
// `<namespace>__<tool>`. Returns the set of namespaces that were flattened
// (name -> tool names) so callers can rename history and restore calls.
export function flattenNamespaceTools(tools) {
  if (!Array.isArray(tools)) return { tools, flattened: false, namespaces: new Map() };
  const flattened = [];
  const namespaces = new Map();
  const spawnAgentModels = new Set();
  let changed = false;
  for (const tool of tools) {
    // Codex adds this control tool when one or more namespace tools use
    // deferred loading. By this boundary every namespace is expanded below,
    // so the search control is redundant; chat-completions providers accept
    // only ordinary function tools and reject `type: "tool_search"` before
    // the model can call any MCP function.
    if (tool?.type === "tool_search") {
      changed = true;
      continue;
    }
    if (tool?.type === "namespace" && Array.isArray(tool.tools)) {
      const names = new Set();
      for (const fn of tool.tools) {
        if (!fn?.name) continue;
        // Codex names function schemas `inputSchema`, while LiteLLM's
        // Responses -> Chat Completions adapter reads only `parameters`.
        // Without this alias every flattened namespace child reaches the
        // provider as an empty object schema, so MCP calls cannot receive the
        // arguments their server requires. Keep inputSchema too: it is the
        // client's native representation and responses-native routes retain
        // it untouched.
        //
        // Strict upstreams (Moonshot/Kimi, the xAI CLI proxy) reject the whole
        // request -- not the one tool -- over a union-rooted parameter schema or
        // an enum literal that contradicts its declared type. Codex's own
        // `codex_app__automation_update` ships a `oneOf` root, so a session that
        // never touches automations still dies on its first message. Normalize
        // only the provider-facing copy; `inputSchema` stays exactly as the
        // client sent it.
        const clientSchema = fn.parameters ?? fn.inputSchema;
        const parameters =
          clientSchema === undefined ? undefined : providerToolSchema(clientSchema);
        flattened.push({
          ...fn,
          name: `${tool.name}${NAMESPACE_DELIMITER}${fn.name}`,
          ...(parameters === undefined ? {} : { parameters }),
        });
        names.add(fn.name);
        if (tool.name === "collaboration" && fn.name === "spawn_agent") {
          schemaStringValues(fn.inputSchema?.properties?.model, spawnAgentModels);
        }
      }
      if (names.size > 0) {
        namespaces.set(tool.name, names);
        changed = true;
      }
      continue;
    }
    flattened.push(tool);
  }
  if (spawnAgentModels.size > 0) SPAWN_AGENT_MODELS.set(namespaces, spawnAgentModels);
  return { tools: flattened, flattened: changed, namespaces };
}

// Flattening only the tool list leaves the model reading two names for one
// tool: `collaboration__spawn_agent` in its tools, but a bare `spawn_agent`
// in its own call history, because LiteLLM's bridge drops the `namespace`
// field when it converts stored function calls to Chat Completions tool calls.
// The model imitates the history, emits the bare name, nothing rewrites it,
// and Codex answers `unsupported call` -- permanently, since every failure
// adds another bare example. Rename the history to match the flattened tools.
export function flattenNamespacedHistory(input, namespaces) {
  if (!Array.isArray(input) || namespaces.size === 0) return input;
  const flattenedNames = new Set();
  const bareOwners = new Map();
  for (const [namespace, names] of namespaces) {
    for (const name of names) {
      flattenedNames.add(`${namespace}${NAMESPACE_DELIMITER}${name}`);
      if (!bareOwners.has(name)) bareOwners.set(name, new Set());
      bareOwners.get(name).add(namespace);
    }
  }
  return input.map((item) => {
    if (item?.type !== "function_call") return item;
    const { name } = item;
    if (typeof name !== "string") return item;
    // Already in the flattened form (the client stored the restored call).
    if (flattenedNames.has(name)) return item;
    // The client stores namespaced calls as { name, namespace }.
    const namespace = item.namespace;
    if (typeof namespace === "string" && namespaces.get(namespace)?.has(name)) {
      const { namespace: _namespace, ...rest } = item;
      return { ...rest, name: `${namespace}${NAMESPACE_DELIMITER}${name}` };
    }
    // Calls stored without a namespace field whose bare name belongs to
    // exactly one flattened namespace.
    if (namespace === undefined) {
      const owners = bareOwners.get(name);
      if (owners && owners.size === 1) {
        const [owner] = [...owners];
        const { namespace: _namespace, ...rest } = item;
        return { ...rest, name: `${owner}${NAMESPACE_DELIMITER}${name}` };
      }
    }
    return item;
  });
}

// Reverse lookups for restoring calls: flattened name -> native
// { namespace, name }, and bare tool name -> namespaces that own it.
export function buildNamespaceLookups(namespaces) {
  const flatToNative = new Map();
  const bareToNamespaces = new Map();
  for (const [namespace, names] of namespaces) {
    for (const name of names) {
      flatToNative.set(`${namespace}${NAMESPACE_DELIMITER}${name}`, {
        namespace,
        name,
      });
      if (!bareToNamespaces.has(name)) bareToNamespaces.set(name, new Set());
      bareToNamespaces.get(name).add(namespace);
    }
  }
  return {
    flatToNative,
    bareToNamespaces,
    spawnAgentModels: SPAWN_AGENT_MODELS.get(namespaces),
  };
}

function sanitizeSpawnAgentModel(item, lookups) {
  if (item?.namespace !== "collaboration" || item.name !== "spawn_agent") return item;
  const allowed = lookups.spawnAgentModels;
  if (!(allowed instanceof Set) || allowed.size === 0 || typeof item.arguments !== "string") {
    return item;
  }
  let args;
  try {
    args = JSON.parse(item.arguments);
  } catch {
    return item;
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) return item;
  if (typeof args.model !== "string" || allowed.has(args.model)) return item;
  const { model: _invalidModel, ...safeArgs } = args;
  return { ...item, arguments: JSON.stringify(safeArgs) };
}

// Restore one SSE event's function call to the client's native namespace
// shape. A flattened `<namespace>__<tool>` name resolves exactly. A bare tool
// name (some models emit the unqualified form) is restored only when it is
// unambiguous across every flattened namespace; a collision stays untouched
// rather than guessing which runtime owns it.
function rewriteFunctionCallArguments(item) {
  if (!item || typeof item !== "object") return item;
  const argumentsText = coerceFunctionCallArguments(item.arguments);
  if (argumentsText === item.arguments) return item;
  return { ...item, arguments: argumentsText };
}

function rewriteNamespaceFunctionCallItem(item, lookups, sessionModel) {
  if (!item || item.type !== "function_call") return undefined;
  let rewritten = item;
  const resolved = lookups.flatToNative.get(item.name);
  if (resolved) {
    rewritten = {
      ...item,
      name: resolved.name,
      namespace: resolved.namespace,
    };
  } else {
    const owners = lookups.bareToNamespaces.get(item.name);
    if (item.namespace === undefined && owners && owners.size === 1) {
      const [namespace] = [...owners];
      rewritten = {
        ...item,
        namespace,
      };
    }
  }
  rewritten = sanitizeSpawnAgentModel(rewritten, lookups);
  rewritten = injectSessionModelForSpawnCalls(rewritten, sessionModel);
  rewritten = rewriteFunctionCallArguments(rewritten);
  return rewritten === item ? undefined : rewritten;
}

export function rewriteNamespaceFunctionCall(event, lookups, sessionModel) {
  const item = rewriteNamespaceFunctionCallItem(event?.item, lookups, sessionModel);
  return item ? { ...event, item } : undefined;
}

function rewriteOutputItems(output, lookups, sessionModel) {
  if (!Array.isArray(output)) return undefined;
  let changed = false;
  const rewritten = output.map((item) => {
    const next = rewriteNamespaceFunctionCallItem(item, lookups, sessionModel);
    if (!next) return item;
    changed = true;
    return next;
  });
  return changed ? rewritten : undefined;
}

// Non-streaming Responses return completed function calls in an `output`
// array instead of SSE `item` events. Restore both shapes through the same
// exact request-local lookup so stream mode cannot change dispatch semantics.
// Returns a copy only when at least one call was restored.
export function rewriteNamespaceResponsePayload(payload, lookups, sessionModel) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  let rewritten = rewriteNamespaceFunctionCall(payload, lookups, sessionModel) || payload;
  let changed = rewritten !== payload;

  if (payload.type === "response.function_call_arguments.done") {
    const argumentsText = coerceFunctionCallArguments(rewritten.arguments);
    if (argumentsText !== rewritten.arguments) {
      rewritten = { ...rewritten, arguments: argumentsText };
      changed = true;
    }
  }

  const output = rewriteOutputItems(rewritten.output, lookups, sessionModel);
  if (output) {
    rewritten = { ...rewritten, output };
    changed = true;
  }

  const responseOutput = rewriteOutputItems(rewritten.response?.output, lookups, sessionModel);
  if (responseOutput) {
    rewritten = {
      ...rewritten,
      response: { ...rewritten.response, output: responseOutput },
    };
    changed = true;
  }
  return changed ? rewritten : undefined;
}

// Inject missing collaboration.interrupt_agent calls for children that already
// finished (FINAL_ANSWER in the request input) when the model forgot to close
// them. Codex 0.147 keeps those children Working until interrupt_agent runs or
// the user opens the child. Sequence numbers continue after the last model
// event so Codex accepts the spliced calls as part of the same response.
function nextSequence(event, lastSequence) {
  const value = Number(event?.sequence_number);
  return Number.isFinite(value) ? value : lastSequence;
}

function trackInterruptFromItem(item, interrupted) {
  if (!item) return;
  const target = interruptTargetFromCall(item);
  if (target) interrupted.add(target);
}

function appendInterruptCallsToOutput(output, pending, interrupted) {
  const remaining = filterAlreadyInterrupted(pending, interrupted);
  if (!remaining.length) return { output, injected: 0, remaining: [] };
  const base = Array.isArray(output) ? [...output] : [];
  for (const item of base) trackInterruptFromItem(item, interrupted);
  const still = filterAlreadyInterrupted(remaining, interrupted);
  for (const target of still) {
    const call = buildInterruptAgentCall(target);
    base.push(call);
    interrupted.add(target);
  }
  return { output: base, injected: still.length, remaining: still };
}

// Rewrites LiteLLM's flattened `<namespace>__<tool>` function calls back to
// the namespace + name shape Codex dispatches through its app runtime.
export class NamespaceToolCallTransform extends Transform {
  #eventStream;
  #decoder = new StringDecoder("utf8");
  #buffer = "";
  #pending = Buffer.alloc(0);
  #released = false;
  #headerlessDetector;
  #lookups;
  #sessionModel;
  #pendingInterrupts;
  #injectOnly = false;
  #interruptedTargets = new Set();
  #lastSequence = 0;
  #interruptSeq = 0;
  #injectQueue = [];
  #injectionsDone = false;
  #lastInjectedCalls = [];

  constructor(namespaces, contentType = "", sessionModel, options = {}) {
    super();
    this.#lookups = buildNamespaceLookups(namespaces);
    this.#sessionModel = sessionModel;
    this.#pendingInterrupts = Array.isArray(options.pendingInterrupts)
      ? [...options.pendingInterrupts]
      : [];
    // Native turns attach this transform only to close finished children. A
    // native stream is otherwise relayed byte-identical, so inject-only mode
    // must not run the namespace rewrites (they exist for routed providers)
    // or re-serialize model-authored events it did not change.
    this.#injectOnly = Boolean(options.injectOnly);
    const declared = String(contentType).toLowerCase();
    this.#eventStream = declared.includes("text/event-stream");
    this.#headerlessDetector =
      !this.#eventStream && !declared.includes("json")
        ? new HeaderlessSseDetector()
        : undefined;
  }

  _transform(chunk, _encoding, callback) {
    if (this.#headerlessDetector) {
      const detected = this.#headerlessDetector.write(chunk);
      if (detected.decision === "pending") {
        callback();
        return;
      }
      this.#headerlessDetector = undefined;
      this.#eventStream = detected.decision === "event-stream";
      for (const buffered of detected.chunks) this.#transformChunk(buffered);
      callback();
      return;
    }
    this.#transformChunk(chunk);
    callback();
  }

  #transformChunk(chunk) {
    if (!this.#eventStream) {
      if (this.#released) {
        this.push(chunk);
        return;
      }
      this.#pending = this.#pending.length ? Buffer.concat([this.#pending, chunk]) : chunk;
      if (this.#pending.length > MAX_JSON_CAPTURE_BYTES) {
        this.push(this.#pending);
        this.#pending = Buffer.alloc(0);
        this.#released = true;
      }
      return;
    }
    this.#buffer += this.#decoder.write(chunk);
    this.#emitCompleteEvents();
  }

  _flush(callback) {
    if (this.#headerlessDetector) {
      const detected = this.#headerlessDetector.end();
      this.#headerlessDetector = undefined;
      this.#eventStream = detected.decision === "event-stream";
      for (const buffered of detected.chunks) this.#transformChunk(buffered);
    }
    if (!this.#eventStream) {
      const body = this.#pending;
      this.#pending = Buffer.alloc(0);
      if (this.#released || !body.length) {
        if (body.length) this.push(body);
        callback();
        return;
      }
      try {
        const original = JSON.parse(body.toString("utf8"));
        let payload = original;
        if (!this.#injectOnly) {
          const rewritten = rewriteNamespaceResponsePayload(
            payload,
            this.#lookups,
            this.#sessionModel,
          );
          if (rewritten) payload = rewritten;
        }
        payload = this.#injectJsonInterrupts(payload);
        // An inject-only relay that injected nothing returns the exact bytes
        // it was handed rather than a re-serialization of them.
        if (this.#injectOnly && payload === original) {
          this.push(body);
        } else {
          this.push(Buffer.from(JSON.stringify(payload), "utf8"));
        }
      } catch {
        this.push(body);
      }
      callback();
      return;
    }
    this.#buffer += this.#decoder.end();
    this.#emitCompleteEvents(true);
    // Streams that omit response.completed / [DONE] still need the closes.
    for (const piece of this.#drainInterruptBlocks()) {
      this.push(Buffer.from(piece));
      if (!piece.endsWith("\n\n")) this.push(Buffer.from("\n\n"));
    }
    callback();
  }

  #emitCompleteEvents(flush = false) {
    const blocks = this.#buffer.split(/\r?\n\r?\n/);
    this.#buffer = flush ? "" : blocks.pop() || "";
    for (const block of blocks) {
      const pieces = this.#rewriteBlock(block);
      for (const piece of pieces) {
        this.push(Buffer.from(piece));
        if (!piece.endsWith("\n\n")) this.push(Buffer.from("\n\n"));
      }
    }
  }

  #rewriteBlock(block) {
    const lines = block.split(/\r?\n/);
    const eventName = lines
      .find((line) => line.startsWith("event:"))
      ?.slice(6)
      .trim();
    let dataLineIndex = -1;
    let dataText = "";
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.startsWith("data:")) continue;
      dataLineIndex = index;
      dataText = line.slice(5).trimStart();
      break;
    }
    if (dataLineIndex === -1) return [block];
    if (!dataText || dataText === "[DONE]") {
      // Inject before the stream terminator so Codex still executes the calls.
      if (dataText === "[DONE]" || eventName === "response.done") {
        return [...this.#drainInterruptBlocks(), block];
      }
      return [block];
    }
    try {
      let event = JSON.parse(dataText);
      if (!this.#injectOnly) {
        const next = rewriteNamespaceResponsePayload(event, this.#lookups, this.#sessionModel);
        if (next) event = next;
      }
      this.#observeEvent(event);
      const rebuilt = [...lines];
      rebuilt[dataLineIndex] = `data: ${JSON.stringify(event)}`;
      // Inject finished-child interrupts before the response closes so Codex
      // still executes them as ordinary tool calls in this turn.
      if (event?.type === "response.completed" || eventName === "response.completed") {
        const interruptBlocks = this.#drainInterruptBlocks();
        const withOutput = this.#mergeInjectedIntoCompleted(event);
        // Nothing injected and nothing rewritten: the event goes out as it
        // came in, not as a JSON round-trip of itself.
        if (this.#injectOnly && !interruptBlocks.length && withOutput === event) {
          return [block];
        }
        rebuilt[dataLineIndex] = `data: ${JSON.stringify(withOutput)}`;
        return [...interruptBlocks, rebuilt.join("\n")];
      }
      if (event?.type === "response.done" || eventName === "response.done") {
        const interruptBlocks = this.#drainInterruptBlocks();
        if (this.#injectOnly) return [...interruptBlocks, block];
        return [...interruptBlocks, rebuilt.join("\n")];
      }
      if (this.#injectOnly) return [block];
      return [rebuilt.join("\n")];
    } catch {
      return [block];
    }
  }

  #observeEvent(event) {
    if (!event || typeof event !== "object") return;
    this.#lastSequence = nextSequence(event, this.#lastSequence);
    trackInterruptFromItem(event.item, this.#interruptedTargets);
    if (Array.isArray(event.output)) {
      for (const item of event.output) trackInterruptFromItem(item, this.#interruptedTargets);
    }
    if (Array.isArray(event.response?.output)) {
      for (const item of event.response.output) {
        trackInterruptFromItem(item, this.#interruptedTargets);
      }
    }
  }

  #remainingInterrupts() {
    return filterAlreadyInterrupted(this.#pendingInterrupts, this.#interruptedTargets);
  }

  #drainInterruptBlocks() {
    if (this.#injectionsDone) return [];
    const remaining = this.#remainingInterrupts();
    if (!remaining.length) {
      this.#injectionsDone = true;
      this.#lastInjectedCalls = [];
      return [];
    }
    const blocks = [];
    const injectedCalls = [];
    for (const target of remaining) {
      this.#interruptSeq += 1;
      const callId = `call_router_interrupt_${this.#interruptSeq}`;
      const call = buildInterruptAgentCall(target, { callId });
      this.#interruptedTargets.add(target);
      injectedCalls.push(call);
      const addedSeq = this.#lastSequence + 1;
      const doneSeq = this.#lastSequence + 2;
      this.#lastSequence = doneSeq;
      const added = {
        type: "response.output_item.added",
        sequence_number: addedSeq,
        item: {
          type: "function_call",
          name: call.name,
          namespace: call.namespace,
          call_id: call.call_id,
          arguments: "",
        },
      };
      const done = {
        type: "response.output_item.done",
        sequence_number: doneSeq,
        item: {
          type: "function_call",
          name: call.name,
          namespace: call.namespace,
          call_id: call.call_id,
          arguments: call.arguments,
        },
      };
      blocks.push(formatSseBlock("response.output_item.added", added).trimEnd() + "\n");
      blocks.push(formatSseBlock("response.output_item.done", done).trimEnd() + "\n");
    }
    this.#lastInjectedCalls = injectedCalls;
    this.#injectionsDone = true;
    return blocks.map((block) => block.replace(/\n$/, ""));
  }

  #mergeInjectedIntoCompleted(event) {
    // drainInterruptBlocks already marked targets interrupted and emitted the
    // SSE tool calls. Mirror those calls into response.completed.output so
    // non-incremental consumers still see them.
    if (!event || typeof event !== "object") return event;
    const injected = this.#lastInjectedCalls;
    if (!Array.isArray(injected) || !injected.length) return event;
    if (Array.isArray(event.response?.output)) {
      return {
        ...event,
        response: {
          ...event.response,
          output: [...event.response.output, ...injected],
        },
      };
    }
    if (Array.isArray(event.output)) {
      return { ...event, output: [...event.output, ...injected] };
    }
    return event;
  }

  #injectJsonInterrupts(payload) {
    if (!payload || typeof payload !== "object") return payload;
    // Non-streaming Responses put completed function calls in `output`.
    if (Array.isArray(payload.output)) {
      for (const item of payload.output) trackInterruptFromItem(item, this.#interruptedTargets);
      const result = appendInterruptCallsToOutput(
        payload.output,
        this.#pendingInterrupts,
        this.#interruptedTargets,
      );
      if (result.injected) payload = { ...payload, output: result.output };
    }
    if (payload.response && Array.isArray(payload.response.output)) {
      for (const item of payload.response.output) {
        trackInterruptFromItem(item, this.#interruptedTargets);
      }
      const result = appendInterruptCallsToOutput(
        payload.response.output,
        this.#pendingInterrupts,
        this.#interruptedTargets,
      );
      if (result.injected) {
        payload = {
          ...payload,
          response: { ...payload.response, output: result.output },
        };
      }
    }
    return payload;
  }
}
