import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  KIMI_REGION_PROFILES,
  kimiCodeHome,
  resolveKimiCodeEnvironment,
} from "../src/kimi-region.mjs";

function withHome(run) {
  const home = mkdtempSync(path.join(os.tmpdir(), "kimi-region-"));
  try {
    return run(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function writeConfig(home, { baseUrl, key, oauthHost }) {
  const lines = ['default_model = "kimi-code/k3"', "", '[providers."managed:kimi-code"]', 'type = "kimi"'];
  if (baseUrl) lines.push(`base_url = "${baseUrl}"`);
  lines.push('api_key = ""', "", '[providers."managed:kimi-code".oauth]', 'storage = "file"');
  if (key) lines.push(`key = "${key}"`);
  if (oauthHost) lines.push(`oauth_host = "${oauthHost}"`);
  lines.push("", '[models."kimi-code/k3"]', 'provider = "managed:kimi-code"', 'model = "k3"', "");
  writeFileSync(path.join(home, "config.toml"), lines.join("\n"));
}

function scopedKey(ssoHost, baseUrl) {
  const digest = createHash("sha256")
    .update(JSON.stringify({ oauthHost: ssoHost, baseUrl }))
    .digest("hex")
    .slice(0, 16);
  return `oauth/kimi-code-env-${digest}`;
}

test("kimiCodeHome honours KIMI_CODE_HOME and defaults to ~/.kimi-code", () => {
  assert.equal(kimiCodeHome({ KIMI_CODE_HOME: "/tmp/elsewhere" }), "/tmp/elsewhere");
  assert.equal(kimiCodeHome({}), path.join(os.homedir(), ".kimi-code"));
});

test("a fresh install with no config resolves to mainland China and kimi-code.json", () => {
  withHome((home) => {
    const resolved = resolveKimiCodeEnvironment({ KIMI_CODE_HOME: home });
    assert.equal(resolved.region, "mainland-cn");
    assert.equal(resolved.oauthHost, "https://auth.kimi.com");
    assert.equal(resolved.apiBase, "https://api.kimi.com/coding/v1");
    assert.equal(resolved.credentialsPath, path.join(home, "credentials", "kimi-code.json"));
  });
});

test("a global (kimi.ai) login recorded by the official CLI is followed (#819)", () => {
  withHome((home) => {
    const { ssoHost, apiBase } = KIMI_REGION_PROFILES.global;
    const key = scopedKey(ssoHost, apiBase);
    writeConfig(home, { baseUrl: apiBase, key, oauthHost: ssoHost });
    const resolved = resolveKimiCodeEnvironment({ KIMI_CODE_HOME: home });
    assert.equal(resolved.region, "global");
    assert.equal(resolved.oauthHost, "https://auth.kimi.ai");
    assert.equal(resolved.apiBase, "https://api.kimi.ai/coding/v1");
    assert.equal(resolved.siteBase, "https://www.kimi.ai");
    assert.equal(
      resolved.credentialsPath,
      path.join(home, "credentials", `${key.slice("oauth/".length)}.json`),
    );
  });
});

test("a mainland login pinned with the default key stays on kimi.com despite a global marker", () => {
  withHome((home) => {
    writeConfig(home, { baseUrl: "https://api.kimi.com/coding/v1", key: "oauth/kimi-code" });
    writeFileSync(path.join(home, "region"), "global\n");
    const resolved = resolveKimiCodeEnvironment({ KIMI_CODE_HOME: home });
    assert.equal(resolved.region, "mainland-cn");
    assert.equal(resolved.credentialsPath, path.join(home, "credentials", "kimi-code.json"));
  });
});

test("the install-channel region marker decides when nothing is persisted yet", () => {
  withHome((home) => {
    writeFileSync(path.join(home, "region"), "global\n");
    const resolved = resolveKimiCodeEnvironment({ KIMI_CODE_HOME: home });
    assert.equal(resolved.region, "global");
    assert.equal(resolved.apiBase, "https://api.kimi.ai/coding/v1");
    writeFileSync(path.join(home, "region"), "mars\n");
    assert.equal(resolveKimiCodeEnvironment({ KIMI_CODE_HOME: home }).region, "mainland-cn");
  });
});

test("environment overrides redirect requests without moving the credential slot", () => {
  withHome((home) => {
    const { ssoHost, apiBase } = KIMI_REGION_PROFILES.global;
    const key = scopedKey(ssoHost, apiBase);
    writeConfig(home, { baseUrl: apiBase, key, oauthHost: ssoHost });
    const resolved = resolveKimiCodeEnvironment({
      KIMI_CODE_HOME: home,
      KIMI_CODE_OAUTH_HOST: "http://127.0.0.1:4300/",
      KIMI_CODE_BASE_URL: "http://127.0.0.1:4301/v1/",
    });
    assert.equal(resolved.oauthHost, "http://127.0.0.1:4300");
    assert.equal(resolved.apiBase, "http://127.0.0.1:4301/v1");
    assert.equal(
      resolved.credentialsPath,
      path.join(home, "credentials", `${key.slice("oauth/".length)}.json`),
    );
    assert.equal(
      resolveKimiCodeEnvironment({ KIMI_CODE_HOME: home, KIMI_OAUTH_HOST: "https://auth.kimi.com" }).region,
      "mainland-cn",
    );
  });
});

test("a custom endpoint persisted without a key maps to the CLI's hashed credential slot", () => {
  withHome((home) => {
    writeConfig(home, { baseUrl: "https://proxy.example.test/coding/v1" });
    const resolved = resolveKimiCodeEnvironment({ KIMI_CODE_HOME: home });
    const expected = scopedKey("https://auth.kimi.com", "https://proxy.example.test/coding/v1");
    assert.equal(resolved.apiBase, "https://proxy.example.test/coding/v1");
    assert.equal(
      resolved.credentialsPath,
      path.join(home, "credentials", `${expected.slice("oauth/".length)}.json`),
    );
  });
});

test("an unreadable or malformed config falls back to the defaults", () => {
  withHome((home) => {
    mkdirSync(path.join(home, "config.toml"));
    assert.equal(resolveKimiCodeEnvironment({ KIMI_CODE_HOME: home }).region, "mainland-cn");
  });
  withHome((home) => {
    writeFileSync(path.join(home, "config.toml"), '[providers."managed:kimi-code"\nbase_url = = "x"\n');
    const resolved = resolveKimiCodeEnvironment({ KIMI_CODE_HOME: home });
    assert.equal(resolved.region, "mainland-cn");
    assert.equal(resolved.credentialsPath, path.join(home, "credentials", "kimi-code.json"));
  });
});
