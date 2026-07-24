// Pure helpers that describe a just-captured secret so interactive prompts can
// confirm a paste registered without ever echoing or persisting the value.
// The hidden key prompt reads with terminal echo disabled, so a paste gives no
// visual feedback; reporting the captured length and flagging an input that
// looks like the same value pasted twice prevents silent doubled keys.

export const MIN_DOUBLED_SECRET_LENGTH = 8;

function normalized(value) {
  return String(value ?? "").trim();
}

export function secretEntryFeedback(value) {
  const key = normalized(value);
  if (!key) return "No characters were received.";
  const characters = [...key].length;
  return `Received ${characters} character${characters === 1 ? "" : "s"}.`;
}

export function secretEntryProblem(value) {
  if (!normalized(value)) return "empty";
  if (looksDoubledSecret(value)) return "doubled";
  return undefined;
}

export function looksDoubledSecret(value) {
  const key = normalized(value);
  if (key.length < MIN_DOUBLED_SECRET_LENGTH) return false;
  if (key.length % 2 === 0) {
    const half = key.length / 2;
    return key.slice(0, half) === key.slice(half);
  }
  const middle = (key.length - 1) / 2;
  return /\s/.test(key[middle]) && key.slice(0, middle) === key.slice(middle + 1);
}
