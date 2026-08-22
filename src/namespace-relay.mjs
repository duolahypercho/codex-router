import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

import { HeaderlessSseDetector } from "./sse-prefix.mjs";
import { coerceFunctionCallArguments } from "./tool-arguments.mjs";
import { nonRecursiveToolSchema, providerToolSchema } from "./tool-schema-root.mjs";
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
const TOOL_SEARCH_RELAYS = new WeakMap();
const CUSTOM_TOOL_RELAYS = new WeakMap();

const TOOL_SEARCH_FUNCTION_NAME = "tool_search";
const CUSTOM_TOOL_INPUT_PROPERTY = "input";

function providerFunctionName(tool) {
  return tool?.name ?? tool?.function?.name;
}

function providerVisibleToolNames(tools) {
  const names = new Set();
  if (!Array.isArray(tools)) return names;
  for (const tool of tools) {
    if (tool?.type === "namespace" && Array.isArray(tool.tools)) {
      if (typeof tool.name === "string" && tool.name) names.add(tool.name);
      for (const fn of tool.tools) {
        if (fn?.name) names.add(`${tool.name}${NAMESPACE_DELIMITER}${fn.name}`);
      }
      continue;
    }
    const name = providerFunctionName(tool);
    if (typeof name === "string" && name) names.add(name);
  }
  return names;
}

function availableCustomToolName(nativeName, visibleNames) {
  if (!visibleNames.has(nativeName)) return nativeName;
  const stem = `codex_custom_${nativeName}`;
  if (!visibleNames.has(stem)) return stem;
  let suffix = 1;
  while (visibleNames.has(`${stem}_${suffix}`)) suffix += 1;
  return `${stem}_${suffix}`;
}

// A custom tool's `format` is the model's only specification of the freeform
// payload it must emit: Codex ships apply_patch's V4A dialect as a lark
// grammar and describes the format nowhere else. A function tool has no
// grammar slot, so dropping `format.definition` on the way through would hand
// the model a bare "raw input" string and leave any model that has not
// memorised V4A emitting patches Codex cannot parse. Carry the definition in
// the bridged description instead -- that is the one field every
// function-tool provider does put in front of the model.
export function bridgedCustomToolDescription(tool) {
  const sections = [];
  if (typeof tool?.description === "string" && tool.description.trim()) {
    sections.push(tool.description.trim());
  }
  const format = tool?.format;
  const definition = typeof format?.definition === "string" ? format.definition.trim() : "";
  if (definition) {
    const syntax = typeof format?.syntax === "string" && format.syntax.trim()
      ? format.syntax.trim()
      : "grammar";
    sections.push(
      `The \`${CUSTOM_TOOL_INPUT_PROPERTY}\` string is freeform text, not JSON, and must parse ` +
        `against this ${syntax} grammar:\n\n${definition}`,
    );
  }
  return sections.length ? sections.join("\n\n") : undefined;
}

