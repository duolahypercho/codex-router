import { copyFileSync, linkSync, mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";

// A Homebrew prefix whose current keg holds a real Node binary, so a process
// started from it reports that keg as process.execPath -- which a symlink
// cannot do, because Node resolves execPath through links. The formula's opt
// link points at the keg, and `removedKeg` names the version an upgrade
// deleted.
export function homebrewKegNode(root, { version = "26.10.0", previous = "26.9.0" } = {}) {
  const prefix = path.join(root, "homebrew");
  const keg = path.join(prefix, "Cellar", "node", version, "bin", "node");
  const opt = path.join(prefix, "opt", "node", "bin", "node");
  mkdirSync(path.dirname(keg), { recursive: true });
  try {
    linkSync(process.execPath, keg);
  } catch {
    copyFileSync(process.execPath, keg);
  }
  mkdirSync(path.dirname(opt), { recursive: true });
  symlinkSync(keg, opt);
  return {
    keg,
    opt,
    removedKeg: path.join(prefix, "Cellar", "node", previous, "bin", "node"),
  };
}
