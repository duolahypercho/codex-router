// Pure helpers for the guided-setup terminal UI. Rendering and selection
// state carry no terminal I/O so both target setups share them and unit
// tests can cover every interaction without a PTY.

const ACTION_LABELS = Object.freeze({
  ready: "ready",
  "add-key": "needs API key",
  login: "needs CLI sign-in",
  install: "needs CLI install",
});

const COLOR_CODES = Object.freeze({
  green: "32",
  yellow: "33",
  red: "31",
  cyan: "36",
});

export function stepHeader(step, total, title) {
  return `\n--- Step ${step} of ${total}: ${title} ---\n`;
}

export function providerStatusLabel(snapshot) {
  return ACTION_LABELS[snapshot.action] || "setup required";
}

export function colorize(text, color, enabled) {
  const code = COLOR_CODES[color];
  if (!enabled || !code) return text;
  return `\u001b[${code}m${text}\u001b[0m`;
}

export function renderProviderChoices(snapshots, selected, colorEnabled = false) {
  return snapshots
    .map((snapshot, index) => {
      const position = index + 1;
      const mark = selected.has(position) ? "[x]" : "[ ]";
      const label = providerStatusLabel(snapshot);
      const colored = colorize(
        label,
        snapshot.action === "ready" ? "green" : "yellow",
        colorEnabled,
      );
      return `  ${mark} ${position}. ${snapshot.displayName} — ${colored}`;
    })
    .join("\n");
}

export function toggleSelection(selected, input, count) {
  const trimmed = String(input || "").trim().toLowerCase();
  if (trimmed === "") {
    if (selected.size === 0) {
      return { selected, error: "Select at least one provider." };
    }
    return { selected, done: true };
  }
  if (trimmed === "a" || trimmed === "all") {
    const all = new Set();
    for (let position = 1; position <= count; position += 1) all.add(position);
    return { selected: all };
  }
  if (trimmed === "n" || trimmed === "none") {
    return { selected: new Set() };
  }
  const next = new Set(selected);
  for (const part of trimmed.split(",")) {
    const value = Number(part.trim());
    if (!Number.isInteger(value) || value < 1 || value > count) {
      return { selected, error: `Invalid choice: ${part.trim()}` };
    }
    if (next.has(value)) {
      next.delete(value);
    } else {
      next.add(value);
    }
  }
  return { selected: next };
}
