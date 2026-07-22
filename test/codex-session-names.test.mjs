import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  sessionNameFromHeaders,
  threadIdFromHeaders,
} from "../src/codex-session-names.mjs";

const THREAD_ID = "019f8821-881a-7582-9e60-633bff68789f";

test("resolves a Codex thread header to its user-facing session name", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-session-name-"));
  const indexPath = path.join(directory, "session_index.jsonl");
  writeFileSync(
    indexPath,
    `${JSON.stringify({ id: THREAD_ID, thread_name: "  Add   thinking orb to island  " })}\n`,
  );

  assert.equal(
    sessionNameFromHeaders({ "thread-id": THREAD_ID }, { indexPath }),
    "Add thinking orb to island",
  );
});

test("finds nested thread metadata without exposing unrelated metadata", () => {
  assert.equal(
    threadIdFromHeaders({
      "x-codex-turn-metadata": JSON.stringify({ turn: { thread_id: THREAD_ID }, prompt: "private" }),
    }),
    THREAD_ID,
  );
  assert.equal(threadIdFromHeaders({ "x-codex-turn-metadata": "not-json" }), undefined);
});
