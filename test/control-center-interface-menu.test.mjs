import assert from "node:assert/strict";
import test from "node:test";
import { interfaceMenuTemplates, isInterfaceLanguage } from "../apps/control-center/electron/interface-menu.mjs";

test("Chinese native menus retain platform roles and action callbacks", () => {
  let opened = 0;
  let closed = 0;
  const callbacks = { showWindow: () => opened++, quit: () => closed++ };
  const zh = interfaceMenuTemplates("zh-CN", callbacks);
  const en = interfaceMenuTemplates("en", callbacks);
  assert.equal(zh.tray[0].label, "打开控制中心");
  assert.equal(en.tray[0].label, "Open Control Center");
  assert.equal(zh.application[2].label, "编辑");
  assert.equal(zh.application[2].submenu.find(item => item.role === "copy").label, "复制");
  for (const role of ["reload", "forceReload", "toggleDevTools", "close"]) {
    assert.ok(zh.application.some(item => item.submenu.some(entry => entry.role === role)), role);
  }
  zh.tray[0].click();
  zh.tray[2].click();
  assert.equal(opened, 1);
  assert.equal(closed, 1);
  assert.deepEqual(zh.application.flatMap(item => item.submenu.map(entry => entry.role)), en.application.flatMap(item => item.submenu.map(entry => entry.role)));
});

test("interface language validates bounded locale IDs", () => {
  for (const value of [null, {}, "../../zh-CN", "Chinese", ""]) assert.equal(isInterfaceLanguage(value), false);
  for (const value of ["en", "zh-CN", "ja"]) assert.equal(isInterfaceLanguage(value), true);
});

// New menu coverage is deliberately independent of an Electron installation.
// Actual packaged-app rendering remains a separate CI/desktop verification.
import { interfaceLanguageFromLocale, INTERFACE_LANGUAGES } from "../apps/control-center/electron/interface-locale.mjs";
import english from "../apps/control-center/electron/locales/interface-menu.en.mjs";
import simplified from "../apps/control-center/electron/locales/interface-menu.zh-CN.mjs";
import traditional from "../apps/control-center/electron/locales/interface-menu.zh-TW.mjs";

const aliases = [
  ["en-US", "en"], ["en-GB", "en"],
  ["zh", "zh-CN"], ["zh-CN", "zh-CN"], ["zh-SG", "zh-CN"],
  ["zh-Hans", "zh-CN"], ["zh-Hans-CN", "zh-CN"],
  ["zh-Hans-TW", "zh-CN"], ["zh-Hans-HK", "zh-CN"],
  ["zh-TW", "zh-TW"], ["zh_TW", "zh-TW"], ["zh-HK", "zh-TW"], ["zh-MO", "zh-TW"],
  ["zh-Hant", "zh-TW"], ["zh-Hant-TW", "zh-TW"],
  ["zh-Hant-CN", "zh-TW"], ["zh-Hant-SG", "zh-TW"],
  ["zH-hAnT-tW", "zh-TW"], [" zh-TW ", "zh-TW"],
  ["zh-Hant-TW-u-nu-hanidec", "zh-TW"],
  ["ar-SA", "ar"], ["hi-IN", "hi"], ["ja-JP", "ja"],
  ["ko-KR", "ko"], ["es-419", "es"],
  ["de-DE", "en"], ["zh-Latn", "en"], ["zh-Latn-TW", "en"],
];

for (const [locale, expected] of aliases) {
  test(`system locale ${JSON.stringify(locale)} resolves to ${expected}`, () => {
    assert.equal(interfaceLanguageFromLocale(locale), expected);
  });
}

const invalid = [
  undefined, null, 0, 123, {}, [], new String("zh-TW"), Symbol("zh-TW"),
  "", " ", "../zh-TW", "zh-", "zh-CN<script>", "x".repeat(129),
];
for (const [index, value] of invalid.entries()) {
  test(`invalid system locale ${index} safely falls back to English`, () => {
    assert.equal(interfaceLanguageFromLocale(value), "en");
  });
}

