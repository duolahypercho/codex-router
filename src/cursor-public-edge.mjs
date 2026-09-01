import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertCallerSecret,
  callerBaseUrl,
  secretEqual,
} from "./caller-auth.mjs";
import { handleCursorRequest } from "./cursor-surface.mjs";
import { installStableFetchTransport } from "./fetch-transport.mjs";
import { installGracefulShutdown, writeJson } from "./http-utils.mjs";
import {
  CALLER_SECRET_PATH,
  CURSOR_PUBLIC_SECRET_PATH,
  PORTS,
} from "./paths.mjs";
import { routedClientModels } from "./routed-client-models.mjs";

installStableFetchTransport();

export const CURSOR_PUBLIC_PREFIX = "/_codex-router-cursor";

function storedSecret(target, label) {
  try {
    return assertCallerSecret(readFileSync(target, "utf8").trim());
  } catch {
    throw new Error(`${label} is missing or invalid; run ./bin/doctor --fix.`);
  }
}

export function cursorPublicBasePath(secret) {
  return `${CURSOR_PUBLIC_PREFIX}/${assertCallerSecret(secret)}/v1`;
}

export function cursorPublicBaseUrl(origin, secret) {
  return `${String(origin).replace(/\/+$/, "")}${cursorPublicBasePath(secret)}`;
}

export function redactCursorPublicUrl(value) {
  if (typeof value !== "string") return value;
  return value.replace(
    new RegExp(`(${CURSOR_PUBLIC_PREFIX}/)[A-Za-z0-9_-]+(?=/v1(?:/|$))`, "g"),
    "$1[REDACTED]",
  );
}

export function authenticatedCursorPublicRoute(pathname, expectedSecret) {
  const prefix = `${CURSOR_PUBLIC_PREFIX}/`;
  if (typeof pathname !== "string" || !pathname.startsWith(prefix)) return undefined;
  const remainder = pathname.slice(prefix.length);
  const separator = remainder.indexOf("/");
  if (separator < 0 || !secretEqual(remainder.slice(0, separator), expectedSecret)) return undefined;
  const route = remainder.slice(separator);
  if (route === "/v1/models") return "/cursor/v1/models";
  if (route === "/v1/chat/completions") return "/cursor/v1/chat/completions";
  return undefined;
}

export function createCursorPublicServer({
  publicSecret,
  responsesUrl,
  routedModels = routedClientModels,
} = {}) {
  return http.createServer((request, response) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
    if (request.method === "GET" && url.pathname === "/health") {
      writeJson(response, 200, { ok: true, service: "codex-router-cursor-edge" });
      return;
    }
    const route = authenticatedCursorPublicRoute(url.pathname, publicSecret);
    if (!route) {
      writeJson(response, 404, {
        error: { type: "not_found", message: "Unsupported Cursor edge route." },
      });
      return;
    }
    handleCursorRequest(request, response, route, { responsesUrl, routedModels }).catch((error) => {
      console.error(`[codex-router-cursor-edge] request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!response.headersSent) {
        writeJson(response, error?.status || 500, {
          error: { type: "cursor_edge_error", message: "The Cursor edge could not complete the request." },
        });
      } else {
        response.end();
      }
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const publicSecret = storedSecret(CURSOR_PUBLIC_SECRET_PATH, "Cursor public edge key");
  const callerSecret = storedSecret(CALLER_SECRET_PATH, "Router caller key");
  const server = createCursorPublicServer({
    publicSecret,
    responsesUrl: `${callerBaseUrl(PORTS.router, callerSecret)}/responses`,
  });
  server.listen(PORTS.cursorPublic, "127.0.0.1", () => {
    console.error(`[codex-router-cursor-edge] ready on 127.0.0.1:${PORTS.cursorPublic}`);
  });
  installGracefulShutdown(server);
}
