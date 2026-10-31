import { execFileSync } from "node:child_process";
import { closeSync, openSync, readSync, writeSync } from "node:fs";

export function promptLine(label, defaultValue = "") {
  if (process.platform === "win32") {
    const prompt = `${label}${defaultValue ? ` [${defaultValue}]` : ""}`;
    const script = "$answer = Read-Host $env:MODEL_ROUTER_PROMPT_LABEL; [Console]::Out.Write($answer)";
    let lastError;
    for (const executable of ["powershell.exe", "pwsh.exe"]) {
      try {
        const answer = execFileSync(
          executable,
          ["-NoLogo", "-NoProfile", "-Command", script],
          {
            encoding: "utf8",
            env: { ...process.env, MODEL_ROUTER_PROMPT_LABEL: prompt },
            stdio: ["inherit", "pipe", "inherit"],
          },
        ).trim();
        return answer || defaultValue;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("PowerShell is required for guided setup on Windows.");
  }
  let descriptor;
  try {
    descriptor = openSync("/dev/tty", "r+");
  } catch {
    throw new Error("Interactive setup requires a terminal; use --providers for automatic setup.");
  }
  try {
    writeSync(descriptor, `${label}${defaultValue ? ` [${defaultValue}]` : ""}: `);
    const chunks = [];
    const byte = Buffer.alloc(1);
    while (readSync(descriptor, byte, 0, 1) === 1) {
      if (byte[0] === 10 || byte[0] === 13) break;
      chunks.push(Buffer.from(byte));
    }
    writeSync(descriptor, "\n");
    return Buffer.concat(chunks).toString("utf8").trim() || defaultValue;
  } finally {
    closeSync(descriptor);
  }
}

export function confirm(label, defaultYes = true) {
  const answer = promptLine(`${label} ${defaultYes ? "[Y/n]" : "[y/N]"}`).toLowerCase();
  if (!answer) return defaultYes;
  return answer === "y" || answer === "yes";
}
