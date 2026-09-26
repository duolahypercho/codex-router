import { DEFAULT_IMAGE_TOKEN_BOUND } from "./prompt-image-usage.mjs";

// The per-image charge used when a route's own bound is not known. The router
// call site passes `maxImageTokensForRoute(route)` explicitly; for a resold
// route that returns `undefined`, which the default parameter below turns into
// the shared `DEFAULT_IMAGE_TOKEN_BOUND` (4096) from prompt-image-usage.mjs.
// Imported rather than restated so the two modules cannot drift apart.

// OpenRouter refuses a request whose downloaded image content exceeds 30MB
// ("HTTP 413: Downloaded image content cannot exceed 30MB"). Measured on this
// host 2026-09-17: 81 screenshots (~12MB decoded) answered 200; 211 of the same
// screenshots (~31MB decoded) answered 413. The limit is on the total decoded
// image content of one request, not on any single image.
//
// A conversation replays every image it still holds on every following turn, so
// an ordinary session that views screenshots crosses that ceiling on its own -
// the Kalaam worker's session reached 1,791 image references before its turns
// started failing outright. That is a stalled agent, not a slow one, so the
// router bounds the payload before the turn leaves rather than trusting each
// capture to stay small.
//
// The budget is deliberately below the provider's ceiling: 20MB decoded leaves
// 10MB of headroom for a provider that counts differently (base64 versus decoded
// bytes, or a slightly different multiplier) and for the text of the same
// request. Being wrong in this direction costs an old screenshot the model has
// already acted on; being wrong in the other direction costs the whole turn.
export const IMAGE_PAYLOAD_BUDGET_BYTES = 20 * 1024 * 1024;

// Bytes bound the request, not the bill. Under 20MB every image still rides
// along on every following turn and is charged again, so a session that keeps
// each screenshot small can carry a hundred of them and stay under the byte
// line while the per-turn prompt cost runs away. This second budget caps that:
// each counted image is charged the route's per-image token bound (4096 on a
// resold route, 1024 on the native DeepSeek Flash API - see
// `maxImageTokensForRoute`), and the oldest images become receipts until the
// total image tokens fit. The figure is a small slice of the 1,048,576-token
// window (about an eighth) and of the 900,000-token auto-compaction threshold
// (about a seventh): images can be a real part of a turn but never most of it.
//
// The bound is a flat constant, not a fraction of the route's window. A bigger
// window does not make an image cheaper - it only delays compaction - and what
// this bounds is recurring spend per turn, so scaling the cap with the window
// would raise the bill precisely on the routes that can hide it. The honest
// reading of the number: 128K image tokens is a steady-state per-turn cost once
// a session reaches it, not a one-off saving.
export const IMAGE_PAYLOAD_BUDGET_TOKENS = 128 * 1024;

// The newest images are the ones the model is actually looking at, so they are
// never dropped, even if a single one were to exceed the budget by itself.
export const IMAGE_PAYLOAD_KEEP_NEWEST = 2;

// Known limit, alongside the newest-two rule above. Only `data:image/` references
// are measured, so a remote https image URL is invisible to this budget - and the
// provider's error says "Downloaded image content", which is exactly what it does
// with a URL it fetches. Codex sends data URLs, so that path is not reachable
// today; if a surface ever forwards a remote image, it needs measuring here too.

const IMAGE_PART_TYPES = new Set(["input_image", "image_url"]);
const DATA_URL = /^data:image\//i;
const RECEIPT =
  "[image omitted by Codex Router: this conversation was carrying more image " +
  "content than one request should hold. Re-capture the screen if you need it " +
  "again.]";

function dataUrlDecodedBytes(value) {
  const comma = value.indexOf(",");
  if (comma === -1) return 0;
  const payload = value.length - comma - 1;
  // base64 carries 3 bytes per 4 characters. Padding only ever rounds down, so
  // this is an upper bound on what the provider downloads, which is the safe
  // direction for a budget.
  return Math.floor((payload * 3) / 4);
}

function imagePartBytes(part) {
  if (!part || typeof part !== "object" || !IMAGE_PART_TYPES.has(part.type)) return undefined;
  const url = typeof part.image_url === "string" ? part.image_url
    : typeof part.image_url?.url === "string" ? part.image_url.url
      : undefined;
  if (url === undefined || !DATA_URL.test(url)) return undefined;
  return dataUrlDecodedBytes(url);
}

// Both shapes a Responses input uses for content that can carry an image: a
// message's `content`, and a tool result's `output`.
function partArrays(item) {
  if (!item || typeof item !== "object") return [];
  const arrays = [];
  if (Array.isArray(item.content)) arrays.push(["content", item.content]);
  if (Array.isArray(item.output)) arrays.push(["output", item.output]);
  return arrays;
}

