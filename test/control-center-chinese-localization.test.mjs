import assert from "node:assert/strict";
import test from "node:test";
import { uiText, effortLabel } from "../apps/control-center/src/ui-text.ts";
import { storeLanguage, detectLanguage } from "../apps/control-center/src/i18n.ts";
import { formatDateTime, metricValue } from "../apps/control-center/src/lib.ts";
import { serviceHealthRows } from "../apps/control-center/src/service-health.ts";
import { messageCatalogs } from "../apps/control-center/src/i18n.ts";

test("Chinese translation templates preserve every interpolation", () => {
  const tokens = value => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
  for (const language of ["zh-CN", "zh-TW"]) {
    const dictionary = messageCatalogs[language];
    assert.deepEqual(Object.keys(dictionary).sort(), Object.keys(messageCatalogs.en).sort());
    for (const [key, translation] of Object.entries(dictionary)) {
      const source = messageCatalogs.en[key];
      assert.ok(translation.trim(), `empty translation: ${source}`);
      assert.deepEqual(tokens(translation), tokens(source), `interpolation drift: ${source}`);
    }
  }
});

test("Chinese text changes presentation without rewriting technical values", () => {
  assert.equal(uiText("Refresh", {}, "zh-CN"), "刷新");
  assert.equal(uiText("Refresh", {}, "en"), "Refresh");
  assert.equal(uiText("Refresh", {}, "ja"), "Refresh", "new source strings keep English fallback for other locales");
  assert.equal(uiText("{label} completed.", { label: "opencode-go/deepseek-v4.1-flash" }, "zh-CN"), "已完成：opencode-go/deepseek-v4.1-flash。");
  for (const source of ["unlisted/provider-id", "constructor", "__proto__"]) {
    assert.equal(uiText(source, {}, "zh-CN"), source);
  }
});

test("language switch updates helpers and health status even without browser storage", () => {
  try {
    storeLanguage("zh-CN");
    assert.equal(detectLanguage(), "zh-CN");
    assert.equal(effortLabel("max"), "最高 (max)");
    assert.equal(serviceHealthRows({ ok: true })[0].status, "就绪");
    assert.equal(metricValue({ remainingPercent: 25 }), "剩余 25%");
    assert.doesNotMatch(formatDateTime("2026-09-19T06:00:00Z"), /Sep|AM|PM/);
    storeLanguage("en");
    assert.equal(effortLabel("max"), "max");
    assert.equal(serviceHealthRows({ ok: true })[0].status, "Ready");
    assert.equal(metricValue({ remainingPercent: 25 }), "25% left");
  } finally {
    storeLanguage("en");
  }
});
