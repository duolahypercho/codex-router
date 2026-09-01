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
  let navigationListener;
  let operationListener;
  const searchParams = new URLSearchParams(location.search);
  let usageDelayMs = Number(searchParams.get("usageDelayMs")) || 0;
  let cursorHarnessState = "configured";
  let openclawHarnessConfigured = true;
  const snapshotDelayMs = Number(searchParams.get("snapshotDelayMs")) || 0;
  const providerDelayMs = Number(searchParams.get("providerDelayMs")) || 0;
  const accountDelay = searchParams.has("accountDelayMs")
    ? Number(searchParams.get("accountDelayMs")) || 0
    : null;
  const providerUsageDelay = searchParams.has("providerUsageDelayMs")
    ? Number(searchParams.get("providerUsageDelayMs")) || 0
    : null;
  const rejectAccountUsageRead = Number(searchParams.get("rejectAccountUsageRead")) || 0;
  const staleAccountFailure = searchParams.get("staleAccountFailure") === "1";
  const staleProviderUsage = searchParams.get("staleProviderUsage") === "1";
  const fallbackUsage = searchParams.get("fallbackUsage") === "1";
  const pollOnceMs = Number(searchParams.get("pollOnceMs")) || 0;
  const healthPollOnceMs = Number(searchParams.get("healthPollOnceMs")) || 0;
  const staleHealth = searchParams.get("staleHealth") === "1";
  let accountUsageReads = 0;
  let providerUsageReads = 0;
  let healthReads = 0;
  if (pollOnceMs > 0 || healthPollOnceMs > 0) {
    const nativeSetInterval = window.setInterval.bind(window);
    window.setInterval = (callback, delay, ...args) => {
      if (delay === 5 * 60_000 && pollOnceMs > 0) return window.setTimeout(callback, pollOnceMs, ...args);
      if (delay === 1_000 && healthPollOnceMs > 0) return window.setTimeout(callback, healthPollOnceMs, ...args);
      return nativeSetInterval(callback, delay, ...args);
    };
  }
  const subagents = { mode: "all", enabled: [], disabled: [], efforts: {}, proofs: {} };
  const selectedModel = {
    slug: "deepseek/deepseek-chat",
    displayName: "DeepSeek Chat",
    description: "Selected route used by the renderer fixture.",
    provider: "deepseek",
    enabled: true,
    visible: true,
    multiAgentVersion: "v2",
    subagentCertification: "v2",
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
      localModels: {
        available: [],
        availableVision: [],
        availableExplore: [{
          tag: "hf.co/unsloth/GLM-5.3-Flash-GGUF:UD-IQ1_S",
          family: "hf.co/unsloth/GLM-5.3-Flash-GGUF",
          variant: "UD-IQ1_S",
          displayName: "GLM-5.3-Flash · UD-IQ1_S",
          sizeGb: 93.1,
          context: 1048576,
          fit: "too-large",
          diskFit: "fits",
          downloadable: true,
          researchStatus: "Unsloth GGUF · 7 local quants",
          researchCapabilities: ["vision", "tools", "thinking"],
          researchNote: "Community quantization; capability and Codex checks run after pull.",
        }],
        families: [{
          family: "hf.co/unsloth/GLM-5.3-Flash-GGUF",
          displayName: "GLM-5.3-Flash",
          variants: ["UD-IQ1_S"],
        }],
        installed: 0,
        enabled: 0,
        models: [],
        totalGb: 0,
        machine: "16 GB unified memory",
        runtime: { installed: true, running: true, managed: true, version: "test" },
      },
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
    getSnapshot: async () => {
      await new Promise((resolve) => setTimeout(resolve, snapshotDelayMs));
      return snapshot;
    },
    getProviders: async () => {
      await new Promise((resolve) => setTimeout(resolve, providerDelayMs));
      return providers;
    },
    getPresence: async () => ({ mode: "always" }),
    getHealth: async () => {
      healthReads += 1;
      const read = healthReads;
      await new Promise((resolve) => setTimeout(resolve, staleHealth && read === 1 ? 400 : 0));
      return staleHealth && read === 1
        ? { ok: false, error: "Stale health response", activity: { state: "offline", active: [], activeCount: 0 } }
        : { ok: true, version: "health-" + read, activity: { state: "idle", active: [], activeCount: 0 } };
    },
    getHarnesses: async () => ({
      platform: "darwin",
      terminalAvailable: true,
      harnesses: [
        {
          id: "openclaw", displayName: "OpenClaw", ownership: "openclaw",
          description: "OpenClaw's current agent runtime.", cliInstalled: true, appInstalled: false,
          configured: openclawHarnessConfigured, canInstall: true, installRequirement: "Publish shared config.",
          docsUrl: "https://docs.openclaw.ai/",
        },
        {
          id: "codex", displayName: "Codex", ownership: "openai",
          description: "OpenAI coding client.", cliInstalled: true, appInstalled: true,
          configured: true, canInstall: true, installRequirement: "Publish shared config.",
          docsUrl: "https://developers.openai.com/codex/",
        },
        {
          id: "dsh", displayName: "DeepSeek Harness", ownership: "deepseek",
          description: "DeepSeek coding client.", cliInstalled: true, appInstalled: true,
          configured: true, canInstall: true, installRequirement: "Publish shared config.",
          docsUrl: "https://github.com/deepseek-ai/DeepSeek-Harness",
        },
        {
          id: "cursor", displayName: "Cursor", ownership: "cursor",
          description: "Cursor Agent and Cursor App.", cliInstalled: true, appInstalled: true,
          configured: cursorHarnessState === "configured",
          agentConfigured: true,
          appConfigured: cursorHarnessState === "configured",
          canInstall: true,
          installRequirement: cursorHarnessState === "configured" ? "Cursor App is connected." : "Continue Cursor setup.",
          tunnel: cursorHarnessState === "configured"
            ? { provider: "cloudflare", binaryInstalled: true, loggedIn: true, configured: true, nextAction: "ready" }
            : cursorHarnessState === "login"
              ? { provider: "cloudflare", binaryInstalled: true, loggedIn: false, configured: false, nextAction: "login" }
              : { provider: "cloudflare", binaryInstalled: false, loggedIn: false, configured: false, nextAction: "install-cloudflared" },
          docsUrl: "https://docs.cursor.com/",
        },
        {
          id: "claude", displayName: "Claude Code", ownership: "anthropic",
          description: "Anthropic coding client.", cliInstalled: true, appInstalled: false,
          configured: true, canInstall: true, installRequirement: "Publish shared config.",
          docsUrl: "https://code.claude.com/docs/en/overview",
        },
        {
          id: "gemini", displayName: "Gemini CLI", ownership: "google",
          description: "Google coding client.", cliInstalled: true, appInstalled: false,
          configured: true, canInstall: true, installRequirement: "Publish shared config.",
          docsUrl: "https://github.com/google-gemini/gemini-cli",
        },
      ],
    }),
    getAgentBridges: async () => ({
      version: 1,
      bridges: [
        { id: "anthropic", displayName: "Claude", protocol: "claude-code", installed: true, sessions: 2, authentication: "client-owned" },
        { id: "cursor", displayName: "Cursor Agent", protocol: "acp", installed: true, sessions: 1, authentication: "client-owned" },
        { id: "gemini", displayName: "Gemini CLI", protocol: "acp", installed: false, sessions: 0, authentication: "unavailable" },
      ],
    }),
    getContextSessions: async () => ({
      fetchedAt: "2026-08-30T08:00:00.000Z",
      counts: { total: 3, codex: 1, dsh: 1, cursor: 1, claude: 0, gemini: 0, openclaw: 0, archived: 0 },
      sessions: [
        { id: "11111111-1111-4111-8111-111111111111", harnessId: "cursor", title: "Cursor routing task", updatedAt: "2026-08-30T08:00:00.000Z", archived: false, resumable: true },
        { id: "session-22222222-2222-4222-8222-222222222222", harnessId: "dsh", title: "DeepSeek routing task", updatedAt: "2026-08-30T07:00:00.000Z", archived: false, resumable: true },
        { id: "33333333-3333-4333-8333-333333333333", harnessId: "codex", title: "Codex routing task", updatedAt: "2026-08-30T06:00:00.000Z", archived: false, resumable: true },
      ],
    }),
    setupHarness: async (harnessId) => {
      record("setupHarness", harnessId);
      if (harnessId === "openclaw") openclawHarnessConfigured = true;
      return { configured: true };
    },
    prepareCursorTunnel: async () => {
      record("prepareCursorTunnel");
      operationListener?.({ action: "prepareCursorTunnel", status: "started", message: "Downloading Cloudflare connector…" });
      await new Promise((resolve) => setTimeout(resolve, 250));
      cursorHarnessState = "login";
      operationListener?.({ action: "prepareCursorTunnel", status: "completed", message: "Cloudflare connector installed." });
      return { installed: true };
    },
    connectCursor: async () => {
      record("connectCursor");
      operationListener?.({ action: "connectCursor", status: "started", message: "Installing Cloudflare connector…" });
      await new Promise((resolve) => setTimeout(resolve, 250));
      cursorHarnessState = "configured";
      operationListener?.({ action: "connectCursor", status: "completed", message: "Cursor routing verified." });
      return { configured: true, opened: true };
    },
    launchHarness: async (harnessId, surface) => {
      record("launchHarness", harnessId, surface);
      return { opened: true };
    },
    probeAgentBridge: async (bridgeId) => { record("probeAgentBridge", bridgeId); return { handshake: "ok" }; },
    loginAgentBridge: async (bridgeId) => { record("loginAgentBridge", bridgeId); return { opened: true }; },
    openHarnessSession: async () => ({ opened: true }),
    getAccountUsage: async () => {
      accountUsageReads += 1;
      const read = accountUsageReads;
      await new Promise((resolve) => setTimeout(
        resolve,
        staleAccountFailure && read > 1 ? 0 : accountDelay ?? usageDelayMs,
      ));
      if ((staleAccountFailure && read === 1) || rejectAccountUsageRead === read) {
        throw new Error("Account usage poll failed");
      }
      return {
        fetchedAt: "2026-08-27T08:00:00.000Z",
        planType: "pro",
        primary: {
          usedPercent: 34,
          remainingPercent: 66,
          windowDurationMins: 300,
          resetsAt: 1800000000,
        },
        dailyUsageBuckets: [{ startDate: "2026-08-27", tokens: 24000 }],
        summary: { lifetimeTokens: 24000, peakDailyTokens: 24000, currentStreakDays: 1 },
      };
    },
    getProviderUsage: async () => {
      providerUsageReads += 1;
      const read = providerUsageReads;
      await new Promise((resolve) => setTimeout(
        resolve,
        staleProviderUsage && read > 1 ? 0 : providerUsageDelay ?? usageDelayMs,
      ));
      const totalTokens = staleProviderUsage && read > 1 ? 24000 : 12000;
      return {
        fetchedAt: "2026-08-27T08:00:00.000Z",
        providers: [
          ...(fallbackUsage ? [{
            id: "openai",
            displayName: "OpenAI",
            credentialType: "oauth",
            totalTokens: 31_000,
            requests: 3,
            last24hTokens: 31_000,
            last24hRequests: 3,
            dailyUsageBuckets: [{
              startDate: "2026-08-28",
              tokens: 31_000,
              requests: 3,
              inputTokens: 25_000,
              cachedInputTokens: 7_000,
              outputTokens: 6_000,
            }],
          }] : []),
          {
            id: "deepseek",
            displayName: "DeepSeek",
            credentialType: "api",
            totalTokens,
            requests: 8,
            last24hTokens: totalTokens,
            last24hRequests: 8,
            dailyUsageBuckets: [{ startDate: "2026-08-27", tokens: totalTokens, requests: 8 }],
            account: {
              status: "available",
              metrics: [
                {
                  kind: "quota",
                  label: "Monthly credits",
                  usedPercent: 25,
                  remainingPercent: 75,
                  resetAt: 1800000000,
                },
                {
                  kind: "quota",
                  label: "Rolling window",
                  usedPercent: 40,
                  remainingPercent: 60,
                  resetAt: 1790000000,
                },
              ],
            },
          },
        ],
      };
    },
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
    setSubagentModel: async () => ({ ok: true }),
    setSubagentEffort: async () => ({ ok: true }),
    onNavigation: (listener) => {
      navigationListener = listener;
      return () => { if (navigationListener === listener) navigationListener = undefined; };
    },
    onOperation: (listener) => {
      operationListener = listener;
      return () => { if (operationListener === listener) operationListener = undefined; };
    },
  });
  window.routerControlTest = Object.freeze({
    calls: () => calls.map((call) => ({ name: call.name, args: call.args })),
    navigationReady: () => Boolean(navigationListener),
    navigate: (destination) => {
      if (!navigationListener) return false;
      navigationListener(destination);
      return true;
    },
    setUsageDelay: (milliseconds) => { usageDelayMs = milliseconds; },
    usageReads: () => ({ account: accountUsageReads, provider: providerUsageReads }),
    healthReads: () => healthReads,
    setCursorHarnessState: (state) => { cursorHarnessState = state; },
    setOpenClawHarnessConfigured: (configured) => { openclawHarnessConfigured = configured; },
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

test("the production renderer exposes model discovery and picker actions", { timeout: 120_000 }, async () => {
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
    // Windows hosted runners routinely spend about 30 seconds starting the
    // browser. Keep UI waits short and diagnostic without letting that startup
    // consume the whole integration-test deadline.
    page.setDefaultTimeout(10_000);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(message.text());
    });

    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.getByRole("navigation", { name: "Control center sections" }).waitFor();
    const wordmark = page.locator(".router-wordmark");
    assert.equal((await wordmark.locator("strong").innerText()).trim(), "Codex Router");
    assert.equal(await wordmark.locator("img").count(), 0);
    await page.waitForFunction(() => window.routerControlTest.navigationReady());
    await page.evaluate(() => window.routerControlTest.setUsageDelay(600));
    assert.equal(
      await page.evaluate(() => window.routerControlTest.navigate({ destination: "usage", sourceId: "deepseek" })),
      true,
    );
    await page.getByRole("heading", { name: "Usage", exact: true }).waitFor();
    assert.equal(
      await page.evaluate(() => window.routerControlTest.navigate({ destination: "usage-resets", sourceId: "deepseek" })),
      true,
    );
    await page.waitForFunction(() => {
      const active = document.activeElement;
      return active?.classList.contains("us-metric-card")
        && active.getAttribute("aria-label")?.startsWith("DeepSeek, Rolling window");
    });
    assert.match(
      await page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
      /DeepSeek, Rolling window.*Resets/,
    );
    assert.equal(
      await page.evaluate(() => window.routerControlTest.navigate({ destination: "usage", sourceId: "openai" })),
      true,
    );
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Usage overview");
    assert.equal(await page.getByLabel("Usage source").inputValue(), "chatgpt-subscription");

    // Harness is one client per row, in the product order the operator uses,
    // and the shared metadata index continues into Context Manager.
    await page.getByRole("button", { name: "Harness Experimental", exact: true }).click();
    assert.equal(await page.locator(".primary-nav .badge-warning", { hasText: "Experimental" }).count(), 1);
    assert.equal(await page.locator(".title-tabs .badge-warning", { hasText: "Experimental" }).count(), 1);
    assert.equal(await page.locator(".page-scroll-harness").evaluate((element) => getComputedStyle(element).display), "block");
    const harnessRows = page.locator(".lhc-harness-row");
    await harnessRows.first().waitFor();
    assert.equal(await harnessRows.count(), 6);
    assert.deepEqual(
      (await harnessRows.locator("h2").allTextContents()).map((value) => value.trim()),
      ["OpenClaw", "Cursor", "Claude Code", "Gemini CLI", "DeepSeek Harness", "Codex"],
    );
    assert.equal(await harnessRows.nth(0).locator('[data-client-logo="openclaw"]').count(), 1);
    assert.equal(await harnessRows.nth(1).locator('[data-client-logo="cursor"]').count(), 1);
    assert.equal(await harnessRows.nth(2).locator('[data-client-logo="claude"]').count(), 1);
    assert.equal(await harnessRows.nth(3).locator('[data-client-logo="gemini"]').count(), 1);
    assert.equal(await harnessRows.nth(4).locator('[data-client-logo="dsh"]').count(), 1);
    assert.equal(await harnessRows.nth(5).locator('[data-client-logo="codex"]').count(), 1);
    assert.deepEqual(
      await page.locator(".lhc-harness-table-head span").allTextContents(),
      ["Client", "Runtime", "Models", "Sessions", "Actions"],
    );
    assert.equal(await page.getByText("1 published", { exact: true }).count(), 5);
    assert.equal(await page.getByText("1 available", { exact: true }).count(), 1);
    assert.equal(await page.getByLabel("Stable public HTTPS origin").count(), 0);
    assert.deepEqual(
      (await page.locator(".lhc-harness-actions button").allTextContents()).map((label) => label.trim()),
      ["Open", "Open", "Open", "Open", "Open", "Open"],
    );
    for (const client of ["OpenClaw", "Cursor", "Claude Code", "Gemini CLI", "DeepSeek Harness", "Codex"]) {
      assert.equal(await page.getByRole("button", { name: `Open ${client}`, exact: true }).count(), 1);
    }
    assert.deepEqual(
      await harnessRows.evaluateAll((rows) => rows.map((row) => row.querySelectorAll(".lhc-harness-actions button").length)),
      [1, 1, 1, 1, 1, 1],
    );
    assert.equal(await page.getByRole("button", { name: /documentation|terminal|agent/i }).count(), 0);
    await harnessRows.nth(0).getByRole("button", { name: "Open OpenClaw", exact: true }).click();
    assert.deepEqual(
      await page.evaluate(() => window.routerControlTest.calls().find((call) => call.name === "launchHarness")),
      { name: "launchHarness", args: ["openclaw", "app"] },
    );
    await page.evaluate(() => window.routerControlTest.setOpenClawHarnessConfigured(false));
    await page.getByRole("button", { name: "Context Manager", exact: true }).click();
    await page.getByRole("button", { name: "Harness Experimental", exact: true }).click();
    await harnessRows.nth(0).getByRole("button", { name: "Set up", exact: true }).click();
    await harnessRows.nth(0).getByRole("button", { name: "Open OpenClaw", exact: true }).waitFor();
    assert.equal(
      await page.evaluate(() => window.routerControlTest.calls()
        .filter((call) => call.name === "setupHarness" && call.args[0] === "openclaw").length),
      1,
    );
    assert.equal(await page.locator(".lhc-agent-bridges").count(), 0);
    assert.deepEqual(
      await page.locator(".lhc-harness-bridge strong").allTextContents(),
      ["Available", "Available", "Not detected"],
    );
    const rowBoxes = await harnessRows.evaluateAll((rows) => rows.map((row) => {
      const box = row.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    }));
    assert.equal(rowBoxes.every((box) => box.width === rowBoxes[0].width), true);
    for (let index = 1; index < rowBoxes.length; index += 1) {
      assert.equal(Math.abs(rowBoxes[index].y - (rowBoxes[index - 1].y + rowBoxes[index - 1].height)) < 1, true);
    }
    const listBox = await page.locator(".lhc-harness-list").boundingBox();
    assert.ok(listBox);
    const lastRow = rowBoxes.at(-1);
    assert.ok(lastRow);
    const listEndDelta = (listBox.y + listBox.height) - (lastRow.y + lastRow.height);
    assert.ok(listEndDelta >= 0 && listEndDelta < 3, JSON.stringify({ listBox, rowBoxes, listEndDelta }));
    const harnessColumns = await harnessRows.evaluateAll((rows) => rows.map((row) => {
      const box = (selector) => {
        const rect = row.querySelector(selector).getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width };
      };
      return {
        identity: box(":scope > header"),
        runtime: box(".lhc-harness-runtime"),
        catalog: box(".lhc-harness-catalog"),
        sessions: box(".lhc-harness-sessions"),
        actions: box(":scope > footer"),
      };
    }));
    for (const column of ["identity", "runtime", "catalog", "sessions", "actions"]) {
      assert.equal(harnessColumns.every((row) => Math.abs(row[column].x - harnessColumns[0][column].x) < 1), true);
      assert.equal(harnessColumns.every((row) => Math.abs(row[column].width - harnessColumns[0][column].width) < 1), true);
    }
    assert.equal(harnessColumns.every((row) => Math.abs(row.actions.y - harnessColumns[0].actions.y - (rowBoxes[harnessColumns.indexOf(row)].y - rowBoxes[0].y)) < 1), true);
    await page.setViewportSize({ width: 880, height: 840 });
    assert.equal(
      await harnessRows.first().evaluate((row) => getComputedStyle(row).gridTemplateColumns.split(" ").length),
      3,
    );
    await page.setViewportSize({ width: 1280, height: 840 });
    await page.evaluate(() => window.routerControlTest.setCursorHarnessState("install"));
    await page.getByRole("button", { name: "Context Manager", exact: true }).click();
    await page.getByRole("button", { name: "Harness Experimental", exact: true }).click();
    await page.getByRole("button", { name: "Connect Cursor", exact: true }).click();
    const cursorProgress = page.getByRole("progressbar", { name: "Cursor setup progress" });
    await cursorProgress.waitFor();
    assert.match(await harnessRows.nth(1).innerText(), /Installing Cloudflare connector/);
    await harnessRows.nth(1).getByRole("button", { name: "Open Cursor", exact: true }).waitFor();
    assert.equal(await cursorProgress.count(), 0);
    assert.equal(
      await page.evaluate(() => window.routerControlTest.calls().filter((call) => call.name === "connectCursor").length),
      1,
    );
    await page.getByRole("button", { name: "Context Manager", exact: true }).click();
    await page.getByRole("heading", { name: "Context Manager", exact: true }).waitFor();
    assert.equal(await page.locator(".lhc-session-row").count(), 3);
    assert.deepEqual(
      await page.locator('.segmented-control[aria-label="Filter sessions by harness"] button').allTextContents(),
      ["All", "Cursor", "DeepSeek Harness", "Codex"],
    );
    await page.getByRole("button", { name: "Models", exact: true }).click();

    // The connections strip carries every account: connected providers as
    // chips, the rest behind one menu.
    const connections = page.locator(".pm-connections");
    await connections.waitFor();
    assert.match(await connections.innerText(), /3 of 8 connected/);
    assert.deepEqual(
      (await connections.locator(".pm-chip:not(.pm-chip-add)").allTextContents()).map((text) => text.trim()).sort(),
      ["DeepSeek", "OpenCode Free", "opencode Go/Zen"].sort(),
    );
    await connections.getByRole("button", { name: "Connect provider", exact: true }).click();
    const connectMenu = page.locator(".pm-connect-menu");
    await connectMenu.waitFor();
    // An anonymous endpoint is not connected until it is explicitly enabled,
    // so it belongs with the providers still waiting for a connection.
    assert.match(await connectMenu.innerText(), /Kilo Free/);
    assert.equal(await connectMenu.getByRole("menuitem").count(), 5);
    await page.keyboard.press("Escape");

    // A single-route model's thinking menu opens below its definition-list
    // cell. The menu used to be clipped by that cell's generic text-overflow
    // rule, leaving only its top edge visible.
    const selectedFamily = page.locator(".pm-family-row").filter({ hasText: "DeepSeek Chat" });
    await selectedFamily.locator(".pm-family-open").click();
    const thinkingTrigger = selectedFamily.getByRole("button", {
      name: "DeepSeek Chat DeepSeek subagent thinking effort",
    });
    await thinkingTrigger.click();
    const thinkingMenu = selectedFamily.locator(".pm-effort-menu");
    await thinkingMenu.waitFor();
    const detailsCell = selectedFamily.locator(".pm-model-details-controls");
    assert.equal(await detailsCell.evaluate((element) => getComputedStyle(element).overflow), "visible");
    const [cellBox, menuBox] = await Promise.all([detailsCell.boundingBox(), thinkingMenu.boundingBox()]);
    assert.ok(cellBox && menuBox);
    assert.ok(menuBox.y + menuBox.height > cellBox.y + cellBox.height);
    assert.equal(await page.evaluate(({ x, y }) => (
      Boolean(document.elementFromPoint(x, y)?.closest(".pm-effort-menu"))
    ), {
      x: menuBox.x + menuBox.width / 2,
      y: menuBox.y + menuBox.height - 2,
    }), true);
    await page.keyboard.press("Escape");
    await selectedFamily.locator(".pm-family-open").click();

    // A route that is only known to the registry still has to be findable, and
    // has to say which connection it is waiting for.
    const modelSearch = page.locator('input[placeholder="Search models"]');
    await modelSearch.fill("Ox Alpha");
    const oxFamily = page.locator(".pm-family-row").filter({ hasText: "Ox Alpha" });
    await oxFamily.waitFor();
    assert.match(await oxFamily.innerText(), /6 providers/);
    assert.match(await oxFamily.innerText(), /6 routes/i);
    await oxFamily.locator(".pm-family-open").click();
    assert.equal(await oxFamily.locator(".pm-route-row").count(), 6);
    assert.equal(await oxFamily.locator('.pm-route-row[data-availability="known"]').count(), 4);
    // Every row ends in the same slot: a switch you can use, or the button
    // that would make it usable.
    assert.equal(await oxFamily.getByRole("button", { name: /^Connect / }).count(), 4);
    const columns = await oxFamily.locator(".pm-route-head > span").allTextContents();
    assert.deepEqual(columns, ["Account", "Context", "Input", "In picker", "Subagents", "Thinking"]);
    await modelSearch.fill("");

    // Adding reads every connected provider's catalog at once. Only a provider
    // that is both connected and publishes a catalog is asked.
    await page.getByRole("button", { name: "Add models", exact: true }).click();
    const addDialog = page.locator(".pm-add-models");
    await addDialog.waitFor();
    await page.waitForFunction(() => window.routerControlTest.calls()
      .some((call) => call.name === "discoverProviderModels"));
    const bulkCatalogProviders = await page.evaluate(() => window.routerControlTest.calls()
      .filter((call) => call.name === "discoverProviderModels")
      .map((call) => call.args[0]));
    assert.deepEqual(bulkCatalogProviders, ["deepseek"]);

    const blockedRow = addDialog.locator(".pm-add-models-row").filter({ hasText: "blocked-preview" });
    await blockedRow.waitFor();
    assert.equal(await blockedRow.getAttribute("data-blocked"), "true");
    assert.equal(await blockedRow.locator("input[type=checkbox]").isDisabled(), true);
    assert.equal(await blockedRow.getByText("Not yet supported", { exact: true }).count(), 1);
    assert.equal(
      await blockedRow.locator(".pm-catalog-block-reason").innerText(),
      "No certified protocol route is available.",
    );

    const addableRow = addDialog.locator(".pm-add-models-row").filter({ hasText: "catalog-addable" });
    await addableRow.locator("input[type=checkbox]").check();
    await addDialog.getByRole("button", { name: "Add 1 model", exact: true }).click();
    await page.waitForFunction(() => window.routerControlTest.calls()
      .some((call) => call.name === "addProviderModels"));

    // Flipping a model must never move it. Sorting by the switch would throw
    // the row across the list at the moment the reader looks for confirmation.
    const modelNames = () => page.locator(".pm-family-main > strong").allTextContents();
    const orderBefore = await modelNames();
    assert.deepEqual(orderBefore, ["DeepSeek Chat", "Ox Alpha"]);
    const deepseekRow = page.locator(".pm-family-row").filter({ hasText: "DeepSeek Chat" });
    assert.equal((await deepseekRow.locator(".pm-family-state").innerText()).trim(), "On");
    await deepseekRow.locator('.pm-family-action input[type="checkbox"]').click();
    // Scope to the row's own state, not any "Off" inside its expanded panel.
    await deepseekRow.locator(".pm-family-state").filter({ hasText: "Off" }).waitFor();
    assert.deepEqual(await modelNames(), orderBefore);

    // Bulk switches live behind the overflow menu, off the main toolbar.
    await page.getByRole("button", { name: "More model actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Turn all on", exact: true }).click();
    await page.waitForFunction(() => window.routerControlTest.calls()
      .some((call) => call.name === "setPickerModels" && call.args[0] === true));

    const calls = await page.evaluate(() => window.routerControlTest.calls());
    assert.deepEqual(calls.find((call) => call.name === "addProviderModels")?.args, [
      "deepseek",
      ["catalog-addable"],
    ]);
    assert.equal(calls.some((call) => call.name === "setPickerModels" && call.args[0] === true), true);

    // Huge community GGUFs stay guarded, but the explicit oversized-model
    // acknowledgement must make their exact Ollama tag selectable. Otherwise
    // the catalog advertises GLM while forcing the operator to retype it.
    await page.getByRole("button", { name: "Local", exact: true }).click();
    await page.getByRole("heading", { name: "Local", exact: true }).waitFor();
    const glmFamily = page.locator(".lhc-catalog-family").filter({ hasText: "GLM-5.3-Flash" });
    await glmFamily.locator(".lhc-catalog-family-trigger").click();
    const glmRow = glmFamily.locator(".lhc-catalog-model").filter({ hasText: "UD-IQ1_S" });
    const glmSelect = glmRow.getByRole("button", { name: "Select", exact: true });
    assert.equal(await glmSelect.isDisabled(), true);
    await page.getByRole("checkbox", { name: "Allow a model larger than the router recommends for this machine" }).check();
    assert.equal(await glmSelect.isEnabled(), true);
    await glmSelect.click();
    assert.equal(
      await page.getByRole("textbox", { name: "Model tag or Ollama URL" }).inputValue(),
      "hf.co/unsloth/GLM-5.3-Flash-GGUF:UD-IQ1_S",
    );
    assert.deepEqual(pageErrors, [], `renderer errors: ${pageErrors.join("; ")}`);
  } finally {
    await browser.close();
    await close();
  }
});