// Replace image references with text until the payload fits both budgets, oldest
// first. Returns the original array untouched when nothing has to go, so an
// ordinary turn is not copied or re-serialized.
export function boundImagePayload(
  input,
  {
    maxBytes = IMAGE_PAYLOAD_BUDGET_BYTES,
    maxTokens = IMAGE_PAYLOAD_BUDGET_TOKENS,
    keepNewest = IMAGE_PAYLOAD_KEEP_NEWEST,
    tokensPerImage = DEFAULT_IMAGE_TOKEN_BOUND,
  } = {},
) {
  const empty = {
    imageReferencesSeen: 0,
    imageReferencesDropped: 0,
    imageBytesBefore: 0,
    imageBytesAfter: 0,
    imageBytesSaved: 0,
    imageTokensBefore: 0,
    imageTokensAfter: 0,
    imageTokensSaved: 0,
  };
  if (!Array.isArray(input)) return { input, stats: empty };

  // A missing or nonsensical bound disables that half of the check rather than
  // dropping every image: the caller passing no token budget must not be read as
  // "budget of zero".
  const perImageTokens =
    Number.isSafeInteger(tokensPerImage) && tokensPerImage > 0 ? tokensPerImage : 0;
  const tokenBudget = Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : Infinity;

  const references = [];
  for (let itemIndex = 0; itemIndex < input.length; itemIndex += 1) {
    for (const [field, parts] of partArrays(input[itemIndex])) {
      for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
        const bytes = imagePartBytes(parts[partIndex]);
        if (bytes === undefined) continue;
        references.push({ itemIndex, field, partIndex, bytes });
      }
    }
  }
  const imageBytesBefore = references.reduce((total, reference) => total + reference.bytes, 0);
  const imageTokensBefore = references.length * perImageTokens;
  const stats = {
    ...empty,
    imageReferencesSeen: references.length,
    imageBytesBefore,
    imageBytesAfter: imageBytesBefore,
    imageTokensBefore,
    imageTokensAfter: imageTokensBefore,
  };
  // Nothing to do when the conversation is inside the budget, and nothing to do
  // when the only images are the ones we promised never to drop.
  const droppable = references.slice(0, Math.max(0, references.length - Math.max(0, keepNewest)));
  if (
    (imageBytesBefore <= maxBytes && imageTokensBefore <= tokenBudget) ||
    droppable.length === 0
  ) return { input, stats };

  let remainingBytes = imageBytesBefore;
  let remainingTokens = imageTokensBefore;
  const dropped = new Set();
  for (const reference of droppable) {
    if (remainingBytes <= maxBytes && remainingTokens <= tokenBudget) break;
    dropped.add(reference);
    remainingBytes -= reference.bytes;
    remainingTokens -= perImageTokens;
  }
  if (dropped.size === 0) return { input, stats };

  // Group by item so each rewritten item is copied once, not once per image.
  const byItem = new Map();
  for (const reference of dropped) {
    if (!byItem.has(reference.itemIndex)) byItem.set(reference.itemIndex, []);
    byItem.get(reference.itemIndex).push(reference);
  }
  const next = input.map((item, itemIndex) => {
    const hits = byItem.get(itemIndex);
    if (!hits) return item;
    const rewritten = { ...item };
    for (const [field] of partArrays(item)) {
      const indexes = new Set(
        hits.filter((hit) => hit.field === field).map((hit) => hit.partIndex),
      );
      if (indexes.size === 0) continue;
      rewritten[field] = item[field].map((part, partIndex) =>
        indexes.has(partIndex) ? { type: "input_text", text: RECEIPT } : part);
    }
    return rewritten;
  });

  let imageBytesAfter = 0;
  for (const reference of references) {
    if (!dropped.has(reference)) imageBytesAfter += reference.bytes;
  }
  const imageTokensAfter = (references.length - dropped.size) * perImageTokens;
  return {
    input: next,
    stats: {
      imageReferencesSeen: references.length,
      imageReferencesDropped: dropped.size,
      imageBytesBefore,
      imageBytesAfter,
      imageBytesSaved: imageBytesBefore - imageBytesAfter,
      imageTokensBefore,
      imageTokensAfter,
      imageTokensSaved: imageTokensBefore - imageTokensAfter,
    },
  };
}

// The budget above is a measurement of one provider on one day, not a contract.
// A provider that counts differently, lowers its ceiling, or caps the number of
// images rather than their size still refuses the request, and a refused
// compaction is retried by the client before every following turn - the
// session stalls for good. So a refusal that names image content is answered by
// sending less of it, rather than by surfacing an error nobody can act on.
//
// Only a 400 or 413 whose body says an image was too large or too many counts:
// a generic 413 is this router's own inbound frame limit, and a 400 about
// anything else would not be fixed by dropping screenshots.
const IMAGE_REJECTION = /\bimages?\b[^\n]{0,120}?\b(exceed|too large|too big|too many|maximum|limit|size)/i;

export function isImagePayloadRejection({ status, bodyText } = {}) {
  if (status !== 400 && status !== 413) return false;
  return typeof bodyText === "string" && IMAGE_REJECTION.test(bodyText);
}

// How many times one request may be resent with fewer images. Each retry halves
// what the last attempt carried, so two retries reach a quarter of it - well
// under any ceiling the first attempt merely grazed - while a provider that
// refuses even that still fails in bounded time.
export const IMAGE_REJECTION_MAX_RETRIES = 2;

// The budget for the next attempt after `stats` was refused, or undefined when
// nothing more can go: every image left is one of the newest the budget never
// drops, so resending would only repeat the refusal.
export function tighterImageBudget(stats, { keepNewest = IMAGE_PAYLOAD_KEEP_NEWEST } = {}) {
  if (!stats) return undefined;
  const remaining = stats.imageReferencesSeen - stats.imageReferencesDropped;
  if (remaining <= Math.max(0, keepNewest)) return undefined;
  return {
    maxBytes: Math.floor(stats.imageBytesAfter / 2),
    // A route with no per-image charge reports zero tokens; halving that would
    // read as "no budget" and disable the check, so keep the byte half only.
    maxTokens: stats.imageTokensAfter > 0 ? Math.floor(stats.imageTokensAfter / 2) : undefined,
  };
}
