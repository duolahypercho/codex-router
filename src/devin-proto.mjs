// Wire schemas for the subset of `exa.api_server_pb.ApiServerService` the Devin
// CLI provider speaks. Field numbers are transcribed from the descriptor set
// embedded in the shipped `devin` binary, which is the only published source
// for them -- Cognition documents no model API.
//
// Only fields the router reads or writes are listed. Everything else on the
// wire decodes to nothing, which is deliberate: the upstream adds fields
// without notice and this provider must not fail a turn over one.

export const CHAT_MESSAGE_SOURCE = Object.freeze({
  UNSPECIFIED: 0,
  USER: 1,
  SYSTEM: 2,
  UNKNOWN: 3,
  TOOL: 4,
  SYSTEM_PROMPT: 5,
});

export const CHAT_MESSAGE_REQUEST_TYPE = Object.freeze({
  UNSPECIFIED: 0,
  GENERAL: 1,
  CASCADE: 5,
});

export const STOP_REASON = Object.freeze({
  UNSPECIFIED: 0,
  INCOMPLETE: 1,
  STOP_PATTERN: 2,
  MAX_TOKENS: 3,
  PARTIAL: 9,
  FUNCTION_CALL: 10,
  CONTENT_FILTER: 11,
  ERROR: 13,
});

export const TRAJECTORY_TYPE_CASCADE = 4;
export const STEP_TYPE_USER_INPUT = 14;
export const PLANNER_MODE_DEFAULT = 1;

export const METADATA = Object.freeze({
  ideName: { no: 1, type: "string" },
  extensionVersion: { no: 2, type: "string" },
  apiKey: { no: 3, type: "string" },
  locale: { no: 4, type: "string" },
  os: { no: 5, type: "string" },
  ideVersion: { no: 7, type: "string" },
  extensionName: { no: 12, type: "string" },
  deviceFingerprint: { no: 24, type: "string" },
  f: { no: 31, type: "string" },
});

export const IMAGE_DATA = Object.freeze({
  base64Data: { no: 1, type: "string" },
  mimeType: { no: 2, type: "string" },
  caption: { no: 3, type: "string" },
});

export const CHAT_TOOL_CALL = Object.freeze({
  id: { no: 1, type: "string" },
  name: { no: 2, type: "string" },
  argumentsJson: { no: 3, type: "string" },
  invalidJsonStr: { no: 4, type: "string" },
  invalidJsonErr: { no: 5, type: "string" },
  isCustomToolCall: { no: 6, type: "bool" },
});

export const CHAT_MESSAGE_PROMPT = Object.freeze({
  messageId: { no: 1, type: "string" },
  source: { no: 2, type: "enum" },
  prompt: { no: 3, type: "string" },
  numTokens: { no: 4, type: "uint32" },
  toolCalls: { no: 6, type: "message", message: CHAT_TOOL_CALL, repeated: true },
  toolCallId: { no: 7, type: "string" },
  toolResultIsError: { no: 9, type: "bool" },
  images: { no: 10, type: "message", message: IMAGE_DATA, repeated: true },
  thinking: { no: 11, type: "string" },
  signature: { no: 12, type: "string" },
  thinkingRedacted: { no: 13, type: "bool" },
  outputId: { no: 15, type: "string" },
  thinkingId: { no: 16, type: "string" },
  signatureType: { no: 18, type: "string" },
});

export const CHAT_TOOL_DEFINITION = Object.freeze({
  name: { no: 1, type: "string" },
  description: { no: 2, type: "string" },
  jsonSchemaString: { no: 3, type: "string" },
  strict: { no: 12, type: "bool" },
});

// `choice` is a oneof; writing both members would put two fields on the wire
// and let the upstream pick. Callers set exactly one.
export const CHAT_TOOL_CHOICE = Object.freeze({
  optionName: { no: 1, type: "string" },
  toolName: { no: 2, type: "string" },
});

export const COMPLETION_CONFIGURATION = Object.freeze({
  numCompletions: { no: 1, type: "uint64" },
  maxTokens: { no: 2, type: "uint64" },
  maxNewlines: { no: 3, type: "uint64" },
  temperature: { no: 5, type: "double" },
  topK: { no: 7, type: "uint64" },
  topP: { no: 8, type: "double" },
  stopPatterns: { no: 9, type: "string", repeated: true },
});

