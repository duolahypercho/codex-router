import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const directories = [root, path.join(root, "src"), path.join(root, "test")];

for (const directory of directories) {
  for (const entry of readdirSync(directory)) {
    const target = path.join(directory, entry);
    if (statSync(target).isFile() && target.endsWith(".mjs")) {
      execFileSync(process.execPath, ["--check", target], { stdio: "inherit" });
    }
  }
}

execFileSync(process.execPath, [path.join(root, "scripts", "check-v2-agent-applications.mjs")], {
  stdio: "inherit",
});

// A malformed fragment is only discovered at release otherwise, which is the
// worst moment to find it: the person cutting the release did not write it.
execFileSync(process.execPath, [path.join(root, "scripts", "assemble-changelog.mjs"), "--check"], {
  stdio: "inherit",
  cwd: root,
});

console.log("syntax checks passed");
