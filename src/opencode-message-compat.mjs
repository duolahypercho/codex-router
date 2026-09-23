// Console Go rejects a single Anthropic/Chat message whose `content` is longer
// than 2,500,000 characters (`messages[N].content exceeds maximum length of
// 2500000`). A live OpenCode Go Messages ImageGen turn (17 September 2026,
// session 01a0ae2b-ef63-7993-8d0e-8660cfd7c587) generated a 1536x1024 PNG whose
// data URL is 2,707,238 characters. Codex stored the file; the follow-up turn
// 400'd before a final_answer. The Chat Completions hoist keeps those bytes and
// still overflows. Replace oversized image payloads with a labeled stub so
// the hop can continue. Do not invent image bytes or repair tool JSON.
export const OPENCODE_MESSAGE_CONTENT_LIMIT = 2_500_000;
const OPENCODE_MESSAGE_CONTENT_BUDGET = 2_400_000;
const DATA_URL_PATTERN = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/gi;

export function openCodeOversizedImageNotice() {
  return (
    "[Image from a tool result omitted: Console Go rejects a single message " +
    `over ${OPENCODE_MESSAGE_CONTENT_LIMIT} characters. The generated image ` +
    "was delivered to the Codex client.]"
  );
}

export function contentChars(content) {
  if (typeof content === "string") return content.length;
  if (content == null) return 0;
  try {
    return JSON.stringify(content).length;
  } catch {
    return 0;
  }
}

function replaceOversizedDataUrls(text) {
  if (typeof text !== "string") return text;
  const notice = openCodeOversizedImageNotice();
  return text.replace(DATA_URL_PATTERN, (match) =>
    match.length > OPENCODE_MESSAGE_CONTENT_BUDGET ? notice : match,
  );
}

function imageUrlValue(part) {
  if (typeof part?.image_url === "string") return part.image_url;
  if (typeof part?.image_url?.url === "string") return part.image_url.url;
  if (typeof part?.url === "string") return part.url;
  return undefined;
}

function imageSourceChars(source) {
  if (!source || typeof source !== "object") return 0;
  if (typeof source.data === "string") return source.data.length;
  if (typeof source.url === "string") return source.url.length;
  return contentChars(source);
}

function clampContentPart(part) {
  if (typeof part === "string") return replaceOversizedDataUrls(part);
  if (!part || typeof part !== "object") return part;
  if (part.type === "image_url" || part.type === "input_image") {
    const url = imageUrlValue(part);
    if (typeof url === "string" && url.length > OPENCODE_MESSAGE_CONTENT_BUDGET) {
      return { type: "text", text: openCodeOversizedImageNotice() };
    }
    return part;
  }
  if (part.type === "image" && imageSourceChars(part.source) > OPENCODE_MESSAGE_CONTENT_BUDGET) {
    return { type: "text", text: openCodeOversizedImageNotice() };
  }
  if (typeof part.text === "string") {
    const text = replaceOversizedDataUrls(part.text);
    return text === part.text ? part : { ...part, text };
  }
  if (part.content !== undefined) {
    const content = clampMessageContent(part.content);
    return content === part.content ? part : { ...part, content };
  }
  return part;
}

function clampMessageContent(content) {
  if (typeof content === "string") return replaceOversizedDataUrls(content);
  if (!Array.isArray(content)) return content;
  let changed = false;
  const next = content.map((part) => {
    const clamped = clampContentPart(part);
    if (clamped !== part) changed = true;
    return clamped;
  });
  return changed ? next : content;
}

export function clampOpenCodeMessageContent(messages) {
  if (!Array.isArray(messages)) return messages;
  let changed = false;
  const next = messages.map((message) => {
    if (!message || typeof message !== "object") return message;
    if (contentChars(message.content) <= OPENCODE_MESSAGE_CONTENT_BUDGET) return message;
    const content = clampMessageContent(message.content);
    if (content === message.content) return message;
    changed = true;
    return { ...message, content };
  });
  return changed ? next : messages;
}