// OpenCode accepts ordinary JSON-schema function tools but rejects OpenAI's
// freeform `type: "custom"` definition. Codex exposes apply_patch only in that
// native form. Present the same raw-patch contract as one required string
// property, translate matching history and a forced native custom choice, and
// retain a request-local reverse map so the response path can restore the exact
// custom-tool shape Codex executes. An unrelated function or native namespace
// with the same name receives a collision-safe alias and is otherwise untouched.
export function bridgeCustomTools(
  tools,
  input,
  namespaces,
  toolChoice,
  names = ["apply_patch"],
) {
  if (!(namespaces instanceof Map)) {
    return { tools, input, toolChoice, bridged: false };
  }
  const requested = new Set(names);
  const nativeNames = [];
  const remember = (name) => {
    if (requested.has(name) && !nativeNames.includes(name)) nativeNames.push(name);
  };
  if (Array.isArray(tools)) {
    for (const tool of tools) if (tool?.type === "custom") remember(tool.name);
  }
  if (Array.isArray(input)) {
    for (const item of input) if (item?.type === "custom_tool_call") remember(item.name);
  }
  if (toolChoice?.type === "custom") remember(toolChoice.name);
  if (!nativeNames.length) return { tools, input, toolChoice, bridged: false };

  const ordinaryTools = Array.isArray(tools)
    ? tools.filter((tool) => !(tool?.type === "custom" && requested.has(tool.name)))
    : tools;
  const visibleNames = providerVisibleToolNames(ordinaryTools);
  const nativeToProvider = new Map();
  const providerToNative = new Map();
  for (const nativeName of nativeNames) {
    const providerName = availableCustomToolName(nativeName, visibleNames);
    visibleNames.add(providerName);
    nativeToProvider.set(nativeName, providerName);
    providerToNative.set(providerName, nativeName);
  }
  CUSTOM_TOOL_RELAYS.set(namespaces, providerToNative);

  let changedTools = false;
  const routedTools = Array.isArray(tools)
    ? tools.map((tool) => {
        const providerName =
          tool?.type === "custom" ? nativeToProvider.get(tool.name) : undefined;
        if (!providerName) return tool;
        changedTools = true;
        const description = bridgedCustomToolDescription(tool);
        return {
          type: "function",
          name: providerName,
          ...(description ? { description } : {}),
          parameters: {
            type: "object",
            properties: {
              [CUSTOM_TOOL_INPUT_PROPERTY]: {
                type: "string",
                description: "The complete raw freeform input for this tool, preserved verbatim.",
              },
            },
            required: [CUSTOM_TOOL_INPUT_PROPERTY],
            additionalProperties: false,
          },
        };
      })
    : tools;

  const providerChoiceName =
    toolChoice?.type === "custom" ? nativeToProvider.get(toolChoice.name) : undefined;
  const routedToolChoice = providerChoiceName
    ? { ...toolChoice, type: "function", name: providerChoiceName }
    : toolChoice;
  const changedToolChoice = routedToolChoice !== toolChoice;

  if (!Array.isArray(input)) {
    return {
      tools: routedTools,
      input,
      toolChoice: routedToolChoice,
      bridged: changedTools || changedToolChoice,
    };
  }
  const bridgedCallIds = new Set();
  let changedInput = false;
  const routedInput = input.map((item) => {
    const providerName =
      item?.type === "custom_tool_call" ? nativeToProvider.get(item.name) : undefined;
    if (providerName && typeof item.input === "string") {
      const { type: _type, input: customInput, name: _name, ...rest } = item;
      if (typeof item.call_id === "string" && item.call_id) {
        bridgedCallIds.add(item.call_id);
      }
      changedInput = true;
      return {
        ...rest,
        type: "function_call",
        name: providerName,
        arguments: JSON.stringify({ [CUSTOM_TOOL_INPUT_PROPERTY]: customInput }),
      };
    }
    if (
      item?.type === "custom_tool_call_output" &&
      typeof item.call_id === "string" &&
      bridgedCallIds.has(item.call_id)
    ) {
      changedInput = true;
      return { ...item, type: "function_call_output" };
    }
    return item;
  });
  return {
    tools: routedTools,
    input: changedInput ? routedInput : input,
    toolChoice: routedToolChoice,
    bridged: changedTools || changedInput || changedToolChoice,
  };
}

function availableToolSearchName(tools) {
  const names = providerVisibleToolNames(tools);
  if (!names.has(TOOL_SEARCH_FUNCTION_NAME)) return TOOL_SEARCH_FUNCTION_NAME;
  let suffix = 1;
  while (names.has(`codex_tool_search_${suffix}`)) suffix += 1;
  return `codex_tool_search_${suffix}`;
}

function providerToolSearchDescription(description, providerName) {
  if (typeof description !== "string") return undefined;
  if (providerName === TOOL_SEARCH_FUNCTION_NAME) return description;
  const rewritten = description.replaceAll(
    `\`${TOOL_SEARCH_FUNCTION_NAME}\``,
    `\`${providerName}\``,
  );
  return `${rewritten}\n\nFor this routed request, call \`${providerName}\` for deferred tool discovery; \`${TOOL_SEARCH_FUNCTION_NAME}\` is a separate ordinary function.`;
}

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

