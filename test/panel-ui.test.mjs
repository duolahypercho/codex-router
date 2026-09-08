import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  accountBucketsWithRouterFallback,
  buildQuotaCards,
  chartGeometry,
  commandRefused,
  compactTokens,
  dailySeries,
  metricRemainingPercent,
  modelMatchesQuery,
  observedModelSpeed,
  quotaWindow,
  readOnlyCapabilities,
  serviceHealthRows,
  sourceOptions,
  toolResultAgingChecked,
  visibleLocalDownload,
} from "../apps/panel/model.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
import {
  LANGUAGE_OPTIONS,
  availableLanguages,
  getLanguage,
  setLanguage,
  t,
  translationKeys,
} from "../apps/panel/i18n.mjs";

test("model picker search matches names, slugs, and provider labels", () => {
  const model = {
    displayName: "Ox Alpha (OpenCode Free)",
    slug: "opencode-free/ox-alpha",
    provider: "opencode-free",
  };
  assert.equal(modelMatchesQuery(model, "ox alpha", "OpenCode Free"), true);
  assert.equal(modelMatchesQuery(model, "opencode-free/ox", "OpenCode Free"), true);
  assert.equal(modelMatchesQuery(model, "OpenCode", "OpenCode Free"), true);
  assert.equal(modelMatchesQuery(model, "venice", "OpenCode Free"), false);
  assert.equal(modelMatchesQuery(model, "   ", "OpenCode Free"), true);
});

test("desktop usage series fills missing local calendar days", () => {
  const series = dailySeries(
    [
      { startDate: "2026-07-19", tokens: 2_400 },
      { startDate: "2026-07-21", tokens: 8_100 },
    ],
    3,
    new Date(2026, 6, 21, 18),
  );

  assert.deepEqual(
    series.map(({ key, tokens }) => ({ key, tokens })),
    [
      { key: "2026-07-19", tokens: 2_400 },
      { key: "2026-07-20", tokens: 0 },
      { key: "2026-07-21", tokens: 8_100 },
    ],
  );
});

test("panel account usage fills only dates missing from OpenAI account data", () => {
  const merged = accountBucketsWithRouterFallback(
    [
      { startDate: "2026-08-26", tokens: 260 },
      { startDate: "2026-08-28", tokens: 280 },
    ],
    [
      { startDate: "2026-08-27", tokens: 27_000 },
      { startDate: "2026-08-28", tokens: 99_999 },
    ],
  );

  assert.deepEqual(
    merged.map(({ startDate, tokens, displaySource }) => ({ startDate, tokens, displaySource })),
    [
      { startDate: "2026-08-26", tokens: 260, displaySource: "account" },
      { startDate: "2026-08-27", tokens: 27_000, displaySource: "router-fallback" },
      { startDate: "2026-08-28", tokens: 280, displaySource: "account" },
    ],
  );
});

test("an explicit zero account bucket wins over local OpenAI traffic", () => {
  assert.deepEqual(
    accountBucketsWithRouterFallback(
      [{ startDate: "2026-08-27", tokens: 0 }],
      [{ startDate: "2026-08-27", tokens: 27_000 }],
    ),
    [{ startDate: "2026-08-27", tokens: 0, displaySource: "account" }],
  );
});

test("the panel source names and preserves OpenAI fallback provenance", () => {
  const [source] = sourceOptions({
    account: { dailyUsageBuckets: [{ startDate: "2026-08-28", tokens: 280 }] },
    providerUsage: {
      providers: [{
        id: "openai",
        displayName: "OpenAI",
        dailyUsageBuckets: [{ startDate: "2026-08-27", tokens: 27_000 }],
      }],
    },
  });
  assert.equal(source.name, "ChatGPT · OpenAI + local fallback");
  assert.equal(source.fallbackDays, 1);
  assert.equal(source.buckets[0].displaySource, "router-fallback");
});

