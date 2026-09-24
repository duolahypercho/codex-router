import { createHash } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runProcessTree } from "../../src/process-tree.mjs";

const [role, scenario, directory] = process.argv.slice(2);
const record = (name, value) => {
  const target = path.join(directory, name);
  writeFileSync(`${target}.tmp`, JSON.stringify(value));
  renameSync(`${target}.tmp`, target);
};

if (role === "target") {
  record("ready.json", { pid: process.pid });
  if (scenario === "output") {
    const bytes = Buffer.alloc(3 * 1024 * 1024);
    for (let index = 0; index < bytes.length; index++) bytes[index] = index % 256;
    await Promise.all([
      new Promise((resolve) => process.stdout.write(bytes, resolve)),
      new Promise((resolve) => process.stderr.write(bytes, resolve)),
    ]);
    process.exitCode = 7;
  } else if (scenario === "input") {
    const hash = createHash("sha256");
    let count = 0;
    for await (const bytes of process.stdin) {
      count += bytes.length;
      hash.update(bytes);
    }
    console.log(JSON.stringify({ count, hash: hash.digest("hex") }));
    console.error("input-complete");
    process.exitCode = 7;
  } else if (scenario === "early-close") {
    console.log("input-not-needed");
    process.exitCode = 7;
  } else if (scenario === "stalled") {
    process.stdout.write(Buffer.alloc(32 * 1024 * 1024, 97));
    setInterval(() => {}, 1000);
  } else {
    throw new Error(`Unknown target scenario: ${scenario}`);
  }
} else if (role === "owner") {
  const deadline = Date.now() + (scenario === "stalled" ? 6000 : 30_000);
  try {
    const result = await runProcessTree(process.execPath, [
      fileURLToPath(import.meta.url), "target", scenario, directory,
    ], { stdio: "inherit", deadline });
    record("result.json", { result, stdinFlowing: process.stdin.readableFlowing });
    // Immediate exit is used by control.mjs, so pending output must already
    // have been forwarded when the operation is resolved.
    if (scenario === "output") process.exit(result.status);
    process.exitCode = result.status;
  } catch (error) {
    record("result.json", { error: error.code, stdinFlowing: process.stdin.readableFlowing });
  }
} else {
  throw new Error(`Unknown fixture role: ${role}`);
}