// Repair one tool's parameter root, or return it untouched. Providers reject a
// union or nullable-object root by name -- xAI, DeepSeek V4, and the
// opencode-go Responses surface all do -- and none of them care whether the
// tool arrived inside a namespace. `providerToolSchema` returns anything it
// does not recognize by identity, so an ordinary root costs one call and no
// copy.
export function repairToolSchemaRoot(tool, { nonRecursive = false } = {}) {
  // Preserve the established shared-provider behavior byte-for-byte. Native
  // namespace traversal and inputSchema rewriting belong only to the OpenCode
  // compatibility pass below; other providers keep the original root repair.
  if (!nonRecursive) {
    const parameters = tool?.function?.parameters ?? tool?.parameters;
    if (parameters === undefined) return tool;
    const repaired = providerToolSchema(parameters);
    if (repaired === parameters) return tool;
    return tool.function
      ? { ...tool, function: { ...tool.function, parameters: repaired } }
      : { ...tool, parameters: repaired };
  }

  if (tool?.type === "namespace" && Array.isArray(tool.tools)) {
    let changed = false;
    const children = tool.tools.map((child) => {
      const repaired = repairToolSchemaRoot(child, { nonRecursive });
      if (repaired !== child) changed = true;
      return repaired;
    });
    return changed ? { ...tool, tools: children } : tool;
  }

  let repairedTool = tool;
  let changed = false;
  const repair = (schema) => nonRecursiveToolSchema(providerToolSchema(schema));

  if (tool?.function?.parameters !== undefined) {
    const parameters = repair(tool.function.parameters);
    if (parameters !== tool.function.parameters) {
      repairedTool = {
        ...repairedTool,
        function: { ...repairedTool.function, parameters },
      };
      changed = true;
    }
  }
  // Flattened namespace children deliberately carry both inputSchema (the
  // client-native declaration) and parameters (the Chat Completions alias).
  // Repair both: choosing inputSchema first would leave the provider-facing
  // parameters recursive on Ox even though the Responses branch was fixed.
  for (const field of ["parameters", "inputSchema"]) {
    if (tool?.[field] === undefined) continue;
    const schema = repair(tool[field]);
    if (schema === tool[field]) continue;
    repairedTool = { ...repairedTool, [field]: schema };
    changed = true;
  }
  return changed ? repairedTool : tool;
}

// Array form for callers that relay tools without flattening them --
// Responses-native providers keep the namespace shape but still need a root
// their upstream accepts. Returns the original array when nothing needed
// repair, so the common request is not copied.
export function repairToolSchemaRoots(tools, options) {
  if (!Array.isArray(tools)) return tools;
  let changed = false;
  const repaired = tools.map((tool) => {
    const next = repairToolSchemaRoot(tool, options);
    if (next !== tool) changed = true;
    return next;
  });
  return changed ? repaired : tools;
}

// OpenCode currently accepts search_content_types only on the legacy
// web_search_preview shape. Codex sends the field on web_search, so remove only
// that unsupported extension and preserve every other search-tool option.
export function stripSearchContentTypes(tools) {
  if (!Array.isArray(tools)) return tools;
  let changed = false;
  const stripped = tools.map((tool) => {
    if (tool?.type !== "web_search" || !("search_content_types" in tool)) return tool;
    changed = true;
    const { search_content_types: _unsupported, ...rest } = tool;
    return rest;
  });
  return changed ? stripped : tools;
}

// agent_message is a Codex collaboration input item, not part of the public
// Responses schema OpenCode implements. The readable handoff has already been
// recovered before this boundary, so keep its content and present it as the
// equivalent user message strict compatible endpoints accept.
export function agentMessagesAsUserMessages(input) {
  if (!Array.isArray(input)) return input;
  let changed = false;
  const converted = input.map((item) => {
    if (item?.type !== "agent_message" || !Array.isArray(item.content)) return item;
    changed = true;
    return { type: "message", role: "user", content: item.content };
  });
  return changed ? converted : input;
}

// Codex can inherit an image with detail:"original" from the parent thread.
// OpenCode rejects that OpenAI-only hint but accepts the same image as auto.
// Preserve the image bytes and surrounding transcript; change only the hint.
export function downgradeOriginalImageDetail(input) {
  if (!Array.isArray(input)) return input;
  let changed = false;
  const converted = input.map((item) => {
    if (!Array.isArray(item?.content)) return item;
    let contentChanged = false;
    const content = item.content.map((part) => {
      if (part?.type !== "input_image" || part.detail !== "original") return part;
      changed = true;
      contentChanged = true;
      return { ...part, detail: "auto" };
    });
    return contentChanged ? { ...item, content } : item;
  });
  return changed ? converted : input;
}

