import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(appRoot, "dist");

const bridgeSource = String.raw`
(() => {
  const calls = [];
  const subagents = { mode: "all", enabled: [], disabled: [], efforts: {}, proofs: {} };
  const selectedModel = {
    slug: "deepseek/deepseek-chat",
    displayName: "DeepSeek Chat",
    description: "Selected route used by the renderer fixture.",
    provider: "deepseek",
    enabled: true,
    visible: true,
    multiAgentVersion: "v1",
    subagentCertification: "v1",
    reasoningLevels: ["low", "medium", "high"],
    contextWindow: 128000,
    inputModalities: ["text"],
  };
  const oxProviders = [
    { id: "commandcode", displayName: "Command Code", kind: "api", configured: false },
    { id: "nousresearch", displayName: "Nous Research", kind: "api", configured: false },
    { id: "opencode-free", displayName: "OpenCode Free", kind: "anonymous", configured: true },
    { id: "opencode-go", displayName: "opencode Go/Zen", kind: "api", configured: true },
    { id: "openrouter", displayName: "OpenRouter", kind: "api", configured: false },
    { id: "venice", displayName: "Venice", kind: "api", configured: false },
  ];
  const knownOxModels = oxProviders.map((provider) => ({
    slug: provider.id + "/ox-alpha",
    displayName: "Ox Alpha (" + provider.displayName + ")",
    provider: provider.id,
    available: provider.id === "opencode-free" || provider.id === "opencode-go",
    contextWindow: 1048576,
    inputModalities: ["text", "image"],
    isFree: true,
  }));
  const activeOxModels = knownOxModels.filter((model) => model.available).map((model) => ({
    ...model,
    enabled: true,
    visible: false,
    multiAgentVersion: "v1",
    subagentCertification: "unknown",
  }));
  const target = {
    target: "codex",
    configured: true,
    active: true,
    enabledProviders: ["deepseek", "opencode-free", "opencode-go"],
    providers: [
      { id: "deepseek", displayName: "DeepSeek", kind: "api" },
      { id: "kilo-free", displayName: "Kilo Free", kind: "anonymous" },
      ...oxProviders.map(({ id, displayName, kind }) => ({ id, displayName, kind })),
    ],
    models: [selectedModel, ...activeOxModels],
    modelSettings: {
      subagents,
      picker: { hidden: [], visible: [selectedModel.slug], hasExplicitVisibility: true },
      localModels: {},
      visionBridge: { enabled: false },
    },
  };
  const snapshot = {
    targets: { codex: target },
    catalog: {
      source: "codex-router",
      configured: true,
      enabledProviders: ["deepseek", "opencode-free", "opencode-go"],
      models: [selectedModel, ...activeOxModels],
      knownModels: knownOxModels,
      picker: { hidden: [], visible: [selectedModel.slug], hasExplicitVisibility: true },
      subagents,
    },
    chatgptSession: { sharing: "disabled", session: "unavailable", present: false },
  };
  const providers = {
    providers: [
      {
        id: "deepseek",
        displayName: "DeepSeek",
        kind: "api",
        configured: true,
        action: "ready",
        credentialLabel: "DeepSeek API key",
        catalogSources: [{ id: "deepseek", displayName: "DeepSeek", kind: "models-endpoint" }],
      },
      {
        id: "kilo-free",
        displayName: "Kilo Free",
        kind: "anonymous",
        configured: true,
        action: "anonymous",
        credentialLabel: "No API key",
        catalogSources: [{ id: "kilo-free", displayName: "Kilo Free", kind: "models-endpoint" }],
      },
      ...oxProviders.map((provider) => ({
        ...provider,
        action: provider.configured ? "ready" : "provider-key",
        credentialLabel: provider.kind === "anonymous" ? "No API key" : provider.displayName + " API key",
      })),
    ],
  };

  const record = (name, ...args) => calls.push({ name, args });
  const catalog = (providerId) => {
    record("discoverProviderModels", providerId);
    if (providerId === "kilo-free") {
      return {
        provider: providerId,
        discovered: ["kilo-unselected-free"],
        registered: [],
        unregistered: ["kilo-unselected-free"],
        addable: ["kilo-unselected-free"],
        blocked: {},
        unavailable: [],
        free: ["kilo-unselected-free"],
      };
    }
    return {
      provider: providerId,
      discovered: ["catalog-addable", "blocked-preview"],
      registered: [],
      unregistered: ["catalog-addable", "blocked-preview"],
      addable: ["catalog-addable"],
      blocked: { "blocked-preview": "No certified protocol route is available." },
      unavailable: [],
      contextLengths: { "catalog-addable": 200000, "blocked-preview": 128000 },
      fetchedAt: "2026-08-24T00:00:00.000Z",
    };
  };

  window.routerControl = Object.freeze({
    platform: navigator.platform.toLowerCase().includes("mac") ? "darwin" : "linux",
    getSnapshot: async () => snapshot,
    getChatGptSession: async () => ({ sharing: "disabled", session: "usable", present: true, email: "primary@example.com" }),
    getChatGptAccountPool: async () => ({
      version: 1,
      policy: {
        enabled: true,
        mode: "switch",
        strategy: "quota",
        autoSwitchThreshold: 0.1,
        sticky: true,
        stickyLimit: 50,
        maxCooldownSeconds: 300,
        priorityOrder: [],
        pausedAccountIds: [],
        selectedAccountId: "active",
      },
      accounts: {
        revoked: { id: "revoked", state: "revoked", paused: true, priority: 50, label: "Removed account", health: { state: "healthy" }, turns: 0, requests: 0 },
        active: { id: "active", state: "active", paused: false, priority: 50, label: "Secondary account", subscription: { status: "usable", authenticated: true, usable: true, expired: false, email: "secondary@example.com" }, health: { state: "healthy" }, turns: 0, requests: 0 },
        current: { id: "current", state: "active", paused: false, priority: 50, label: "Current account", subscription: { status: "usable", authenticated: true, usable: true, expired: false, email: "primary@example.com" }, health: { state: "healthy" }, turns: 0, requests: 0 },
      },
      sessions: { count: 0 },
      profile: { desired: "active", active: "active", pending: false, running: false },
    }),
    getProviders: async () => providers,
    getPresence: async () => ({ mode: "always" }),
    getHealth: async () => ({ ok: true, activity: { state: "idle", active: [], activeCount: 0 } }),
    controlTray: async () => ({ status: { supported: true } }),
    getAccountUsage: async () => ({}),
    getProviderUsage: async () => ({ providers: [] }),
    discoverProviderModels: async (providerId) => catalog(providerId),
    addProviderModels: async (providerId, modelIds) => {
      record("addProviderModels", providerId, [...modelIds]);
      return { ok: true };
    },
    setPickerModels: async (showAll) => {
      record("setPickerModels", showAll);
      return { ok: true };
    },
    setPickerModel: async () => ({ ok: true }),
    setProviderEnabled: async () => ({ ok: true }),
    setChatGptAccountSelection: async (selection) => {
      record("setChatGptAccountSelection", selection);
      return { ok: true };
    },
    setChatGptAccountPoolMode: async (mode) => {
      record("setChatGptAccountPoolMode", mode);
      return { ok: true };
    },
    setSubagentModel: async () => ({ ok: true }),
    setSubagentEffort: async () => ({ ok: true }),
    onOperation: () => () => {},
  });
  window.routerControlTest = Object.freeze({
    calls: () => calls.map((call) => ({ name: call.name, args: call.args })),
  });
})();
`;

