import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function kimiCodeHome() {
  return process.env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code");
}

export function kimiOAuthStatus() {
  const credentialsPath = path.join(
    kimiCodeHome(),
    "credentials",
    "kimi-code.json",
  );
  if (!existsSync(credentialsPath)) {
    return {
      configured: false,
      credentialsPath,
      setup: "Run `kimi login` in an interactive terminal",
    };
  }
  try {
    const value = JSON.parse(readFileSync(credentialsPath, "utf8"));
    const configured = Boolean(value?.access_token && value?.refresh_token);
    return configured
      ? { configured: true, credentialsPath, scope: value.scope || "kimi-code" }
      : {
          configured: false,
          credentialsPath,
          setup: "Run `kimi login` again; the credential file is incomplete",
        };
  } catch {
    return {
      configured: false,
      credentialsPath,
      setup: "Run `kimi login` again; the credential file is invalid",
    };
  }
}
