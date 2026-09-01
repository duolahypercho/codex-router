import { createHash } from "node:crypto";

// Tool results are replayed on every following turn. A single large command
// output can therefore cost its full size many times after the model has
// already acted on it. Keep the policy deliberately narrow: only old, textual
// results above this floor qualify, and the newest result frontier stays
// byte-for-byte intact on ordinary turns. RTK-style shaping is reserved for an
// actual routed compaction request, after the client has decided it needs one.
export const TOOL_RESULT_AGING_MIN_BYTES = 32 * 1024;
export const TOOL_RESULT_AGING_FRONTIER = 4;
export const DENSE_SHAPING_MIN_BYTES = 8 * 1024;

const PREVIEW_CODE_UNITS = 1_024;
const DENSE_SHAPING_MIN_SAVED_BYTES = 1_024;
const DENSE_SHAPING_RECEIPT_PREFIX =
  "[Tool result shaped by Codex Router RTK-style compaction:";
const LEGACY_TOKEN_MAXXING_RECEIPT_PREFIX =
  "[Tool result shaped by Codex Router token maxxing:";
const OUTPUT_TYPES = new Set(["function_call_output", "custom_tool_call_output"]);
const MODEL_ACTION_TYPES = new Set([
  "function_call",
  "custom_tool_call",
  "reasoning",
]);

function modelActed(item) {
  if (MODEL_ACTION_TYPES.has(item?.type)) return true;
  return item?.type === "message" && item.role === "assistant";
}

function textualOutput(item) {
  if (!OUTPUT_TYPES.has(item?.type)) return undefined;
  if (typeof item.output === "string") return item.output;
  if (!Array.isArray(item.output)) return undefined;
  const text = [];
  for (const part of item.output) {
    if (
      !part ||
      typeof part !== "object" ||
      !["input_text", "text"].includes(part.type) ||
      typeof part.text !== "string"
    ) {
      return undefined;
    }
    text.push(part.text);
  }
  return text.join("");
}

function safeHead(value) {
  let end = Math.min(value.length, PREVIEW_CODE_UNITS);
  if (end < value.length && /[\uD800-\uDBFF]/u.test(value[end - 1])) end -= 1;
  return value.slice(0, end);
}

function safeTail(value) {
  let start = Math.max(0, value.length - PREVIEW_CODE_UNITS);
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(value[start])) start += 1;
  return value.slice(start);
}

function leadingIndent(value) {
  const match = /^( *)\S/u.exec(value);
  return match ? match[1].length : 0;
}

const IMPORTANT_LINE =
  /\b(error|failed?|failure|exception|fatal|panic|traceback|warning|denied|invalid|security)\b/iu;

function collapseTerminalRewrites(value) {
  return value
    .replace(/\r\n/gu, "\n")
    .split("\n")
    .map((line) => {
      if (!line.includes("\r")) return line;
      const rewrites = line.split("\r");
      const final = rewrites.findLast((entry) => entry.length > 0) ?? "";
      const important = rewrites.filter(
        (entry) => entry !== final && IMPORTANT_LINE.test(entry),
      );
      return [...important, final].join("\n");
    })
    .join("\n");
}

function collapseRepeatedLines(lines) {
  const compacted = [];
  for (let index = 0; index < lines.length; ) {
    const line = lines[index];
    let end = index + 1;
    while (end < lines.length && lines[end] === line) end += 1;
    const count = end - index;
    if (count >= 3 && line.trim()) {
      const marker = `[same line repeated ${count - 1} more times]`;
      const replacement = `${line}\n${marker}`;
      const originalLength = line.length * count + count - 1;
      if (replacement.length < originalLength) {
        compacted.push(line, marker);
      } else {
        compacted.push(...lines.slice(index, end));
      }
    } else if (!line.trim() && count > 1) {
      compacted.push(line);
    } else {
      compacted.push(...lines.slice(index, end));
    }
    index = end;
  }
  return compacted;
}

