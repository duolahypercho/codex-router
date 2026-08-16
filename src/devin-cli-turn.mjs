// Translation between the OpenAI Chat Completions request LiteLLM sends this
// provider and the Cascade `GetChatMessage` call the Devin backend answers.
// Kept free of I/O so the mapping can be tested without an account.

import { randomUUID } from "node:crypto";

import {
  CHAT_MESSAGE_REQUEST_TYPE,
  CHAT_MESSAGE_SOURCE,
  PLANNER_MODE_DEFAULT,
  STEP_TYPE_USER_INPUT,
  STOP_REASON,
  TRAJECTORY_TYPE_CASCADE,
} from "./devin-proto.mjs";

const CLIENT_NAME = "windsurf";
const CLIENT_VERSION = "1.0.0";

// Cascade has no "assistant" message source. The shipped client sends prior
// model turns as SYSTEM, and a turn built any other way is rejected.
const SOURCE_BY_ROLE = Object.freeze({
  user: CHAT_MESSAGE_SOURCE.USER,
  assistant: CHAT_MESSAGE_SOURCE.SYSTEM,
  tool: CHAT_MESSAGE_SOURCE.TOOL,
});

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && (part.type === "text" || typeof part.text === "string"))
    .map((part) => part.text || "")
    .join("");
}

function imagesFromContent(content) {
  if (!Array.isArray(content)) return [];
  const images = [];
  for (const part of content) {
    const url = part?.type === "image_url" ? part.image_url?.url : undefined;
    if (typeof url !== "string") continue;
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
    if (!match) continue;
    images.push({ mimeType: match[1], base64Data: match[2] });
  }
  return images;
}

// A tool description block mirroring the shipped client: Cascade models are
// prompted with their tools inline as well as receiving the structured
// definitions, and a turn that omits the block calls tools noticeably less.
export function withToolDescriptions(systemPrompt, tools = []) {
  const escape = (value) =>
    String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const sections = [];
  for (const tool of tools) {
    const name = tool?.function?.name;
    const description = String(tool?.function?.description || "").trim();
    if (!name || !description) continue;
    sections.push(`<tool name="${escape(name)}">\n${escape(description)}\n</tool>`);
  }
  if (!sections.length) return systemPrompt;
  const block = `# tools descriptions\n${sections.join("\n")}`;
  const trimmed = String(systemPrompt || "").replace(/[\r\n]+$/, "");
  return trimmed.trim() ? `${trimmed}\n\n${block}` : block;
}

function toolChoiceFor(toolChoice) {
  if (!toolChoice) return undefined;
  if (typeof toolChoice === "string") return { optionName: toolChoice };
  const name = toolChoice?.function?.name;
  return name ? { toolName: name } : undefined;
}

// Cascade accepts images only on the current turn; replaying historical ones
// fails the whole request with `invalid_argument`. The current turn is every
// message after the last assistant reply.
function lastAssistantIndex(messages) {
  let index = -1;
  for (let position = 0; position < messages.length; position += 1) {
    if (messages[position]?.role === "assistant") index = position;
  }
  return index;
}

function promptForMessage(message, { attachImages, newId }) {
  const source = SOURCE_BY_ROLE[message.role];
  if (source === undefined) return undefined;
  const prompt = { messageId: newId(), source, prompt: textFromContent(message.content) };

  const images = attachImages ? imagesFromContent(message.content) : [];
  if (images.length) prompt.images = images;
  else if (!attachImages && imagesFromContent(message.content).length) {
    prompt.prompt = `${prompt.prompt}\n[Image omitted from history]`.trim();
  }

  if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
    prompt.toolCalls = message.tool_calls
      .filter((call) => call?.function?.name)
      .map((call) => ({
        id: call.id || newId(),
        name: call.function.name,
        argumentsJson: call.function.arguments || "{}",
      }));
  }
  if (message.role === "tool") {
    prompt.toolCallId = message.tool_call_id || "";
  }
  return prompt;
}

export function buildChatMessageRequest(chat, { token, modelUid, newId = randomUUID } = {}) {
  const messages = Array.isArray(chat?.messages) ? chat.messages : [];
  const tools = Array.isArray(chat?.tools) ? chat.tools : [];
  const systemPrompt = messages
    .filter((message) => message?.role === "system" || message?.role === "developer")
    .map((message) => textFromContent(message.content))
    .join("\n\n");

  const conversation = messages.filter(
    (message) => message?.role !== "system" && message?.role !== "developer",
  );
  const boundary = lastAssistantIndex(conversation);

  const request = {
    metadata: {
      apiKey: token,
      ideName: CLIENT_NAME,
      ideVersion: CLIENT_VERSION,
      extensionName: CLIENT_NAME,
      extensionVersion: CLIENT_VERSION,
      locale: "en",
      os: { darwin: "mac", win32: "win" }[process.platform] || "linux",
    },
    prompt: withToolDescriptions(systemPrompt, tools),
    chatModelUid: modelUid,
    requestType: CHAT_MESSAGE_REQUEST_TYPE.CASCADE,
    plannerMode: PLANNER_MODE_DEFAULT,
    cascadeId: newId(),
    executionId: newId(),
    promptId: newId(),
    trajectoryReference: {
      trajectoryId: newId(),
      trajectoryType: TRAJECTORY_TYPE_CASCADE,
      stepType: STEP_TYPE_USER_INPUT,
    },
    configuration: {
      numCompletions: 1,
      maxTokens: Number(chat?.max_tokens) > 0 ? Number(chat.max_tokens) : 128_000,
      maxNewlines: 400,
      temperature: typeof chat?.temperature === "number" ? chat.temperature : 1,
      topK: 40,
      topP: 0.95,
    },
    chatMessagePrompts: [],
  };

  for (let index = 0; index < conversation.length; index += 1) {
    const prompt = promptForMessage(conversation[index], {
      attachImages: index > boundary,
      newId,
    });
    if (prompt) request.chatMessagePrompts.push(prompt);
  }

  if (tools.length) {
    request.tools = tools
      .filter((tool) => tool?.function?.name)
      .map((tool) => ({
        name: tool.function.name,
        description: String(tool.function.description || ""),
        jsonSchemaString: JSON.stringify(tool.function.parameters ?? { type: "object", properties: {} }),
      }));
  }
  const choice = toolChoiceFor(chat?.tool_choice);
  if (choice) request.toolChoice = choice;
  if (chat?.parallel_tool_calls === false) request.disableParallelToolCalls = true;

  return request;
}

export function finishReasonFor(stopReason, sawToolCall) {
  if (sawToolCall || stopReason === STOP_REASON.FUNCTION_CALL) return "tool_calls";
  if (stopReason === STOP_REASON.MAX_TOKENS) return "length";
  if (stopReason === STOP_REASON.CONTENT_FILTER) return "content_filter";
  return "stop";
}

export function usageFrom(stats) {
  if (!stats) return undefined;
  const prompt = Number(stats.inputTokens || 0);
  const completion = Number(stats.outputTokens || 0);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: Number(stats.cacheReadTokens || 0) },
  };
}
