import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import http from "node:http";

import {
  ANTIGRAVITY_AUTH_URL,
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_CLIENT_SECRET,
  ANTIGRAVITY_REDIRECT_URI,
  ANTIGRAVITY_SCOPES,
  ANTIGRAVITY_TOKEN_URL,
  antigravityCallbackTarget,
  antigravityUserAgent,
} from "./antigravity-oauth-constants.mjs";
import {
  discoverAntigravityProject,
  resolveAntigravityProject,
} from "./antigravity-project.mjs";
import { saveAntigravityToken } from "./antigravity-oauth-session.mjs";
import { installStableFetchTransport } from "./fetch-transport.mjs";

installStableFetchTransport();

export { resolveAntigravityProject };

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

export function generateAntigravityPkce(random = randomBytes) {
  const verifier = base64Url(random(64));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function verifierChallenge(verifier) {
  return base64Url(createHash("sha256").update(verifier).digest());
}

export function antigravityAuthorizationUrl(
  verifier,
  state,
  { redirectUri = ANTIGRAVITY_REDIRECT_URI } = {},
) {
  // Validation and listener derivation share the same helper, so the URI sent
  // to Google cannot drift from the local callback server.
  const validatedRedirect = antigravityCallbackTarget(redirectUri).redirectUri;
  const url = new URL(ANTIGRAVITY_AUTH_URL);
  url.searchParams.set("client_id", ANTIGRAVITY_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", validatedRedirect);
  url.searchParams.set("scope", ANTIGRAVITY_SCOPES.join(" "));
  url.searchParams.set("code_challenge", verifierChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

export async function exchangeAntigravityCode(
  code,
  verifier,
  { fetchImpl = fetch, now = Date.now, redirectUri = ANTIGRAVITY_REDIRECT_URI } = {},
) {
  const validatedRedirect = antigravityCallbackTarget(redirectUri).redirectUri;
  const response = await fetchImpl(ANTIGRAVITY_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      Accept: "*/*",
      "User-Agent": antigravityUserAgent(),
    },
    body: new URLSearchParams({
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: validatedRedirect,
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      `Antigravity OAuth token exchange failed with HTTP ${response.status}.`,
    );
    error.code = response.status >= 500 ? "oauth_transient" : "oauth_unauthorized";
    error.status = response.status >= 500 ? 503 : 401;
    throw error;
  }

  const expiresIn = Number(payload.expires_in);
  if (
    typeof payload.access_token !== "string" ||
    typeof payload.refresh_token !== "string" ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0
  ) {
    throw new Error("Antigravity OAuth token exchange returned an incomplete response.");
  }
  return {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    expires_at: Math.floor(now() / 1_000) + expiresIn,
    expires_in: expiresIn,
    token_type: typeof payload.token_type === "string" ? payload.token_type : "Bearer",
  };
}

export async function fetchAntigravityUserEmail(accessToken, { fetchImpl = fetch } = {}) {
  try {
    const response = await fetchImpl("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return undefined;
    const data = await response.json().catch(() => ({}));
    return typeof data?.email === "string" ? data.email : undefined;
  } catch {
    return undefined;
  }
}

function openBrowser(url) {
  let command;
  let args;
  let env;
  if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else if (process.platform === "win32") {
    command = "powershell.exe";
    args = [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Start-Process $env:CODEX_ROUTER_BROWSER_URL",
    ];
    env = { ...process.env, CODEX_ROUTER_BROWSER_URL: url };
  } else {
    command = "xdg-open";
    args = [url];
  }
  const child = spawn(command, args, {
    stdio: "ignore",
    detached: true,
    windowsHide: true,
    ...(env ? { env } : {}),
  });
  child.on("error", () => {});
  child.unref();
}

const BROWSER_RESPONSE_HEADERS = Object.freeze({
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
});

function browserResponse(response, status, html) {
  response.writeHead(status, BROWSER_RESPONSE_HEADERS);
  response.end(html);
}

// Runs the interactive Google OAuth authorization-code + PKCE flow.
export function signInAntigravity({
  fetchImpl = fetch,
  open = openBrowser,
  redirectUri = ANTIGRAVITY_REDIRECT_URI,
  timeoutMs = 10 * 60_000,
  now = Date.now,
  projectAttempts = 10,
  projectRetryDelayMs = 5_000,
  delayImpl,
} = {}) {
  const callback = antigravityCallbackTarget(redirectUri);
  return new Promise((resolve, reject) => {
    const pkce = generateAntigravityPkce();
    const state = randomUUID();
    const authorizationUrl = antigravityAuthorizationUrl(pkce.verifier, state, {
      redirectUri: callback.redirectUri,
    });
    process.stdout.write(`Open this URL to sign in to Antigravity:\n\n  ${authorizationUrl}\n\n`);

    let settled = false;
    let processing = false;
    let timer;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close(() => {});
      if (error) reject(error);
      else resolve(result);
    };

    const server = http.createServer(async (request, response) => {
      const url = new URL(request.url || "/", new URL(callback.redirectUri).origin);
      if (url.pathname !== callback.path) {
        browserResponse(response, 404, "<h1>Not found</h1>");
        return;
      }

      const returnedState = url.searchParams.get("state");
      if (returnedState !== state) {
        browserResponse(
          response,
          400,
          "<h1>Sign-in request did not match</h1><p>Return to the original sign-in tab.</p>",
        );
        return;
      }

      const code = url.searchParams.get("code");
      const providerError = url.searchParams.get("error");
      if (providerError || !code) {
        browserResponse(
          response,
          400,
          "<h1>Sign-in failed</h1><p>You can close this window and retry.</p>",
        );
        finish(new Error("Antigravity OAuth sign-in was not completed."));
        return;
      }
      if (processing) {
        browserResponse(response, 409, "<h1>Sign-in is already being completed</h1>");
        return;
      }
      processing = true;
      clearTimeout(timer);

      try {
        const token = await exchangeAntigravityCode(code, pkce.verifier, {
          fetchImpl,
          now,
          redirectUri: callback.redirectUri,
        });
        const projectOptions = {
          fetchImpl,
          now,
          attempts: projectAttempts,
          retryDelayMs: projectRetryDelayMs,
          ...(delayImpl ? { delayImpl } : {}),
        };
        const [project, email] = await Promise.all([
          discoverAntigravityProject(token.access_token, projectOptions),
          fetchAntigravityUserEmail(token.access_token, { fetchImpl }),
        ]);
        const stored = await saveAntigravityToken({
          ...token,
          project_id: project.source === "managed" ? project.projectId : "",
          project_source: project.source,
          project_checked_at: project.checkedAt,
          tier_id: project.tierId,
          email,
        });
        browserResponse(response, 200, "<h1>Signed in</h1><p>You can close this window.</p>");
        finish(null, stored);
      } catch (error) {
        browserResponse(
          response,
          500,
          "<h1>Sign-in failed</h1><p>You can close this window and retry.</p>",
        );
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });

    server.on("error", (error) => finish(error));
    timer = setTimeout(() => {
      finish(new Error("Antigravity OAuth sign-in timed out; run it again."));
    }, timeoutMs);

    server.listen(callback.port, callback.host, () => {
      try {
        open(authorizationUrl);
      } catch {
        // The URL is already printed; a browser-open failure is not fatal.
      }
    });
  });
}