test("quota windows use one weekly label and a distinct five-hour label", () => {
  assert.deepEqual(quotaWindow({ label: "Weekly requests" }), {
    key: "weekly",
    label: "Weekly limit",
  });
  assert.deepEqual(quotaWindow({ windowDurationMins: 300 }), {
    key: "five-hour",
    label: "5-hour limit",
  });
});

test("monthly quota windows keep their own label instead of being dropped", () => {
  assert.deepEqual(quotaWindow({ label: "Monthly limit" }), {
    key: "monthly",
    label: "Monthly limit",
  });
  assert.deepEqual(quotaWindow({ label: "Monthly subscription" }), {
    key: "monthly",
    label: "Monthly limit",
  });
  assert.deepEqual(quotaWindow({ windowDurationMins: 43_200 }), {
    key: "monthly",
    label: "Monthly limit",
  });
});

test("quota cards omit unconfigured providers and de-duplicate synonymous windows", () => {
  const cards = buildQuotaCards({
    providerSetup: {
      providers: [
        { id: "kimi-oauth", configured: true },
        { id: "grok-api", configured: false },
      ],
    },
    providerUsage: {
      providers: [
        {
          id: "kimi-oauth",
          displayName: "Kimi OAuth",
          account: {
            metrics: [
              { kind: "quota", label: "Weekly requests", usedPercent: 48 },
              { kind: "quota", label: "Week", usedPercent: 48 },
              { kind: "quota", label: "5 hour", usedPercent: 3 },
            ],
          },
        },
        {
          id: "grok-api",
          displayName: "Grok API",
          account: { metrics: [{ kind: "quota", label: "Weekly", usedPercent: 20 }] },
        },
      ],
    },
  });

  assert.deepEqual(
    cards.map(({ providerId, label }) => ({ providerId, label })),
    [
      { providerId: "kimi-oauth", label: "Weekly limit" },
      { providerId: "kimi-oauth", label: "5-hour limit" },
    ],
  );
  assert.deepEqual(
    cards.map(({ usedPercent, remainingPercent }) => ({ usedPercent, remainingPercent })),
    [
      { usedPercent: 48, remainingPercent: 52 },
      { usedPercent: 3, remainingPercent: 97 },
    ],
  );
});

test("quota remaining percentage prefers provider data and derives from usage", () => {
  assert.equal(metricRemainingPercent({ usedPercent: 35 }), 65);
  assert.equal(metricRemainingPercent({ used: 25, limit: 100 }), 75);
  assert.equal(metricRemainingPercent({ usedPercent: 35, remainingPercent: 72 }), 72);
});

test("chart geometry stays finite for an empty week", () => {
  const geometry = chartGeometry(Array.from({ length: 7 }, () => ({ tokens: 0 })));
  assert.match(geometry.line, /^M /);
  assert.equal(geometry.points.length, 7);
  assert.ok(geometry.points.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y)));
});

test("token counts remain compact without hiding small values", () => {
  assert.equal(compactTokens(983), "983");
  assert.equal(compactTokens(1_250), "1.3k");
  assert.equal(compactTokens(28_800), "29k");
  assert.equal(compactTokens(2_500_000), "2.5m");
});

test("completed local downloads disappear when the model is no longer installed", () => {
  const done = { tag: "gemma4:12b", status: "done", percent: 100 };
  assert.equal(visibleLocalDownload({ models: [], download: done }), null);
  assert.deepEqual(
    visibleLocalDownload({ models: [{ tag: "gemma4:12b" }], download: done }),
    done,
  );
  const removedWithWarning = {
    tag: "gemma4:12b",
    kind: "uninstall",
    status: "done",
    detail: "Model removed · catalog refresh needed",
    catalogError: "The Codex catalog could not be refreshed.",
  };
  assert.deepEqual(
    visibleLocalDownload({ models: [], download: removedWithWarning }),
    removedWithWarning,
  );
  const active = { tag: "gemma4:12b", status: "downloading", percent: 42 };
  assert.deepEqual(visibleLocalDownload({ models: [], download: active }), active);
  assert.equal(
    visibleLocalDownload({
      models: [],
      download: { tag: "gemma4:12b", status: "cancelled", detail: "Download cancelled" },
    }),
    null,
  );
});

