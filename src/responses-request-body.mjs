import { once } from "node:events";
import { PassThrough, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createBrotliDecompress, createGunzip, createInflate, createZstdDecompress } from "node:zlib";
import { parser } from "stream-json/parser.js";
import Assembler from "stream-json/assembler.js";
import { MAX_BODY_BYTES, zstdFrameContentSize } from "./http-utils.mjs";
import { boundImagePayload, imagePartBytes, isImageHistoryAction, IMAGE_PAYLOAD_BUDGET_BYTES } from "./prompt-image-budget.mjs";

// Incoming history can be much larger than the retained prompt. Keep its wire
// and decoded sizes bounded, but never buffer all of its old image data.
export const MAX_IMAGE_HISTORY_BYTES = 2 * 1024 * 1024 * 1024;

function failure(status, message) {
  return Object.assign(new Error(message), { status });
}

function decodingStages(header) {
  const encodings = String(Array.isArray(header) ? header.join(",") : header || "")
    .split(",").map((value) => value.trim().toLowerCase())
    .filter((value) => value && value !== "identity").reverse();
  return encodings.map((encoding) => {
    if (encoding === "gzip" || encoding === "x-gzip") return createGunzip();
    if (encoding === "deflate") return createInflate();
    if (encoding === "br") return createBrotliDecompress();
    if (encoding === "zstd") {
      let prefix = Buffer.alloc(0);
      const checkFrame = new Transform({
        transform(chunk, _, callback) {
          if (prefix.length < 18) {
            prefix = Buffer.concat([prefix, chunk.subarray(0, 18 - prefix.length)]);
            const declared = zstdFrameContentSize(prefix);
            if (declared !== undefined && declared > MAX_IMAGE_HISTORY_BYTES) {
              callback(failure(413, "Decoded image history is too large."));
              return;
            }
          }
          callback(null, chunk);
        },
      });
      return [checkFrame, createZstdDecompress()];
    }
    throw failure(415, `Unsupported Content-Encoding: ${encoding}`);
  }).flat();
}

