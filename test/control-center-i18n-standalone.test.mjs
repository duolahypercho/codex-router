import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Root CI installs only root dependencies. A developer's existing renderer
// node_modules must not hide an accidental React dependency in the engine.
// Copy the actual shipped modules, not a rewritten or mocked version of them.
test("the translation engine and backend formatters run without renderer dependencies", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "router-i18n-standalone-"));
  try {
    writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
    const source = new URL("../apps/control-center/src/", import.meta.url);
    for (const file of ["i18n.ts", "lib.ts", "backend-text.ts", "backend-messages.ts", "ui-text.ts", "locales"]) {
      cpSync(new URL(file, source), path.join(root, file), { recursive: true });
    }
    writeFileSync(path.join(root, "verify.mjs"), `
      import assert from "node:assert/strict";
      import { createTranslator } from "./i18n.ts";
      import { effortLabel, formatContext } from "./lib.ts";
      import { backendText } from "./backend-text.ts";
      import { uiText } from "./ui-text.ts";
      for (const [language, expected] of [["en", "Settings"], ["zh-CN", "设置"], ["zh-TW", "設定"]]) {
        const t = createTranslator(language);
        assert.equal(t("nav.settings"), expected);
        assert.equal(effortLabel("future-depth", t), "future-depth");
        assert.ok(formatContext(8192, t).length > 0);
        assert.equal(backendText("vendor/raw-model", t), "vendor/raw-model");
        assert.equal(uiText("/tmp/{name}", { name: "file.txt" }, language), "/tmp/file.txt");
      }
    `);
    const result = spawnSync(process.execPath, [path.join(root, "verify.mjs")], {
      cwd: root,
      encoding: "utf8",
      timeout: 15_000,
      env: { ...process.env, NODE_PATH: "" },
    });
    assert.equal(result.status, 0, result.stderr || String(result.error || "translation subprocess failed"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
