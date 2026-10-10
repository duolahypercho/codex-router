import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dist = process.env.CODEX_ROUTER_TEST_UI_DIST
  ? path.resolve(process.env.CODEX_ROUTER_TEST_UI_DIST)
  : path.join(root, "apps/control-center/dist");

function fixture(events) {
  return {
    events,
    providerUsage: { providers: [{ id: "custom", displayName: "Fixture provider", requests: 12,
      successfulRequests: 8, meteredRequests: 12, totalTokens: 720, last24hRequests: events.length, last24hTokens: events.length * 120,
      outcomeCounts: { completed: 1, failed: 1, incomplete: 1, canceled: 1, indeterminate: 1 }, legacyOutcomeRequests: 7,
      models: [{ slug: "custom/ledger-model", displayName: "Ledger model", requests: 12, successfulRequests: 8,
        totalTokens: 720, inputTokens: 600, outputTokens: 120,
        outcomeCounts: { completed: 1, failed: 1, incomplete: 1, canceled: 1, indeterminate: 1 }, legacyOutcomeRequests: 7 }] }] },
  };
}

async function addFixture(page, payload, locale = "en") {
  await page.addInitScript(({ events, providerUsage, locale }) => {
    localStorage.setItem("codex-router-language", locale);
    localStorage.setItem("model-router-control-center-view", "dashboard");
    const target = { target: "codex", configured: true, active: true, enabledProviders: [], providers: [], models: [], usageEvents: events };
    window.routerControl = Object.freeze({
      platform: "linux",
      getSnapshot: async () => ({ targets: { codex: target } }),
      getProviders: async () => ({ providers: [] }),
      getPresence: async () => ({ mode: "always" }),
      getHealth: async () => ({ ok: true, activity: { state: "idle", active: [], activeCount: 0 } }),
      getAccountUsage: async () => ({}),
      getProviderUsage: async () => providerUsage,
    });
  }, { ...payload, locale });
}

async function serveRenderer() {
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const target = path.resolve(dist, relative);
    if (!target.startsWith(`${dist}${path.sep}`) || !existsSync(target)) return response.writeHead(404).end();
    const type = target.endsWith(".html") ? "text/html" : target.endsWith(".js") ? "text/javascript" : target.endsWith(".css") ? "text/css" : target.endsWith(".svg") ? "image/svg+xml" : "application/octet-stream";
    response.writeHead(200, { "content-type": type });
    response.end(readFileSync(target));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((resolve) => {
    server.close(resolve); server.closeAllConnections();
  }) };
}

const chromiumPath = [process.env.CODEX_ROUTER_TEST_CHROMIUM, chromium.executablePath(),
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Google/Chrome/Application/chrome.exe"),
  process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Google/Chrome/Application/chrome.exe"),
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe"),
].find((candidate) => candidate && existsSync(candidate));

test("the compiled Dashboard and Status distinguish HTTP 200 failures and historical records", { timeout: 60_000 }, async () => {
  assert.ok(existsSync(path.join(dist, "index.html")), "build the Control Center before testing its renderer");
  assert.ok(chromiumPath, "a Chromium executable is required for renderer verification");
  const events = ["completed", "failed", "incomplete", "canceled", "indeterminate", undefined].map((generationOutcome) => ({
    at: new Date().toISOString(), model: `custom/${generationOutcome ?? "historical"}-model`, provider: "custom",
    status: 200, ...(generationOutcome ? { httpStatus: 200, generationOutcome } : {}),
    billedInputTokens: 100, billedOutputTokens: 20, inputTokens: 1, outputTokens: 20, totalTokens: 21,
    durationMs: 1000, firstTokenMs: 600,
  }));
  const labels = { completed: "Completed", failed: "Failed", incomplete: "Incomplete", canceled: "Canceled", indeterminate: "Unknown", historical: "Not recorded" };
  const tones = { completed: "success", failed: "danger", incomplete: "warning", canceled: "neutral", indeterminate: "warning", historical: "neutral" };
  const { url, close } = await serveRenderer();
  const browser = await chromium.launch({ executablePath: chromiumPath, headless: true, args: process.platform === "linux" ? ["--no-sandbox"] : [] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await addFixture(page, fixture(events));
    await page.goto(url);
    await page.locator(".db-event-list > article").first().waitFor();
    assert.equal(await page.locator(".db-event-list > article").count(), 5, "retain the existing recent-event limit");
    for (const name of ["failed", "incomplete", "canceled", "indeterminate", "historical"]) {
      const row = page.locator(".db-event-list > article").filter({ hasText: `${name}-model` });
      assert.equal((await row.locator(".badge").textContent())?.trim(), labels[name]);
      assert.match(await row.locator(".badge").getAttribute("class"), new RegExp(`badge-${tones[name]}`));
      assert.match(await row.getAttribute("aria-label"), /HTTP 200; generation:/);
      assert.match(await row.locator(".db-event-metering").innerText(), /120/);
      assert.doesNotMatch(await row.locator(".db-event-metering").innerText(), /50\.0 tok\/s/);
    }
    assert.match(await page.locator(".db-breakdown-list").first().innerText(), /90-day outcomes:.*1 Completed.*7 Not recorded/);
    const screenshotDir = path.join(root, "generated/generation-outcome-ui");
    mkdirSync(screenshotDir, { recursive: true });
    await page.locator(".db-events-panel").screenshot({ path: path.join(screenshotDir, "dashboard.png") });
    await page.locator(".primary-nav button").nth(2).click();
    await page.locator(".st-event-list article").first().waitFor();
    for (const [name, label] of Object.entries(labels)) {
      const row = page.locator(".st-event-list article").filter({ hasText: `${name}-model` });
      assert.equal((await row.locator(".st-event-flag .badge").textContent())?.trim(), label);
      assert.match(await row.locator(".badge").getAttribute("class"), new RegExp(`badge-${tones[name]}`));
      assert.match(await row.locator(".st-event-metering").innerText(), /120/);
      assert.match(await row.getAttribute("aria-label"), /HTTP 200; generation:/);
    }
    assert.match(await page.locator(".st-model-facts").innerText(), /1 Completed.*1 Failed.*1 Canceled.*1 Unknown.*7 Not recorded/);
    await page.locator(".st-event-list").screenshot({ path: path.join(screenshotDir, "status.png") });
    for (const width of [960, 1280]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const badge of await page.locator(".st-event-flag .badge").all()) {
        const clipped = await badge.evaluate((element) => element.scrollWidth > element.clientWidth + 1);
        assert.equal(clipped, false, `outcome badge is clipped at ${width}px`);
      }
    }
    assert.deepEqual(errors, []);
    const completedPage = await browser.newPage();
    await addFixture(completedPage, fixture([events[0]]));
    await completedPage.goto(url);
    const completed = completedPage.locator(".db-event-list > article");
    await completed.waitFor();
    assert.equal((await completed.locator(".badge").textContent())?.trim(), "Completed");
    assert.match(await completed.locator(".db-event-metering").innerText(), /50\.0 tok\/s/, "completed negative control retains measured speed");
  } finally { await browser.close(); await close(); }
});
