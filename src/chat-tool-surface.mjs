import { CODEX_APP_TOOLS, mergeCodexAppTools } from "./codex-app-tools.mjs";
import { flattenNamespaceTools, NAMESPACE_DELIMITER } from "./namespace-relay.mjs";

export const GROQ_MAX_TOOLS = 128;
export const GROQ_TOOL_LIMIT_CODE = "groq_tool_limit_exceeded";

export class GroqToolLimitError extends Error {
  constructor({
    clientToolCount,
    expandedToolCount,
    historyToolCapacity,
    historyToolCount,
    referencedToolCapacity,
    referencedToolCount,
  }) {
    const historyOverflow = Number.isInteger(historyToolCount);
    const referencedOverflow = Number.isInteger(referencedToolCount);
    let message;
    if (historyOverflow) {
      message = `Groq accepts at most ${GROQ_MAX_TOOLS} tools. The current surface contains ` +
        `${clientToolCount}, and stored history references ${historyToolCount} discovered ` +
        `tools while only ${historyToolCapacity} slots remain. The router refused to drop ` +
        "a tool used by the transcript or send an inconsistent request.";
    } else if (referencedOverflow) {
      message = `Groq accepts at most ${GROQ_MAX_TOOLS} tools. The client declared ` +
        `${clientToolCount}, and the request references ${referencedToolCount} deferred app ` +
        `tools while only ${referencedToolCapacity} slots remain. The router refused to drop ` +
        "a referenced tool or send an inconsistent request.";
    } else {
      message = `Groq accepts at most ${GROQ_MAX_TOOLS} tools, but routed app-tool expansion ` +
        `would send ${expandedToolCount} and the client-visible surface already contains ` +
        `${clientToolCount}. The router refused to drop client tools or send an invalid request.`;
    }
    super(message);
    this.name = "GroqToolLimitError";
    this.code = GROQ_TOOL_LIMIT_CODE;
    this.status = 400;
    this.provider = "groq";
    this.limit = GROQ_MAX_TOOLS;
    this.clientToolCount = clientToolCount;
    this.expandedToolCount = expandedToolCount;
    if (historyOverflow) {
      this.historyToolCapacity = historyToolCapacity;
      this.historyToolCount = historyToolCount;
    }
    if (referencedOverflow) {
      this.referencedToolCapacity = referencedToolCapacity;
      this.referencedToolCount = referencedToolCount;
    }
  }
}

function appIdentityKey(namespace, name) {
  return JSON.stringify([namespace, name]);
}

const APP_NAMESPACE_BY_NAME = new Map();
const APP_TOOL_BY_IDENTITY = new Map();
const APP_TOOL_IDENTITIES_BY_PROVIDER_NAME = new Map();
const APP_TOOL_IDENTITIES_BY_BARE_NAME = new Map();
for (const namespace of CODEX_APP_TOOLS) {
  if (namespace?.type !== "namespace" || typeof namespace.name !== "string") continue;
  APP_NAMESPACE_BY_NAME.set(namespace.name, namespace);
  for (const tool of Array.isArray(namespace.tools) ? namespace.tools : []) {
    if (tool?.type !== "function" || typeof tool.name !== "string" || !tool.name) continue;
    const identity = {
      namespace: namespace.name,
      name: tool.name,
      definition: tool,
    };
    const key = appIdentityKey(identity.namespace, identity.name);
    const providerName = `${identity.namespace}${NAMESPACE_DELIMITER}${identity.name}`;
    APP_TOOL_BY_IDENTITY.set(key, identity);
    if (!APP_TOOL_IDENTITIES_BY_PROVIDER_NAME.has(providerName)) {
      APP_TOOL_IDENTITIES_BY_PROVIDER_NAME.set(providerName, []);
    }
    APP_TOOL_IDENTITIES_BY_PROVIDER_NAME.get(providerName).push(identity);
    if (!APP_TOOL_IDENTITIES_BY_BARE_NAME.has(identity.name)) {
      APP_TOOL_IDENTITIES_BY_BARE_NAME.set(identity.name, []);
    }
    APP_TOOL_IDENTITIES_BY_BARE_NAME.get(identity.name).push(identity);
  }
}

function providerFunctionName(tool) {
  return tool?.name ?? tool?.function?.name;
}

