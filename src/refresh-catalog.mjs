import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SOURCE_ROOT } from "./paths.mjs";
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
    ]);
  }
}

export function refreshCatalog({
  run = nodeRunner,
  aliases = readNativeAliases,
  aliasFor = nativeAliasFor,
} = {}) {
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
  const transport = {
    signed,
    loginFree,
    loginFreeDisplayModel: loginFree ? status.model : undefined,
    loginFreeModel: loginFree
      ? aliases()[status.model] || status.model
      : undefined,
  };
  let restoreNeeded = false;
  let catalogResult;
  try {
    if (routed) {
      checked(run, "config-manager.mjs", [
        "disable",
        ...(loginFree ? ["--preserve-login-free-state"] : []),
      ]);
      restoreNeeded = true;
    }
    catalogResult = checked(run, "catalog.mjs", ["--refresh-native"]);
    if (restoreNeeded) {
      restoreTransport(run, transport, aliasFor);
      restoreNeeded = false;
    }
  } catch (error) {
    if (restoreNeeded) {
      try {
        restoreTransport(run, transport, aliasFor);
        restoreNeeded = false;
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          "Catalog refresh failed and the previous routing transport could not be restored.",
        );
      }
    }
    throw error;
  }
  return { catalogOutput: catalogResult.stdout || "" };
}

function main() {
  const { catalogOutput } = refreshCatalog();
  if (catalogOutput) process.stdout.write(catalogOutput);
  process.stdout.write("Native and external model catalogs refreshed. Fully quit and reopen Codex.\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
