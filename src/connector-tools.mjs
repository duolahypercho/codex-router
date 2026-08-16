// `connector-tools list|enable <connector>|disable <connector>`
//
// Lists the app connectors Codex has cached locally, with the context each one
// costs, and records which of them the router should relay in full to routed
// models.

import {
  CONNECTOR_TOOL_CACHE_DIR,
  connectorToolCatalog,
} from "./codex-apps-connectors.mjs";
import {
  CONNECTOR_TOOLS_STATE_PATH,
  readConnectorSelection,
  writeConnectorSelection,
} from "./connector-tools-state.mjs";

// Rough, and labelled rough in the output: what the operator needs is the
// order of magnitude that tells them whether a connector fits their context.
function approximateTokens(bucket) {
  let chars = 0;
  for (const tool of bucket.tools.values()) chars += JSON.stringify(tool).length;
  return Math.round(chars / 4);
}

function connectorRows(catalog, selected) {
  return [...catalog.values()]
    .map((bucket) => ({
      connector: bucket.connector,
      label: bucket.connectorName,
      tools: bucket.tools.size,
      tokens: approximateTokens(bucket),
      enabled: selected.includes(bucket.connector) || selected.includes(bucket.name),
    }))
    .sort((a, b) => b.tokens - a.tokens);
}

function printList(rows) {
  if (rows.length === 0) {
    console.log(`No connector tools cached under ${CONNECTOR_TOOL_CACHE_DIR}.`);
    console.log("Connect an app in Codex, then run this again.");
    return;
  }
  const width = Math.max(...rows.map((row) => row.connector.length));
  console.log("  relayed  connector".padEnd(width + 13) + "tools   ~tokens");
  for (const row of rows) {
    const mark = row.enabled ? "yes" : " no";
    console.log(
      `      ${mark}  ${row.connector.padEnd(width)}  ${String(row.tools).padStart(5)}   ${String(
        row.tokens,
      ).padStart(7)}  ${row.label}`,
    );
  }
  const on = rows.filter((row) => row.enabled);
  const total = on.reduce((sum, row) => sum + row.tokens, 0);
  console.log("");
  console.log(
    on.length
      ? `Relaying ${on.length} connector(s), roughly ${total} tokens of tool schema per request.`
      : "Relaying none. Routed models see only the subset Codex sends inline.",
  );
  console.log(`Selection: ${CONNECTOR_TOOLS_STATE_PATH}`);
}

function resolve(catalog, name) {
  for (const bucket of catalog.values()) {
    if (bucket.connector === name || bucket.name === name) return bucket.connector;
  }
  return undefined;
}

export function main(argv = process.argv.slice(2)) {
  const [command, target] = argv;
  const catalog = connectorToolCatalog();
  const selected = readConnectorSelection();

  if (!command || command === "list") {
    printList(connectorRows(catalog, selected));
    return 0;
  }

  if (command !== "enable" && command !== "disable") {
    console.error("usage: connector-tools [list | enable <connector> | disable <connector>]");
    return 2;
  }
  if (!target) {
    console.error(`usage: connector-tools ${command} <connector>`);
    return 2;
  }

  if (command === "enable") {
    const connector = resolve(catalog, target);
    if (!connector) {
      console.error(`No cached connector named "${target}". Run \`connector-tools list\`.`);
      return 1;
    }
    const next = writeConnectorSelection([...selected, connector]);
    console.log(`Relaying ${connector}. Restart the router for it to take effect.`);
    printList(connectorRows(catalog, next));
    return 0;
  }

  // Disable resolves against the recorded selection too, so a connector that
  // has since left the cache can still be turned off.
  const connector = resolve(catalog, target) || target;
  if (!selected.includes(connector)) {
    console.log(`${connector} was not being relayed.`);
    return 0;
  }
  const next = writeConnectorSelection(selected.filter((entry) => entry !== connector));
  console.log(`Stopped relaying ${connector}. Restart the router for it to take effect.`);
  printList(connectorRows(catalog, next));
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main();
}