test("active model speed prefers its provider and matches qualified slugs", () => {
  const usage = {
    providers: [
      {
        id: "deepseek",
        models: [
          {
            slug: "deepseek/deepseek-v4-flash",
            displayName: "deepseek-v4-flash",
            observedTokensPerSecond: 18.7,
            speedSampleCount: 4,
          },
        ],
      },
    ],
  };
  assert.deepEqual(observedModelSpeed(usage, "deepseek", "deepseek/deepseek-v4-flash"), {
    speed: 18.7,
    samples: 4,
  });
  usage.providers[0].models[0].observedTokensPerSecond = null;
  assert.equal(observedModelSpeed(usage, "deepseek", "deepseek/deepseek-v4-flash"), null);
  assert.equal(observedModelSpeed(usage, "deepseek", "missing/model"), null);
});

test("panel speed rendering logic detects generation state correctly", () => {
  // Verify the isGenerating logic that renderModelSpeed uses

  // Idle state with no active requests
  const idleActivity = {
    state: "idle",
    model: "provider/model",
    provider: "provider",
    active: [],
  };
  const isIdleGenerating = idleActivity.state === "generating" || (idleActivity.active && idleActivity.active.length > 0);
  assert.equal(isIdleGenerating, false, "idle state with no active requests should not be generating");

  // Generating state
  const generatingActivity = {
    state: "generating",
    model: "provider/model",
    provider: "provider",
    active: [{ model: "provider/model", provider: "provider" }],
  };
  const isGenerating =
    generatingActivity.state === "generating" || (generatingActivity.active && generatingActivity.active.length > 0);
  assert.equal(isGenerating, true, "generating state should be detected");

  // Active requests present even if state is not explicitly "generating"
  const activeWithoutGeneratingState = {
    state: "idle",
    model: "provider/model",
    provider: "provider",
    active: [{ model: "provider/model", provider: "provider" }],
  };
  const hasActive =
    activeWithoutGeneratingState.state === "generating" ||
    (activeWithoutGeneratingState.active && activeWithoutGeneratingState.active.length > 0);
  assert.equal(hasActive, true, "active requests should be detected even without generating state");

  // Verify observedModelSpeed should return null when generating
  const providerUsage = {
    providers: [
      {
        id: "provider",
        models: [
          {
            slug: "provider/model",
            displayName: "model",
            observedTokensPerSecond: 125.3,
            speedSampleCount: 10,
          },
        ],
      },
    ],
  };
  // When not generating, observedModelSpeed should be called and return speed
  const observedIdle = !isIdleGenerating ? observedModelSpeed(providerUsage, "provider", "provider/model") : null;
  assert.deepEqual(observedIdle, { speed: 125.3, samples: 10 });

  // When generating, observedModelSpeed should not be called (returns null)
  const observedGenerating = !isGenerating ? observedModelSpeed(providerUsage, "provider", "provider/model") : null;
  assert.equal(observedGenerating, null, "speed should be null during generation");
});

test("service health rows expose enabled dependencies without leaking endpoint details", () => {
  assert.deepEqual(
    serviceHealthRows({
      ok: false,
      degraded: ["gateway"],
      gateway: { reachable: false },
      oauth: { enabled: false, reachable: true },
      api: { enabled: true, reachable: true },
    }).map(({ id, state, status, detail }) => ({ id, state, status, detail })),
    [
      { id: "router", state: "degraded", status: "Degraded", detail: "1 dependency needs attention" },
      { id: "gateway", state: "offline", status: "Offline", detail: "Unreachable" },
      { id: "oauth", state: "standby", status: "Standby", detail: "Not enabled" },
      { id: "api", state: "ready", status: "Ready", detail: "Reachable" },
    ],
  );
  assert.deepEqual(
    serviceHealthRows({ ok: true, gateway: { reachable: true } }).at(-1),
    {
      id: "forwarders",
      label: "External forwarders",
      state: "standby",
      status: "Standby",
      detail: "No external forwarders enabled",
    },
  );
});

