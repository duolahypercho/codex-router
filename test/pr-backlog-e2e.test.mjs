import test from "node:test";
import "./port-pool.mjs";
import { runMacosScenarios } from "./pr-backlog-macos-fixtures.mjs";
import { runProviderScenarios } from "./pr-backlog-provider-fixtures.mjs";
import { runSmallScenarios } from "./pr-backlog-small-fixtures.mjs";
import { runTransportScenarios } from "./pr-backlog-transport-fixtures.mjs";

// One final E2E entrypoint for the reviewed backlog. Helpers register bounded,
// serial scenarios; none contacts a paid provider or the installed router.
test("reviewed PR backlog: end-to-end acceptance", { timeout: 300_000 }, async (t) => {
  await runMacosScenarios(t);
  await runProviderScenarios(t);
  await runSmallScenarios(t);
  await runTransportScenarios(t);
});