export async function readResponsesRequest(request, {
  signal, maxBytes = MAX_BODY_BYTES, maxHistoryBytes = MAX_IMAGE_HISTORY_BYTES,
} = {}) {
  if (signal?.aborted) {
    request.destroy?.();
    signal.throwIfAborted();
  }
  maxBytes = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 128 * 1024 * 1024;
  maxHistoryBytes = Number.isFinite(maxHistoryBytes) && maxHistoryBytes > 0 ? Math.floor(maxHistoryBytes) : MAX_IMAGE_HISTORY_BYTES;
  let decoders;
  try { decoders = decodingStages(request.headers?.["content-encoding"]); }
  catch (cause) { request.resume?.(); throw cause; }
  const source = new PassThrough();
  const assembler = new Assembler();
  let error, wireBytes = 0, decodedBytes = 0, retainedBytes = 0, stringBytes = 0;
  let imagesDropped = 0, imageBytesSaved = 0;
  let imageItems = [], latestAction, actionBoundary = 0, imageBytesHeld = 0;
  const decodedLimit = new Transform({
    transform(chunk, _, callback) {
      decodedBytes += chunk.length;
      callback(decodedBytes > maxHistoryBytes
        ? failure(413, `Decoded image history exceeds ${maxHistoryBytes} bytes.`) : null, chunk);
    },
  });
  const processing = pipeline(source, ...decoders,
    decodedLimit, parser.asStream({ streamStrings: true, streamKeys: true, streamNumbers: true }), async (tokens) => {
      for await (const token of tokens) {
        if (["startString", "startKey", "startNumber"].includes(token.name)) stringBytes = 0;
        if (token.name === "stringChunk" || token.name === "numberChunk") {
          stringBytes += Buffer.byteLength(token.value);
          if (stringBytes > maxBytes) throw failure(413, "A request string exceeds the retained body limit.");
        }
        if (["stringValue", "keyValue", "numberValue"].includes(token.name)) {
          retainedBytes += Buffer.byteLength(token.value) + 4;
        } else if (["startObject", "startArray", "trueValue", "falseValue", "nullValue"].includes(token.name)) {
          retainedBytes += 16;
        }
        assembler.consume(token);
        // A completed item in the top-level input array. Only image-bearing
        // items and the latest model action need scanning; text history stays.
        if (token.name === "endObject" && assembler.depth === 2 && assembler.path[0] === "input") {
          const item = assembler.current.at(-1);
          const isAction = isImageHistoryAction(item);
          const bytes = [item.content, item.output].flatMap((parts) => Array.isArray(parts) ? parts : [])
            .reduce((sum, part) => sum + (imagePartBytes(part) ?? 0), 0);
          const hasImages = bytes > 0;
          if (isAction || hasImages) {
            if (isAction) { latestAction = { type: "reasoning" }; actionBoundary = imageItems.length; }
            if (hasImages) { imageItems.push(item); imageBytesHeld += bytes; }
            // Only measured inline data needs retention work. No scan is
            // necessary until the byte budget is exceeded by consumed images.
            if (!actionBoundary || imageBytesHeld <= IMAGE_PAYLOAD_BUDGET_BYTES) continue;
            const history = [...imageItems.slice(0, actionBoundary), latestAction, ...imageItems.slice(actionBoundary)];
            const bounded = boundImagePayload(history, { protectPending: true, maxTokens: Infinity });
            const retained = [];
            let newBoundary = 0;
            for (let index = 0; index < imageItems.length; index += 1) {
              const rewritten = bounded.input[index < actionBoundary ? index : index + 1];
              if (rewritten !== imageItems[index]) Object.assign(imageItems[index], rewritten);
              const value = imageItems[index];
              if ([value.content, value.output].some((parts) => Array.isArray(parts) &&
                parts.some((part) => imagePartBytes(part) !== undefined))) {
                retained.push(value);
                if (index < actionBoundary) newBoundary++;
              }
            }
            imageItems = retained;
            actionBoundary = newBoundary;
            imageBytesHeld = bounded.stats.imageBytesAfter;
            const saved = bounded.stats.imageBytesSaved;
            retainedBytes -= Math.floor(saved * 4 / 3);
            imagesDropped += bounded.stats.imageReferencesDropped;
            imageBytesSaved += saved;
          }
        }
        // A pending image group needs one-item lookahead to distinguish old
        // evidence from the current batch. Final retained size stays maxBytes.
        // ponytail: transient assembly is capped at twice the retained limit.
        if (retainedBytes > 2 * maxBytes) throw failure(413, "Pending request body is too large.");
      }
    }, { signal }).catch((cause) => {
      error ??= cause.status ? cause : failure(400, "Invalid or compressed JSON request.");
    });
  const abort = () => request.destroy?.(signal.reason);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for await (const chunk of request) {
      wireBytes += chunk.length;
      if (wireBytes > maxHistoryBytes) {
        error ??= failure(413, `Image history exceeds ${maxHistoryBytes} bytes.`);
        source.destroy(error);
      }
      // Drain rejected requests without retaining their tail, so the response
      // remains writable and rejected bytes cannot become another request.
      if (error) continue;
      try { if (!source.write(chunk)) await once(source, "drain"); }
      catch (cause) { error ??= cause.status ? cause : failure(400, "Invalid JSON request."); }
    }
    source.end();
    await processing;
    if (signal?.aborted) throw signal.reason;
    if (error) throw error;
    const payload = assembler.current;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw failure(400, "Request JSON must be an object.");
    }
    const retainedBodyBytes = Buffer.byteLength(JSON.stringify(payload));
    if (retainedBodyBytes > maxBytes) {
      throw failure(413, `Retained request body exceeds ${maxBytes} bytes.`);
    }
    return { payload, stats: { wireBytes, decodedBytes, retainedBodyBytes, imagesDropped, imageBytesSaved } };
  } finally {
    source.destroy();
    signal?.removeEventListener("abort", abort);
    await processing;
  }
}
