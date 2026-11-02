import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

// Git for Windows ships sh without necessarily putting it on PATH. Never
// invoke the WindowsApps bash shim: it can launch an unrelated WSL session.
export function posixShell() {
  if (spawnSync("sh", ["-c", "exit 0"], { stdio: "ignore" }).status === 0) return "sh";
  if (process.platform !== "win32") return undefined;
  const git = spawnSync("git", ["--exec-path"], { encoding: "utf8", timeout: 5_000 });
  if (git.status !== 0) return undefined;
  const shell = path.resolve(git.stdout.trim(), "..", "..", "..", "bin", "sh.exe");
  return existsSync(shell) ? shell : undefined;
}
