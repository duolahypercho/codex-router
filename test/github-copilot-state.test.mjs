import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  clearGitHubCopilotHost,
  normalizeGitHubCopilotHost,
  readGitHubCopilotSettings,
  setGitHubCopilotHost,
} from "../src/github-copilot-state.mjs";

test("Copilot host accepts public GitHub and one enterprise tenant label", () => {
  assert.equal(normalizeGitHubCopilotHost(" GITHUB.COM "), "github.com");
  assert.equal(normalizeGitHubCopilotHost(" Octocorp.ghe.com "), "octocorp.ghe.com");
  assert.equal(normalizeGitHubCopilotHost("a.ghe.com"), "a.ghe.com");
  for (const value of ["", null, "ghe.com", "api.octocorp.ghe.com", "octocorp.ghe.com.example", "git.example", "127.0.0.1", "https://octocorp.ghe.com", "octocorp.ghe.com:443", "-tenant.ghe.com", "tenant-.ghe.com", `${"a".repeat(64)}.ghe.com`, "tenant.ghe.com/path", "user@tenant.ghe.com"]) {
    assert.throws(() => normalizeGitHubCopilotHost(value), /Copilot host must be/);
  }
});

test("Copilot host state defaults only when absent and writes protected state", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "copilot-host-state-"));
  const options = { filePath: path.join(directory, "settings.json") };
  try {
    assert.deepEqual(readGitHubCopilotSettings(options), { host: "github.com", source: "default" });
    assert.deepEqual(setGitHubCopilotHost("octocorp.ghe.com", options), { host: "octocorp.ghe.com", source: "protected state" });
    assert.deepEqual(readGitHubCopilotSettings(options), { host: "octocorp.ghe.com", source: "protected state" });
    assert.deepEqual(JSON.parse(readFileSync(options.filePath, "utf8")), { version: 1, host: "octocorp.ghe.com" });
    if (process.platform !== "win32") assert.equal(statSync(options.filePath).mode & 0o777, 0o600);
    const before = readFileSync(options.filePath, "utf8");
    assert.throws(() => setGitHubCopilotHost("git.example", options));
    assert.equal(readFileSync(options.filePath, "utf8"), before);
    clearGitHubCopilotHost(options);
    assert.deepEqual(readGitHubCopilotSettings(options), { host: "github.com", source: "protected state" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Copilot damaged host state is preserved and never defaults to public GitHub", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "copilot-host-invalid-"));
  const options = { filePath: path.join(directory, "settings.json") };
  try {
    for (const value of ["{", "null", "[]", JSON.stringify({ version: 2, host: "octocorp.ghe.com" }), JSON.stringify({ version: 1, host: "git.example" }), JSON.stringify({ version: 1, host: "github.com", extra: true }), " ".repeat(4097)]) {
      writeFileSync(options.filePath, value);
      assert.throws(() => readGitHubCopilotSettings(options), /settings are invalid or unreadable/);
      assert.equal(readFileSync(options.filePath, "utf8"), value);
    }
    assert.throws(() => readGitHubCopilotSettings({ filePath: directory }), /settings are invalid or unreadable/);
    if (process.platform !== "win32") {
      const link = path.join(directory, "link.json");
      symlinkSync(options.filePath, link);
      assert.throws(() => readGitHubCopilotSettings({ filePath: link }), /settings are invalid or unreadable/);
    }
    clearGitHubCopilotHost(options);
    assert.equal(readGitHubCopilotSettings(options).host, "github.com");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