test("only canonical preference IDs cross the renderer IPC boundary", () => {
  for (const value of INTERFACE_LANGUAGES) assert.equal(isInterfaceLanguage(value), true, value);
  for (const value of [...invalid, "zh-Hant", "zh-Hant-TW", "zh-tw", "en-US", "zh-TW ", "constructor", "__proto__"]) {
    assert.equal(isInterfaceLanguage(value), false);
  }
  assert.equal(isInterfaceLanguage("zh-TW"), true);
  assert.ok(Object.isFrozen(INTERFACE_LANGUAGES));
});

for (const [locale, messages] of [["en", english], ["zh-CN", simplified], ["zh-TW", traditional]]) {
  test(`${locale} menu dictionary has every semantic key, nonempty values and no extra keys`, () => {
    assert.deepEqual(Object.keys(messages).sort(), Object.keys(english).sort());
    assert.equal(Object.keys(messages).length, 29);
    assert.ok(Object.isFrozen(messages));
    for (const [key, value] of Object.entries(messages)) {
      assert.equal(typeof value, "string", key);
      assert.ok(value.trim(), key);
      assert.doesNotMatch(value, /[\u0000-\u001f\u007f]/, key);
      assert.doesNotMatch(value, /\{\w+\}/, key);
    }
    // Brand spelling is deliberately not converted or translated.
    for (const key of ["app.about", "app.hide", "app.quit"]) assert.match(messages[key], /Codex Router/);
  });
}

function structureWithoutLabels(value) {
  if (Array.isArray(value)) return value.map(structureWithoutLabels);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "label")
    .map(([key, child]) => [key, structureWithoutLabels(child)]));
}

for (const locale of INTERFACE_LANGUAGES) {
  test(`${locale} keeps English native roles, separators, order and callback identity`, () => {
    const actions = { showWindow() {}, quit() {} };
    const base = interfaceMenuTemplates("en", actions);
    const translated = interfaceMenuTemplates(locale, actions);
    assert.deepEqual(structureWithoutLabels(translated), structureWithoutLabels(base));
    assert.equal(translated.tray[0].click, actions.showWindow);
    assert.equal(translated.tray[2].click, actions.quit);
    assert.equal(translated.application[4].submenu.find((item) => item.click)?.click, actions.showWindow);
    assert.equal(translated.application[0].label, "Codex Router");
  });
}

test("Traditional Chinese uses its own terminology in tray and application menus", () => {
  const menu = interfaceMenuTemplates("zh-TW", { showWindow() {}, quit() {} });
  assert.equal(menu.tray[0].label, "開啟控制中心");
  assert.equal(menu.tray[2].label, "結束 Codex Router");
  assert.equal(menu.application[1].label, "檔案");
  assert.equal(menu.application[4].label, "視窗");
  const edit = menu.application[2].submenu;
  assert.equal(edit.find((item) => item.role === "undo").label, "還原");
  assert.equal(edit.find((item) => item.role === "cut").label, "剪下");
  assert.equal(edit.find((item) => item.role === "copy").label, "複製");
  assert.equal(edit.find((item) => item.role === "paste").label, "貼上");
});

test("other locales and malformed menu input retain the previous English fallback", () => {
  const actions = { showWindow() {}, quit() {} };
  const base = interfaceMenuTemplates("en", actions);
  for (const locale of ["ar", "hi", "ja", "ko", "es", "de", ...invalid]) {
    assert.deepEqual(interfaceMenuTemplates(locale, actions), base);
  }
});

test("building another language does not mutate prior menus or dictionaries", () => {
  const actions = { showWindow() {}, quit() {} };
  const first = interfaceMenuTemplates("zh-TW", actions);
  const serialized = JSON.stringify(first);
  const second = interfaceMenuTemplates("zh-CN", actions);
  second.tray[0].label = "changed only in this menu";
  second.application[0].submenu[0].role = "changed only in this menu";
  assert.equal(JSON.stringify(first), serialized);
  assert.equal(interfaceMenuTemplates("zh-CN", actions).tray[0].label, "打开控制中心");
  assert.equal(interfaceMenuTemplates("zh-TW", actions).tray[0].label, "開啟控制中心");
});
