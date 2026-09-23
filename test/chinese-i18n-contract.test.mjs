import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  LANGUAGE_OPTIONS, createTranslator, detectLanguage, messageCatalogs,
  resolveLanguage, storeLanguage, translate,
} from "../apps/control-center/src/i18n.ts";
import { effortLabel, formatContext, formatDateTime, metricValue } from "../apps/control-center/src/lib.ts";
import { backendText } from "../apps/control-center/src/backend-text.ts";
import { MESSAGES } from "../apps/panel/messages.mjs";
import { availableLanguages, getLanguage, resolveLanguage as resolvePanelLanguage, setLanguage, t as panelText } from "../apps/panel/i18n.mjs";
import { interfaceLanguageFromLocale, interfaceMenuTemplates } from "../apps/control-center/electron/interface-menu.mjs";

const tokens = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

for (const language of ["zh-CN", "zh-TW"]) {
  test(`${language} catalogs have exact English key and placeholder parity`, () => {
    for (const catalogs of [messageCatalogs, MESSAGES]) {
      assert.deepEqual(Object.keys(catalogs[language]).sort(), Object.keys(catalogs.en).sort());
      for (const [key, source] of Object.entries(catalogs.en)) {
        assert.ok(catalogs[language][key].trim(), `${language}:${key} is empty`);
        assert.deepEqual(tokens(catalogs[language][key]), tokens(source), `${language}:${key} changed named values`);
      }
    }
  });
  test(`${language} labels do not become submitted model or effort ids`, () => {
    const t = createTranslator(language);
    for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]) {
      assert.match(effortLabel(effort, t), new RegExp(` \\(${effort}\\)$`));
    }
    assert.equal(effortLabel("future-depth", t), "future-depth");
    assert.equal(effortLabel("constructor", t), "constructor");
    assert.match(effortLabel("default", t), /默认|預設/);
    assert.match(formatContext(undefined, t), /管理|管理/);
    assert.match(metricValue({ remainingPercent: 25 }, t), /25%/);
    assert.doesNotMatch(formatDateTime("2026-09-19T06:00:00Z", t), /Sep|AM|PM/);
    for (const source of ["vendor/raw-id", "401 invalid_api_key", "/Users/me/config.json", "constructor", "__proto__"]) {
      assert.equal(backendText(source, t), source);
    }
  });
}

test("page headings and reasoning controls retain their meaning in each locale", () => {
  const en = createTranslator("en"), cn = createTranslator("zh-CN"), tw = createTranslator("zh-TW");
  // These are UI contract expectations, not values read back from a catalog:
  // a settings column must not become the transient "Thinking" activity state.
  assert.equal(en("models.route.thinking"), "Reasoning effort");
  assert.equal(cn("models.route.thinking"), "推理强度");
  assert.equal(tw("models.route.thinking"), "推理強度");
  assert.equal(tw("harness.title"), "工具鏈");
  assert.equal(tw("context.title"), "Context 管理");
  for (const key of ["models.method.apiKey", "models.credential.apiKey"]) {
    assert.equal(cn(key), "API 密钥");
    assert.equal(tw(key), "API 金鑰");
  }
});

test("all UI surfaces distinguish script, region and persisted locale ids consistently", () => {
  const expected = new Map([
    ["zh", "zh-CN"], ["zh_CN", "zh-CN"], ["zh-SG", "zh-CN"],
    ["zh-Hans-TW", "zh-CN"], ["zh-Hans-HK", "zh-CN"],
    ["zh-Hant", "zh-TW"], ["zh-Hant-CN", "zh-TW"], ["zh-TW", "zh-TW"],
    ["ZH_hk", "zh-TW"], ["zh-MO", "zh-TW"],
    ["zh-x-hant", "zh-CN"], ["zh-x-TW", "zh-CN"], ["zh-Hant-x-hans", "zh-TW"],
    ["zh-u-rg-twzzzz", "zh-CN"], ["zh-Latn-TW", "en"], ["zh---CN", "en"], ["ja-JP", "ja"], ["fr-FR", "en"],
  ]);
  for (const [tag, language] of expected) {
    assert.equal(resolveLanguage(tag), language, tag);
    assert.equal(resolvePanelLanguage(tag), language, tag);
    // Locale IDs agree; unrelated menu languages still use English labels.
    assert.equal(interfaceLanguageFromLocale(tag), language, tag);
  }
  assert.deepEqual(availableLanguages().map((l) => l.id), LANGUAGE_OPTIONS.map((l) => l.id));
});