function clientToolInventory(tools) {
  const plainNames = new Set();
  const nativeIdentities = new Set();
  const bareNamespaceOwners = new Map();
  const wireNamespaceOwners = new Map();
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (tool?.type === "namespace" && typeof tool.name === "string") {
      for (const child of Array.isArray(tool.tools) ? tool.tools : []) {
        if (child?.type !== "function" || typeof child.name !== "string" || !child.name) {
          continue;
        }
        const key = appIdentityKey(tool.name, child.name);
        nativeIdentities.add(key);
        if (!bareNamespaceOwners.has(child.name)) bareNamespaceOwners.set(child.name, new Set());
        bareNamespaceOwners.get(child.name).add(key);
        const wireName = `${tool.name}${NAMESPACE_DELIMITER}${child.name}`;
        if (!wireNamespaceOwners.has(wireName)) wireNamespaceOwners.set(wireName, new Set());
        wireNamespaceOwners.get(wireName).add(key);
      }
      continue;
    }
    if (tool?.type !== "function") continue;
    const name = providerFunctionName(tool);
    if (typeof name === "string" && name) plainNames.add(name);
  }
  return { plainNames, nativeIdentities, bareNamespaceOwners, wireNamespaceOwners };
}

function uniqueIdentity(identities) {
  return Array.isArray(identities) && identities.length === 1 ? identities[0] : undefined;
}

function appToolIdentity(value, inventory) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const nestedName = value.function?.name;
  const name = typeof nestedName === "string" ? nestedName : value.name;
  if (typeof name !== "string" || !name) return undefined;
  const namespace =
    typeof value.namespace === "string" && value.namespace ? value.namespace : undefined;
  if (namespace) return APP_TOOL_BY_IDENTITY.get(appIdentityKey(namespace, name));

  // An unqualified reference whose exact spelling is client-declared belongs
  // to that plain function. Stored app calls can still identify themselves
  // unambiguously with the native namespace field.
  if (inventory.plainNames.has(name)) return undefined;

  const flattened = uniqueIdentity(APP_TOOL_IDENTITIES_BY_PROVIDER_NAME.get(name));
  if (flattened) {
    const owners = inventory.wireNamespaceOwners.get(name);
    const flattenedKey = appIdentityKey(flattened.namespace, flattened.name);
    if (!owners || [...owners].every((owner) => owner === flattenedKey)) return flattened;
  }

  const bare = uniqueIdentity(APP_TOOL_IDENTITIES_BY_BARE_NAME.get(name));
  if (!bare) return undefined;
  const owners = inventory.bareNamespaceOwners.get(name);
  if (owners && [...owners].some((owner) => owner !== appIdentityKey(bare.namespace, bare.name))) {
    return undefined;
  }
  return bare;
}

function referencedAppTools(input, toolChoice, inventory) {
  const referenced = new Map();
  const remember = (value) => {
    const identity = appToolIdentity(value, inventory);
    if (identity) referenced.set(appIdentityKey(identity.namespace, identity.name), identity);
  };
  for (const item of Array.isArray(input) ? input : []) {
    if (item?.type !== "function_call") continue;
    remember(item);
  }
  if (toolChoice?.type === "allowed_tools" && Array.isArray(toolChoice.tools)) {
    for (const choice of toolChoice.tools) {
      if (choice?.type === "function") remember(choice);
    }
  } else if (toolChoice?.type === "function") {
    remember(toolChoice);
  }
  return referenced;
}

function withRequiredAppTools(tools, required) {
  if (!required.size) return tools;
  const selected = [];
  const fulfilled = new Set();
  for (const tool of tools) {
    if (tool?.type !== "namespace" || !APP_NAMESPACE_BY_NAME.has(tool.name)) {
      selected.push(tool);
      continue;
    }
    const additions = [];
    for (const identity of required.values()) {
      if (identity.namespace !== tool.name || fulfilled.has(appIdentityKey(identity.namespace, identity.name))) {
        continue;
      }
      additions.push(identity.definition);
      fulfilled.add(appIdentityKey(identity.namespace, identity.name));
    }
    selected.push(additions.length
      ? { ...tool, tools: [...(Array.isArray(tool.tools) ? tool.tools : []), ...additions] }
      : tool);
  }
  for (const namespace of CODEX_APP_TOOLS) {
    const additions = [];
    for (const identity of required.values()) {
      const key = appIdentityKey(identity.namespace, identity.name);
      if (identity.namespace !== namespace.name || fulfilled.has(key)) continue;
      additions.push(identity.definition);
      fulfilled.add(key);
    }
    if (additions.length) selected.push({ ...namespace, tools: additions });
  }
  return selected;
}

