import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { protectPrivateFile } from "./file-security.mjs";
import { STATE_DIR } from "./paths.mjs";

export const MODEL_PICKER_STATE_PATH =
  process.env.MODEL_ROUTER_MODEL_PICKER_STATE ||
  path.join(STATE_DIR, "model-picker.json");

// Per-model visibility overrides for the router's client pickers. Hiding a
// model only changes the generated catalogs for this machine; the registry
// stays untouched. `visible` is persisted as well as `hidden`, so an explicit
// "show" choice has a durable, inspectable representation instead of looking
// like the model was never selected simply because it is absent from the
// hidden list.
//
// `hidden` answers "is this model off"; `seeded` answers the different question
// "has this model ever been decided" -- by the operator, or by a default the
// catalog build applied once. Absence from `hidden` cannot answer it, because
// that is also what a model nobody has ever seen looks like, and a default
// that cannot tell the two apart re-applies itself over the operator's choice
// on the next rebuild (see `seedModelsHidden`).
function readPickerState() {
  const empty = {
    hidden: new Set(),
    visible: new Set(),
    seeded: new Set(),
    hasExplicitVisibility: false,
  };
  if (!existsSync(MODEL_PICKER_STATE_PATH)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(MODEL_PICKER_STATE_PATH, "utf8"));
    if (parsed?.version !== 1 || !Array.isArray(parsed.hidden)) return empty;
    const slugs = (value) =>
      new Set((Array.isArray(value) ? value : []).map((slug) => String(slug)).filter(Boolean));
    const hidden = slugs(parsed.hidden);
    const seeded = slugs(parsed.seeded);
    // `visible` was added after version 1 shipped. For an older file, every
    // seeded model not in `hidden` is an explicit show decision and can be
    // reconstructed without changing the effective picker behavior.
    const hasExplicitVisibility = Array.isArray(parsed.visible);
    const visible = hasExplicitVisibility
      ? slugs(parsed.visible)
      : new Set([...seeded].filter((slug) => !hidden.has(slug)));
    for (const slug of hidden) visible.delete(slug);
    return { hidden, visible, seeded, hasExplicitVisibility };
  } catch {
    return empty;
  }
}

export function readHiddenModels() {
  return readPickerState().hidden;
}

// Routed picker publication is an allowlist.  Keep this separate from
// `hidden`: the latter preserves compatibility with older state files and
// answers why a model is off, while this records the operator's positive
// selection and is what every client publisher uses to decide what to show.
export function readVisibleModels() {
  return readPickerState().visible;
}

