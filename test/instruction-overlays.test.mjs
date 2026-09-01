import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyInstructionOverlay,
} from "../src/instruction-overlays.mjs";
import { MODEL_BY_SLUG } from "../src/model-registry.mjs";

test("Grok 4.6 OAuth distinguishes local files from discovered MCP resources", () => {
  const model = MODEL_BY_SLUG.get("grok-oauth/grok-4.6");
  assert.equal(model?.instructionOverlay, "filesystem-mcp-discipline");

  const instructions = applyInstructionOverlay("Base instructions.", model.instructionOverlay);
  assert.match(instructions, /local filesystem paths as files, never as MCP resource URIs/i);
  assert.match(instructions, /server name and URI returned by MCP.*discovery/i);
  assert.match(instructions, /Never invent an MCP server name such as file/i);
  assert.match(instructions, /unknown server or invalid URI.*do not repeat/is);
  assert.match(instructions, /Keep using read_mcp_resource for valid resources/i);
});
