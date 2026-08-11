// Guards the committed Homebrew formula against silent staleness.
//
// The formula embeds every pinned Python resource, so a change to
// requirements/python.txt leaves it wrong without touching the version. Nothing
// about the checked-in file looks different in that state, and the next release
// would ship a tap that installs a different dependency set than the lock
// describes. This regenerates the formula from the version, URL, and checksum
// the committed file already declares, and fails when the result differs.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildFormula, FORMULA_PATH } from "./generate-formula.mjs";

const sourceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

function field(contents, name, pattern) {
  const match = pattern.exec(contents);
  if (!match) {
    throw new Error(`The committed formula declares no ${name}.`);
  }
  return match[1];
}

function releaseVersion(sourceUrl) {
  const match = /\/codex-router-([^/]+)\.tar\.gz$/.exec(sourceUrl);
  if (!match) {
    throw new Error(
      "The committed formula URL must end with codex-router-VERSION.tar.gz.",
    );
  }
  return match[1];
}

async function main() {
  const formulaPath = path.join(sourceRoot, FORMULA_PATH);
  let committed;
  try {
    committed = readFileSync(formulaPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    // The first release writes this file; before then there is nothing to drift.
    process.stdout.write(
      `${JSON.stringify({ checked: false, reason: `${FORMULA_PATH} does not exist yet` })}\n`,
    );
    return;
  }

  const sourceUrl = field(committed, "url", /^\s*url\s+"([^"]+)"/m);
  const regenerated = await buildFormula({
    version: releaseVersion(sourceUrl),
    sourceUrl,
    sourceSha256: field(committed, "sha256", /^\s*sha256\s+"([a-f0-9]{64})"/m),
    pythonFormula: field(committed, "Python formula", /depends_on\s+"(python@[\d.]+)"/),
    pythonVersion: field(committed, "Python version", /depends_on\s+"python@([\d.]+)"/),
  });

  if (regenerated === committed) {
    process.stdout.write(`${JSON.stringify({ checked: true, drifted: false })}\n`);
    return;
  }

  const committedLines = committed.split("\n");
  const regeneratedLines = regenerated.split("\n");
  // A committed file that is a prefix of the regenerated one has no differing
  // line at all, and findIndex then reports -1 -- which would print line 0 and
  // quote two identical lines. The first missing line is the difference there.
  const differing = committedLines.findIndex(
    (line, index) => line !== regeneratedLines[index],
  );
  const firstDifference = differing === -1 ? committedLines.length : differing;
  throw new Error(
    [
      `${FORMULA_PATH} no longer matches requirements/python.txt.`,
      `First difference at line ${firstDifference + 1}:`,
      `  committed:    ${committedLines[firstDifference] ?? "(end of file)"}`,
      `  regenerated:  ${regeneratedLines[firstDifference] ?? "(end of file)"}`,
      "",
      "Regenerate it with packaging/homebrew/generate-formula.mjs using the",
      "version, URL, and checksum of the release the formula points at.",
    ].join("\n"),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
