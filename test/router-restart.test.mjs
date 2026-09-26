import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { homebrewKegNode } from "./fixtures/homebrew-keg-node.mjs";

import {
  environmentPoolRemovalReminder,
  environmentPoolMutationServiceStatus,
  ROUTER_SERVICE_RESTART_MINIMUM_MS,
  ROUTER_SERVICE_RESTART_OPERATION_MS,
  restartRouterServiceIfInstalled,
  routerServiceRestartCommand,
  routerServiceStatus,
} from "../src/router-restart.mjs";

const INSTALLED_STATUS = {
  status: 0,
  error: undefined,
  stdout: JSON.stringify({ installed: true, loaded: true, state: "running" }),
};
const STOPPED_STATUS = {
  status: 0,
  error: undefined,
  stdout: JSON.stringify({ installed: true, loaded: false, state: "stopped" }),
};
const ABSENT_STATUS = {
  status: 0,
  error: undefined,
  stdout: JSON.stringify({ installed: false, loaded: false, state: "stopped" }),
};
const NOT_INSTALLED_STATUS = { status: 1, error: undefined, stdout: "" };

test("restart instructions are exact on POSIX and Windows", () => {
  assert.equal(routerServiceRestartCommand("linux"), "./bin/control service restart");
  assert.equal(
    routerServiceRestartCommand("win32"),
    "node .\\src\\control.mjs service restart",
  );
});