function flattenNamespaceChild(namespace, fn) {
  const clientSchema = fn.parameters ?? fn.inputSchema;
  const parameters =
    clientSchema === undefined ? undefined : providerToolSchema(clientSchema);
  return {
    ...fn,
    name: `${namespace}${NAMESPACE_DELIMITER}${fn.name}`,
    ...(parameters === undefined ? {} : { parameters }),
  };
}

// Flatten every namespace entry into plain functions named
// `<namespace>__<tool>`. Returns the set of namespaces that were flattened
// (name -> tool names) so callers can rename history and restore calls.
export function flattenNamespaceTools(tools, { bridgeToolSearch = true } = {}) {
  if (!Array.isArray(tools)) return { tools, flattened: false, namespaces: new Map() };
  const flattened = [];
  const namespaces = new Map();
  const spawnAgentModels = new Set();
  const toolSearchName = bridgeToolSearch ? availableToolSearchName(tools) : undefined;
  let toolSearchRelay;
  let changed = false;
  for (const tool of tools) {
    // Codex registers deferred tools client-side and exposes this native
    // control so the model can search them on demand. Chat-completions
    // providers reject the native type, so present the same request-local
    // capability as an ordinary function and restore its calls on the
    // response path. Only the native client-executed shape enables the relay;
    // an unrelated function named `tool_search` never does. When such a plain
    // function already exists, use a deterministic alias so neither call can
    // hijack the other.
    if (tool?.type === "tool_search") {
      changed = true;
      if (bridgeToolSearch && tool.execution === "client" && !toolSearchRelay) {
        const parameters =
          tool.parameters === undefined ? undefined : providerToolSchema(tool.parameters);
        const description = providerToolSearchDescription(tool.description, toolSearchName);
        flattened.push({
          type: "function",
          name: toolSearchName,
          ...(description === undefined ? {} : { description }),
          ...(parameters === undefined ? {} : { parameters }),
        });
        toolSearchRelay = { providerName: toolSearchName };
      }
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
        flattened.push(flattenNamespaceChild(tool.name, fn));
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
    // A plain function tool needs the same repair as a namespaced one. The
    // rejections are the provider's, not the namespace's: DeepSeek V4 Flash and
    // Pro both 400 a `type: ["object","null"]` root with "schema must be a JSON
    // Schema of 'type: \"object\"'", and xAI rejects a union root the same way,
    // whether the tool arrived inside a namespace or on its own. Repairing only
    // the flattened children left every client-declared tool to fail on the
    // provider that objects. `providerToolSchema` returns anything it does not
    // recognize unchanged, so a tool with an ordinary root is not copied.
    const repaired = repairToolSchemaRoot(tool);
    if (repaired !== tool) changed = true;
    flattened.push(repaired);
  }
  if (spawnAgentModels.size > 0) SPAWN_AGENT_MODELS.set(namespaces, spawnAgentModels);
  if (toolSearchRelay) TOOL_SEARCH_RELAYS.set(namespaces, toolSearchRelay);
  return { tools: flattened, flattened: changed, namespaces };
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function validToolSearchHistoryArguments(value) {
  const argumentsObject = plainObject(value);
  if (!argumentsObject || typeof argumentsObject.query !== "string") return false;
  if (!argumentsObject.query.trim()) return false;
  const { limit } = argumentsObject;
  return limit === undefined || (Number.isInteger(limit) && limit > 0);
}

function discoveredProviderTools(toolSpecs) {
  if (!Array.isArray(toolSpecs)) return [];
  const discovered = [];
  for (const tool of toolSpecs) {
    if (tool?.type === "namespace" && typeof tool.name === "string" && Array.isArray(tool.tools)) {
      for (const fn of tool.tools) {
        if (fn?.type !== "function" || !fn.name) continue;
        discovered.push({
          tool: flattenNamespaceChild(tool.name, fn),
          native: { namespace: tool.name, name: fn.name },
        });
      }
      continue;
    }
    if (tool?.type !== "function" || !providerFunctionName(tool)) continue;
    discovered.push({ tool: repairToolSchemaRoot(tool) });
  }
  return discovered;
}

function addDiscoveredNamespace(namespaces, native) {
  if (!native) return;
  let names = namespaces.get(native.namespace);
  if (!names) {
    names = new Set();
    namespaces.set(native.namespace, names);
  }
  names.add(native.name);
}

// A native tool_search output changes what the model may call on the next
// turn. The Responses API understands that special history item directly;
// LiteLLM's chat-completions bridge does not. Translate matched call/output
// pairs into ordinary function history and add the returned definitions to
// this request's provider-facing tool list. Live top-level schemas win on a
// name collision. Native items that do not form one unique, ordered,
// well-formed pair are dropped: a chat-completions provider cannot consume
// them, and forwarding one would make the transcript promise unavailable
// tools.
export function flattenToolSearchHistory(input, tools, namespaces) {
  const relay = TOOL_SEARCH_RELAYS.get(namespaces);
  if (!Array.isArray(input)) {
    return { input, tools, flattened: false };
  }
  if (!Array.isArray(tools)) {
    const routedInput = input.filter(
      (item) => item?.type !== "tool_search_call" && item?.type !== "tool_search_output",
    );
    return {
      input: routedInput.length === input.length ? input : routedInput,
      tools,
      flattened: routedInput.length !== input.length,
    };
  }

  const callsById = new Map();
  const invalidIds = new Set();
  let nativeItems = 0;
  // Pair in one forward walk. Outputs may follow several parallel calls, but
  // they may never reach backwards past an orphan, duplicate, or malformed
  // item with the same id. Records are materialized only after the walk, so a
  // duplicate discovered late invalidates the entire id before any tool can be
  // added to the provider request.
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    const isCall = item?.type === "tool_search_call";
    const isOutput = item?.type === "tool_search_output";
    if (!isCall && !isOutput) continue;
    nativeItems += 1;

    const id = typeof item.call_id === "string" && item.call_id ? item.call_id : undefined;
    if (!id) continue;
    if (invalidIds.has(id)) continue;

    if (isCall) {
      const valid =
        item.execution === "client" && validToolSearchHistoryArguments(item.arguments);
      if (!valid || callsById.has(id)) {
        callsById.delete(id);
        invalidIds.add(id);
        continue;
      }
      callsById.set(id, { call: item, callIndex: index });
      continue;
    }

    const call = callsById.get(id);
    const valid =
      item.execution === "client" &&
      item.status === "completed" &&
      Array.isArray(item.tools);
    if (!valid || !call || call.output) {
      callsById.delete(id);
      invalidIds.add(id);
      continue;
    }
    call.output = item;
    call.outputIndex = index;
  }

  if (nativeItems === 0) return { input, tools, flattened: false };

  const callsByIndex = new Map();
  const outputsByIndex = new Map();
  if (relay) {
    for (const [id, record] of callsById) {
      if (!record.output || invalidIds.has(id)) continue;
      callsByIndex.set(record.callIndex, record);
      outputsByIndex.set(record.outputIndex, record);
    }
  }

  const visibleNames = providerVisibleToolNames(tools);
  let routedTools = tools;
  const routedInput = [];
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    if (item?.type === "tool_search_call") {
      if (!callsByIndex.has(index)) continue;
      const {
        type: _type,
        execution: _execution,
        status: _status,
        arguments: searchArguments,
        ...rest
      } = item;
      routedInput.push({
        ...rest,
        type: "function_call",
        name: relay.providerName,
        arguments: JSON.stringify(searchArguments),
      });
      continue;
    }

    if (item?.type !== "tool_search_output") {
      routedInput.push(item);
      continue;
    }
    if (!outputsByIndex.has(index)) continue;

    const accepted = [];
    for (const candidate of discoveredProviderTools(item.tools)) {
      const name = providerFunctionName(candidate.tool);
      if (!name || visibleNames.has(name)) continue;
      visibleNames.add(name);
      accepted.push(candidate.tool);
      addDiscoveredNamespace(namespaces, candidate.native);
    }
    // Keep the live-name set across outputs. The first valid discovery wins;
    // later outputs omit a duplicate from both their result and the request's
    // tool list instead of advertising a schema that cannot take precedence.
    if (accepted.length) {
      if (routedTools === tools) routedTools = [...tools];
      routedTools.push(...accepted);
    }

    const {
      type: _type,
      execution: _execution,
      status: _status,
      tools: _tools,
      ...rest
    } = item;
    routedInput.push({
      ...rest,
      type: "function_call_output",
      output: JSON.stringify({ tools: accepted }),
    });
  }

  return {
    input: routedInput,
    tools: routedTools,
    flattened: true,
  };
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
    toolSearch: TOOL_SEARCH_RELAYS.get(namespaces),
    customTools: CUSTOM_TOOL_RELAYS.get(namespaces),
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

function toolSearchArguments(value, allowPlaceholder) {
  if (plainObject(value)) return value;
  if (typeof value !== "string") return undefined;
  if (allowPlaceholder && value.trim() === "") return {};
  try {
    return plainObject(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function rewriteToolSearchFunctionCallItem(item, lookups, allowPlaceholder) {
  const relay = lookups.toolSearch;
  if (
    !relay ||
    item?.type !== "function_call" ||
    item.name !== relay.providerName ||
    item.namespace !== undefined ||
    typeof item.call_id !== "string" ||
    !item.call_id
  ) {
    return undefined;
  }
  const argumentsObject = toolSearchArguments(item.arguments, allowPlaceholder);
  if (!argumentsObject) return undefined;
  const {
    type: _type,
    name: _name,
    namespace: _namespace,
    arguments: _arguments,
    encrypted_function_args: _encryptedFunctionArgs,
    ...rest
  } = item;
  return {
    ...rest,
    type: "tool_search_call",
    execution: "client",
    arguments: argumentsObject,
  };
}

function customToolInput(value, allowPlaceholder = false) {
  if (allowPlaceholder && (value === undefined || value === "")) return "";
  const argumentsText = coerceFunctionCallArguments(value);
  if (typeof argumentsText !== "string") return undefined;
  try {
    const parsed = JSON.parse(argumentsText);
    return typeof parsed?.[CUSTOM_TOOL_INPUT_PROPERTY] === "string"
      ? parsed[CUSTOM_TOOL_INPUT_PROPERTY]
      : undefined;
  } catch {
    return undefined;
  }
}

function rewriteCustomToolFunctionCallItem(item, lookups, allowPlaceholder) {
  if (
    item?.type !== "function_call" ||
    item.namespace !== undefined ||
    !(lookups.customTools instanceof Map)
  ) {
    return undefined;
  }
  const nativeName = lookups.customTools.get(item.name);
  if (!nativeName) return undefined;
  const input = customToolInput(item.arguments, allowPlaceholder);
  if (input === undefined) return undefined;
  const {
    type: _type,
    name: _name,
    arguments: _arguments,
    encrypted_function_args: _encryptedFunctionArgs,
    ...rest
  } = item;
  return {
    ...rest,
    type: "custom_tool_call",
    name: nativeName,
    ...(allowPlaceholder && input === "" ? {} : { input }),
  };
}

function rewriteNamespaceFunctionCallItem(
  item,
  lookups,
  sessionModel,
  { allowIncompleteToolSearch = false } = {},
) {
  if (!item || item.type !== "function_call") return undefined;
  const customTool = rewriteCustomToolFunctionCallItem(
    item,
    lookups,
    allowIncompleteToolSearch,
  );
  if (customTool) return customTool;
  const toolSearch = rewriteToolSearchFunctionCallItem(
    item,
    lookups,
    allowIncompleteToolSearch,
  );
  if (toolSearch) return toolSearch;
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
  const item = rewriteNamespaceFunctionCallItem(event?.item, lookups, sessionModel, {
    allowIncompleteToolSearch: event?.type === "response.output_item.added",
  });
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

const CUSTOM_TOOL_OPENING_LIMIT = 1024;
const JSON_ESCAPES = Object.freeze({
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
});

// Decode one new function-argument fragment into the native custom-tool input.
// The wrapper prefix is bounded and every encoded patch character is visited
// once. Only an incomplete escape (at most six characters) is retained between
// calls, avoiding the quadratic full-patch rescans that large streamed patches
// would otherwise trigger.
function customToolInputDelta(state, fragment) {
  if (typeof fragment !== "string" || state.invalid || state.closed) return undefined;
  let encoded = fragment;
  if (!state.opened) {
    state.opening += encoded;
    const opening = state.opening.match(/^\s*\{\s*"input"\s*:\s*"/);
    if (!opening) {
      if (state.opening.length > CUSTOM_TOOL_OPENING_LIMIT) {
        state.opening = "";
        state.invalid = true;
      }
      return undefined;
    }
    state.opened = true;
    encoded = state.opening.slice(opening[0].length);
    state.opening = "";
  }

  if (state.escape) {
    encoded = state.escape + encoded;
    state.escape = "";
  }
  const decoded = [];
  for (let index = 0; index < encoded.length; index += 1) {
    const character = encoded[index];
    if (character === '"') {
      state.closed = true;
      break;
    }
    if (character !== "\\") {
      if (character.charCodeAt(0) < 0x20) {
        state.invalid = true;
        break;
      }
      decoded.push(character);
      continue;
    }

    const escape = encoded[index + 1];
    if (escape === undefined) {
      state.escape = "\\";
      break;
    }
    if (escape === "u") {
      const digits = encoded.slice(index + 2, index + 6);
      if (!/^[0-9a-fA-F]*$/.test(digits)) {
        state.invalid = true;
        break;
      }
      if (digits.length < 4) {
        state.escape = encoded.slice(index);
        break;
      }
      decoded.push(String.fromCharCode(Number.parseInt(digits, 16)));
      index += 5;
      continue;
    }
    if (!(escape in JSON_ESCAPES)) {
      state.invalid = true;
      break;
    }
    decoded.push(JSON_ESCAPES[escape]);
    index += 1;
  }
  return decoded.length ? decoded.join("") : undefined;
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
  #customItemIds = new Set();
  #customDeltaStates = new Map();

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
      const originalEventType = event?.type;
      if (
        !this.#injectOnly &&
        event?.type === "response.function_call_arguments.delta" &&
        this.#customItemIds.has(event.item_id)
      ) {
        const state = this.#customDeltaStates.get(event.item_id);
        const delta = state ? customToolInputDelta(state, event.delta) : undefined;
        if (delta === undefined) return [];
        event = {
          ...event,
          type: "response.custom_tool_call_input.delta",
          delta,
        };
      }
      if (
        !this.#injectOnly &&
        event?.type === "response.function_call_arguments.done" &&
        this.#customItemIds.has(event.item_id)
      ) {
        const input = customToolInput(event.arguments);
        if (input !== undefined) {
          const { arguments: _arguments, ...rest } = event;
          event = {
            ...rest,
            type: "response.custom_tool_call_input.done",
            input,
          };
        }
      }
      if (!this.#injectOnly) {
        const next = rewriteNamespaceResponsePayload(event, this.#lookups, this.#sessionModel);
        if (next) event = next;
      }
      if (
        event?.type === "response.output_item.added" &&
        event.item?.type === "custom_tool_call" &&
        typeof event.item.id === "string"
      ) {
        this.#customItemIds.add(event.item.id);
        this.#customDeltaStates.set(event.item.id, {
          opening: "",
          opened: false,
          escape: "",
          closed: false,
          invalid: false,
        });
      }
      if (
        event?.type === "response.output_item.done" &&
        event.item?.type === "custom_tool_call" &&
        typeof event.item.id === "string"
      ) {
        this.#customItemIds.delete(event.item.id);
        this.#customDeltaStates.delete(event.item.id);
      }
      this.#observeEvent(event);
      const rebuilt = [...lines];
      const eventLineIndex = rebuilt.findIndex((line) => line.startsWith("event:"));
      if (
        eventLineIndex !== -1 &&
        typeof event?.type === "string" &&
        event.type !== originalEventType
      ) {
        rebuilt[eventLineIndex] = `event: ${event.type}`;
      }
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
