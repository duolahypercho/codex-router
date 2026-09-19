import assert from "node:assert/strict";
import test from "node:test";
import { backendText } from "../apps/control-center/src/backend-text.ts";
import { storeLanguage } from "../apps/control-center/src/i18n.ts";
import { backendTemplatesZh, backendZh } from "../apps/control-center/src/locales/backend.zh.ts";

function inChinese(assertions) {
  try {
    storeLanguage("zh-CN");
    assertions();
  } finally {
    storeLanguage("en");
  }
}

test("backend copy is shown in Chinese while the interface language is Chinese", () => {
  inChinese(() => {
    assert.equal(backendText("Downloading Cloudflare connector…"), "正在下载 Cloudflare 连接器…");
    assert.equal(
      backendText("Publishes the shared router catalog into Codex."),
      "把共享的路由目录发布到 Codex。",
    );
    assert.equal(
      backendText("A live compatibility test is required before enabling this route; it sends a small prompt and uses provider quota."),
      "启用此路由前需要做一次实测兼容性检查；它会发送一个小请求并消耗服务商配额。",
    );
    assert.equal(
      backendText("Reads codes, numbers, and dates exactly. The default choice."),
      "能准确读取代码、数字和日期。默认选择。",
    );
    assert.equal(
      backendText("The curated MLX build requires macOS on Apple silicon (arm64)."),
      "精选 MLX 版本需要 Apple 芯片（arm64）上的 macOS。",
    );
  });
});

test("backend templates localize only the wording around the backend's own value", () => {
  inChinese(() => {
    assert.equal(backendText("Official Ollama · 49 tags"), "官方 Ollama · 49 个 tag");
    assert.equal(backendText("Unsloth GGUF · 7 local quants"), "Unsloth GGUF · 7 个本地量化版本");
    assert.equal(
      backendText("Using cursor-router.example.com for Cursor's private connector."),
      "正在将 cursor-router.example.com 用于 Cursor 的私有连接器。",
    );
    assert.equal(
      backendText("Removing the routed catalog from Gemini CLI…"),
      "正在从 Gemini CLI 移除已路由目录…",
    );
    // The command itself stays exactly as the router would print it.
    assert.equal(backendText("Run ./bin/control provider-key zai set"), "运行 ./bin/control provider-key zai set");
  });
});

test("unknown, raw, and inherited-looking backend strings pass through untouched", () => {
  inChinese(() => {
    // A provider error, a path, a status id and an unmapped sentence are the
    // backend's own wording; translating them would misreport diagnostics.
    assert.equal(
      backendText("401 invalid_api_key: your key was rejected by the upstream provider"),
      "401 invalid_api_key: your key was rejected by the upstream provider",
    );
    assert.equal(backendText("/Users/operator/.ollama/models"), "/Users/operator/.ollama/models");
    assert.equal(backendText("collecting-manifest-layers"), "collecting-manifest-layers");
    assert.equal(backendText("A backend sentence nobody has mapped yet."), "A backend sentence nobody has mapped yet.");
    // Object-literal lookups must not reach Object.prototype values.
    assert.equal(backendText("constructor"), "constructor");
    assert.equal(backendText("__proto__"), "__proto__");
    assert.equal(backendText("toString"), "toString");
    // Absent values are empty strings, never "undefined".
    assert.equal(backendText(undefined), "");
    assert.equal(backendText(null), "");
    assert.equal(backendText(""), "");
  });
});

test("English keeps every backend string exactly as it arrived", () => {
  storeLanguage("en");
  try {
    for (const source of [
      "Downloading Cloudflare connector…",
      "Official Ollama · 49 tags",
      "constructor",
      "Publishes every routed model into pi's models.json. Every other provider in that file is preserved.",
    ]) {
      assert.equal(backendText(source), source, source);
    }
  } finally {
    storeLanguage("en");
  }
});

test("backend dictionaries keep every template and translation shaped like its source", () => {
  const tokens = (value) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  for (const [source, translation] of Object.entries(backendZh)) {
    assert.ok(translation.trim(), `empty translation: ${source}`);
    assert.deepEqual(tokens(translation), tokens(source), `interpolation drift: ${source}`);
    // A translation that is identical to its source would only hide the English
    // string behind a dictionary entry.
    assert.notEqual(translation, source, `untranslated entry: ${source}`);
  }
  // A template only ever receives the capture groups its own pattern matched,
  // so it must account for exactly those placeholders.
  for (const { pattern, template } of backendTemplatesZh) {
    const named = [...pattern.source.matchAll(/\(\?<(\w+)>/g)].map((match) => match[1]).sort();
    assert.ok(named.length, `template pattern captures nothing: ${pattern}`);
    assert.deepEqual(tokens(template), named, `template placeholders drift from its pattern: ${template}`);
    assert.notEqual(template, pattern.source, `template is not translated: ${template}`);
  }
});
