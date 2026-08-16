import { readFileSync } from "node:fs";

import { devinCredentialsPath, devinSessionEntry } from "./devin-cli-status.mjs";

// Unlike the Kimi and Grok sessions, the Devin CLI credential carries no
// expiry: `devin auth login` writes a persistent token and the CLI has no
// refresh command to drive. There is therefore nothing to renew -- a rejected
// token means the operator must sign in again, and saying so beats spawning a
// CLI that cannot help.
function oauthError(message) {
  const error = new Error(message);
  error.code = "oauth_unauthorized";
  error.status = 401;
  return error;
}

export function readDevinSession({ credentialsPath = devinCredentialsPath() } = {}) {
  let contents;
  try {
    contents = readFileSync(credentialsPath, "utf8");
  } catch {
    throw oauthError("Devin CLI session is unavailable; run `devin auth login`.");
  }
  let session;
  try {
    session = devinSessionEntry(contents);
  } catch (error) {
    throw oauthError(`Devin CLI session file could not be read plainly: ${error.message}`);
  }
  if (!session) {
    throw oauthError("Devin CLI session is incomplete; run `devin auth login`.");
  }
  return session;
}