function writePickerState({ hidden, visible, seeded, hasExplicitVisibility = true }) {
  const stateDir = path.dirname(MODEL_PICKER_STATE_PATH);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const temporary = `${MODEL_PICKER_STATE_PATH}.tmp.${process.pid}`;
  writeFileSync(
    temporary,
    `${JSON.stringify(
      {
        version: 1,
        hidden: [...hidden].sort(),
        ...(hasExplicitVisibility
          ? { visible: [...visible].filter((slug) => !hidden.has(slug)).sort() }
          : {}),
        seeded: [...seeded].sort(),
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  protectPrivateFile(temporary);
  renameSync(temporary, MODEL_PICKER_STATE_PATH);
  protectPrivateFile(MODEL_PICKER_STATE_PATH);
  return modelPickerSnapshot();
}

export function modelPickerSnapshot() {
  const state = readPickerState();
  return {
    hidden: [...state.hidden].sort(),
    visible: [...state.visible].sort(),
    hasExplicitVisibility: state.hasExplicitVisibility,
    path: MODEL_PICKER_STATE_PATH,
  };
}

export function setModelVisible(slug, visible) {
  return setModelsVisible([slug], visible);
}

// Changes only the supplied models so provider-level actions preserve every
// other provider's picker choices.
export function setModelsVisible(slugs, visible) {
  const values = [...new Set(slugs.map((slug) => String(slug || "").trim()).filter(Boolean))];
  if (values.length === 0) throw new Error("At least one model slug is required.");
  const { hidden, visible: visibleSet, seeded } = readPickerState();
  for (const value of values) {
    if (visible) {
      hidden.delete(value);
      visibleSet.add(value);
    } else {
      hidden.add(value);
      visibleSet.delete(value);
    }
    // The operator just decided this one. Recording it is what stops a
    // shipped default from quietly undoing the decision later.
    seeded.add(value);
  }
  return writePickerState({ hidden, visible: visibleSet, seeded });
}

// Move an operator's picker decision when a curated model's routing identity
// changes. Protocol migrations change the slug even though the upstream model
// is the same; dropping the old decision would make an explicitly selected
// model disappear from the allowlisted picker on the next catalog rebuild.
// A decision already recorded on the destination wins over stale source state.
export function migrateModelVisibility(replacements) {
  const pairs = (Array.isArray(replacements) ? replacements : [])
    .map(({ from, to }) => ({
      from: String(from || "").trim(),
      to: String(to || "").trim(),
    }))
    .filter(({ from, to }) => from && to && from !== to);
  if (pairs.length === 0) return modelPickerSnapshot();

  const { hidden, visible, seeded, hasExplicitVisibility } = readPickerState();
  let changed = false;
  for (const { from, to } of pairs) {
    const sourceHidden = hidden.has(from);
    const sourceVisible = visible.has(from);
    const sourceSeeded = seeded.has(from);
    if (!sourceHidden && !sourceVisible && !sourceSeeded) continue;

    const destinationDecided = seeded.has(to);
    hidden.delete(from);
    visible.delete(from);
    seeded.delete(from);
    changed = true;

    if (!destinationDecided) {
      if (sourceHidden) {
        hidden.add(to);
        visible.delete(to);
      } else if (sourceVisible) {
        hidden.delete(to);
        visible.add(to);
      }
    }
    if (sourceSeeded) seeded.add(to);
  }
  return changed
    ? writePickerState({ hidden, visible, seeded, hasExplicitVisibility })
    : modelPickerSnapshot();
}

export function setAllModelsVisible(slugs, visible) {
  const known = [...new Set(slugs.map((slug) => String(slug).trim()).filter(Boolean))];
  const { hidden: currentHidden, visible: currentVisible, seeded } = readPickerState();
  const hiddenModels = visible
    ? new Set([...currentHidden].filter((slug) => !known.includes(slug)))
    : new Set([...currentHidden, ...known]);
  const visibleModels = visible
    ? new Set([...currentVisible, ...known])
    : new Set([...currentVisible].filter((slug) => !known.includes(slug)));
  return writePickerState({
    hidden: hiddenModels,
    visible: visibleModels,
    seeded: new Set([...seeded, ...known]),
  });
}

// Applies a shipped default to models the operator has never decided, and only
// to those. Used by the catalog build for entries that must arrive switched off
// (`src/native-context-variants.mjs`): they cost more per turn than the model
// they shadow, so an update must never turn one on by itself.
//
// Idempotent, and silent when there is nothing to record -- this runs on every
// catalog rebuild, and rewriting the operator's picker state to say nothing new
// is how a protected file starts churning.
export function seedModelsHidden(slugs) {
  const values = [...new Set(
    (Array.isArray(slugs) ? slugs : []).map((slug) => String(slug || "").trim()).filter(Boolean),
  )];
  const { hidden, visible, seeded, hasExplicitVisibility } = readPickerState();
  const fresh = values.filter((value) => !seeded.has(value));
  if (fresh.length === 0) return modelPickerSnapshot();
  for (const value of fresh) {
    hidden.add(value);
    visible.delete(value);
    seeded.add(value);
  }
  return writePickerState({ hidden, visible, seeded, hasExplicitVisibility });
}