test("stored locale wins on a fresh launch, but denied writes cannot undo an explicit choice", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'zh-HK' } });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
      getItem: () => 'en', setItem: () => { throw new Error('denied'); }
    } });
    const cc = await import('./apps/control-center/src/i18n.ts');
    const panel = await import('./apps/panel/i18n.mjs');
    assert.equal(cc.detectLanguage(), 'en');
    assert.equal(panel.getLanguage(), 'en');
    cc.storeLanguage('zh-TW'); panel.setLanguage('zh-TW');
    assert.equal(cc.detectLanguage(), 'zh-TW'); assert.equal(panel.getLanguage(), 'zh-TW');
    cc.storeLanguage('__proto__'); assert.equal(cc.detectLanguage(), 'zh-TW');
  `], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("interpolation is single pass, own-property only, and preserves missing tokens", () => {
  const hostile = '<img src=x onerror=alert(1)>/{count}/vendor';
  assert.equal(translate("en", "common.refreshTitle", { title: hostile, count: 99 }), `Refresh ${hostile}`);
  assert.equal(translate("en", "common.refreshTitle", Object.create({ title: "not-own" })), "Refresh {title}");
  for (const key of ["constructor", "__proto__", "toString"]) assert.equal(translate("zh-TW", key), key);
  try {
    setLanguage("zh-TW");
    for (const key of ["constructor", "__proto__", "toString"]) assert.equal(panelText(key), key);
    const source = MESSAGES["zh-TW"]["connections.providerPlanNote"];
    assert.equal(panelText("connections.providerPlanNote", { note: hostile, count: 99 }), source.replace("{note}", hostile));
    assert.equal(panelText("connections.providerPlanNote", Object.create({ note: "not-own" })), source);
  } finally { setLanguage("en"); }
});

test("partial non-Chinese overlays preserve their own translations and fall back to English", () => {
  for (const { id } of LANGUAGE_OPTIONS.filter((l) => !["en", "zh-CN", "zh-TW"].includes(l.id))) {
    for (const [key, value] of Object.entries(messageCatalogs[id])) assert.equal(translate(id, key), value);
    assert.equal(translate(id, "backend.doctor.listedRoutes"), messageCatalogs.en["backend.doctor.listedRoutes"]);
    try {
      setLanguage(id);
      for (const [key, value] of Object.entries(MESSAGES[id])) assert.equal(panelText(key), value);
      const missing = Object.keys(MESSAGES.en).find((key) => !Object.hasOwn(MESSAGES[id], key));
      assert.ok(missing); assert.equal(panelText(missing), MESSAGES.en[missing]);
    } finally { setLanguage("en"); }
  }
});

test("Traditional native menus preserve every role, accelerator and action", () => {
  let opened = 0, quit = 0;
  const callbacks = { showWindow: () => opened++, quit: () => quit++ };
  const en = interfaceMenuTemplates("en", callbacks), tw = interfaceMenuTemplates("zh-TW", callbacks);
  assert.equal(tw.tray[0].label, "開啟控制中心");
  tw.tray[0].click(); tw.tray[2].click();
  assert.equal(opened, 1); assert.equal(quit, 1);
  const controls = (menu) => menu.application.flatMap((entry) => entry.submenu.map(({ label, ...item }) => item));
  assert.deepEqual(controls(tw), controls(en));
});

test("the read-only panel serves the new message module and never evaluates translations", () => {
  const server = readFileSync(new URL("../src/desktop-panel.mjs", import.meta.url), "utf8");
  assert.match(server, /\["\/panel\/messages\.mjs", \{ file: "messages\.mjs", type: "text\/javascript; charset=utf-8" \}\]/);
  const i18n = readFileSync(new URL("../apps/panel/i18n.mjs", import.meta.url), "utf8");
  assert.match(i18n, /element\.textContent = t\(element\.dataset\.i18n\)/);
  assert.doesNotMatch(i18n, /\.innerHTML\s*=|\beval\s*\(/);
});


test("ordinary Traditional Chinese labels do not retain untranslated English prose", () => {
  const t = createTranslator("zh-TW");
  assert.equal(t("settings.context.title"), "Token 精簡");
  assert.equal(t("harness.row.agent"), "代理程式");
  assert.equal(t("harness.row.agentCount", { count: 2 }), "代理程式 · 2");
  assert.equal(t("status.model.req", { count: 3 }), "3 次");
  try {
    setLanguage("zh-TW");
    assert.equal(panelText("connections.githubToken"), "GitHub 權杖");
    assert.equal(panelText("models.compactOldToolResults"), "Token 精簡");
  } finally { setLanguage("en"); }
});
