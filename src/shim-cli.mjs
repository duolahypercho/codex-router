// CLI front end for the opt-in `codex` shim. See src/codex-shim.mjs for why the
// shim exists and why installing it is never automatic.

import { installShim, shimReport, uninstallShim } from "./codex-shim.mjs";

const command = process.argv[2] || "status";
const json = process.argv.includes("--json");

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, json ? 2 : 0)}\n`);
}

function describe(status) {
  if (!status.installed) {
    return "The codex shim is not installed. Codex starts without checking the router first.";
  }
  if (!status.on_path) {
    return `The codex shim is installed at ${status.shim}, but that directory is not on PATH, so it never runs.`;
  }
  if (!status.effective) {
    return `The codex shim is installed at ${status.shim}, but ${status.real_codex} comes first on PATH, so the shim never runs.`;
  }
  return `The codex shim is active at ${status.shim} and wraps ${status.real_codex}.`;
}

try {
  if (command === "status") {
    const status = shimReport();
    if (json) emit(status);
    else process.stdout.write(`${describe(status)}\n`);
  } else if (command === "install") {
    const result = installShim();
    if (json) {
      emit(result);
    } else {
      process.stdout.write(`Installed the codex shim at ${result.installed_to}\n`);
      process.stdout.write(`It wraps ${result.wraps}\n`);
      if (result.needs_path_entry) {
        // Not written into a shell rc file on purpose: editing someone's shell
        // startup is a change they should make themselves and be able to see.
        process.stdout.write(
          `\nNo directory ahead of Codex on your PATH was writable, so the shim is not active yet.\n` +
            `Add this to your shell profile, then open a new terminal:\n\n` +
            `  export PATH="${result.needs_path_entry}:$PATH"\n`,
        );
      } else if (!result.effective) {
        process.stdout.write(
          `\nWarning: ${result.real_codex} still comes first on PATH, so the shim will not run.\n`,
        );
      } else {
        process.stdout.write(`\nOpen a new terminal, or run \`hash -r\`, for the change to take effect.\n`);
      }
    }
  } else if (command === "uninstall") {
    const result = uninstallShim();
    if (json) {
      emit(result);
    } else if (result.removed.length === 0) {
      process.stdout.write("No codex shim was installed; nothing to remove.\n");
    } else {
      for (const file of result.removed) process.stdout.write(`Removed ${file}\n`);
    }
  } else {
    process.stderr.write("Usage: model-router codex shim status|install|uninstall [--json]\n");
    process.exit(2);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