function collapseDeeplyIndentedBlocks(lines) {
  const compacted = [];
  for (let index = 0; index < lines.length; ) {
    if (leadingIndent(lines[index]) < 8 || IMPORTANT_LINE.test(lines[index])) {
      compacted.push(lines[index]);
      index += 1;
      continue;
    }
    let end = index + 1;
    while (
      end < lines.length &&
      leadingIndent(lines[end]) >= 8 &&
      !IMPORTANT_LINE.test(lines[end])
    ) {
      end += 1;
    }
    const count = end - index;
    if (count >= 8) {
      const marker = `[${count - 2} deeply indented lines omitted]`;
      const replacement = `${lines[index]}\n${marker}\n${lines[end - 1]}`;
      let originalLength = count - 1;
      for (let cursor = index; cursor < end; cursor += 1) {
        originalLength += lines[cursor].length;
      }
      if (replacement.length < originalLength) {
        compacted.push(lines[index], marker, lines[end - 1]);
      } else {
        compacted.push(...lines.slice(index, end));
      }
    } else {
      compacted.push(...lines.slice(index, end));
    }
    index = end;
  }
  return compacted;
}

// A deliberately small, deterministic RTK-style shaper. It removes terminal
// progress rewrites, exact repetition, blank-line runs, and deep boilerplate,
// while preserving error-bearing lines. The caller keeps a digest and rerun
// instruction because this is a lossy compaction optimization.
export function shapeToolResult(value) {
  if (typeof value !== "string" || !value) return value;
  const normalized = collapseTerminalRewrites(value);
  const repeated = collapseRepeatedLines(normalized.split("\n"));
  const shaped = collapseDeeplyIndentedBlocks(repeated).join("\n");
  return shaped.length < value.length ? shaped : value;
}

function recoveryInstruction(toolName) {
  return toolName
    ? `Repeat the preceding ${toolName} call with the same arguments`
    : "Repeat the preceding tool call with the same arguments";
}

function shapedResult(value, toolName) {
  if (
    value.startsWith(DENSE_SHAPING_RECEIPT_PREFIX) ||
    value.startsWith(LEGACY_TOKEN_MAXXING_RECEIPT_PREFIX)
  ) {
    return undefined;
  }
  const shaped = shapeToolResult(value);
  if (shaped === value) return undefined;
  const before = Buffer.byteLength(value, "utf8");
  const shapedBytes = Buffer.byteLength(shaped, "utf8");
  const digest = createHash("sha256").update(value, "utf8").digest("hex");
  const receipt = [
    `${DENSE_SHAPING_RECEIPT_PREFIX} ${before} -> ${shapedBytes} bytes, sha256:${digest}.`,
    `${recoveryInstruction(toolName)} if exact or omitted content is needed. ` +
      "The original result remains in Codex; only this routed copy was shaped.]",
    "",
    shaped,
  ].join("\n");
  const after = Buffer.byteLength(receipt, "utf8");
  return before - after >= DENSE_SHAPING_MIN_SAVED_BYTES ? receipt : undefined;
}

function resultReceipt(value, toolName) {
  const bytes = Buffer.byteLength(value, "utf8");
  const digest = createHash("sha256").update(value, "utf8").digest("hex");
  return [
    `[Older tool result compacted by Codex Router after the model acted on it: ${bytes} bytes, sha256:${digest}.`,
    `${recoveryInstruction(toolName)} if exact or omitted content is needed. The original result remains in Codex; only this routed copy was compacted.]`,
    "",
    "--- beginning of original result ---",
    safeHead(value),
    "--- omitted middle of original result ---",
    safeTail(value),
    "--- end of original result ---",
  ].join("\n");
}

function callNames(input) {
  const names = new Map();
  for (const item of input) {
    if (
      ["function_call", "custom_tool_call"].includes(item?.type) &&
      typeof item.call_id === "string" &&
      typeof item.name === "string"
    ) {
      names.set(item.call_id, item.name);
    }
  }
  return names;
}

