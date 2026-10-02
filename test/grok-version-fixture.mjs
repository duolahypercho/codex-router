import { writeFileSync } from "node:fs";
import path from "node:path";

export function writeGrokVersionCli(directory) {
  const windows = process.platform === "win32";
  const executable = path.join(directory, windows ? "grok-version.cmd" : "grok-version");
  writeFileSync(executable, windows
    ? "@echo off\r\necho grok 1.0.46 (fixture) [stable]\r\n"
    : "#!/bin/sh\nprintf 'grok 1.0.46 (fixture) [stable]\\n'\n", { mode: 0o700 });
  return executable;
}
