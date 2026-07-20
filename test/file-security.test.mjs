import assert from "node:assert/strict";
import test from "node:test";

import { windowsFullControlGrant } from "../src/file-security.mjs";

test("Windows numeric SID grants use the icacls SID prefix", () => {
  assert.equal(
    windowsFullControlGrant("S-1-5-21-1742564184-1656218818-310408600-500"),
    "*S-1-5-21-1742564184-1656218818-310408600-500:(F)",
  );
  assert.throws(() => windowsFullControlGrant("runner@example.com"), /invalid Windows user SID/);
});
