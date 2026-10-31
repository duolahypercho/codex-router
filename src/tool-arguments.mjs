// Codex tool schemas use integer/u64 fields. Some routed models (Grok in
// particular) emit whole numbers as JSON floats (`20000.0`). Serde then
// rejects the call before the tool runs.
//
// JSON.parse cannot see the difference between 20000 and 20000.0, so this
// rewrites number tokens in the raw argument string.

const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;
const JSON_NUMBER_PARTS = /^(-)?(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;
const PLAIN_INTEGER = /^-?(?:0|[1-9]\d*)$/;

// Decide integrality from the token spelling. JS Number rounds 1e-324 to 0
// and cannot represent every u64, so it must not be the judge.
function integerSpelling(token) {
  const parts = token.match(JSON_NUMBER_PARTS);
  if (!parts) return undefined;
  const sign = parts[1] || "";
  const intPart = parts[2];
  const fracPart = parts[3] || "";
  const exp = parts[4] === undefined ? 0 : Number.parseInt(parts[4], 10);
  if (!Number.isSafeInteger(exp)) return undefined;
  const digits = intPart + fracPart;
  const point = intPart.length + exp;
  if (point > 40) return undefined;
  for (let i = Math.max(0, point); i < digits.length; i += 1) {
    if (digits[i] !== "0") return undefined;
  }
  let integerDigits;
  if (point <= 0) integerDigits = "0";
  else if (point >= digits.length) integerDigits = digits + "0".repeat(point - digits.length);
  else integerDigits = digits.slice(0, point);
  integerDigits = integerDigits.replace(/^0+(?=\d)/, "") || "0";
  if (integerDigits === "0") return "0";
  return `${sign}${integerDigits}`;
}

function integerToken(token) {
  if (PLAIN_INTEGER.test(token) && token !== "-0") return token;
  return integerSpelling(token) ?? token;
}

export function rewriteWholeNumberTokens(raw) {
  if (typeof raw !== "string" || raw.length === 0) return raw;
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; ) {
    const ch = raw[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      const match = raw.slice(i).match(JSON_NUMBER);
      if (match) {
        out += integerToken(match[0]);
        i += match[0].length;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

export function coerceFunctionCallArguments(raw) {
  if (typeof raw !== "string") return raw;
  try {
    JSON.parse(raw);
  } catch {
    return raw;
  }
  const rewritten = rewriteWholeNumberTokens(raw);
  if (rewritten === raw) return raw;
  try {
    JSON.parse(rewritten);
  } catch {
    return raw;
  }
  return rewritten;
}
