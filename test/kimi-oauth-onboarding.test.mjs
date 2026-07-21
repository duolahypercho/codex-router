import assert from "node:assert/strict";
import { test } from "node:test";

import {
  KIMI_CLI_INSTALL_URL,
  KIMI_CLI_MIN_NODE,
  KIMI_CLI_NPM_PACKAGE,
  MAX_CLI_WAIT_ATTEMPTS,
  MAX_LOGIN_ATTEMPTS,
  kimiCliInstallGuidance,
  nextOauthStep,
} from "../src/kimi-oauth-onboarding.mjs";

test("nextOauthStep returns done when a credential is configured", () => {
  assert.equal(
    nextOauthStep({ cliFound: false, credentialConfigured: true }),
    "done",
  );
  assert.equal(
    nextOauthStep({ cliFound: true, credentialConfigured: true }),
    "done",
  );
});

test("nextOauthStep asks to install the CLI when it is missing", () => {
  assert.equal(
    nextOauthStep({ cliFound: false, credentialConfigured: false }),
    "install-cli",
  );
});

test("nextOauthStep asks to log in when the CLI exists but no credential", () => {
  assert.equal(
    nextOauthStep({ cliFound: true, credentialConfigured: false }),
    "login",
  );
});

test("kimiCliInstallGuidance points at the official install URL", () => {
  const guidance = kimiCliInstallGuidance();
  assert.match(guidance, /kimi/i);
  assert.ok(guidance.includes(KIMI_CLI_INSTALL_URL));
});

test("kimiCliInstallGuidance gives a concrete npm install command and Node prerequisite", () => {
  const guidance = kimiCliInstallGuidance();
  assert.ok(guidance.includes(`npm install -g ${KIMI_CLI_NPM_PACKAGE}`));
  assert.ok(guidance.includes(KIMI_CLI_MIN_NODE));
});

test("bounded retry limits are positive integers", () => {
  for (const limit of [MAX_CLI_WAIT_ATTEMPTS, MAX_LOGIN_ATTEMPTS]) {
    assert.ok(Number.isInteger(limit) && limit > 0);
  }
});
