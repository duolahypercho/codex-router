// Pure onboarding helpers for the Kimi Code OAuth login flow.
// Kept side-effect free so the interactive setup can stay thin and these
// decisions remain unit-testable.

export const KIMI_CLI_INSTALL_URL =
  "https://www.kimi.com/help/kimi-code/cli-getting-started";

// Official npm package that provides the `kimi` command. Other install methods
// (install script, etc.) live behind KIMI_CLI_INSTALL_URL.
export const KIMI_CLI_NPM_PACKAGE = "@moonshot-ai/kimi-code";
export const KIMI_CLI_MIN_NODE = "22.19";

// Bounded retry limits shared by the interactive flow.
export const MAX_CLI_WAIT_ATTEMPTS = 5;
export const MAX_LOGIN_ATTEMPTS = 3;

// Decide the next onboarding action from observed state.
// Returns one of: "done", "install-cli", "login".
export function nextOauthStep({ cliFound, credentialConfigured }) {
  if (credentialConfigured) return "done";
  if (!cliFound) return "install-cli";
  return "login";
}

// Guidance shown when the `kimi` command is missing from PATH.
export function kimiCliInstallGuidance() {
  return [
    "Kimi OAuth reuses an existing Kimi Code CLI login session.",
    "The `kimi` command was not found on your PATH.",
    "",
    `Install the Kimi Code CLI (needs Node.js ${KIMI_CLI_MIN_NODE}+):`,
    `  npm install -g ${KIMI_CLI_NPM_PACKAGE}`,
    "",
    "Other install methods (install script, etc.) are in the official guide:",
    `  ${KIMI_CLI_INSTALL_URL}`,
    "",
    "After installing, open a new terminal (or make sure its install directory",
    "is on PATH), then continue here.",
  ].join("\n");
}
