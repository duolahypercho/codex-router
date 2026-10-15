import { spawn } from "node:child_process";

const command = process.argv.at(-1);
const child = spawn("/bin/sh", ["-c", command], { stdio: "inherit" });
child.on("error", () => { process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
