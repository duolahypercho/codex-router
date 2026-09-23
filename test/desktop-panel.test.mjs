import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import test from "node:test";
import { chromium } from "playwright";

import { COMMANDS } from "../src/desktop-commands.mjs";
import { writeJson } from "../src/http-utils.mjs";
import {
  handlePanelRequest,
  isPanelRoute,
  panelCommandAllowed,
  panelLocalCommand,
} from "../src/desktop-panel.mjs";
import { commandRefused, readOnlyCapabilities } from "../apps/panel/model.mjs";

test("panel OAuth commands allow the browser flow its full timeout", () => {
  const command = COMMANDS.connect_oauth({ provider: "antigravity-oauth" });
  assert.ok(command.timeoutMs >= 10 * 60_000);
});

// The panel is served by the router, so these drive the real handler over a
// real socket rather than calling it in-process: the routing, the headers and
// the JSON contract are the parts a browser actually depends on.
function serve(panelOptions = {}) {
  const server = http.createServer(async (request, response) => {
    const route = new URL(request.url, "http://127.0.0.1").pathname;
    if (isPanelRoute(route)) {
      if (await handlePanelRequest(request, response, route, { writeJson, ...panelOptions })) return;
    }
    writeJson(response, 404, { error: { type: "not_found", message: "no route" } });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        server,
        url: (path) => `http://127.0.0.1:${port}${path}`,
        close: () => new Promise((done) => {
          server.close(done);
          server.closeAllConnections?.();
        }),
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
    // The retained panel UI plus the one bridge function app.js calls.
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
      ["/panel/i18n.mjs", /javascript/],
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

// #350: i18n.mjs shipped in apps/panel and was imported by both app.js and
// model.mjs, but was never added to the panel's allowlist, so the module graph
// failed to load and the panel rendered blank. The list above is hand-written
// and drifted; this derives the expectation from what the UI actually imports,
// so the next module added to the graph cannot repeat it.
test("every module the panel UI imports is on the allowlist", async () => {
  const entryPoints = ["app.js", "model.mjs", "thinking-orb.mjs", "i18n.mjs"];
  const required = new Set();
  for (const entry of entryPoints) {
    const source = readFileSync(new URL(`../apps/panel/${entry}`, import.meta.url), "utf8");
    for (const [, specifier] of source.matchAll(/from\s+"\.\/([\w.-]+\.m?js)"/g)) {
      required.add(specifier);
    }
  }
  assert.ok(required.has("i18n.mjs"), "expected the UI to import i18n.mjs");

  const { url, close } = await serve();
  try {
    for (const file of required) {
      const response = await fetch(url(`/panel/${file}`));
      assert.equal(
        response.status,
        200,
        `${file} is imported by the panel UI but is not served; add it to ASSETS in src/desktop-panel.mjs`,
      );
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
    // The full table is still reachable under an explicit unrestricted policy.
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
    // A future unrestricted host can omit the capabilities block, in which
    // case the shared client refuses nothing.
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
  const markup = readFileSync(new URL("../apps/panel/index.html", import.meta.url), "utf8");
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

// The packaged Control Center has its own typed IPC boundary. The browser
// allowlist must not leak into that native application and disable mutations.
test("the packaged Control Center is not narrowed by the browser allowlist", () => {
  for (const command of Object.keys(COMMANDS)) {
    assert.equal(panelCommandAllowed(command, { readOnly: false }), true, command);
  }
  assert.equal(panelCommandAllowed("rm_minus_rf", { readOnly: false }), false);
  const controlCenter = readFileSync(
    new URL("../apps/control-center/electron/ipc.mjs", import.meta.url),
    "utf8",
  );
  const preload = readFileSync(
    new URL("../apps/control-center/electron/preload.cjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(controlCenter, /panelCommandAllowed/);
  const exposed = new Set([...preload.matchAll(/\bcall\("([^"]+)"/g)].map(([, name]) => name));
  const handled = new Set(
    [...controlCenter.matchAll(/\bhandle(?:Action)?\("([^"]+)"/g)].map(([, name]) => name),
  );
  assert.ok(exposed.size >= 50, `only ${exposed.size} Control Center commands are exposed`);
  assert.deepEqual([...handled].sort(), [...exposed].sort());
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
const chromiumPath = [
  process.env.CODEX_ROUTER_TEST_CHROMIUM,
  chromium.executablePath(),
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((candidate) => candidate && existsSync(candidate));
const browserSkip = chromiumPath ? false : "no Chromium executable is available";

test("the panel renders and answers in a real browser", { skip: browserSkip }, async () => {
  // The route and bridge are production code; only the slow external control
  // commands are deterministic here. Their real execution is covered above,
  // while this test owns the browser/module/rendering boundary.
  const { url, close } = await serve({ runCommand: async () => ({}) });
  const browser = await chromium.launch({ executablePath: chromiumPath });
  try {
    // The assertions below name English source copy, and the panel resolves its
    // language from the host, so the browser has to declare the locale it means
    // rather than inheriting whatever the developer's machine is set to.
    const page = await browser.newPage({ viewport: { width: 420, height: 720 }, locale: "en-US" });
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

    // The live dashboard polls continuously, so it intentionally never reaches
    // Playwright's network-idle state. DOM readiness plus the rendered-data
    // assertions below is the stable browser contract.
    await page.goto(url("/panel/"), { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);

    // The bridge is present and the UI painted real data through it.
    assert.equal(
      await page.evaluate(() => typeof window.__TAURI__?.core?.invoke),
      "function",
    );
    await page.click('button.tab[data-tab="connections"]');
    await page.waitForTimeout(600);
    assert.match(
      await page.locator("#router-status").innerText(),
      /Router online/i,
      "the control snapshot did not render",
    );
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