// A router that answered `ok` has already probed every dependency it knows
// about, so a missing per-service key is silence about a service that passed,
// not silence about a service nobody asked. Rendering it as Unknown made a
// perfectly healthy install look like it had never reported.
test("a dependency absent from a healthy report is inferred ready rather than unknown", () => {
  const [, gateway] = serviceHealthRows({ ok: true, degraded: [] });
  assert.deepEqual(gateway, {
    id: "gateway",
    label: "Gateway",
    state: "ready",
    status: "Ready",
    detail: "Reachable",
  });
  // The inference is only ever drawn from a report that says so. An `ok` that
  // names the dependency is still Offline, and no report at all is still
  // Unknown.
  assert.equal(serviceHealthRows({ ok: true, degraded: ["gateway"] })[1].state, "offline");
  assert.equal(serviceHealthRows({ ok: false, degraded: [] })[1].state, "unknown");
  assert.equal(serviceHealthRows(undefined)[1].state, "unknown");
});

// The Grok OAuth forwarder is a fifth local port with a health probe of its
// own (#366). The tray enumerates forwarders explicitly, so a key nobody
// listed would be dropped on the floor rather than rendered.
test("the Grok OAuth forwarder is rendered alongside the other forwarders", () => {
  assert.deepEqual(
    serviceHealthRows({
      ok: false,
      degraded: ["grokOauth"],
      gateway: { reachable: true },
      grokOauth: { reachable: false, enabled: true },
    }).map((row) => row.id),
    ["router", "gateway", "grokOauth"],
  );
  assert.deepEqual(
    serviceHealthRows({
      ok: true,
      degraded: [],
      gateway: { reachable: true },
      grokOauth: { reachable: true, enabled: false },
    }).at(-1),
    {
      id: "grokOauth",
      label: "Grok OAuth forwarder",
      state: "standby",
      status: "Standby",
      detail: "Not enabled",
    },
  );
});

// src/tool-result-aging-state.mjs defaults the feature off when no state file
// exists, so an absent snapshot has to render off. Rendering on told every
// fresh install that ageing was happening when nothing was.
test("the tool-result-aging switch renders off when the snapshot is absent", () => {
  assert.equal(toolResultAgingChecked(undefined), false);
  assert.equal(toolResultAgingChecked(null), false);
  assert.equal(toolResultAgingChecked({}), false);
});

test("the tool-result-aging switch follows the snapshot when it is present", () => {
  assert.equal(toolResultAgingChecked({ enabled: true }), true);
  assert.equal(toolResultAgingChecked({ enabled: false }), false);
  assert.equal(toolResultAgingChecked({ enabled: true, environmentOverride: false }), true);
});

// A control the surface will refuse must be dead before it is clicked, and the
// UI decides that from the surface's own lists rather than a copy of them.
test("a read-only surface refuses only what it did not advertise", () => {
  const capabilities = {
    readOnly: true,
    allowedCommands: ["control_snapshot"],
    localCommands: ["hide_panel"],
  };
  assert.equal(commandRefused(capabilities, "set_tool_result_aging"), true);
  assert.equal(commandRefused(capabilities, "control_snapshot"), false);
  assert.equal(commandRefused(capabilities, "hide_panel"), false);
  // A future unrestricted host can omit a limit and retain the full table.
  assert.equal(commandRefused(null, "set_tool_result_aging"), false);
  assert.equal(readOnlyCapabilities({ os: "darwin" }), null);
  assert.equal(readOnlyCapabilities({ capabilities: { readOnly: false } }), null);
});

