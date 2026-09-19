import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { setLanguage, t, translationKeys } from "../apps/panel/i18n.mjs";
import {
  activityStateLabel,
  buildQuotaCards,
  localizedEffortLabel,
  quotaMetricLabel,
  quotaWindow,
} from "../apps/panel/model.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const panelDir = path.join(root, "apps", "panel");

// A Simplified Chinese string may stay in Latin script only when it is a
// brand, a unit, or router-owned copy the panel must not rewrite.
const LATIN_SCRIPT_ALLOWED = new Set([
  "status.noSpeed", // "— tok/s" is a unit, not prose.
  "usage.tok", // A compact column unit beside an already localized number.
  "connections.oauth", // The protocol name is spelled the same in Chinese.
  "connections.providerPlanNote", // {note} is router-owned provider copy.
]);

const PANEL_FILES = ["index.html", "app.js", "model.mjs"];

function readPanelFile(name) {
  return readFileSync(path.join(panelDir, name), "utf8");
}

// Every string the panel renders: data-i18n* attributes, direct t("literal")
// calls, and keys reached through a lookup table instead of a literal.
function panelTranslationKeys(sources = PANEL_FILES.map(readPanelFile)) {
  const keys = new Set();
  for (const source of sources) {
    for (const match of source.matchAll(/data-i18n(?:-aria-label|-placeholder|-title)?="([^"]+)"/g)) {
      keys.add(match[1]);
    }
    for (const match of source.matchAll(/\bt\(\s*"([^"]+)"/g)) {
      keys.add(match[1]);
    }
    for (const match of source.matchAll(
      /"((?:status|usage|actions|connections|models|footer|island|general|health|nav|effort)\.[A-Za-z0-9]+)"/g,
    )) {
      keys.add(match[1]);
    }
  }
  return [...keys].sort();
}

function stringsFor(language, keys) {
  setLanguage(language);
  return Object.fromEntries(keys.map((key) => [key, t(key)]));
}

// The range label is assembled from the selected range and the active
// language, so app.js writes it instead of data-i18n. Everything else in the
// document must be reachable from applyTranslations.
const DYNAMIC_TEXT_ALLOWLIST = new Set(["7 days"]);

function untranslatedMarkup(markup) {
  const findings = [];
  const stack = [];
  const tagPattern = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  const stripped = markup
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!doctype[^>]*>/gi, "");
  let cursor = 0;
  let match;
  while ((match = tagPattern.exec(stripped))) {
    const between = stripped.slice(cursor, match.index).replace(/\s+/g, " ").trim();
    cursor = tagPattern.lastIndex;
    const parent = stack.at(-1);
    if (/[A-Za-z]{2}/.test(between) && !parent?.localized && !DYNAMIC_TEXT_ALLOWLIST.has(between)) {
      findings.push(`text "${between}" inside <${parent?.name ?? "document"}>`);
    }
    if (match[0].startsWith("</")) {
      stack.pop();
      continue;
    }
    const attributes = match[2] || "";
    for (const attribute of ["aria-label", "placeholder", "title"]) {
      const value = attributes.match(new RegExp(`\\b${attribute}\\s*=\\s*"([^"]*)"`))?.[1];
      if (value && /[A-Za-z]{2}/.test(value) && !attributes.includes(`data-i18n-${attribute}`)) {
        findings.push(`${attribute}="${value}" on <${match[1]}>`);
      }
    }
    const selfClosing = /\/>$/.test(match[0]) || /^(input|br|img|meta|link|hr)$/i.test(match[1]);
    if (!selfClosing) stack.push({ name: match[1], localized: attributes.includes("data-i18n") });
  }
  return findings;
}

const PANEL_KEYS = panelTranslationKeys();

test("every browser panel string is defined for every language", () => {
  const keys = translationKeys();
  assert.ok(PANEL_KEYS.length > 200, `the panel key scan found only ${PANEL_KEYS.length} strings`);
  for (const [language, list] of Object.entries(keys)) {
    const defined = new Set(list);
    for (const key of PANEL_KEYS) {
      assert.ok(defined.has(key), `${key} is missing from ${language}`);
    }
  }
});

test("the Simplified Chinese panel does not fall back to English", () => {
  try {
    const english = stringsFor("en", PANEL_KEYS);
    const chinese = stringsFor("zh-CN", PANEL_KEYS);
    const untranslated = PANEL_KEYS.filter(
      (key) => chinese[key] === english[key] && !LATIN_SCRIPT_ALLOWED.has(key),
    );
    assert.deepEqual(
      untranslated,
      [],
      `these panel strings are still English in zh-CN: ${untranslated.join(", ")}`,
    );
  } finally {
    setLanguage("en");
  }
});

