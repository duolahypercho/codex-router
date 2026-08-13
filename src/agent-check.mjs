import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findCodexBinary } from "./codex-binary.mjs";
import { spawnableCommand } from "./spawnable-command.mjs";

// Whether a local model can drive Codex is not predictable from its size, its
// tool flag, or a hand-written probe. Every approximation tried here got it
// backwards at least once: a 3B model that emits perfect tool calls against a
// short prompt answers about its own instructions when Codex's real ~24K-token
// prompt is in front of it, and a 7B model that returns tool calls as plain
// text on Ollama's OpenAI surface dispatches them correctly through the
// router's native route.
//
// So the check runs the real client. `codex exec` sends exactly what a user's
// turn sends, through the same router, with the same instructions and tools --
// there is nothing left to approximate, and nothing to get subtly wrong.

const CHECK_PROMPT =
  "Use your shell tool to list the files in the current directory, then state how many there are.";

export function gradeCodexRun({ status, stdout = "", stderr = "" }, marker) {
  const output = `${stdout}\n${stderr}`;
  // The marker file exists only in the scratch workspace, so seeing its name
  // means the model actually ran a command and read real output rather than
  // describing what it might do.
  if (output.includes(marker)) {
    return { verdict: "agent", detail: "ran a tool and reported real output" };
  }
  // The classic small-model failure: a tool call rendered as prose, which no
  // client can dispatch, often naming a tool that was never offered.
  if (/\{\s*"(name|tool|function|parameters)"\s*:/.test(output)) {
    return { verdict: "text-tool-calls", detail: "emitted a tool call as text" };
  }
  if (/\b(create_goal|list_agents|create_task)\b/.test(output)) {
    return { verdict: "invents-tools", detail: "called a tool that does not exist" };
  }
  if (status !== 0) return { verdict: "error", detail: `codex exited ${status}` };
  return { verdict: "no-tool-use", detail: "answered without using a tool" };
}

// One run is not a verdict. A borderline model passed here and failed minutes
// later on the same prompt, so a single sample reports luck rather than
// capability. Every attempt must succeed to earn "agent"; a mixed result is
// reported as flaky, which is the honest answer for a model you cannot rely on.
export function checkAgentCapability(slug, options = {}) {
  const attempts = Math.max(1, options.attempts ?? 2);
  const runs = [];
  for (let index = 0; index < attempts; index += 1) {
    const run = runAgentCheckOnce(slug, options);
    runs.push(run);
    if (run.verdict === "not-published" || !run.ok) break;
    if (run.verdict !== "agent") break; // a failure settles it; no need to retry
  }
  const last = runs[runs.length - 1];
  const passed = runs.filter((run) => run.verdict === "agent").length;
  if (last.verdict === "not-published" || !last.ok) return { ...last, runs: runs.length };
  const consistent = passed === runs.length && runs.length >= attempts;
  return {
    ...last,
    runs: runs.length,
    passed,
    agentCapable: consistent,
    verdict: consistent ? "agent" : passed > 0 ? "flaky" : last.verdict,
    detail: consistent
      ? `ran a tool and reported real output (${passed}/${runs.length})`
      : passed > 0
        ? `passed ${passed} of ${runs.length} runs -- not dependable`
        : last.detail,
  };
}

function runAgentCheckOnce(
  slug,
  {
    codex = findCodexBinary(),
    spawn = spawnSync,
    timeoutMs = 420_000,
    catalogSlugs,
    platform = process.platform,
  } = {},
) {
  if (!codex) return { slug, ok: false, error: "No Codex binary found." };
  // A slug Codex cannot resolve does not fail loudly -- it quietly serves the
  // request from another model, and the check then grades that model instead.
  // Every unpublished model "passed" this way before the guard existed.
  if (catalogSlugs && !catalogSlugs.has(slug)) {
    return {
      slug,
      ok: true,
      verdict: "not-published",
      detail: "not offered to Codex, so nothing to measure",
      agentCapable: false,
    };
  }
  const workspace = mkdtempSync(path.join(os.tmpdir(), "codex-agent-check-"));
  // A distinctive name so the grader cannot mistake a hallucinated listing for
  // a real one.
  const marker = `agentcheck-${Math.abs(hash(slug))}.txt`;
  const startedAt = Date.now();
  try {
    writeFileSync(path.join(workspace, marker), "ok\n", "utf8");
    // The prompt is a whole sentence, so this cannot go through a naive
    // `shell: true` -- that joins arguments on spaces and would hand Codex
    // eighteen arguments instead of one. spawnableCommand quotes for cmd.exe.
    const target = spawnableCommand(
      codex,
      [
        "exec",
        "--ephemeral",
        "--sandbox",
        "read-only",
        "--model",
        slug,
        "--skip-git-repo-check",
        CHECK_PROMPT,
      ],
      platform,
    );
    const result = spawn(target.command, target.args, {
      ...target.options,
      cwd: workspace,
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
    });
    const graded = gradeCodexRun(
      { status: result.status, stdout: result.stdout, stderr: result.stderr },
      marker,
    );
    return {
      slug,
      ok: true,
      seconds: Math.round((Date.now() - startedAt) / 100) / 10,
      // Only a model that actually dispatched a tool and used its output can
      // carry a real Codex turn.
      agentCapable: graded.verdict === "agent",
      ...graded,
    };
  } catch (error) {
    return { slug, ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

// Small, stable, and dependency-free; only used to make the marker filename
// distinctive per model.
function hash(value) {
  let total = 0;
  for (const character of String(value)) total = (total * 31 + character.charCodeAt(0)) | 0;
  return total;
}

// The merged catalog is what Codex will actually resolve.
export async function publishedSlugs() {
  try {
    const { MERGED_CATALOG_PATH } = await import("./paths.mjs");
    const { readFileSync } = await import("node:fs");
    const parsed = JSON.parse(readFileSync(MERGED_CATALOG_PATH, "utf8"));
    return new Set((parsed.models || []).map((model) => String(model.slug)));
  } catch {
    return undefined;
  }
}

async function main() {
  const slugs = process.argv.slice(2).filter((value) => !value.startsWith("--"));
  let candidates = slugs;
  if (!candidates.length) {
    const { readLocalModelSelection } = await import("./local-models.mjs");
    candidates = readLocalModelSelection().enabled.map((tag) => `local/${tag}`);
  }
  if (!candidates.length) throw new Error("No local models are checked.");
  const catalogSlugs = await publishedSlugs();
  process.stdout.write(`${"model".padEnd(28)}${"verdict".padEnd(18)}${"time".padEnd(8)}detail\n`);
  for (const slug of candidates) {
    const result = checkAgentCapability(slug, { catalogSlugs });
    process.stdout.write(
      `${slug.padEnd(28)}${(result.ok ? result.verdict : "error").padEnd(18)}${
        `${result.seconds ?? "-"}s`.padEnd(8)
      }${result.detail || result.error || ""}\n`,
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