test("fallback-only splits do not claim account breakdown or a complete range mix", { timeout: 120_000 }, async () => {
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
    page.setDefaultTimeout(10_000);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(message.text());
    });

    await page.goto(`${url}?fallbackUsage=1`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForFunction(() => window.routerControlTest.navigationReady());
    assert.equal(
      await page.evaluate(() => window.routerControlTest.navigate({ destination: "usage", sourceId: "openai" })),
      true,
    );
    await page.getByRole("heading", { name: "Usage", exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('select[aria-label="Usage source"]')?.value === "chatgpt-subscription");
    await page.locator(".us-chart-token-bars rect.router-fallback").first().waitFor();
    await page.getByText(/1 date uses local router fallback\.$/).waitFor();
    await page.getByText(/1 date is filled from this router's local ChatGPT meter/).waitFor();
    assert.equal(
      await page.locator(".us-chart-wrap").getAttribute("aria-label"),
      "Daily account token usage with local router fallback on 1 date",
    );
    assert.doesNotMatch(await page.locator("body").innerText(), /\b1 dates\b/i);

    assert.equal(
      await page.getByText("The account API supplied the input/cache/output split for this 30-day range.", { exact: true }).count(),
      0,
    );
    await page.getByText(
      "OpenAI supplies daily account totals only here; use “This router · all providers” for regular input, cached input, and output.",
      { exact: true },
    ).waitFor();
    assert.equal(await page.locator('.us-token-mix[aria-label="Token mix for selected 30-day range"]').count(), 0);
    assert.equal(await page.locator(".us-token-mix").count(), 0);
    assert.deepEqual(pageErrors, [], `renderer errors: ${pageErrors.join("; ")}`);
  } finally {
    await browser.close();
    await close();
  }
});