// Restarts also come from workers that outlive a Node upgrade, and `brew
// upgrade node` deletes the keg such a worker runs from. Run the module from a
// keg so its own process.execPath is the versioned path: the service command
// must name the formula's opt link instead.
test("service commands name a Node that survives the running keg", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "router-restart-keg-"));
  try {
    const { keg, opt } = homebrewKegNode(root);
    const moduleUrl = new URL("../src/router-restart.mjs", import.meta.url).href;
    const command = execFileSync(
      keg,
      [
        "--input-type=module",
        "--eval",
        `import { routerServiceStatus } from ${JSON.stringify(moduleUrl)};
let seen;
await routerServiceStatus({ spawn: (command) => { seen = command; return { status: 1, stdout: "" }; } });
process.stdout.write(seen);`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(command, opt);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("routerServiceStatus reports an installed, loaded service", async () => {
  const seen = [];
  const spawn = (command, args) => {
    seen.push({ command, args });
    return INSTALLED_STATUS;
  };
  assert.deepEqual(await routerServiceStatus({ spawn }), {
    installed: true,
    loaded: true,
    state: "running",
  });
  assert.equal(seen.length, 1);
  assert.ok(seen[0].args.at(-1) === "status");
});

test("routerServiceStatus marks an unusable probe as unknown instead of absent", async () => {
  for (const stdout of ["", "not json"]) {
    assert.deepEqual(await routerServiceStatus({ spawn: () => ({ status: 0, error: undefined, stdout }) }), {
      installed: false,
      statusUnknown: true,
    });
  }
  assert.deepEqual(
    await routerServiceStatus({ spawn: () => ({ status: 1, error: undefined, stdout: "" }) }),
    { installed: false, statusUnknown: true },
  );
  assert.deepEqual(
    await routerServiceStatus({
      spawn: () => ({
        status: 0,
        error: undefined,
        stdout: JSON.stringify({ installed: false, loaded: "no", state: "stopped" }),
      }),
    }),
    { installed: false, statusUnknown: true },
  );
});

test("environment-backed pool changes refuse a running managed service before probing health", async () => {
  let healthProbes = 0;
  await assert.rejects(
    environmentPoolMutationServiceStatus({
      spawn: () => INSTALLED_STATUS,
      waitForHealth: async () => {
        healthProbes += 1;
        return { ok: false, connectionRefused: true };
      },
    }),
    (error) => {
      assert.equal(error.code, "provider_api_key_pool_service_environment_stale");
      assert.match(error.message, /stop the service/i);
      assert.match(error.message, /restart alone does not rewrite/i);
      return true;
    },
  );
  assert.equal(healthProbes, 0);

  await assert.rejects(
    environmentPoolMutationServiceStatus({
      spawn: () => ({
        status: 0,
        error: undefined,
        stdout: JSON.stringify({ installed: false, loaded: true, state: "running" }),
      }),
      waitForHealth: async () => ({ ok: false, connectionRefused: true }),
    }),
    /managed router service is running/i,
    "an orphaned loaded job is still service-owned even if its definition is missing",
  );
});

test("environment-backed pool changes allow only stopped service state plus a refused port", async () => {
  assert.deepEqual(
    await environmentPoolMutationServiceStatus({
      spawn: () => STOPPED_STATUS,
      waitForHealth: async () => ({ ok: false, connectionRefused: true }),
    }),
    {
      installed: true,
      loaded: false,
      state: "stopped",
      serviceReinstallRequired: true,
    },
  );
  assert.deepEqual(
    await environmentPoolMutationServiceStatus({
      spawn: () => ABSENT_STATUS,
      waitForHealth: async () => ({ ok: false, connectionRefused: true }),
    }),
    {
      installed: false,
      loaded: false,
      state: "stopped",
      serviceReinstallRequired: false,
    },
  );
});

test("a live foreground router blocks environment-backed pool publication", async () => {
  for (const health of [
    { ok: true, payload: { service: "codex-router" } },
    {
      ok: false,
      error: "gateway unavailable",
      degradedPayload: { service: "codex-router", degraded: ["gateway"] },
    },
  ]) {
    await assert.rejects(
      environmentPoolMutationServiceStatus({
        spawn: () => ABSENT_STATUS,
        waitForHealth: async () => health,
      }),
      (error) => {
        assert.equal(error.code, "provider_api_key_pool_service_environment_stale");
        assert.match(error.message, /live router process/i);
        assert.match(error.message, /stop the foreground router/i);
        return true;
      },
    );
  }
});

test("unknown service or ambiguous health ownership fails closed", async () => {
  await assert.rejects(
    environmentPoolMutationServiceStatus({
      spawn: () => NOT_INSTALLED_STATUS,
      waitForHealth: async () => ({ ok: false, connectionRefused: true }),
    }),
    /service state could not be verified/i,
  );

  for (const health of [
    { ok: false, error: "socket reset", connectionRefused: false },
    { ok: false, error: "request timed out" },
    { ok: false, error: "foreign response", connectionRefused: false },
  ]) {
    await assert.rejects(
      environmentPoolMutationServiceStatus({
        spawn: () => ABSENT_STATUS,
        waitForHealth: async () => health,
      }),
      (error) => {
        assert.equal(error.code, "provider_api_key_pool_service_environment_stale");
        assert.match(error.message, /process state could not be verified/i);
        return true;
      },
    );
  }
});

test("environment-backed removal reminders cover managed, unknown, and foreground ownership", () => {
  const managed = environmentPoolRemovalReminder({ installed: true, loaded: false });
  assert.match(managed, /rerun the installer/i);
  assert.match(managed, /remove the retired secret/i);
  assert.match(managed, /service definition/i);
  assert.match(managed, /restart alone/i);

  const unknown = environmentPoolRemovalReminder({ installed: false, statusUnknown: true });
  assert.match(unknown, /could not be verified/i);
  assert.match(unknown, /if one is installed, rerun the installer/i);
  assert.match(unknown, /restart alone/i);

  const loaded = environmentPoolRemovalReminder({ installed: false, loaded: true });
  assert.match(loaded, /stop and restart the loaded router process/i);

  const foreground = environmentPoolRemovalReminder({ installed: false, loaded: false });
  assert.match(foreground, /restart any foreground router/i);
  for (const reminder of [managed, unknown, loaded, foreground]) {
    assert.doesNotMatch(reminder, /OPENCODE_API_KEY|OPENCODE_GO_API_KEY|secret-test-value/);
  }
});

test("restart is skipped when no background service is installed", async () => {
  const calls = [];
  const spawn = (command, args) => {
    calls.push(args.at(-1));
    return NOT_INSTALLED_STATUS;
  };
  assert.equal(await restartRouterServiceIfInstalled({ spawn }), false);
  assert.deepEqual(calls, ["status"]);
});

test("restart runs the service restart command when installed", async () => {
  const calls = [];
  const spawn = (command, args) => {
    calls.push(args.at(-1));
    return args.at(-1) === "status"
      ? INSTALLED_STATUS
      : { status: 0, error: undefined, stdout: JSON.stringify({ state: "running" }) };
  };
  assert.equal(await restartRouterServiceIfInstalled({ spawn }), true);
  assert.deepEqual(calls, ["status", "restart"]);
});

test("status is separately capped while restart retains its contracted absolute deadline", async () => {
  const calls = [];
  const controller = new AbortController();
  const startedAt = Date.now();
  const deadline = startedAt + 400_000;
  const spawn = (_command, args, options) => {
    calls.push({ action: args.at(-1), options });
    return args.at(-1) === "status"
      ? INSTALLED_STATUS
      : { status: 0, error: undefined, stdout: "" };
  };
  assert.equal(
    await restartRouterServiceIfInstalled({ spawn, env: {}, signal: controller.signal, deadline }),
    true,
  );
  assert.deepEqual(calls.map((call) => call.action), ["status", "restart"]);
  const [statusCall, restartCall] = calls;
  assert.ok(statusCall.options.deadline > startedAt);
  assert.ok(statusCall.options.deadline <= startedAt + 10_100);
  assert.equal(statusCall.options.env.CODEX_ROUTER_OPERATION_DEADLINE_MS, undefined);
  assert.ok(restartCall.options.deadline > startedAt + ROUTER_SERVICE_RESTART_MINIMUM_MS);
  assert.ok(restartCall.options.deadline <= startedAt + ROUTER_SERVICE_RESTART_OPERATION_MS + 100);
  assert.equal(
    restartCall.options.env.CODEX_ROUTER_OPERATION_DEADLINE_MS,
    String(restartCall.options.deadline - 10_000),
  );
  assert.equal(Object.hasOwn(statusCall.options, "timeout"), false);
  assert.equal(Object.hasOwn(restartCall.options, "timeout"), false);
});

test("the read-only status helper derives a finite capped deadline without nesting an owner", async () => {
  let options;
  const startedAt = Date.now();
  await routerServiceStatus({
    env: {},
    spawn: (_command, _args, seen) => {
      options = seen;
      return NOT_INSTALLED_STATUS;
    },
  });
  assert.ok(Number.isSafeInteger(options.deadline));
  assert.ok(options.deadline > startedAt);
  assert.ok(options.deadline <= startedAt + 10_100);
  assert.equal(options.env.CODEX_ROUTER_OPERATION_DEADLINE_MS, undefined);
});

test("status overhead still leaves the restart child a full platform and readiness window", async () => {
  const calls = [];
  const spawn = async (_command, args, options) => {
    calls.push({ action: args.at(-1), calledAt: Date.now(), options });
    if (args.at(-1) === "status") {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return INSTALLED_STATUS;
    }
    return { status: 0, error: undefined, stdout: "" };
  };
  assert.equal(await restartRouterServiceIfInstalled({ spawn, env: {} }), true);
  const restart = calls.find((call) => call.action === "restart");
  assert.ok(restart);
  const childDeadline = Number(restart.options.env.CODEX_ROUTER_OPERATION_DEADLINE_MS);
  assert.ok(
    childDeadline - restart.calledAt >= 310_000,
    `restart child retained only ${childDeadline - restart.calledAt}ms`,
  );
});

test("an inherited nominal readiness deadline is refused before service mutation", async () => {
  const calls = [];
  await assert.rejects(
    restartRouterServiceIfInstalled({
      env: {},
      deadline: Date.now() + 300_000,
      spawn: (_command, args) => {
        calls.push(args.at(-1));
        return INSTALLED_STATUS;
      },
    }),
    (error) => error?.code === "router_operation_timeout"
      && /cannot preserve/.test(error.message),
  );
  assert.deepEqual(calls, ["status"]);
});

test("an aborted restart cannot spawn or be mistaken for an absent service", async () => {
  const controller = new AbortController();
  const aborted = new Error("planned restart abort");
  controller.abort(aborted);
  await assert.rejects(
    restartRouterServiceIfInstalled({
      signal: controller.signal,
      deadline: Date.now() + 10_000,
      spawn: () => assert.fail("an aborted restart must fail before spawning"),
    }),
    (error) => error === aborted,
  );
});

test("an expired service deadline fails instead of looking uninstalled", async () => {
  await assert.rejects(
    restartRouterServiceIfInstalled({
      deadline: Date.now() - 1,
      spawn: () => assert.fail("an expired deadline must fail before spawning"),
    }),
    (error) => error?.code === "router_operation_timeout",
  );
});

test("a failed restart fails loudly instead of pretending the route is live", async () => {
  const spawn = (command, args) =>
    args.at(-1) === "status"
      ? INSTALLED_STATUS
      : { status: 1, error: undefined, stdout: "" };
  await assert.rejects(
    restartRouterServiceIfInstalled({ spawn }),
    /could not be restarted/,
  );
});
