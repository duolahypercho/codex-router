import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildQuotaCards,
  chartGeometry,
  commandRefused,
  compactTokens,
  dailySeries,
  metricRemainingPercent,
  observedModelSpeed,
  quotaWindow,
  readOnlyCapabilities,
  serviceHealthRows,
  toolResultAgingChecked,
  visibleLocalDownload,
} from "../apps/desktop/ui/model.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
import { availableLanguages, getLanguage, setLanguage, t, translationKeys } from "../apps/desktop/ui/i18n.mjs";

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
  // A shell that advertises no limit carries the full table and refuses
  // nothing, which is how the tray and the Electron window stay unaffected.
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

test("native tray provider toggles use the atomic selection command", () => {
  const rust = readFileSync(
    path.join(root, "apps", "desktop", "src-tauri", "src", "main.rs"),
    "utf8",
  ).match(/fn update_provider_selection\([\s\S]*?\r?\n}\r?\n\r?\nfn run_control_json/)?.[0];
  const swift = readFileSync(
    path.join(root, "apps", "macos", "ModelRouterTray", "Sources", "ModelRouterTrayApp.swift"),
    "utf8",
  ).match(/private func updateProviderSelection[\s\S]*?\r?\n  }\r?\n\r?\n  private func refreshActivity/)?.[0];
  assert.ok(rust, "Tauri provider-toggle helper should be readable");
  assert.ok(swift, "macOS provider-toggle helper should be readable");
  for (const source of [rust, swift]) {
    assert.match(source, /["\[]set-apply/);
    assert.match(source, /--activate/);
    assert.doesNotMatch(source, /was_enabled|wasEnabled|["\[]apply["\]]/);
  }
});

test("native credential actions do not race atomic selection publication", () => {
  const rust = readFileSync(
    path.join(root, "apps", "desktop", "src-tauri", "src", "main.rs"),
    "utf8",
  );
  const swift = readFileSync(
    path.join(root, "apps", "macos", "ModelRouterTray", "Sources", "ModelRouterTrayApp.swift"),
    "utf8",
  );
  const rustSave = rust.match(/async fn save_api_key[\s\S]*?\r?\n}\r?\n\r?\n\/\//)?.[0];
  const rustRemove = rust.match(/async fn remove_api_key[\s\S]*?\r?\n}\r?\n\r?\n#\[tauri::command\]/)?.[0];
  const swiftSave = swift.match(/func saveProviderKey[\s\S]*?\r?\n  }\r?\n\r?\n  \/\//)?.[0];
  const swiftRemove = swift.match(/func removeProviderKey[\s\S]*?\r?\n  }\r?\n\r?\n  func dailyTokens/)?.[0];
  for (const [name, source] of Object.entries({ rustSave, rustRemove, swiftSave, swiftRemove })) {
    assert.ok(source, `${name} should be readable`);
    assert.match(source, /credential/);
    assert.doesNotMatch(source, /update_provider_selection|updateProviderSelection|["\[]apply["\]]/);
  }
});

test("desktop keeps invalid router-managed OAuth sessions removable", () => {
  const source = readFileSync(
    path.join(root, "apps", "desktop", "ui", "app.js"),
    "utf8",
  );
  assert.match(
    source,
    /const canRemove = \(provider\.kind === "api" && provider\.configured\) \|\| provider\.disconnectable;/,
  );
  assert.doesNotMatch(source, /provider\.configured && \([^\n]*provider\.disconnectable/);
});

// The disabled set is derived from data-command, so a control that drives a
// command without carrying one would stay live on a surface that refuses it.
test("every mutating control in the desktop UI names the command it drives", () => {
  const markup = [
    readFileSync(path.join(root, "apps", "desktop", "ui", "index.html"), "utf8"),
    readFileSync(path.join(root, "apps", "desktop", "ui", "app.js"), "utf8"),
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

test("desktop UI exposes translations with matching keys for every language", () => {
  assert.deepEqual(
    availableLanguages().map(({ id }) => id),
    ["en", "zh-CN", "ar", "hi", "ja", "ko"],
  );
  const keys = translationKeys();
  const englishKeys = [...keys.en].sort();
  for (const language of Object.keys(keys)) {
    assert.deepEqual([...keys[language]].sort(), englishKeys, `translation keys diverge for ${language}`);
  }
  // Stated separately from the parity check above, which would also pass if a
  // new string were left out of all six.
  for (const language of Object.keys(keys)) {
    for (const key of ["general.readOnlySurface", "general.readOnlyControl"]) {
      assert.ok([...keys[language]].includes(key), `${key} is missing from ${language}`);
    }
  }
  const samples = [
    ["zh-CN", "用量"],
    ["ar", "الاستخدام"],
    ["hi", "उपयोग"],
    ["ja", "使用量"],
    ["ko", "사용량"],
  ];
  try {
    for (const [language, navUsage] of samples) {
      setLanguage(language);
      assert.equal(getLanguage(), language);
      assert.equal(t("nav.usage"), navUsage);
    }
    setLanguage("zh-CN");
    assert.equal(t("usage.resetsToday", { time: "10:30" }), "今天 10:30 重置");
  } finally {
    setLanguage("en");
  }
  assert.equal(t("nav.usage"), "Usage");
});

test("desktop UI marks Arabic as the only right-to-left language", () => {
  for (const { id, dir } of availableLanguages()) {
    if (id === "ar") assert.equal(dir, "rtl");
    else assert.notEqual(dir, "rtl", `unexpected right-to-left direction for ${id}`);
  }
});