// Chat-completions providers need namespace flattening. When the client also
// supplies its client-executed tool_search control, however, its reduced
// codex_app namespace is deliberate deferred loading: keep that reduced surface
// and add back only app definitions already referenced by stored history or a
// forced tool choice. Otherwise the router would defeat discovery by injecting
// the full deferLoading snapshot before the model can search for a tool.
//
// Providers without client tool_search keep the compatibility fallback that
// merges the full app snapshot so routed models still see native app tools.
// Groq alone caps a request at 128 tools and already applies the same
// reference-driven app selection regardless of discovery support. Stored app
// calls and forced app choices are evidence that an omitted definition is
// required; those definitions are added back before the request is admitted. A
// client surface (or client + required definitions) over the cap is refused
// locally rather than truncated.
// Command Code validates the provider-facing tool `name` at 64 characters and
// refuses the whole request over a longer one, so a client tool such as
// `mcp__openai_api_key_local_confirmation__confirm_openai_api_key_local_destination`
// (80 characters) fails the turn before generation (issue #626). Both provider
// variants front the same validator. They opt into the router's existing
// bounded alias route, which is deterministic and reversible, so
// `rewriteNamespaceResponsePayload()` still restores the client's own identity.
// Meta returned the same 80-character rejection through OpenRouter for Muse
// Spark 1.3 Contributor. Keep that opt-in exact to the observed model route.
const BOUNDED_TOOL_NAME_PROVIDERS = new Set(["commandcode", "commandcode-messages"]);
const BOUNDED_TOOL_NAME_LENGTH = 64;

function needsBoundedChatToolNames(providerId, upstreamModel) {
  return BOUNDED_TOOL_NAME_PROVIDERS.has(providerId) ||
    (providerId === "openrouter" && upstreamModel === "meta/muse-spark-1.3-contributor");
}

export function chatProviderToolSurface(
  tools,
  providerId,
  { input, toolChoice, upstreamModel } = {},
) {
  if (providerId !== "groq") {
    const clientToolSearch = Array.isArray(tools) && tools.some(
      (tool) => tool?.type === "tool_search" && tool.execution === "client",
    );
    let providerTools;
    if (clientToolSearch) {
      const inventory = clientToolInventory(tools);
      const referenced = referencedAppTools(input, toolChoice, inventory);
      const requiredDefinitions = new Map(
        [...referenced].filter(([key]) => !inventory.nativeIdentities.has(key)),
      );
      providerTools = withRequiredAppTools(tools, requiredDefinitions);
    } else {
      providerTools = mergeCodexAppTools(tools).tools;
    }
    // Collision safety is not the length bound. A provider with no name-length
    // limit still cannot be sent two tools under one name: the second
    // declaration wins on the wire, and every call to that name comes back
    // under one identity, so the other tool is unreachable for the whole turn.
    // The bounded branch already aliases both apart because any duplicate
    // forces an alias there; the unbounded branch has to ask for it.
    return flattenNamespaceTools(providerTools, {
      aliasCollisions: true,
      ...(needsBoundedChatToolNames(providerId, upstreamModel)
        ? { maxNameLength: BOUNDED_TOOL_NAME_LENGTH }
        : {}),
    });
  }

  const merged = mergeCodexAppTools(tools);

  // Groq has no OpenCode-style length bound, but it still needs deterministic
  // aliases when two distinct native identities have the same flattened wire
  // spelling -- the same reason the branch above asks for them.
  const expanded = flattenNamespaceTools(merged.tools, { aliasCollisions: true });
  if (!Array.isArray(expanded.tools) || expanded.tools.length <= GROQ_MAX_TOOLS) return expanded;

  const client = flattenNamespaceTools(tools, { aliasCollisions: true });
  const clientToolCount = Array.isArray(client.tools) ? client.tools.length : 0;
  if (!Array.isArray(client.tools) || clientToolCount > GROQ_MAX_TOOLS) {
    throw new GroqToolLimitError({
      clientToolCount,
      expandedToolCount: expanded.tools.length,
    });
  }

  const inventory = clientToolInventory(tools);
  const referenced = referencedAppTools(input, toolChoice, inventory);
  const requiredDefinitions = new Map(
    [...referenced].filter(([key]) => !inventory.nativeIdentities.has(key)),
  );
  const referencedToolCapacity = GROQ_MAX_TOOLS - clientToolCount;
  if (requiredDefinitions.size > referencedToolCapacity) {
    throw new GroqToolLimitError({
      clientToolCount,
      expandedToolCount: expanded.tools.length,
      referencedToolCapacity,
      referencedToolCount: requiredDefinitions.size,
    });
  }

  const selected = flattenNamespaceTools(
    withRequiredAppTools(tools, requiredDefinitions),
    { aliasCollisions: true },
  );
  if (!Array.isArray(selected.tools) || selected.tools.length > GROQ_MAX_TOOLS) {
    throw new GroqToolLimitError({
      clientToolCount,
      expandedToolCount: expanded.tools.length,
      referencedToolCapacity,
      referencedToolCount: requiredDefinitions.size,
    });
  }
  return selected;
}