export const TRAJECTORY_REFERENCE = Object.freeze({
  trajectoryId: { no: 1, type: "string" },
  stepIndex: { no: 2, type: "int32" },
  trajectoryType: { no: 3, type: "enum" },
  stepType: { no: 4, type: "enum" },
});

export const GET_CHAT_MESSAGE_REQUEST = Object.freeze({
  metadata: { no: 1, type: "message", message: METADATA },
  prompt: { no: 2, type: "string" },
  chatMessagePrompts: { no: 3, type: "message", message: CHAT_MESSAGE_PROMPT, repeated: true },
  requestType: { no: 7, type: "enum" },
  configuration: { no: 8, type: "message", message: COMPLETION_CONFIGURATION },
  tools: { no: 10, type: "message", message: CHAT_TOOL_DEFINITION, repeated: true },
  disableParallelToolCalls: { no: 11, type: "bool" },
  toolChoice: { no: 12, type: "message", message: CHAT_TOOL_CHOICE },
  chatModelName: { no: 14, type: "string" },
  trajectoryReference: { no: 15, type: "message", message: TRAJECTORY_REFERENCE },
  cascadeId: { no: 16, type: "string" },
  promptId: { no: 17, type: "string" },
  plannerMode: { no: 20, type: "enum" },
  chatModelUid: { no: 21, type: "string" },
  executionId: { no: 22, type: "string" },
});

export const MODEL_USAGE_STATS = Object.freeze({
  inputTokens: { no: 2, type: "uint64" },
  outputTokens: { no: 3, type: "uint64" },
  cacheWriteTokens: { no: 4, type: "uint64" },
  cacheReadTokens: { no: 5, type: "uint64" },
  modelUid: { no: 9, type: "string" },
});

export const GET_CHAT_MESSAGE_RESPONSE = Object.freeze({
  messageId: { no: 1, type: "string" },
  deltaText: { no: 3, type: "string" },
  deltaTokens: { no: 4, type: "uint32" },
  stopReason: { no: 5, type: "enum" },
  deltaToolCalls: { no: 6, type: "message", message: CHAT_TOOL_CALL, repeated: true },
  usage: { no: 7, type: "message", message: MODEL_USAGE_STATS },
  redact: { no: 8, type: "bool" },
  deltaThinking: { no: 9, type: "string" },
  deltaSignature: { no: 10, type: "string" },
  thinkingRedacted: { no: 11, type: "bool" },
  creditCost: { no: 14, type: "int32" },
  outputId: { no: 15, type: "string" },
  thinkingId: { no: 16, type: "string" },
  requestId: { no: 17, type: "string" },
  deltaSignatureType: { no: 21, type: "string" },
  actualModelUid: { no: 23, type: "string" },
});

export const MODEL_INFO = Object.freeze({
  modelName: { no: 1, type: "string" },
  maxOutputTokens: { no: 8, type: "int32" },
});

export const CLIENT_MODEL_CONFIG = Object.freeze({
  label: { no: 1, type: "string" },
  disabled: { no: 4, type: "bool" },
  supportsImages: { no: 5, type: "bool" },
  isPremium: { no: 7, type: "bool" },
  isBeta: { no: 9, type: "bool" },
  maxTokens: { no: 18, type: "int32" },
  modelUid: { no: 22, type: "string" },
  description: { no: 27, type: "string" },
});

export const GET_CASCADE_MODEL_CONFIGS_REQUEST = Object.freeze({
  metadata: { no: 1, type: "message", message: METADATA },
});

export const GET_CASCADE_MODEL_CONFIGS_RESPONSE = Object.freeze({
  clientModelConfigs: { no: 1, type: "message", message: CLIENT_MODEL_CONFIG, repeated: true },
});

export const SERVICE_PATH = "exa.api_server_pb.ApiServerService";
export const GET_CHAT_MESSAGE = "GetChatMessage";
export const GET_CASCADE_MODEL_CONFIGS = "GetCascadeModelConfigs";
