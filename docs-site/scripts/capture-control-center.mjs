import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "../../apps/control-center/node_modules/playwright/index.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../..");
const appRoot = path.join(repositoryRoot, "apps/control-center");
const distRoot = path.join(appRoot, "dist");
const fixtureSource = readFileSync(path.join(appRoot, "test/renderer.test.mjs"), "utf8");
const fixtureMatch = fixtureSource.match(
  /const bridgeSource = String\.raw`([\s\S]*?)`;\n\nfunction mimeType/,
);

if (!fixtureMatch) {
  throw new Error("Could not locate the Control Center's sanitized renderer fixture.");
}

if (!existsSync(path.join(distRoot, "index.html"))) {
  throw new Error("Build apps/control-center before capturing screenshots.");
}

const bridgeSource = fixtureMatch[1].replace(
  "    active: true,\n    enabledProviders:",
  `    active: true,
    usageEvents: Array.from({ length: 18 }, (_, index) => {
      const inputTokens = 7_400 + (index * 930) + ((index % 4) * 1_700);
      const cachedInputTokens = Math.round(inputTokens * (0.42 + ((index % 3) * 0.08)));
      const outputTokens = 360 + ((index % 5) * 97);
      return {
        at: new Date(Date.now() - ((17 - index) * 75 * 60_000)).toISOString(),
        model: selectedModel.slug,
        provider: "deepseek",
        status: 200,
        durationMs: 4_200 + (index * 170),
        firstTokenMs: 780 + (index * 23),
        inputTokens,
        cachedInputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      };
    }),
    enabledProviders:`,
).replace(
  /  const providerUsage = \{[\s\S]*?\n  \};\n\n  const record/,
  `  const providerUsage = {
    fetchedAt: new Date().toISOString(),
    providers: [{
      id: "openai",
      displayName: "OpenAI",
      credentialType: "oauth",
      requests: 184,
      successfulRequests: 182,
      meteredRequests: 183,
      inputTokens: 1_486_200,
      regularInputTokens: 922_000,
      cachedInputTokens: 564_200,
      outputTokens: 42_800,
      totalTokens: 1_529_000,
      last24hInputTokens: 74_200,
      last24hRegularInputTokens: 46_800,
      last24hCachedInputTokens: 27_400,
      last24hOutputTokens: 2_250,
      last24hTokens: 76_450,
      last24hRequests: 9,
      last24hMeteredRequests: 9,
      dailyUsageBuckets: Array.from({ length: 30 }, (_, index) => {
        const inputTokens = 31_500 + ((index % 7) * 4_100) + (index * 380);
        const cachedInputTokens = Math.round(inputTokens * (0.31 + ((index % 4) * 0.04)));
        const outputTokens = 1_350 + ((index % 5) * 240);
        return {
          startDate: localDateKey(29 - index),
          tokens: inputTokens + outputTokens,
          requests: 4 + (index % 7),
          inputTokens,
          cachedInputTokens,
          outputTokens,
        };
      }),
    }],
  };

  const record`,
);
const outputRoot = path.join(repositoryRoot, "docs-site/public/app");
mkdirSync(outputRoot, { recursive: true });

function mimeType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
}

const server = createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
  if (pathname === "/marketing-bridge.js") {
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    response.end(bridgeSource);
    return;
  }

  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = path.resolve(distRoot, relative);
  if ((target !== distRoot && !target.startsWith(`${distRoot}${path.sep}`)) || !existsSync(target)) {
    response.writeHead(404).end("not found");
    return;
  }

  let contents = readFileSync(target);
  if (relative === "index.html") {
    contents = Buffer.from(
      contents
        .toString("utf8")
        .replace(
          '<script type="module"',
          '<script src="./marketing-bridge.js"></script><script type="module"',
        ),
    );
  }
  response.writeHead(200, { "content-type": mimeType(target) });
  response.end(contents);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Capture server did not start.");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  colorScheme: "light",
});

await page.addInitScript(() => {
  localStorage.setItem("model-router-control-center-theme", "light");
  localStorage.setItem("model-router-control-center-view", "dashboard");
});

try {
  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "networkidle" });
  await page.getByRole("navigation", { name: "Control center sections" }).waitFor();
  await page.evaluate(() => document.fonts.ready);

  const capture = async (view, fileName) => {
    await page.getByRole("button", { name: view, exact: true }).click();
    await page.getByRole("heading", { name: view, exact: true }).waitFor();
    await page.waitForTimeout(180);
    await page.screenshot({
      path: path.join(outputRoot, fileName),
      fullPage: false,
      animations: "disabled",
    });
  };

  await capture("Dashboard", "control-center-dashboard.png");
  await capture("Models", "control-center-models.png");
  await capture("Usage", "control-center-usage.png");
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

console.log(`Captured sanitized production UI screenshots in ${outputRoot}`);
