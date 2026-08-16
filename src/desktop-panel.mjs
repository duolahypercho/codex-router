// The companion, served by the router that is already running, so looking at
// it costs nothing to install. The tray and the Electron shell each need a
// binary to be built, published, downloaded and kept current; this needs a
// browser and the router you already started.
//
// It is the same apps/desktop/ui those shells render, reached through the same
// command table, so it is a third window onto one application rather than a
// third application.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { COMMANDS, runDesktopCommand, sourceRoot } from "./desktop-commands.mjs";

const UI_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "apps",
  "desktop",
  "ui",
);

// Only what the UI is built from. A directory served wholesale would follow
// whatever else ever lands in it, and this route sits behind a capability that
// is worth more than the convenience.
const ASSETS = new Map([
  ["/panel/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/panel/index.html", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/panel/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
  ["/panel/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/panel/model.mjs", { file: "model.mjs", type: "text/javascript; charset=utf-8" }],
  [
    "/panel/thinking-orb.mjs",
    { file: "thinking-orb.mjs", type: "text/javascript; charset=utf-8" },
  ],
]);

// app.js reaches its backend through window.__TAURI__.core.invoke and nothing
// else, so presenting that one function is the whole port. Injected rather
// than shipped as a file in apps/desktop/ui, because that directory belongs to
// the shells that load it from disk.
const BRIDGE = `<script>
window.__TAURI__ = {
  core: {
    invoke: async (command, args) => {
      const response = await fetch("./invoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command, args: args || {} }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error?.message || "The router command failed.");
      return payload.value;
    },
  },
};
</script>
`;

export function isPanelRoute(route) {
  return (
    route === "/panel" ||
    ASSETS.has(route) ||
    route === "/panel/invoke" ||
    route === "/panel/favicon.ico"
  );
}

// Commands the panel may run. The mutating half of the table is deliberately
// absent: a browser tab is reachable by any page that learns the capability,
// and "save this API key" is not something to expose on that assumption. The
// tray and the Electron shell keep the full table because reaching them means
// already running code on the machine.
const READ_ONLY = new Set([
  "control_snapshot",
  "account_usage",
  "provider_usage",
  "provider_setup",
  "local_models",
]);

export function panelCommandAllowed(command, { readOnly = true } = {}) {
  if (!Object.hasOwn(COMMANDS, command)) return false;
  return readOnly ? READ_ONLY.has(command) : true;
}

// Commands the shells answer from their own process rather than the CLI. A
// browser tab has no window to show, hide or quit and cannot float an overlay
// above other applications, so those resolve to the honest answer instead of
// failing: the UI asks for them on load and would otherwise paint an error
// over a panel that is working.
const LOCAL = {
  platform_info: () => ({
    platform: process.platform,
    island: false,
    shell: "web",
    // What this surface will and will not run, said out loud. The UI could
    // infer it from `shell`, but then two places would encode the same policy
    // and only one of them is the gate. Both lists are the real ones -- a
    // command in neither is precisely what /panel/invoke answers 403 for -- so
    // a control the UI leaves live cannot disagree with what the panel permits.
    // The tray and the Electron shell advertise nothing here and keep the full
    // table, which is why this field is additive rather than a mode switch.
    capabilities: {
      readOnly: true,
      allowedCommands: [...READ_ONLY],
      localCommands: Object.keys(LOCAL),
    },
  }),
  desktop_settings: () => ({ islandEnabled: false, islandExpanded: false }),
  // The router is answering this request, so it is by definition reachable.
  router_health: () => ({ ok: true, service: "codex-router", status: "ok" }),
  set_island_enabled: () => ({ islandEnabled: false, islandExpanded: false }),
  set_island_expanded: () => ({ islandEnabled: false, islandExpanded: false }),
  show_panel: () => null,
  hide_panel: () => null,
  quit_app: () => null,
};

export function panelLocalCommand(command) {
  return Object.hasOwn(LOCAL, command) ? LOCAL[command] : undefined;
}

async function readBody(request, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("The panel request was too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function handlePanelRequest(request, response, route, { writeJson }) {
  // index.html loads styles.css and app.js relatively. Served at "/panel" the
  // browser resolves those one level too high and the page renders empty, so
  // the directory form is the canonical one and the bare name redirects to it.
  if (route === "/panel") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      writeJson(response, 405, { error: { type: "invalid_request", message: "Use GET." } });
      return true;
    }
    response.writeHead(302, { location: "./panel/", "cache-control": "no-store" });
    response.end();
    return true;
  }

  // Browsers ask for this unprompted; answering keeps a console clean enough
  // that a real error still stands out in it.
  if (route === "/panel/favicon.ico") {
    const icon = path.resolve(UI_DIR, "..", "src-tauri", "icons", "32x32.png");
    try {
      const body = await readFile(icon);
      response.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
      response.end(body);
    } catch {
      response.writeHead(204).end();
    }
    return true;
  }

  const asset = ASSETS.get(route);
  if (asset) {
    if (request.method !== "GET") {
      writeJson(response, 405, { error: { type: "invalid_request", message: "Use GET." } });
      return true;
    }
    let body = await readFile(path.join(UI_DIR, asset.file), "utf8");
    if (asset.file === "index.html") body = body.replace("<head>", `<head>\n${BRIDGE}`);
    response.writeHead(200, {
      "content-type": asset.type,
      "cache-control": "no-store",
      // The panel is same-origin only and frames nothing; a capability in the
      // URL is not a reason to let another page embed or reach into it.
      "content-security-policy":
        "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    response.end(body);
    return true;
  }

  if (route !== "/panel/invoke") return false;
  if (request.method !== "POST") {
    writeJson(response, 405, { error: { type: "invalid_request", message: "Use POST." } });
    return true;
  }

  let command;
  let args;
  try {
    ({ command, args } = JSON.parse(await readBody(request)) || {});
  } catch {
    writeJson(response, 400, {
      error: { type: "invalid_request", message: "The panel request was not valid JSON." },
    });
    return true;
  }

  const local = panelLocalCommand(command);
  if (local) {
    writeJson(response, 200, { value: local() });
    return true;
  }

  if (!panelCommandAllowed(command)) {
    writeJson(response, 403, {
      error: {
        type: "invalid_request",
        message: `${command} is not available from the browser panel.`,
      },
    });
    return true;
  }

  try {
    const value = await runDesktopCommand(command, args ?? {}, { root: sourceRoot() });
    writeJson(response, 200, { value });
  } catch (error) {
    writeJson(response, 502, {
      error: { type: "upstream_error", message: error?.message || "The router command failed." },
    });
  }
  return true;
}
