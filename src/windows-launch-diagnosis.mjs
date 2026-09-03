import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";

// Node reports a module it cannot *read* the same way it reports one that is
// not there: `Cannot find module '<path>'` with code MODULE_NOT_FOUND. On
// Windows that collapses two very different failures into one message, and a
// scheduled task hits the readable-only-to-someone-else case (issue #548):
// the installer creates the managed checkout, the task exits 1, the router log
// names `src\start.mjs` as missing, and the operator can open that exact file.
//
// The distinguishing evidence is cheap and local: does the path the loader
// named exist right now? If it does, absence was never the problem, and
// repeating Node's wording sends the operator looking for a missing file that
// is sitting in front of them.
const MISSING_MODULE = /Cannot find module '([^']+)'/g;

// The tail is enough: the loader fails within the first lines of a launch, and
// only the most recent launch is being diagnosed.
const LOG_TAIL_BYTES = 64 * 1024;

// Seeks to the window rather than loading the file: this runs on a failure
// path that is already reporting an outage, and the router log is long-lived.
export function readLogTail(logPath, { maxBytes = LOG_TAIL_BYTES } = {}) {
  let descriptor;
  try {
    if (!existsSync(logPath)) return "";
    const { size } = statSync(logPath);
    if (size === 0) return "";
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    descriptor = openSync(logPath, "r");
    const read = readSync(descriptor, buffer, 0, length, size - length);
    // A window that starts mid-character would corrupt the first rune; the
    // patterns this feeds are anchored well inside the tail, so the partial
    // leading line is simply not worth reconstructing.
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    // A log the router cannot read is not evidence of anything; the caller
    // falls back to its generic message.
    return "";
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Nothing actionable; the diagnosis is best-effort by design.
      }
    }
  }
}

/**
 * Explain a Windows scheduled-task launch failure, or return undefined when
 * the log carries no evidence worth adding.
 *
 * Deliberately narrow. This only speaks when the loader named a module *and*
 * that path exists, because that combination has exactly one meaning: the
 * launch could not read a file that is present, which is a permission or
 * token problem rather than a broken checkout. Every other shape returns
 * undefined so the caller keeps its own wording instead of guessing.
 */
export function diagnoseWindowsLaunchFailure({ logText, exists = existsSync } = {}) {
  if (typeof logText !== "string" || !logText) return undefined;
  const named = [...logText.matchAll(MISSING_MODULE)].map((match) => match[1]);
  if (named.length === 0) return undefined;
  const modulePath = named.at(-1);
  if (!exists(modulePath)) {
    return (
      `The scheduled task could not start: Node reported ${modulePath} missing, ` +
      "and it is in fact absent. The managed checkout is incomplete — re-run the " +
      "installer to restore it."
    );
  }
  return (
    `The scheduled task could not start: Node reported ${modulePath} missing, ` +
    "but that file exists. The task's own token could not read it, which Node " +
    "surfaces as MODULE_NOT_FOUND. An installer run elevated can leave the " +
    "managed checkout readable only to the elevated identity, while the task " +
    "itself runs at Limited level.\n" +
    "Confirm with `icacls \"<checkout>\"` and grant the task's account read and " +
    "execute on it, or re-run the installer from a non-elevated shell so the " +
    "checkout and the task share one identity."
  );
}