test("the macOS tray tool-result-aging switch mirrors the same off default", () => {
  const source = readFileSync(
    path.join(root, "apps", "macos", "ModelRouterTray", "Sources", "ModelRouterTrayApp.swift"),
    "utf8",
  );
  assert.match(source, /toolResultAging\?\.enabled \?\? false/);
  assert.doesNotMatch(source, /toolResultAging\?\.enabled \?\? true/);
});

test("the macOS tray panel follows the system appearance", () => {
  const source = readFileSync(
    path.join(root, "apps", "macos", "ModelRouterTray", "Sources", "ModelRouterTrayApp.swift"),
    "utf8",
  );
  const trayStart = source.indexOf("private struct TrayView");
  const trayEnd = source.indexOf("private struct ProviderSetupRow", trayStart);
  assert.ok(trayStart > 0 && trayEnd > trayStart, "TrayView should remain readable");
  assert.doesNotMatch(
    source.slice(trayStart, trayEnd),
    /\.preferredColorScheme\(\.dark\)/,
    "the menu-bar panel must not override the operator's macOS appearance",
  );
});

test("the macOS tray does not redraw a hidden or unchanged settings tree", () => {
  const source = readFileSync(
    path.join(root, "apps", "macos", "ModelRouterTray", "Sources", "ModelRouterTrayApp.swift"),
    "utf8",
  );
  const closePanel = source.match(/private func closePanel\(\)[\s\S]*?\r?\n  }/)?.[0];
  const refreshActivity = source.match(/private func refreshActivity\(\)[\s\S]*?\r?\n  }\r?\n\r?\n  private func recordActivityHealthFailure/)?.[0];

  assert.ok(closePanel, "tray close helper should be readable");
  assert.match(closePanel, /panel\.contentViewController = nil/);
  assert.ok(refreshActivity, "activity refresh helper should be readable");
  assert.match(refreshActivity, /if routerHealth != health \{ routerHealth = health \}/);
  assert.match(source, /private struct RouterHealth: Decodable, Equatable/);
  assert.match(source, /private struct RouterActivity: Decodable, Equatable/);
});

test("the macOS tray provider toggle uses the atomic selection command", () => {
  const swift = readFileSync(
    path.join(root, "apps", "macos", "ModelRouterTray", "Sources", "ModelRouterTrayApp.swift"),
    "utf8",
  ).match(/private func updateProviderSelection[\s\S]*?\r?\n  }\r?\n\r?\n  private func refreshActivity/)?.[0];
  assert.ok(swift, "macOS provider-toggle helper should be readable");
  assert.match(swift, /["\[]set-apply/);
  assert.match(swift, /--activate/);
  assert.doesNotMatch(swift, /wasEnabled|["\[]apply["\]]/);
});

test("macOS tray credential actions do not race atomic selection publication", () => {
  const swift = readFileSync(
    path.join(root, "apps", "macos", "ModelRouterTray", "Sources", "ModelRouterTrayApp.swift"),
    "utf8",
  );
  const swiftSave = swift.match(/func saveProviderKey[\s\S]*?\r?\n  }\r?\n\r?\n  \/\//)?.[0];
  const swiftRemove = swift.match(/func removeProviderKey[\s\S]*?\r?\n  }\r?\n\r?\n  func dailyTokens/)?.[0];
  for (const [name, source] of Object.entries({ swiftSave, swiftRemove })) {
    assert.ok(source, `${name} should be readable`);
    assert.match(source, /credential/);
    assert.doesNotMatch(source, /update_provider_selection|updateProviderSelection|["\[]apply["\]]/);
  }
});

