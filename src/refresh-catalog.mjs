import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SOURCE_ROOT } from "./paths.mjs";
import {
  beginLoginFreeRefresh,
  clearLoginFreeRefreshJournal,
  readLoginFreeRefreshJournal,
} from "./login-free-refresh-journal.mjs";
import { withLoginFreeRefreshLock } from "./login-free-refresh-lock.mjs";
import { nativeAliasFor, readNativeAliases } from "./native-alias.mjs";

function nodeRunner(script, args) {
  return spawnSync(process.execPath, [path.join(SOURCE_ROOT, "src", script), ...args], {
    cwd: SOURCE_ROOT,
    env: process.env,
    encoding: "utf8",
  });
}

function checked(run, script, args) {
  const result = run(script, args);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${script} exited with status ${result.status ?? "unknown"}` +
        `${result.stderr ? `: ${result.stderr.trim()}` : "."}`,
    );
  }
  return result;
}

function restoreTransport(
  run,
  { signed, loginFree, loginFreeModel, loginFreeDisplayModel },
  aliasFor,
) {
  if (loginFree) {
    checked(
      run,
      "config-manager.mjs",
      [
        "login-free-enable",
        ...(loginFreeModel ? [loginFreeModel] : []),
        "--restore-disabled-login-free",
      ],
    );
  } else {
    checked(run, "config-manager.mjs", ["enable"]);
    if (signed) checked(run, "config-manager.mjs", ["signed-enable"]);
  }
  try {
    checked(run, "catalog.mjs", []);
  } catch (error) {
    if (loginFree && loginFreeDisplayModel) {
      try {
        checked(run, "config-manager.mjs", [
          "login-free-enable",
          loginFreeDisplayModel,
          "--complete-login-free-refresh",
        ]);
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          "The routed catalog failed and the prior login-free model could not be restored.",
        );
      }
    }
    throw error;
  }
  if (loginFree && loginFreeModel) {
    // The refreshed native catalog can assign a different allowlisted slug to
    // the same external route. Select the fresh alias after publication so the
    // desktop picker highlights and dispatches the route the user had chosen,
    // rather than preserving a stale native slug that may now name another
    // external model.
    checked(run, "config-manager.mjs", [
      "login-free-enable",
      aliasFor(loginFreeModel) || loginFreeModel,
      "--complete-login-free-refresh",
    ]);
  }
}

async function refreshCatalogUnlocked({
  run = nodeRunner,
  aliases = readNativeAliases,
  aliasFor = nativeAliasFor,
  journal = {
    begin: beginLoginFreeRefresh,
    clear: clearLoginFreeRefreshJournal,
    read: readLoginFreeRefreshJournal,
  },
} = {}) {
  // A killed refresh can leave the exact direct provider source parked while
  // the login-free provider state is intentionally retained. Only the private
  // journal written by this operation makes that otherwise ambiguous pair
  // recoverable; config-manager keeps all no-journal cases fail-closed.
  const pendingJournal = journal.read();
  if (pendingJournal) {
    checked(run, "config-manager.mjs", ["enable", "--resume-login-free-refresh"]);
  }
  const statusResult = checked(run, "config-manager.mjs", ["status"]);
  let status;
  try {
    status = JSON.parse(statusResult.stdout);
  } catch {
    throw new Error("config-manager.mjs status returned invalid JSON.");
  }
  const routed = status.mode === "router";
  const signed = status.signed_routing === true;
  const loginFree = status.login_free === true;
  if (pendingJournal && !loginFree) {
    throw new Error("The pending login-free refresh could not restore its managed transport.");
  }
  const transport = {
    signed,
    loginFree,
    loginFreeDisplayModel: loginFree
      ? pendingJournal?.displayModel || status.model
      : undefined,
    loginFreeModel: loginFree
      ? pendingJournal?.canonicalModel || aliases()[status.model] || status.model
      : undefined,
  };
  let restoreNeeded = false;
  let catalogResult;
  let mirrorResult;
  try {
    if (routed) {
      if (loginFree) {
        journal.begin({
          canonicalModel: transport.loginFreeModel,
          displayModel: transport.loginFreeDisplayModel,
        });
      }
      checked(run, "config-manager.mjs", [
        "disable",
        ...(loginFree ? ["--preserve-login-free-state"] : []),
        ...(loginFree ? ["--park-login-free-refresh"] : []),
      ]);
      restoreNeeded = true;
      if (
        loginFree &&
        process.env.MODEL_ROUTER_TEST_EXIT_AFTER_LOGIN_FREE_PARK === "1"
      ) {
        process.exit(86);
      }
    }
    catalogResult = checked(run, "catalog.mjs", [
      "--refresh-native",
      "--router-transport-parked",
    ]);
    if (restoreNeeded) {
      restoreTransport(run, transport, aliasFor);
      restoreNeeded = false;
      if (loginFree) journal.clear();
    }
    // Restore transport before committing a discovered model. The mirror owns
    // one overlay transaction that regenerates gateway routes, republishes all
    // installed model pickers, and restarts the service only when its managed
    // entries changed. Ordinary providers remain a zero-network no-op.
    mirrorResult = checked(run, "native-model-mirror.mjs", []);
  } catch (error) {
    if (restoreNeeded) {
      try {
        restoreTransport(run, transport, aliasFor);
        restoreNeeded = false;
        if (loginFree) journal.clear();
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          "Catalog refresh failed and the previous routing transport could not be restored.",
        );
      }
    }
    throw error;
  }
  return {
    catalogOutput: catalogResult.stdout || "",
    mirrorOutput: mirrorResult?.stdout || "",
  };
}

export async function refreshCatalog({
  lock = withLoginFreeRefreshLock,
  lockOptions,
  ...options
} = {}) {
  return lock(() => refreshCatalogUnlocked(options), lockOptions);
}

async function main() {
  const { catalogOutput, mirrorOutput } = await refreshCatalog();
  if (catalogOutput) process.stdout.write(catalogOutput);
  if (mirrorOutput) process.stdout.write(mirrorOutput);
  process.stdout.write("Native and external model catalogs refreshed. Fully quit and reopen Codex.\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