test("independent control-center reads reveal each ready page region", { timeout: 120_000 }, async () => {
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
    page.setDefaultTimeout(10_000);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(message.text());
    });

    await page.goto(`${url}?snapshotDelayMs=3000&accountDelayMs=4000`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    // Only the responsiveness checks use the tight budget. A cold browser
    // navigation includes process and module startup and needs a normal timeout.
    page.setDefaultTimeout(1_500);
    await page.getByRole("heading", { name: "Dashboard", exact: true }).waitFor();
    await page.locator(".service-health-strip").waitFor();
    await page.locator('.db-breakdown-list[aria-label="Providers usage breakdown"]')
      .getByText("DeepSeek", { exact: true })
      .waitFor();
    assert.equal(await page.locator(".db-breakdown-panel .panel-skeleton").count(), 0);

    await page.getByRole("button", { name: "Models", exact: true }).click();
    await page.getByRole("heading", { name: "Models", exact: true }).waitFor();
    const connections = page.locator(".pm-connections:not(.pm-connections-loading)");
    await connections.waitFor();
    assert.match(await connections.innerText(), /DeepSeek/);
    await page.locator(".pm-models-loading").waitFor();

    page.setDefaultTimeout(7_000);
    await page.locator(".pm-family-row").filter({ hasText: "DeepSeek Chat" }).waitFor();
    assert.deepEqual(pageErrors, [], `renderer errors: ${pageErrors.join("; ")}`);
  } finally {
    await browser.close();
    await close();
  }
});

