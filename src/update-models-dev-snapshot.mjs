import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  MODELS_DEV_SNAPSHOT_PATH,
  MODELS_DEV_URL,
  fetchModelsDevCatalog,
  filterModelsDevCatalog,
  readModelsDevSnapshot,
} from "./models-dev.mjs";

// Development-time maintenance of the models.dev snapshot: fetch the upstream
// catalog, filter it to the providers and fields the router uses, and rewrite
// config/models-dev.json. A refresh replaces the whole file, so hand-added
// models that upstream still lacks show up in the diff as removals — review
// the diff and restore the ones to keep before committing, like any other
// registry change. The router itself never runs this; installed machines read
// the committed file. For local hand edits, modify models-dev.json directly.

function modelCount(providers) {
  return Object.values(providers).reduce(
    (sum, provider) => sum + Object.keys(provider.models || {}).length,
    0,
  );
}

async function main() {
  const fixture = (() => {
    const index = process.argv.indexOf("--fixture");
    return index === -1 ? undefined : process.argv[index + 1];
  })();
  const previous = readModelsDevSnapshot();

  const catalog = fixture
    ? JSON.parse(readFileSync(path.resolve(fixture), "utf8"))
    : await fetchModelsDevCatalog({ timeoutMs: 30_000 });
  const providers = filterModelsDevCatalog(catalog);

  const snapshot = {
    version: 1,
    source: MODELS_DEV_URL,
    attribution: "Data from the MIT-licensed models.dev catalog (https://github.com/sst/models.dev).",
    fetchedAt: new Date().toISOString(),
    providers,
  };
  writeFileSync(MODELS_DEV_SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`);
  process.stdout.write(
    `Wrote ${MODELS_DEV_SNAPSHOT_PATH}: ` +
      `${modelCount(providers)} models across ${Object.keys(providers).length} providers` +
      (previous ? ` (previously ${modelCount(previous.providers)} models, fetched ${previous.fetchedAt})` : "") +
      ".\nReview the diff — restore any hand-added models it removed — and commit it.\n",
  );
}

main().catch((error) => {
  console.error(
    `codex-router update-models-dev-snapshot: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