export function ageToolResults(
  input,
  {
    enabled = true,
    minBytes = TOOL_RESULT_AGING_MIN_BYTES,
    frontier = TOOL_RESULT_AGING_FRONTIER,
    denseShaping = false,
  } = {},
) {
  const empty = {
    toolResultsAged: 0,
    toolResultBytesBefore: 0,
    toolResultBytesAfter: 0,
    toolResultBytesSaved: 0,
  };
  // A disabled pass reports nothing beyond the zeroed counters, so "off" stays
  // distinguishable from "on and nothing qualified" -- two states this used to
  // report identically, leaving no way to prove the pass had run at all.
  if (!enabled || !Array.isArray(input)) return { input, stats: empty };

  const outputIndexes = [];
  const actedAfter = new Array(input.length).fill(false);
  let laterModelAction = false;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    actedAfter[index] = laterModelAction;
    if (modelActed(input[index])) laterModelAction = true;
  }
  for (let index = 0; index < input.length; index += 1) {
    if (OUTPUT_TYPES.has(input[index]?.type)) outputIndexes.push(index);
  }
  const protectedIndexes = new Set(outputIndexes.slice(-Math.max(0, frontier)));
  const names = callNames(input);
  let changed = false;
  let toolResultsAged = 0;
  let toolResultsShaped = 0;
  let toolResultBytesBefore = 0;
  let toolResultBytesAfter = 0;
  let toolResultShapeBytesSaved = 0;
  // What the pass looked at, recorded whether or not anything qualified. A
  // session can spend its whole context on results that each sit under the
  // floor, and without these the outcome is indistinguishable from the pass
  // never running. The largest result seen says which it was: compare it
  // against minBytes.
  let toolResultsEvaluated = 0;
  let toolResultBytesLargest = 0;
  const replacements = new Map();
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    const protectedResult = protectedIndexes.has(index);
    if (protectedResult && !denseShaping) continue;
    const value = textualOutput(item);
    if (value === undefined) continue;
    const size = Buffer.byteLength(value, "utf8");
    if (!protectedResult) {
      toolResultsEvaluated += 1;
      if (size > toolResultBytesLargest) toolResultBytesLargest = size;
    }
    const canAge = !protectedResult && size > minBytes && actedAfter[index];
    let receipt;
    let shaped = false;
    if (canAge) {
      receipt = resultReceipt(value, names.get(item.call_id));
    } else if (denseShaping && size > DENSE_SHAPING_MIN_BYTES) {
      receipt = shapedResult(value, names.get(item.call_id));
      shaped = receipt !== undefined;
    }
    if (!receipt) continue;
    const rewritten = { ...item, output: receipt };
    // Count model-visible text rather than serializing the whole item again.
    // The request path will serialize once later; avoiding a second copy here
    // matters when the result itself is hundreds of megabytes.
    const before = size;
    const after = Buffer.byteLength(receipt, "utf8");
    if (after >= before) continue;
    changed = true;
    if (shaped) {
      toolResultsShaped += 1;
      toolResultShapeBytesSaved += before - after;
    } else {
      toolResultsAged += 1;
    }
    toolResultBytesBefore += before;
    toolResultBytesAfter += after;
    replacements.set(index, rewritten);
  }
  const next = changed
    ? input.map((item, index) => replacements.get(index) ?? item)
    : input;
  const toolResultBytesSaved = toolResultBytesBefore - toolResultBytesAfter;
  return {
    input: next,
    stats: {
      toolResultsAged,
      toolResultsShaped,
      toolResultBytesBefore,
      toolResultBytesAfter,
      toolResultBytesSaved,
      toolResultShapeBytesSaved,
      toolResultsEvaluated,
      toolResultBytesLargest,
    },
  };
}