test("the browser panel markup carries no untranslated English text", () => {
  const findings = untranslatedMarkup(readPanelFile("index.html"));
  assert.deepEqual(
    findings,
    [],
    `wrap each of these in data-i18n* so applyTranslations covers it: ${findings.join(" | ")}`,
  );
});

test("router activity states render in the active language without losing the raw token", () => {
  try {
    setLanguage("en");
    assert.equal(activityStateLabel("generating"), "Thinking");
    assert.equal(activityStateLabel("offline"), "Offline");
    assert.equal(activityStateLabel("", "status.active"), "active");
    assert.equal(activityStateLabel("reticulating"), "reticulating");

    setLanguage("zh-CN");
    assert.equal(activityStateLabel("generating"), "思考中");
    assert.equal(activityStateLabel("starting"), "启动中");
    assert.equal(activityStateLabel("error"), "错误");
    assert.equal(activityStateLabel("", "status.active"), "进行中");
    // The live-request summary is the composition app.js renders, so the raw
    // router state token can no longer leak into the Chinese sentence.
    assert.equal(
      t("status.inFlight", {
        count: 2,
        request: t("status.requests"),
        state: activityStateLabel("generating"),
      }),
      "2 个请求进行中 · 思考中",
    );
    // A token the panel has never seen stays itself rather than being
    // relabelled as a state the router did not report.
    assert.equal(activityStateLabel("reticulating"), "reticulating");
  } finally {
    setLanguage("en");
  }
});

test("vision effort labels are translated while the wire value keeps the level name", () => {
  const appJs = readPanelFile("app.js");
  // The option's value is what the router stores, so it stays the level name.
  assert.ok(
    appJs.includes('<option value="${escapeHtml(effort)}"'),
    "the vision effort option no longer carries the raw level as its value",
  );
  try {
    setLanguage("en");
    assert.equal(localizedEffortLabel("max"), "max");
    setLanguage("zh-CN");
    assert.equal(localizedEffortLabel("max"), "最高 (max)");
    assert.equal(localizedEffortLabel("xhigh"), "很高 (xhigh)");
    assert.equal(localizedEffortLabel("ultra"), "极高 (ultra)");
    assert.equal(localizedEffortLabel("default"), "default");
    for (const unknown of ["constructor", "__proto__"]) {
      assert.equal(localizedEffortLabel(unknown), unknown);
      assert.equal(activityStateLabel(unknown), unknown);
    }
    setLanguage("es");
    assert.equal(localizedEffortLabel("low"), "Bajo (low)");
  } finally {
    setLanguage("en");
  }
});

test("provider quota labels are translated and unrecognized ones pass through", () => {
  try {
    setLanguage("zh-CN");
    assert.deepEqual(quotaWindow({ label: "Rolling limit", usedPercent: 25 }), {
      key: "rolling",
      label: "滚动限额",
    });
    assert.deepEqual(quotaWindow({ label: "Rolling window", usedPercent: 25 }), {
      key: "rolling",
      label: "滚动周期",
    });
    assert.equal(quotaMetricLabel("Weekly limit"), "每周限制");
    assert.equal(quotaMetricLabel("Monthly credits"), "每月额度");
    assert.equal(quotaMetricLabel("DIEM balance"), "DIEM 余额");
    assert.equal(quotaMetricLabel("Daily DIEM allowance"), "每日 DIEM 额度");
    assert.equal(quotaMetricLabel("Current window"), "当前窗口");
    assert.equal(quotaMetricLabel("12-hour limit"), "12 小时限制");
    assert.equal(quotaMetricLabel("4-week limit"), "4 周限制");
    assert.equal(quotaMetricLabel("Partner window"), "Partner window");
    assert.equal(t("models.toolAgingSavings", {tokens:"2k",mb:"1.5",requests:3}), "节省约 2k token（1.5 MB），共 3 个请求 · ");

    // Translation preserves the existing policy of omitting unknown windows.
    const cards = buildQuotaCards({
      providerSetup: { providers: [{ id: "opencode-go", configured: true }] },
      providerUsage: {
        providers: [
          {
            id: "opencode-go",
            displayName: "OpenCode Go",
            account: {
              metrics: [
                { kind: "quota", label: "Rolling limit", usedPercent: 25 },
                { kind: "quota", label: "Partner window", usedPercent: 50, resetsAt: 1_800_000_000 },
              ],
            },
          },
        ],
      },
    });
    assert.deepEqual(
      cards.map(({ label, window }) => ({ label, window })),
      [
        { label: "滚动限额", window: "rolling" },
      ],
    );

    setLanguage("en");
    assert.equal(quotaMetricLabel("Rolling limit"), "Rolling limit");
    assert.equal(quotaMetricLabel("Partner window"), "Partner window");
  } finally {
    setLanguage("en");
  }
});
