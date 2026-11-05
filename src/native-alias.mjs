import { lstatSync, readFileSync } from "node:fs";

import { NATIVE_ALIAS_PATH } from "./paths.mjs";

// Native slots are persistent destination identities. Visibility may withdraw
// an alias, but cannot lend its slot to a different canonical model.
export function buildNativeAliasAssignments(nativeModels, externalModels, previousBindings = {}) {
  const slots = (Array.isArray(nativeModels) ? nativeModels : [])
    .filter((model) => model.visibility === "list" && typeof model.slug === "string")
    .sort((left, right) => {
      const priority = Number(left.priority ?? 999) - Number(right.priority ?? 999);
      return priority || String(left.slug).localeCompare(String(right.slug));
    });
  const bySlug = new Map(slots.map((slot) => [slot.slug, slot]));
  const bindings = new Map(Object.entries(previousBindings));
  const byTarget = new Map();
  for (const [slot, target] of bindings) {
    if (!byTarget.has(target)) byTarget.set(target, slot);
  }
  const available = slots.filter((slot) => !bindings.has(slot.slug));
  const assignments = [];
  for (const model of externalModels) {
    let slot;
    if (byTarget.has(model.slug)) {
      slot = bySlug.get(byTarget.get(model.slug));
    } else {
      slot = available.shift();
      if (slot) {
        bindings.set(slot.slug, model.slug);
        byTarget.set(model.slug, slot.slug);
      }
    }
    if (slot) assignments.push({ nativeModel: slot, model });
  }
  return { assignments, bindings: Object.fromEntries(bindings) };
}

function aliasMap(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.entries(value).every(([slot, target]) => slot && typeof target === "string" && target);
}

// Read once per publication or request. A present unreadable document cannot
// become an empty binding history and authorize reuse of an old client's slot.
export function readNativeAliasSnapshot(filePath = NATIVE_ALIAS_PATH) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      try {
        lstatSync(filePath);
      } catch (entryError) {
        if (entryError?.code === "ENOENT") {
          return { version: 1, mode: "native", aliases: {}, bindings: {} };
        }
      }
    }
    throw new Error("Native alias state is unreadable; refusing to replace reserved model slots.", { cause: error });
  }
  if (parsed?.version === 1 && aliasMap(parsed.aliases)
    && parsed.mode === undefined && parsed.bindings === undefined) {
    const aliases = { ...parsed.aliases };
    return { version: 1, mode: Object.keys(aliases).length ? "login-free" : "native", aliases, bindings: { ...aliases } };
  }
  if (parsed?.version !== 1 || !["native", "login-free"].includes(parsed.mode)
    || !aliasMap(parsed.aliases) || !aliasMap(parsed.bindings)
    || (parsed.mode === "native" && Object.keys(parsed.aliases).length)
    || Object.entries(parsed.aliases).some(([slot, target]) => !Object.hasOwn(parsed.bindings, slot) || parsed.bindings[slot] !== target)) {
    throw new Error("Native alias state is invalid; refusing to replace reserved model slots.");
  }
  return { version: 1, mode: parsed.mode, aliases: { ...parsed.aliases }, bindings: { ...parsed.bindings } };
}

// The caller supplies the actually loaded/routable registry lookup. A withdrawn
// binding, including an active alias whose route vanished, must not fall through
// to native redirect or passthrough. Explicit native mode keeps native traffic.
export function resolveNativeAliasRoute(requestedModel, snapshot, resolveRoute) {
  if (snapshot.mode !== "login-free") return { kind: "native" };
  if (Object.hasOwn(snapshot.aliases, requestedModel)) {
    const target = snapshot.aliases[requestedModel];
    const route = resolveRoute(target);
    return route ? { kind: "active", target, route } : { kind: "withdrawn", target };
  }
  if (Object.hasOwn(snapshot.bindings, requestedModel)) {
    return { kind: "withdrawn", target: snapshot.bindings[requestedModel] };
  }
  return { kind: "native" };
}

// Compatibility readers need only currently active aliases. Routing uses the
// strict snapshot interface above so an unreadable state cannot become native.
export function readNativeAliases() {
  try {
    return readNativeAliasSnapshot().aliases;
  } catch {
    return {};
  }
}

export function nativeAliasFor(externalSlug) {
  const aliases = readNativeAliases();
  return Object.keys(aliases).find((nativeSlug) => aliases[nativeSlug] === externalSlug);
}