function mimeType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

function serveRenderer() {
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
    if (pathname === "/test-bridge.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(bridgeSource);
      return;
    }
    if (pathname === "/favicon.ico") {
      response.writeHead(204).end();
      return;
    }
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const target = path.resolve(dist, relative);
    if (target !== dist && !target.startsWith(`${dist}${path.sep}`) || !existsSync(target)) {
      response.writeHead(404).end("not found");
      return;
    }
    let contents = readFileSync(target);
    if (relative === "index.html") {
      const html = contents.toString("utf8");
      assert.match(html, /<script type="module"/);
      contents = Buffer.from(
        html.replace('<script type="module"', '<script src="./test-bridge.js"></script><script type="module"'),
      );
    }
    response.writeHead(200, { "content-type": mimeType(target) });
    response.end(contents);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}/`,
        close: () => new Promise((done) => {
          server.close(done);
          server.closeAllConnections?.();
        }),
      });
    });
  });
}

const chromiumPath = [
  process.env.CODEX_ROUTER_TEST_CHROMIUM,
  chromium.executablePath(),
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
  process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
].find((candidate) => candidate && existsSync(candidate));

test("the production renderer exposes model discovery and picker actions", { timeout: 60_000 }, async () => {
  assert.equal(existsSync(path.join(dist, "index.html")), true, "npm test must build the renderer first");
  assert.ok(chromiumPath, "No Chromium executable is available for the Control Center renderer test.");

  const { url, close } = await serveRenderer();
  const browser = await chromium.launch({
    executablePath: chromiumPath,
    headless: true,
    args: process.platform === "linux" ? ["--no-sandbox"] : [],
  });
  const pageErrors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 840 } });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(message.text());
    });

    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.getByRole("navigation", { name: "Control center sections" }).waitFor();
    await page.getByRole("button", { name: "Models", exact: true }).click();
    const providerSearch = page.locator('input[placeholder="Search providers or known models"]');
    await providerSearch.waitFor();

    await providerSearch.fill("Ox Alpha");
    const oxProviderRows = page.locator(".pm-provider-row");
    await oxProviderRows.filter({ hasText: "Command Code" }).waitFor();
    assert.equal(await oxProviderRows.count(), 6);
    assert.deepEqual(
      (await oxProviderRows.locator(".pm-provider-title-line > strong").allTextContents()).sort(),
      ["Command Code", "Nous Research", "OpenCode Free", "OpenRouter", "Venice", "opencode Go/Zen"].sort(),
    );
    assert.equal(await oxProviderRows.filter({ hasText: "not connected" }).count(), 4);
    assert.equal(await oxProviderRows.filter({ hasText: "1 known match" }).count(), 6);

    const knownModelSearch = page.locator('input[placeholder="Search active, known, or loaded catalog models"]');
    await knownModelSearch.fill("Ox Alpha");
    const oxFamily = page.locator(".pm-family-row").filter({ hasText: "Ox Alpha" });
    await oxFamily.waitFor();
    assert.match(await oxFamily.innerText(), /6 providers/);
    assert.match(await oxFamily.innerText(), /6 routes/i);
    await oxFamily.locator(".pm-family-summary").click();
    assert.equal(await oxFamily.locator(".pm-route-row").count(), 6);
    assert.equal(await oxFamily.locator('.pm-route-row[data-availability="known"]').count(), 4);
    assert.equal(await oxFamily.getByText("Enable or connect provider", { exact: true }).count(), 4);

    await providerSearch.fill("");
    await knownModelSearch.fill("");

    const anonymousRow = page.locator(".pm-provider-row").filter({ hasText: "Kilo Free" });
    await anonymousRow.waitFor();
    assert.equal(await anonymousRow.getAttribute("data-connection"), "setup");
    assert.match(await anonymousRow.innerText(), /not connected/i);

    await page.getByRole("button", { name: "Load connected catalogs", exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll("button")]
      .some((button) => button.textContent?.trim() === "Load connected catalogs"));
    const bulkCatalogProviders = await page.evaluate(() => window.routerControlTest.calls()
      .filter((call) => call.name === "discoverProviderModels")
      .map((call) => call.args[0]));
    assert.deepEqual(bulkCatalogProviders, ["deepseek"]);

    const search = page.locator('input[placeholder="Search active, known, or loaded catalog models"]');
    await search.fill("catalog-addable");
    const addableRow = page.locator(".pm-catalog-search-row").filter({ hasText: "catalog-addable" });
    await addableRow.waitFor();
    await addableRow.getByRole("button", { name: "Add", exact: true }).click();
    await page.waitForFunction(() => window.routerControlTest.calls()
      .some((call) => call.name === "addProviderModels"));

    await search.fill("blocked-preview");
    const blockedRow = page.locator(".pm-catalog-search-row").filter({ hasText: "blocked-preview" });
    await blockedRow.waitFor();
    const blockedButton = blockedRow.getByRole("button", { name: "Protocol pending", exact: true });
    assert.equal(await blockedButton.isDisabled(), true);
    assert.equal(
      await blockedRow.locator(".pm-catalog-block-reason").innerText(),
      "No certified protocol route is available.",
    );

    await page.getByRole("button", { name: "Show all", exact: true }).click();
    await page.waitForFunction(() => window.routerControlTest.calls()
      .some((call) => call.name === "setPickerModels" && call.args[0] === true));

    const calls = await page.evaluate(() => window.routerControlTest.calls());
    assert.deepEqual(calls.find((call) => call.name === "addProviderModels")?.args, [
      "deepseek",
      ["catalog-addable"],
    ]);
    assert.equal(calls.some((call) => call.name === "setPickerModels" && call.args[0] === true), true);

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const accountRows = page.locator(".subscription-account-row");
    await page.getByText("ChatGPT subscription pool", { exact: true }).waitFor();
    assert.equal(await accountRows.count(), 2, "two logged-in accounts should be visible");
    assert.equal(await accountRows.filter({ hasText: "Removed account" }).count(), 0, "revoked accounts stay hidden");
    assert.equal(await accountRows.filter({ hasText: "secondary@example.com" }).count(), 1, "secondary email should be visible");
    const readySecondary = accountRows.filter({ hasText: "Secondary account" });
    assert.equal(await readySecondary.getByRole("button", { name: "Login", exact: true }).isDisabled(), true, "ready accounts cannot start a duplicate login");
    await page.getByRole("combobox", { name: "ChatGPT account to use" }).selectOption("active");
    await page.waitForFunction(() => window.routerControlTest.calls()
      .some((call) => call.name === "setChatGptAccountSelection" && call.args[0] === "active"));
    assert.deepEqual(pageErrors, [], `renderer errors: ${pageErrors.join("; ")}`);
  } finally {
    await browser.close();
    await close();
  }
});
