import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SOURCE_ROOT } from "./paths.mjs";

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

function restoreTransport(run, { signed, loginFree, loginFreeModel }) {
  checked(run, "config-manager.mjs", ["enable"]);
  if (signed) checked(run, "config-manager.mjs", ["signed-enable"]);
  if (loginFree) {
    checked(
      run,
      "config-manager.mjs",
      ["login-free-enable", ...(loginFreeModel ? [loginFreeModel] : [])],
    );
  }
  checked(run, "catalog.mjs", []);
}

export function refreshCatalog({ run = nodeRunner } = {}) {
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
    loginFreeModel: loginFree ? status.model : undefined,
  };
  let restoreNeeded = false;
  let catalogResult;
  try {
    if (routed) {
      checked(run, "config-manager.mjs", ["disable"]);
      restoreNeeded = true;
    }
    catalogResult = checked(run, "catalog.mjs", ["--refresh-native"]);
    if (restoreNeeded) {
      restoreTransport(run, transport);
      restoreNeeded = false;
    }
  } catch (error) {
    if (restoreNeeded) {
      try {
        restoreTransport(run, transport);
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
