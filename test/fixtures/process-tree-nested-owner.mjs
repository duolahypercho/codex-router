import path from "node:path";
import { fileURLToPath } from "node:url";

import { runProcessTree } from "../../src/process-tree.mjs";

const SELF = fileURLToPath(import.meta.url);
const depth = Number.parseInt(process.argv[2], 10);
const pidFile = path.resolve(process.argv[3]);

if (!Number.isSafeInteger(depth) || depth < 0 || depth > 32) {
  throw new Error("A nested process-tree fixture depth from 0 through 32 is required.");
}

if (depth > 0) {
  await runProcessTree(process.execPath, [SELF, String(depth - 1), pidFile], {
    deadline: Date.now() + 60_000,
    env: {
      ...process.env,
      CODEX_ROUTER_OPERATION_CHILD: "1",
    },
  });
} else {
  const terminal = [
    "const { writeFileSync, renameSync } = require('node:fs')",
    "process.on('SIGINT', () => {})",
    "process.on('SIGTERM', () => {})",
    `const readyFile = ${JSON.stringify(pidFile)}`,
    "const temporary = readyFile + '.' + process.pid + '.tmp'",
    "writeFileSync(temporary, String(process.pid))",
    "renameSync(temporary, readyFile)",
    "setInterval(() => {}, 1000)",
  ].join(";");
  await runProcessTree(process.execPath, ["-e", terminal], {
    deadline: Date.now() + 60_000,
    env: {
      ...process.env,
      CODEX_ROUTER_OPERATION_CHILD: "1",
    },
  });
}
