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
    // "Nothing has ever been recorded here" and "the file says nothing is
    // hidden" are different machines, and only the second one has a history
    // worth preserving (see `migrateLegacyVisibleModels`).
    recognized: false,
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
    return { hidden, visible, seeded, hasExplicitVisibility, recognized: true };
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

// Answers "which of these models is the picker showing right now" with the
// same rule every publisher applies, so a surface that offers the operator a
// pre-filled list starts from what they are actually looking at rather than
// from one of the two representations. A machine with no picker state has
// decided nothing, and new router models are opt-in, so the answer there is
// "none" -- not "all of them", which is what `hidden` being empty would say.
export function effectiveVisibleModels(slugs) {
  const values = [...new Set(
    (Array.isArray(slugs) ? slugs : []).map((slug) => String(slug || "").trim()).filter(Boolean),
  )];
  const { hidden, visible, hasExplicitVisibility, recognized } = readPickerState();
  if (!recognized) return new Set();
  return new Set(
    values.filter((value) => (hasExplicitVisibility ? visible.has(value) : !hidden.has(value))),
  );
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

// Applies one explicit picker selection to the supplied models while leaving
// every other provider's visibility untouched.
//
// `hasExplicitVisibility` is threaded through for the same reason
// `seedModelsHidden` threads it: this call sees one screen's worth of models,
// and turning a legacy file into an allowlist answers for every provider it
// never looked at -- with "off", because they are absent from `visible`. The
// selection is still durable on such a file, through `hidden` and `seeded`,
// which is the representation that file already speaks. A file the catalog
// build has migrated is an allowlist already and stays one.
export function setModelSelection(slugs, selectedSlugs) {
  const values = [...new Set(
    (Array.isArray(slugs) ? slugs : []).map((slug) => String(slug || "").trim()).filter(Boolean),
  )];
  if (values.length === 0) return modelPickerSnapshot();
  const selected = new Set(
    (Array.isArray(selectedSlugs) ? selectedSlugs : [])
      .map((slug) => String(slug || "").trim())
      .filter(Boolean),
  );
  const { hidden, visible, seeded, hasExplicitVisibility } = readPickerState();
  for (const value of values) {
    if (selected.has(value)) {
      hidden.delete(value);
      visible.add(value);
    } else {
      hidden.add(value);
      visible.delete(value);
    }
    seeded.add(value);
  }
  return writePickerState({ hidden, visible, seeded, hasExplicitVisibility });
}

// Bridges one install from the pre-allowlist file format, exactly once.
//
// Before `visible` existed, "absent from `hidden`" was the whole answer to "is
// this model in the picker", so every routed model the operator had not
// switched off was showing. The allowlist asks a different question, and a
// slug that was never recorded at all answers it "off" -- which is how the
// first catalog rebuild after an update emptied a whole provider out of the
// picker (issue #338): `seedModelsHidden` read those slugs as never-decided
// and applied the opt-in default to models that were visibly already on.
//
// So record the old answer for the models that had one, in the moment before
// the default gets to speak. Deliberately hidden stays hidden, and a slug
// already in `seeded` has been decided by someone -- neither is this
// function's business. A machine with no picker state has no history to
// preserve, so opt-in stays opt-in on a fresh install.
//
// This cannot repair an install that has already run the new build: there the
// slugs sit in `hidden` and `seeded`, which is byte-for-byte what a deliberate
// hide looks like. That machine needs `control picker provider <id> show`, and
// guessing on its behalf would switch models back on that someone switched
// off.
export function migrateLegacyVisibleModels(slugs) {
  const { hidden, visible, seeded, hasExplicitVisibility, recognized } = readPickerState();
  if (!recognized || hasExplicitVisibility) return modelPickerSnapshot();
  const values = [...new Set(
    (Array.isArray(slugs) ? slugs : []).map((slug) => String(slug || "").trim()).filter(Boolean),
  )];
  const legacy = values.filter((value) => !hidden.has(value) && !seeded.has(value));
  if (legacy.length === 0) return modelPickerSnapshot();
  for (const value of legacy) {
    visible.add(value);
    // Recording the decision is the point: without it the opt-in default
    // immediately below would still read these slugs as never-decided.
    seeded.add(value);
  }
  return writePickerState({ hidden, visible, seeded });
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