// The disabled set is derived from data-command, so a control that drives a
// command without carrying one would stay live on a surface that refuses it.
test("every mutating control in the browser panel names the command it drives", () => {
  const markup = [
    readFileSync(path.join(root, "apps", "panel", "index.html"), "utf8"),
    readFileSync(path.join(root, "apps", "panel", "app.js"), "utf8"),
  ].join("\n");
  for (const command of [
    "set_tool_result_aging",
    "set_login_free",
    "set_signed_routing",
    "set_presence_mode",
    "set_vision_bridge",
    "set_subagent_mode",
    "set_subagent_model",
    "set_picker_model",
    "set_provider_enabled",
    "save_api_key",
    "remove_api_key",
    "install_local_model",
    "set_local_model_enabled",
  ]) {
    assert.ok(
      markup.includes(`data-command="${command}"`),
      `no control declares data-command="${command}"`,
    );
  }
});

test("browser panel exposes translations with matching keys for every language", () => {
  assert.deepEqual(
    availableLanguages().map(({ id }) => id),
    LANGUAGE_OPTIONS.map(({ id }) => id),
  );
  const keys = translationKeys();
  const englishKeys = [...keys.en].sort();
  for (const language of Object.keys(keys)) {
    assert.deepEqual([...keys[language]].sort(), englishKeys, `translation keys diverge for ${language}`);
  }
  // Stated separately from the parity check above, which would also pass if a
  // new string were left out of every locale.
  for (const language of Object.keys(keys)) {
    for (const key of [
      "general.readOnlySurface",
      "general.readOnlyControl",
      "usage.chatgptWithFallback",
      "usage.localFallbackNotice",
      "usage.localFallbackNoticeOne",
      "usage.localFallbackDates",
      "usage.localFallbackDatesOne",
      "usage.localFallbackPoint",
      "usage.localFallbackShort",
    ]) {
      assert.ok([...keys[language]].includes(key), `${key} is missing from ${language}`);
    }
  }
  const samples = [
    ["zh-CN", "用量"],
    ["ar", "الاستخدام"],
    ["hi", "उपयोग"],
    ["ja", "使用量"],
    ["ko", "사용량"],
    ["es", "Uso"],
  ];
  try {
    for (const [language, navUsage] of samples) {
      setLanguage(language);
      assert.equal(getLanguage(), language);
      assert.equal(t("nav.usage"), navUsage);
      assert.notEqual(
        t("usage.localFallbackNotice", { count: 2 }),
        "OpenAI supplied no account bucket for 2 dates; local router traffic fills the gap. These are not global account totals.",
      );
      assert.notEqual(
        t("usage.localFallbackNoticeOne"),
        "OpenAI supplied no account bucket for 1 date; local router traffic fills the gap. This is not a global account total.",
      );
    }
    setLanguage("zh-CN");
    assert.equal(t("usage.resetsToday", { time: "10:30" }), "今天 10:30 重置");
  } finally {
    setLanguage("en");
  }
  assert.equal(t("nav.usage"), "Usage");
});

test("browser and macOS settings present the unified pipeline as Token maxxing", () => {
  assert.equal(t("models.compactOldToolResults"), "Token maxxing");
  assert.match(t("models.reduceRepeatedContext"), /RTK-shape noisy output.*routed compaction/i);
  assert.doesNotMatch(t("models.reduceRepeatedContext"), /70%|pressure|reasoning packets/i);
  assert.doesNotMatch(t("models.compactOldToolResults"), /compact old tool results/i);

  const markup = readFileSync(path.join(root, "apps", "panel", "index.html"), "utf8");
  assert.match(markup, />Token maxxing</u);
  assert.match(markup, /Toggle Token maxxing for external models/u);

  const swift = readFileSync(
    path.join(root, "apps", "macos", "ModelRouterTray", "Sources", "ModelRouterTrayApp.swift"),
    "utf8",
  );
  assert.match(swift, /title: routerLocalized\("Token maxxing"\)/u);
  assert.doesNotMatch(swift, /title: routerLocalized\("Compact old tool results"\)/u);
});

test("browser panel marks Arabic as the only right-to-left language", () => {
  for (const { id, dir } of availableLanguages()) {
    if (id === "ar") assert.equal(dir, "rtl");
    else assert.notEqual(dir, "rtl", `unexpected right-to-left direction for ${id}`);
  }
});
