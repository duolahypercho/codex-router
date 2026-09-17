import { PRODUCTION_SERVICE_LABEL } from "./paths.mjs";

// A test that runs the real service installer rewrites the developer's own
// machine. The LaunchAgent gets repointed at the checkout under test, the
// router then refuses to start against state owned by another checkout
// (`foreign_state_owner`), and an uninstall in the same test can delete the
// definition outright. None of that is visible in the suite's output: the
// damage surfaces later as a dead router, with nothing tying it back to a test
// run, and the obvious next step -- run the tests again -- reproduces it.
//
// So under the Node test runner a service definition may only be written to a
// location the test explicitly redirected. NODE_TEST_CONTEXT is set by the
// runner in each test file's process and inherited by the processes those
// tests spawn, which is the same path the damage travels, so it marks exactly
// the calls that have to be isolated and nothing else.
//
// This is a backstop, not the mechanism: tests are expected to redirect these
// paths themselves. It exists because the failure is silent and lands on the
// machine rather than in the run.
export function assertServiceWriteIsolated(
  target,
  { redirected, env = process.env, label = "service definition", override } = {},
) {
  if (!env.NODE_TEST_CONTEXT) return;
  if (redirected) return;
  throw new Error(
    `Refusing to write the ${label} to ${target} from a test run.\n`
      + "This is the machine's own installed service, not a fixture. Point "
      + `${override || "the path override for this platform (see src/paths.mjs)"} `
      + "at a temporary directory in the test.",
  );
}

// launchd identifies a job by label, not the plist that supplied it. A test
// writing into /tmp can therefore still evict the real router if it bootstraps
// `io.github.codex-router`. Refuse that label before any launchctl command;
// tests that intentionally exercise service behavior must opt into a unique
// test-only label through CODEX_ROUTER_TEST_SERVICE_LABEL.
export function assertServiceLabelIsolated(label, { env = process.env } = {}) {
  if (!env.NODE_TEST_CONTEXT || label !== PRODUCTION_SERVICE_LABEL) return;
  throw new Error(
    `Refusing to use the production launchd label ${PRODUCTION_SERVICE_LABEL} from a test run. `
      + "Set CODEX_ROUTER_TEST_SERVICE_LABEL to a unique fixture label.",
  );
}
