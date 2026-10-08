import { constants as bufferConstants } from "node:buffer";
import { once } from "node:events";
import { PassThrough, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createBrotliDecompress, createGunzip, createInflate, createZstdDecompress } from "node:zlib";
import { parser } from "stream-json/parser.js";
import Assembler from "stream-json/assembler.js";
import { MAX_BODY_BYTES, zstdFrameContentSize } from "./http-utils.mjs";
import {
  boundImagePayload, boundedJsonByteLength, imagePartBytes, isImageHistoryAction,
  IMAGE_PAYLOAD_BUDGET_BYTES, JsonStringSize, MAX_REQUEST_JSON_DEPTH,
} from "./prompt-image-budget.mjs";

// History has a finite streaming allowance; retained JSON keeps the ordinary
// request limit. Explicit transport limits can be smaller than this allowance.
export const MAX_IMAGE_HISTORY_BYTES = 2 * 1024 * 1024 * 1024;
const PARSER_CHUNK_BYTES = 64 * 1024;

function failure(status, message) {
  return Object.assign(new Error(message), { status });
}

function positiveLimit(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function byteLimit(maxBytes, onChunk) {
  let bytes = 0;
  return new Transform({
    transform(chunk, _, callback) {
      bytes += chunk.length;
      onChunk?.(bytes);
      if (bytes > maxBytes) callback(failure(413, `Decoded image history exceeds ${maxBytes} bytes.`));
      else callback(null, chunk);
    },
  });
}

function decodingStages(header, maxBytes) {
  const encodings = String(Array.isArray(header) ? header.join(",") : header || "")
    .split(",").map((value) => value.trim().toLowerCase())
    .filter((value) => value && value !== "identity").reverse();
  return encodings.flatMap((encoding) => {
    let decoder;
    if (encoding === "gzip" || encoding === "x-gzip") decoder = createGunzip();
    else if (encoding === "deflate") decoder = createInflate();
    else if (encoding === "br") decoder = createBrotliDecompress();
    else if (encoding === "zstd") {
      let prefix = Buffer.alloc(0);
      const checkFrame = new Transform({
        transform(chunk, _, callback) {
          if (prefix.length < 18) {
            prefix = Buffer.concat([prefix, chunk.subarray(0, 18 - prefix.length)]);
            const declared = zstdFrameContentSize(prefix);
            if (declared !== undefined && declared > maxBytes) {
              callback(failure(413, `Decoded image history exceeds ${maxBytes} bytes.`));
              return;
            }
          }
          callback(null, chunk);
        },
      });
      return [checkFrame, createZstdDecompress(), byteLimit(maxBytes)];
    } else throw failure(415, `Unsupported Content-Encoding: ${encoding}`);
    // An intermediate compressed member may be much larger than the final
    // JSON. Cap every stage before handing its bytes to the next decoder.
    return [decoder, byteLimit(maxBytes)];
  });
}

export async function readResponsesRequest(request, {
  signal, maxBytes = MAX_BODY_BYTES, maxHistoryBytes = MAX_IMAGE_HISTORY_BYTES,
  maxWireBytes = maxHistoryBytes,
} = {}) {
  if (signal?.aborted) {
    request.destroy?.();
    signal.throwIfAborted();
  }
  maxBytes = Math.min(positiveLimit(maxBytes, 128 * 1024 * 1024), bufferConstants.MAX_STRING_LENGTH);
  maxHistoryBytes = positiveLimit(maxHistoryBytes, MAX_IMAGE_HISTORY_BYTES);
  maxWireBytes = positiveLimit(maxWireBytes, maxHistoryBytes);
  let decoders;
  try { decoders = decodingStages(request.headers?.["content-encoding"], maxHistoryBytes); }
  catch (cause) { request.resume?.(); throw cause; }
  const source = new PassThrough();
  const assembler = new Assembler();
  let error, wireBytes = 0, decodedBytes = 0, retainedBytes = 0;
  let scalar, scalarValue = "", scalarSize, scalarBytes = 0;
  const containers = [];
  let imagesDropped = 0, imageBytesSaved = 0;
  let imageItems = [], actionBoundary = 0, imageBytesHeld = 0;
  function rejectAssembly(status, message) {
    // Node 22 can replace an async pipeline sink's rejection with AbortError
    // during teardown. Keep the original limit status before that happens.
    error ??= failure(status, message);
    throw error;
  }
  function startValue() {
    const parent = containers.at(-1);
    if (parent?.array && parent.members++) retainedBytes++;
  }
  function trimCompletedImages() {
    if (!actionBoundary || (imageBytesHeld <= IMAGE_PAYLOAD_BUDGET_BYTES && retainedBytes <= maxBytes)) return;
    const history = [...imageItems.slice(0, actionBoundary), { type: "reasoning" }, ...imageItems.slice(actionBoundary)];
    const bounded = boundImagePayload(history, {
      protectPending: true, maxTokens: Infinity, maxBodyBytes: maxBytes, bodyBytes: retainedBytes,
    });
    const retained = [];
    let newBoundary = 0;
    for (let index = 0; index < imageItems.length; index++) {
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
    retainedBytes = bounded.stats.bodyBytesAfter;
    imagesDropped += bounded.stats.imageReferencesDropped;
    imageBytesSaved += bounded.stats.imageBytesSaved;
  }
  const processing = pipeline(source, ...decoders,
    byteLimit(maxHistoryBytes, (bytes) => { decodedBytes = bytes; }),
    parser.asStream({ packValues: false, streamValues: true }), async (tokens) => {
      for await (const token of tokens) {
        if (token.name === "startKey" || token.name === "startString" || token.name === "startNumber") {
          scalar = token.name;
          scalarValue = "";
          scalarSize = new JsonStringSize();
          scalarBytes = scalar === "startNumber" ? 0 : 2;
          if (scalar === "startKey") {
            if (containers.at(-1).members++) retainedBytes++;
            retainedBytes += 1; // colon
          } else startValue();
          retainedBytes += scalarBytes;
        } else if (token.name === "stringChunk" || token.name === "numberChunk") {
          const before = scalarBytes;
          scalarBytes = scalar === "startNumber" ? scalarBytes + token.value.length : scalarSize.add(token.value);
          retainedBytes += scalarBytes - before;
          if (scalarBytes > maxBytes + (scalarSize.highSurrogate ? 2 : 0)) {
            rejectAssembly(413, "A request string exceeds the retained body limit.");
          }
          scalarValue += token.value;
        } else if (token.name === "endKey" || token.name === "endString" || token.name === "endNumber") {
          if (scalarBytes > maxBytes) rejectAssembly(413, "A request string exceeds the retained body limit.");
          if (token.name === "endNumber") retainedBytes += boundedJsonByteLength(Number(scalarValue)) - scalarBytes;
          assembler.consume({
            name: token.name === "endKey" ? "keyValue" : token.name === "endString" ? "stringValue" : "numberValue",
            value: scalarValue,
          });
          scalarValue = "";
        } else {
          if (token.name === "startObject" || token.name === "startArray") {
            if (containers.length >= MAX_REQUEST_JSON_DEPTH) rejectAssembly(400, "Request JSON is nested too deeply.");
            startValue();
            retainedBytes += 2; // opening and closing delimiters
            containers.push({ array: token.name === "startArray", members: 0 });
          } else if (token.name === "endObject" || token.name === "endArray") containers.pop();
          else {
            startValue();
            retainedBytes += token.name === "falseValue" ? 5 : 4;
          }
          assembler.consume(token);
        }
        if (token.name === "endObject" && assembler.depth === 2 && assembler.path[0] === "input" && Array.isArray(assembler.current)) {
          const item = assembler.current.at(-1);
          if (isImageHistoryAction(item)) actionBoundary = imageItems.length;
          const bytes = [item.content, item.output].flatMap((parts) => Array.isArray(parts) ? parts : [])
            .reduce((sum, part) => sum + (imagePartBytes(part) ?? 0), 0);
          if (bytes > 0) { imageItems.push(item); imageBytesHeld += bytes; }
          trimCompletedImages();
        }
        // One bounded group can wait for the following model action. The
        // canonical UTF-8 size includes escapes, keys and envelope overhead.
        if (retainedBytes > 2 * maxBytes + (scalarSize?.highSurrogate ? 2 : 0)) rejectAssembly(413, "Pending request body is too large.");
      }
    }, { signal }).catch((cause) => {
      error ??= cause.status ? cause : failure(400, "Invalid or compressed JSON request.");
    });
  const abort = () => request.destroy?.(signal.reason);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const declared = Number(request.headers?.["content-length"]);
    if (Number.isFinite(declared) && declared > maxWireBytes) {
      error = failure(413, `Image history exceeds ${maxWireBytes} wire bytes.`);
      source.destroy(error);
    }
    for await (const chunk of request) {
      wireBytes += chunk.length;
      if (wireBytes > maxWireBytes && !error) {
        error = failure(413, `Image history exceeds ${maxWireBytes} wire bytes.`);
        source.destroy(error);
      }
      // Drain rejected tails without retention to preserve HTTP framing and
      // the writable response. No rejected byte can become the next request.
      if (error) continue;
      try {
        for (let offset = 0; offset < chunk.length && !error; offset += PARSER_CHUNK_BYTES) {
          if (!source.write(chunk.subarray(offset, offset + PARSER_CHUNK_BYTES))) await once(source, "drain");
        }
      } catch (cause) { error ??= cause.status ? cause : failure(400, "Invalid JSON request."); }
    }
    source.end();
    await processing;
    if (signal?.aborted) throw signal.reason;
    if (error) throw error;
    const payload = assembler.current;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw failure(400, "Request JSON must be an object.");
    }
    // Late envelope fields can consume the remaining allowance. Trim with
    // their exact serialized size before any whole-body serialization occurs.
    const bounded = boundImagePayload(payload.input, {
      protectPending: true, maxTokens: Infinity,
      maxBodyBytes: maxBytes, bodyBytes: boundedJsonByteLength(payload),
    });
    if (bounded.input !== payload.input) payload.input = bounded.input;
    imagesDropped += bounded.stats.imageReferencesDropped;
    imageBytesSaved += bounded.stats.imageBytesSaved;
    const retainedBodyBytes = boundedJsonByteLength(payload, maxBytes);
    if (retainedBodyBytes > maxBytes) throw failure(413, `Retained request body exceeds ${maxBytes} bytes.`);
    return { payload, stats: { wireBytes, decodedBytes, retainedBodyBytes, imagesDropped, imageBytesSaved } };
  } finally {
    source.destroy();
    signal?.removeEventListener("abort", abort);
    await processing;
  }
}
