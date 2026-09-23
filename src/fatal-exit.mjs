// Issue #465: on Windows the router intermittently died with exit code
// 3221226505 (0xC0000409) and no JS frame, and the service log recorded only
// the bare number:
//
//   [codex-router] Codex router exited (code=3221226505, signal=null).
//
// That number alone identifies no subsystem. Microsoft documents 0xC0000409 as
// the generic __fastfail envelope; the actual reason rides in fast-fail
// parameter 0, which only a debugger or a Node diagnostic report can show.
// The reporter additionally found that WER LocalDumps captures nothing for
// these deaths, because __fastfail bypasses the vectored/SEH path LocalDumps
// hooks -- so the one artifact a bare exit line asks for is the one that is
// never written.
//
// The native root cause is still unconfirmed (a V8/JIT fast-fail on Windows
// build 26200, nodejs/node#62260, remains the closer upstream match, and no
// public Node issue ties node:zlib's zstd decoder to this status), so there is
// deliberately no behavior change here. What this module does is make the
// supervisor's exit line classify the death the way the router's own listen
// failures already do (src/router.mjs): name the Windows fatal status when the
// exit code is one, and point at the credential-safe capture that can settle
// the next occurrence. Ordinary exits and signalled exits render exactly as
// before, so existing log assertions are unaffected.

// High-confidence Windows fatal NTSTATUS values a Node child surfaces as its
// exit code (unsigned). The set is intentionally small: these are the process
// killers with no JS frame, not every status Windows defines.
const WINDOWS_FATAL_EXIT_NAMES = new Map([
  [0xC0000005, "STATUS_ACCESS_VIOLATION"],
  [0xC000001D, "STATUS_ILLEGAL_INSTRUCTION"],
  [0xC0000374, "STATUS_HEAP_CORRUPTION"],
  [0xC0000409, "STATUS_STACK_BUFFER_OVERRUN"],
  [0xC00000FD, "STATUS_STACK_OVERFLOW"],
]);

function unsignedExitCode(code) {
  if (typeof code !== "number" || !Number.isInteger(code)) return undefined;
  // Node reports Windows fatal statuses unsigned (3221226505), but accept the
  // signed form (-1073740791) too so both spellings classify the same death.
  return code >>> 0;
}

// A process-level native abort: no signal, and the code sits in the NTSTATUS
// error range. Ordinary failures (exit 1, 94-98) and external kills (SIGTERM,
// SIGKILL) are not this and must not gain the capture pointer below.
export function isWindowsFatalExit(exit) {
  if (exit?.signal !== null && exit?.signal !== undefined) return false;
  const code = unsignedExitCode(exit?.code);
  return code !== undefined && code >= 0xC0000000;
}

function hexExitCode(code) {
  return `0x${code.toString(16).toUpperCase().padStart(8, "0")}`;
}

// The `code=…, signal=…` fragment supervisors log, with the fatal status named
// when the code is one. Every other exit renders byte-identical to before.
export function describeChildExit(exit) {
  const base = `code=${String(exit?.code)}, signal=${String(exit?.signal)}`;
  if (!isWindowsFatalExit(exit)) return base;
  const code = unsignedExitCode(exit.code);
  const name = WINDOWS_FATAL_EXIT_NAMES.get(code);
  return name ? `${base} (${hexExitCode(code)} ${name})` : `${base} (${hexExitCode(code)})`;
}

// What to capture after a native abort, or undefined for any other exit. The
// pointer is credential-safe by construction: it names the exclusion flags and
// the sanitized extract, and it forbids uploading raw reports or dumps, which
// may carry the caller capability, provider credentials, or process memory
// (see the security correction on issue #465). 0xC0000409 is called out
// explicitly because it is only the __fastfail envelope -- fast-fail parameter
// 0 is the piece that distinguishes a zstd defect from a V8 fast-fail on OOM
// or a JIT-tier fault.
export function fatalExitFollowUp(exit) {
  if (!isWindowsFatalExit(exit)) return undefined;
  const code = unsignedExitCode(exit.code);
  const name = WINDOWS_FATAL_EXIT_NAMES.get(code);
  const what = name ? `${hexExitCode(code)} ${name}` : hexExitCode(code);
  return (
    `Native abort with no JS frame (${what}): capture the Event Viewer Application entry and ` +
    `WinDbg '!analyze -v' -- fast-fail parameter 0 is the actual reason, the status alone is the envelope. ` +
    `For a Node child, arm NODE_OPTIONS=--report-on-fatalerror --report-uncaught-exception ` +
    `--report-exclude-env --report-exclude-network with a private --report-directory. ` +
    `Do not upload raw reports or dumps (they may carry credentials); attach only versions, stack frames, ` +
    `the exception code with parameter 0, and the surrounding log lines. Related to issue #465.`
  );
}
