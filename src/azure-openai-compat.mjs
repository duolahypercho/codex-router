import { stripCodexEncryptedSchemaAnnotation } from "./tool-schema-root.mjs";

const COLLABORATION_MESSAGE_TOOLS = new Set([
  "agents__spawn_agent",
  "agents__send_message",
  "agents__followup_task",
  "collaboration__spawn_agent",
  "collaboration__send_message",
  "collaboration__followup_task",
]);
const COLLABORATION_NAMESPACES = new Set(["agents", "collaboration"]);
const COLLABORATION_MESSAGE_NAMES = new Set([
  "spawn_agent",
  "send_message",
  "followup_task",
]);

function plaintextCollaborationTool(tool) {
  const key = Object.hasOwn(tool, "parameters") ? "parameters" : "inputSchema";
  const schema = tool[key];
  const normalized = stripCodexEncryptedSchemaAnnotation(schema);
  return normalized === schema ? tool : { ...tool, [key]: normalized };
}

export function normalizeAzureOpenAIResponsesRequest(payload, { providerId, route } = {}) {
  if (
    providerId !== "azure-kmamc" ||
    route !== "/responses" ||
    !payload ||
    typeof payload !== "object" ||
    !Array.isArray(payload.tools)
  ) {
    return payload;
  }

  const filteredTools = payload.tools.filter((tool) => {
    // Hosted image-generation declaration.
    if (tool?.type === "image_generation") return false;

    // Current Codex imagegen extension:
    // namespace "image_gen" containing function "imagegen".
    if (tool?.type === "namespace" && tool?.name === "image_gen") return false;

    // Compatibility with flattened/legacy representations.
    if (tool?.type === "function") {
      const name =
        typeof tool?.name === "string"
          ? tool.name
          : tool?.function?.name;

      if (name === "image_gen.imagegen" || name === "image_gen__imagegen") {
        return false;
      }
    }

    return true;
  });

  const hasCollaboration = filteredTools.some(
    (tool) => tool?.type === "namespace" && tool.name === "collaboration",
  );
  const hasAgents = filteredTools.some(
    (tool) => tool?.type === "namespace" && tool.name === "agents",
  );
  if (hasCollaboration && hasAgents) {
    const error = new Error("Azure collaboration alias conflicts with an existing agents namespace.");
    error.status = 400;
    throw error;
  }

  let plaintextTools = false;
  const tools = filteredTools.map((tool) => {
    if (tool?.type === "namespace" && COLLABORATION_NAMESPACES.has(tool.name) && Array.isArray(tool.tools)) {
      let changed = false;
      const children = tool.tools.map((child) => {
        if (child?.type !== "function" || !COLLABORATION_MESSAGE_NAMES.has(child.name)) {
          return child;
        }
        const normalized = plaintextCollaborationTool(child);
        changed ||= normalized !== child;
        return normalized;
      });
      if (!changed && tool.name !== "collaboration") return tool;
      plaintextTools = true;
      return { ...tool, name: tool.name === "collaboration" ? "agents" : tool.name, tools: children };
    }
    if (tool?.type !== "function" || !COLLABORATION_MESSAGE_TOOLS.has(tool.name)) {
      return tool;
    }
    const normalized = plaintextCollaborationTool(tool);
    plaintextTools ||= normalized !== tool;
    return normalized;
  });

  if (tools.length === payload.tools.length && !plaintextTools) return payload;

  const normalized = { ...payload, tools };
  if (hasCollaboration) {
    if (Array.isArray(payload.input)) {
      normalized.input = payload.input.map((item) =>
        item?.type === "function_call" && item.namespace === "collaboration"
          ? { ...item, namespace: "agents" }
          : item
      );
    }
    if (payload.tool_choice?.type === "function" && payload.tool_choice.namespace === "collaboration") {
      normalized.tool_choice = { ...payload.tool_choice, namespace: "agents" };
    }
  }
  if (tools.length === 0) delete normalized.tools;
  return normalized;
}
