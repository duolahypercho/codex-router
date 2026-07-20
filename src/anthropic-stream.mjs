import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

function eventRecords(text) {
  const records = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue;
    let event;
    const data = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length) records.push({ event, data: data.join("\n") });
  }
  return records;
}

function rewriteMessageStartRecord(block, modelOverride) {
  const lineEnding = block.includes("\r\n") ? "\r\n" : "\n";
  const lines = block.split(/\r?\n/);
  const dataIndexes = lines
    .map((line, index) => (line.startsWith("data:") ? index : undefined))
    .filter((index) => index !== undefined);
  if (!dataIndexes.length) return block;
  const raw = dataIndexes.map((index) => lines[index].slice(5).trimStart()).join("\n");
  if (raw === "[DONE]") return block;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return block;
  }
  if (
    payload?.type !== "message_start" ||
    !payload.message ||
    typeof payload.message !== "object" ||
    Array.isArray(payload.message)
  ) {
    return block;
  }
  payload = {
    ...payload,
    message: { ...payload.message, model: modelOverride },
  };
  const first = dataIndexes[0];
  lines[first] = `data: ${JSON.stringify(payload)}`;
  const extraIndexes = new Set(dataIndexes.slice(1));
  return lines.filter((_line, index) => !extraIndexes.has(index)).join(lineEnding);
}

export function createAnthropicSseModelTransform(modelOverride) {
  const decoder = new StringDecoder("utf8");
  let buffered = "";

  function emitRecords(stream) {
    while (true) {
      const separator = buffered.match(/\r?\n\r?\n/);
      if (!separator || separator.index === undefined) return;
      const block = buffered.slice(0, separator.index);
      buffered = buffered.slice(separator.index + separator[0].length);
      stream.push(rewriteMessageStartRecord(block, modelOverride));
      stream.push(separator[0]);
    }
  }

  return new Transform({
    transform(chunk, _encoding, callback) {
      buffered += decoder.write(chunk);
      emitRecords(this);
      callback();
    },
    flush(callback) {
      buffered += decoder.end();
      emitRecords(this);
      if (buffered) this.push(rewriteMessageStartRecord(buffered, modelOverride));
      callback();
    },
  });
}

function appendValue(target, key, value) {
  if (value === undefined) return;
  if (typeof value === "string" && typeof target[key] === "string") {
    target[key] += value;
  } else {
    target[key] = value;
  }
}

function sanitizedBlock(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const block = { ...value };
  if (block.provider_specific_fields == null) delete block.provider_specific_fields;
  return block;
}

export function collectAnthropicSse(text, modelOverride) {
  let message;
  let sawStop = false;
  const toolJson = new Map();

  for (const record of eventRecords(text)) {
    if (record.data === "[DONE]") continue;
    let payload;
    try {
      payload = JSON.parse(record.data);
    } catch {
      throw new Error("The Messages adapter returned an invalid SSE event.");
    }
    const type = payload?.type || record.event;
    if (type === "ping") continue;
    if (type === "error") {
      throw new Error("The Messages adapter returned a streamed error.");
    }
    if (type === "message_start") {
      const initial = payload.message;
      if (!initial || typeof initial !== "object" || Array.isArray(initial)) {
        throw new Error("The Messages adapter returned an invalid message_start event.");
      }
      message = {
        ...initial,
        type: "message",
        role: "assistant",
        content: Array.isArray(initial.content)
          ? initial.content.map((block) => sanitizedBlock(block))
          : [],
      };
      continue;
    }
    if (!message) {
      throw new Error("The Messages adapter streamed content before message_start.");
    }
    if (type === "content_block_start") {
      const index = Number(payload.index);
      if (!Number.isInteger(index) || index < 0) {
        throw new Error("The Messages adapter returned an invalid content-block index.");
      }
      message.content[index] = sanitizedBlock(payload.content_block || {});
      if (message.content[index]?.type === "tool_use") toolJson.set(index, "");
      continue;
    }
    if (type === "content_block_delta") {
      const index = Number(payload.index);
      const block = message.content[index];
      const delta = payload.delta;
      if (!Number.isInteger(index) || index < 0 || !block || !delta) {
        throw new Error("The Messages adapter returned an invalid content-block delta.");
      }
      if (delta.type === "input_json_delta") {
        toolJson.set(index, `${toolJson.get(index) || ""}${delta.partial_json || ""}`);
      } else if (delta.type === "text_delta") {
        appendValue(block, "text", delta.text || "");
      } else if (delta.type === "thinking_delta") {
        appendValue(block, "thinking", delta.thinking || "");
      } else if (delta.type === "signature_delta") {
        appendValue(block, "signature", delta.signature || "");
      } else {
        for (const [key, value] of Object.entries(delta)) {
          if (key !== "type") appendValue(block, key, value);
        }
      }
      continue;
    }
    if (type === "content_block_stop") {
      const index = Number(payload.index);
      const block = message.content[index];
      if (block?.type === "tool_use") {
        const raw = toolJson.get(index) || "";
        if (raw) {
          try {
            block.input = JSON.parse(raw);
          } catch {
            throw new Error("The Messages adapter returned invalid tool input JSON.");
          }
        } else if (!block.input || typeof block.input !== "object") {
          block.input = {};
        }
      }
      continue;
    }
    if (type === "message_delta") {
      if (payload.delta && typeof payload.delta === "object") {
        Object.assign(message, payload.delta);
      }
      if (payload.usage && typeof payload.usage === "object") {
        message.usage = { ...(message.usage || {}), ...payload.usage };
      }
      continue;
    }
    if (type === "message_stop") sawStop = true;
  }

  if (!message || !sawStop) {
    throw new Error("The Messages adapter ended before message_stop.");
  }
  message.content = message.content.filter(Boolean).map((block) => sanitizedBlock(block));
  if (modelOverride) message.model = modelOverride;
  return message;
}
