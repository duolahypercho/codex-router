// Which app connectors the operator wants relayed in full to routed models.
//
// Empty by default. Merging a connector costs real context -- Outlook's 46
// tools serialize to about 66k tokens -- so nothing is merged until someone
// asks for it by name, and an install that never opts in behaves exactly as it
// does today.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { writePrivateJson } from "./file-security.mjs";
import { STATE_DIR } from "./paths.mjs";

export const CONNECTOR_TOOLS_STATE_PATH =
  process.env.MODEL_ROUTER_CONNECTOR_TOOLS_STATE ||
  path.join(STATE_DIR, "connector-tools.json");

export function readConnectorSelection(statePath = CONNECTOR_TOOLS_STATE_PATH) {
  if (!existsSync(statePath)) return [];
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return [];
  }
  const connectors = parsed?.connectors;
  if (!Array.isArray(connectors)) return [];
  const unique = [];
  for (const entry of connectors) {
    if (typeof entry !== "string" || !entry) continue;
    if (!unique.includes(entry)) unique.push(entry);
  }
  return unique;
}

export function writeConnectorSelection(connectors, statePath = CONNECTOR_TOOLS_STATE_PATH) {
  const unique = [];
  for (const entry of Array.isArray(connectors) ? connectors : []) {
    if (typeof entry !== "string" || !entry) continue;
    if (!unique.includes(entry)) unique.push(entry);
  }
  unique.sort();
  writePrivateJson(statePath, { version: 1, connectors: unique });
  return unique;
}