test("usage polling surfaces current rejections, recovers, and ignores older results", { timeout: 120_000 }, async () => {
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
    page.setDefaultTimeout(10_000);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(message.text());
    });

    await page.goto(`${url}?providerUsageDelayMs=400&staleProviderUsage=1&rejectAccountUsageRead=2&pollOnceMs=50`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.waitForFunction(() => {
      const reads = window.routerControlTest.usageReads();
      return reads.account >= 2 && reads.provider >= 2;
    });
    await page.getByText("Account usage poll failed", { exact: true }).waitFor();
    await page.waitForTimeout(450);
    assert.equal(
      await page.locator('.db-breakdown-list[aria-label="Providers usage breakdown"] .db-breakdown-value').innerText(),
      "24k",
    );
    await page.getByRole("button", { name: "Refresh all data", exact: true }).click();
    await page.getByText("Account usage poll failed", { exact: true }).waitFor({ state: "detached" });
    assert.deepEqual(pageErrors, [], `renderer errors: ${pageErrors.join("; ")}`);
  } finally {
    await browser.close();
    await close();
  }
});

test("an older rejected usage read cannot replace a newer success with a warning", { timeout: 120_000 }, async () => {
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
    page.setDefaultTimeout(10_000);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(message.text());
    });

    await page.goto(`${url}?accountDelayMs=400&staleAccountFailure=1&pollOnceMs=50`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.waitForFunction(() => window.routerControlTest.usageReads().account >= 2);
    await page.waitForTimeout(450);
    assert.equal(await page.getByText("Account usage poll failed", { exact: true }).count(), 0);
    assert.deepEqual(pageErrors, [], `renderer errors: ${pageErrors.join("; ")}`);
  } finally {
    await browser.close();
    await close();
  }
});

test("health polling and core refresh share latest-wins ordering", { timeout: 120_000 }, async () => {
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
    page.setDefaultTimeout(10_000);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(message.text());
    });

    await page.goto(`${url}?staleHealth=1&healthPollOnceMs=50`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.waitForFunction(() => window.routerControlTest.healthReads() >= 2);
    await page.waitForTimeout(450);
    assert.match(await page.locator(".service-health-strip").innerText(), /ALL CLEAR/);
    assert.match(
      await page.getByRole("listitem", { name: /^Router state:/ }).getAttribute("aria-label"),
      /version health-2/,
    );
    assert.deepEqual(pageErrors, [], `renderer errors: ${pageErrors.join("; ")}`);
  } finally {
    await browser.close();
    await close();
  }
});
