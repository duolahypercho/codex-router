import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import test from "node:test";

import { COMMANDS } from "../src/desktop-commands.mjs";
import { writeJson } from "../src/http-utils.mjs";
import {
  handlePanelRequest,
  isPanelRoute,
  panelCommandAllowed,
  panelLocalCommand,
} from "../src/desktop-panel.mjs";
import { commandRefused, readOnlyCapabilities } from "../apps/desktop/ui/model.mjs";

// The panel is served by the router, so these drive the real handler over a
// real socket rather than calling it in-process: the routing, the headers and
// the JSON contract are the parts a browser actually depends on.
function serve() {
  const server = http.createServer(async (request, response) => {
    const route = new URL(request.url, "http://127.0.0.1").pathname;
    if (isPanelRoute(route)) {
      if (await handlePanelRequest(request, response, route, { writeJson })) return;
    }
    writeJson(response, 404, { error: { type: "not_found", message: "no route" } });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        server,
        url: (path) => `http://127.0.0.1:${port}${path}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

test("panel routes are recognised, and nothing else is", () => {
  assert.equal(isPanelRoute("/panel"), true);
  assert.equal(isPanelRoute("/panel/app.js"), true);
  assert.equal(isPanelRoute("/panel/invoke"), true);
  assert.equal(isPanelRoute("/panel/../../etc/passwd"), false);
  assert.equal(isPanelRoute("/panel/secrets.json"), false);
  assert.equal(isPanelRoute("/v1/responses"), false);
});

test("the panel serves the shared UI with the bridge injected", async () => {
  const { url, close } = await serve();
  try {
    const response = await fetch(url("/panel"));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
    const body = await response.text();
    // The same UI the shells load, plus the one function app.js calls.
    assert.match(body, /window\.__TAURI__/);
    assert.match(body, /fetch\("\.\/invoke"/);
    assert.match(body, /data-tab="connections"/);
    // Framing and sniffing are closed off even though the route is gated.
    assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  } finally {
    await close();
  }
});

test("the panel serves each asset the UI loads", async () => {
  const { url, close } = await serve();
  try {
    for (const [asset, pattern] of [
      ["/panel/styles.css", /text\/css/],
      ["/panel/app.js", /javascript/],
      ["/panel/model.mjs", /javascript/],
      ["/panel/thinking-orb.mjs", /javascript/],
    ]) {
      const response = await fetch(url(asset));
      assert.equal(response.status, 200, `${asset} did not serve`);
      assert.match(response.headers.get("content-type"), pattern, asset);
    }
  } finally {
    await close();
  }
});

// A browser tab is reachable by anything that learns the capability, so the
// panel deliberately carries only the reading half of the command table.
test("the panel refuses the commands that change credentials or state", async () => {
  const { url, close } = await serve();
  try {
    for (const command of [
      "save_api_key",
      "remove_api_key",
      "set_provider_enabled",
      "connect_oauth",
      // The toggle the UI used to render live: the panel refused it silently
      // and the click came back as a generic failure.
      "set_tool_result_aging",
    ]) {
      const response = await fetch(url("/panel/invoke"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command, args: { provider: "deepseek", apiKey: "x" } }),
      });
      assert.equal(response.status, 403, `${command} was not refused`);
      const payload = await response.json();
      assert.match(payload.error.message, /not available from the browser panel/);
    }
    assert.equal(panelCommandAllowed("save_api_key"), false);
    assert.equal(panelCommandAllowed("control_snapshot"), true);
    // The full table is still reachable for a shell that asks for it.
    assert.equal(panelCommandAllowed("save_api_key", { readOnly: false }), true);
  } finally {
    await close();
  }
});

// The refusal is correct; the UI not knowing about it is what turned a
// deliberate posture into a broken-looking switch. platform_info is the one
// call the UI already makes on load, so the panel says so there.
test("the panel tells the UI it is read-only over the same command bridge", async () => {
  const { url, close } = await serve();
  try {
    const response = await fetch(url("/panel/invoke"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "platform_info", args: {} }),
    });
    assert.equal(response.status, 200);
    const { value } = await response.json();
    assert.equal(value.capabilities.readOnly, true);
    assert.equal(readOnlyCapabilities(value)?.readOnly, true);
    // What a shell that carries the full table sends: no capabilities block,
    // so nothing is refused and the tray and Electron window are unaffected.
    assert.equal(readOnlyCapabilities({ os: "darwin", islandSupported: true }), null);
  } finally {
    await close();
  }
});

// Two lists that describe one policy drift. This asserts they cannot: what the
// panel advertises has to agree with what the gate actually permits, for every
// command in the shared table.
test("the advertised allowed commands are exactly the ones the panel permits", () => {
  const { capabilities } = panelLocalCommand("platform_info")();
  assert.deepEqual(
    [...capabilities.allowedCommands].sort(),
    Object.keys(COMMANDS).filter((command) => panelCommandAllowed(command)).sort(),
  );
  for (const command of Object.keys(COMMANDS)) {
    assert.equal(
      commandRefused(capabilities, command),
      !panelCommandAllowed(command),
      `${command} is advertised differently from how it is gated`,
    );
  }
  // Commands the panel answers from its own process are not refusals: the UI
  // must keep offering Close and the activity pill, which do work here.
  for (const command of capabilities.localCommands) {
    assert.equal(commandRefused(capabilities, command), false, command);
  }
  assert.equal(commandRefused(capabilities, "set_tool_result_aging"), true);
  assert.equal(commandRefused(capabilities, "control_snapshot"), false);
});

// The two halves joined: the commands the shipped markup declares, answered by
// the capabilities the panel actually sends. Asserting each side separately
// would still pass if a control named a command nobody gates.
test("the panel's own answer marks the settings in the shipped markup dead", () => {
  const { capabilities } = panelLocalCommand("platform_info")();
  const markup = readFileSync(new URL("../apps/desktop/ui/index.html", import.meta.url), "utf8");
  const declared = new Set([...markup.matchAll(/data-command="([a-z_]+)"/g)].map(([, name]) => name));
  assert.ok(declared.size >= 15, `only ${declared.size} controls declare a command`);
  for (const command of declared) {
    assert.ok(
      Object.hasOwn(COMMANDS, command) || capabilities.localCommands.includes(command),
      `${command} is not a command any surface answers`,
    );
  }
  // The switch this whole change is about, plus the two the panel does answer.
  assert.equal(declared.has("set_tool_result_aging"), true);
  assert.equal(commandRefused(capabilities, "set_tool_result_aging"), true);
  assert.equal(commandRefused(capabilities, "set_island_enabled"), false);
});

// Reaching the tray or the Electron window means already running code on this
// machine, so neither is narrowed by any of the above.
test("a shell that is not the browser panel still carries the full table", () => {
  for (const command of Object.keys(COMMANDS)) {
    assert.equal(panelCommandAllowed(command, { readOnly: false }), true, command);
  }
  assert.equal(panelCommandAllowed("rm_minus_rf", { readOnly: false }), false);
  // The Electron shell runs the table directly rather than through the panel's
  // gate, which is what keeps the read-only posture local to the browser.
  const electron = readFileSync(new URL("../apps/electron/main.js", import.meta.url), "utf8");
  assert.doesNotMatch(electron, /panelCommandAllowed/);
  assert.match(electron, /runDesktopCommand\(command, args \?\? \{\}, \{ root \}\)/);
});

test("an unknown command is refused rather than shelled out", async () => {
  const { url, close } = await serve();
  try {
    const response = await fetch(url("/panel/invoke"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "rm_minus_rf", args: {} }),
    });
    assert.equal(response.status, 403);
    assert.equal(panelCommandAllowed("rm_minus_rf"), false);
  } finally {
    await close();
  }
});

test("a read command answers with the router's own data", async () => {
  const { url, close } = await serve();
  try {
    const response = await fetch(url("/panel/invoke"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "control_snapshot", args: {} }),
    });
    // Read once: the failure message and the assertion cannot both consume it.
    const raw = await response.text();
    assert.equal(response.status, 200, raw);
    const payload = JSON.parse(raw);
    assert.equal(typeof payload.value, "object");
    // The overview the tray renders, produced by the same control CLI.
    assert.ok(payload.value.targets, "expected the control overview shape");
  } finally {
    await close();
  }
});

test("malformed JSON and wrong methods are answered, not crashed on", async () => {
  const { url, close } = await serve();
  try {
    const bad = await fetch(url("/panel/invoke"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(bad.status, 400);

    const wrongMethod = await fetch(url("/panel/invoke"), { method: "GET" });
    assert.equal(wrongMethod.status, 405);

    const wrongAssetMethod = await fetch(url("/panel"), { method: "POST" });
    assert.equal(wrongAssetMethod.status, 405);
  } finally {
    await close();
  }
});

// Serving the files is not the same as the page working. This drives the panel
// in a real browser, because the two defects that got through here -- relative
// assets resolving one level too high at "/panel", and the UI's non-CLI
// commands being refused -- both served a 200 and rendered an empty panel.
const chromiumPath = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const browserSkip = !existsSync(chromiumPath)
  ? "no preinstalled chromium"
  : !existsSync(new URL("../apps/electron/node_modules/playwright", import.meta.url))
    ? "playwright is not installed (npm ci --prefix apps/electron)"
    : false;

test("the panel renders and answers in a real browser", { skip: browserSkip }, async () => {
  // Playwright's entry is CommonJS; imported from ESM the namespace may carry
  // the exports directly or behind `default` depending on the interop path.
  const loaded = await import("../apps/electron/node_modules/playwright/index.js");
  const chromium = loaded.chromium ?? loaded.default?.chromium;
  assert.ok(chromium, "playwright did not expose chromium");
  const { url, close } = await serve();
  const browser = await chromium.launch({ executablePath: chromiumPath });
  try {
    const page = await browser.newPage({ viewport: { width: 420, height: 720 } });
    const failures = [];
    page.on("pageerror", (error) => failures.push(String(error.message)));
    page.on("response", (response) => {
      const route = new URL(response.url()).pathname;
      // account_usage needs a Codex install, which a test machine need not
      // have; every other non-2xx is a real failure.
      if (response.status() >= 400 && response.status() !== 502) {
        failures.push(`${response.status()} ${route}`);
      }
    });

    await page.goto(url("/panel/"), { waitUntil: "networkidle" });
    await page.waitForTimeout(1200);

    // The bridge is present and the UI painted real data through it.
    assert.equal(
      await page.evaluate(() => typeof window.__TAURI__?.core?.invoke),
      "function",
    );
    await page.click('button.tab[data-tab="connections"]');
    await page.waitForTimeout(600);
    const text = await page.locator("body").innerText();
    assert.match(text, /anthropic|cerebras|deepseek/i, "provider rows did not render");
    assert.equal(
      await page.evaluate(() => document.querySelector("button.tab.is-active")?.dataset.tab),
      "connections",
    );
    assert.deepEqual(failures, [], `browser reported: ${failures.join(", ")}`);
  } finally {
    await browser.close();
    await close();
  }
});

test("the bare panel path redirects to the directory form", async () => {
  const { url, close } = await serve();
  try {
    const response = await fetch(url("/panel"), { redirect: "manual" });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "./panel/");
  } finally {
    await close();
  }
});
