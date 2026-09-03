import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

function allowedSystemPathLink(target) {
  const normalized = path.resolve(target);
  if (!["/var", "/tmp"].includes(normalized)) return false;
  try {
    const resolved = path.resolve(realpathSync(normalized));
    return normalized === "/var"
      ? resolved === "/private/var"
      : resolved === "/private/tmp";
  } catch {
    return false;
  }
}

// Inspect the complete existing path chain rather than only the caller-owned
// suffix. A private root beneath a replaced ancestor is no longer private.
// macOS's fixed /var and /tmp aliases are the sole deliberate exceptions.
export function ensureNoSymlinkParents(target, { label = "Private path" } = {}) {
  const absolute = path.resolve(target);
  const root = path.parse(absolute).root;
  const relative = path.relative(root, absolute);
  let current = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      if (!allowedSystemPathLink(current)) {
        throw new Error(`Refusing to traverse a symbolic-link ${label.toLowerCase()}: ${current}`);
      }
      continue;
    }
    if (!stat.isDirectory()) {
      throw new Error(`${label} component is not a directory: ${current}`);
    }
  }
  return absolute;
}
