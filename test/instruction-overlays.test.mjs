import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyGrokFileToolsOverlay,
  applyInstructionOverlay,
  grokFileToolsOverlayFor,
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

test("Grok file-tool overlay is available without replacing the catalog MCP overlay", () => {
  const model = MODEL_BY_SLUG.get("grok-oauth/grok-4.6");
  assert.equal(model?.instructionOverlay, "filesystem-mcp-discipline");
  const gated = applyInstructionOverlay("Base instructions.", "grok-file-tools");
  assert.match(gated, /search_replace/);
  assert.match(gated, /read_file/);
  assert.match(gated, /run_terminal_command is only for processes/i);
  assert.match(gated, /Do not dump minified node_modules/i);
  assert.doesNotMatch(gated, /Create files with write/);
  assert.doesNotMatch(gated, /write is create-only/);
  const withWrite = applyInstructionOverlay("Base instructions.", "grok-file-tools-write");
  assert.match(withWrite, /Create files with write/);
  assert.match(withWrite, /write is create-only/);
});

test("file-tool overlay only names the installed façade tools", () => {
  const searchOnly = grokFileToolsOverlayFor(new Set(["search_replace"]));
  assert.match(searchOnly, /search_replace/);
  assert.doesNotMatch(searchOnly, /read_file/);
  assert.doesNotMatch(searchOnly, /run_terminal_command/);
  const applied = applyGrokFileToolsOverlay("Base.", new Set(["search_replace", "write"]));
  assert.match(applied, /Create files with write/);
  assert.doesNotMatch(applied, /read_file/);
});
