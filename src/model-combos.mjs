const COMBO_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const IDENTIFIER = /^[^\s\x00-\x1f\x7f]{1,240}$/;
const STRATEGIES = new Set(["failover", "round-robin"]);
const CAPABILITIES = new Set(["tools", "vision", "search"]);
const OUTCOMES = new Set(["success", "retryable_failure", "terminal_failure"]);
const MAX_WEIGHT = 1_000;
const MAX_TARGETS = 100;
const MAX_STICKY_LIMIT = 100_000;
const MAX_SESSIONS = 1_000;
const DEFAULT_STICKY_LIMIT = 20;

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function identifier(value) {
  const result = text(value);
  return result && IDENTIFIER.test(result) ? result : "";
}

function targetSlug(target) {
  const model = text(target?.model);
  const slug = text(target?.slug);
  if (model && slug && model !== slug) {
    throw new Error("A combo target cannot declare different model and slug identities.");
  }
  return slug || model;
}

function targetKey(target) {
  return target.slug;
}

function modelIdentity(model) {
  return text(model?.slug);
}

function modelProvider(model) {
  return text(model?.provider);
}

function normalizedCapabilities(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => text(item).toLowerCase()).filter(Boolean))];
}

function declaredCapability(model, capability) {
  if (typeof model?.supportsTools === "boolean" && capability === "tools") return model.supportsTools;
  if (typeof model?.supportsVision === "boolean" && capability === "vision") return model.supportsVision;
  if (typeof model?.supportsSearch === "boolean" && capability === "search") return model.supportsSearch;
  if (typeof model?.toolCalling === "boolean" && capability === "tools") return model.toolCalling;
  if (typeof model?.tools === "boolean" && capability === "tools") return model.tools;
  if (Array.isArray(model?.capabilities)) return model.capabilities.map((item) => text(item).toLowerCase()).includes(capability);
  if (Array.isArray(model?.supportedCapabilities)) return model.supportedCapabilities.map((item) => text(item).toLowerCase()).includes(capability);
  if (Array.isArray(model?.experimentalSupportedTools) && capability === "tools") return model.experimentalSupportedTools.length > 0;
  if (Array.isArray(model?.supportedTools) && capability === "tools") return model.supportedTools.length > 0;
  if (Array.isArray(model?.inputModalities) && capability === "vision") return model.inputModalities.some((item) => text(item).toLowerCase() === "image");
  if (capability === "search" && model?.searchTool && typeof model.searchTool === "object" && !Array.isArray(model.searchTool)) return true;
  return undefined;
}

function capabilityStatus(model, required, estimatedTokens) {
  const requested = normalizedCapabilities(required);
  const unsupported = requested.filter((capability) => !CAPABILITIES.has(capability));
  if (unsupported.length) return { eligible: false, reason: `unsupported-capability:${unsupported.join(",")}` };
  const unknown = requested.filter((capability) => declaredCapability(model, capability) === undefined);
  if (unknown.length) return { eligible: false, reason: `capability-unknown:${unknown.join(",")}` };
  const missing = requested.filter((capability) => declaredCapability(model, capability) !== true);
  if (missing.length) return { eligible: false, reason: `missing-capability:${missing.join(",")}` };
  if (Number.isFinite(estimatedTokens) && Number.isFinite(Number(model?.contextWindow)) && Number(model.contextWindow) < estimatedTokens) {
    return { eligible: false, reason: "context-window-too-small" };
  }
  return { eligible: true };
}

function healthForTarget(target, health) {
  if (!health) return { healthy: false, reason: "health-unknown" };
  const key = targetKey(target);
  const value = health instanceof Map ? health.get(key) : health[key];
  if (value === true) return { healthy: true };
  if (value === false) return { healthy: false, reason: "unhealthy" };
  if (!value || typeof value !== "object" || Array.isArray(value)) return { healthy: false, reason: "health-unknown" };
  if (value.healthy === true || ["healthy", "ready", "ok", "available"].includes(text(value.status).toLowerCase())) return { healthy: true };
  if (value.healthy === false || ["unhealthy", "cooldown", "unavailable"].includes(text(value.status).toLowerCase())) {
    const reason = text(value.reason).toLowerCase();
    return { healthy: false, reason: /^[a-z0-9][a-z0-9._:-]{0,63}$/.test(reason) ? reason : text(value.status).toLowerCase() || "unhealthy" };
  }
  return { healthy: false, reason: "health-unknown" };
}

function normalizeTarget(raw, index) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`targets[${index}] must be an object.`);
  const provider = identifier(raw.provider || raw.providerId);
  let slug = identifier(targetSlug(raw));
  if (!provider) throw new Error(`targets[${index}].provider must be a non-empty id.`);
  if (!slug) throw new Error(`targets[${index}].slug must be a non-empty model slug.`);
  if (!slug.includes("/")) slug = `${provider}/${slug}`;
  if (!slug.startsWith(`${provider}/`)) throw new Error(`targets[${index}].slug must be namespaced under its provider.`);
  const weight = raw.weight === undefined ? 1 : raw.weight;
  if (!Number.isInteger(weight) || weight < 1 || weight > MAX_WEIGHT) throw new Error(`targets[${index}].weight must be an integer between 1 and ${MAX_WEIGHT}.`);
  return Object.freeze({ provider, slug, weight });
}

export function normalizeComboDefinition(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Combo must be an object.");
  const id = text(raw.id || raw.name);
  if (!COMBO_ID.test(id)) throw new Error("Combo id must be lower-case letters, numbers, dot, underscore or dash.");
  const displayName = text(raw.displayName || raw.label || id);
  if (!displayName || displayName.length > 240) throw new Error("Combo displayName must be non-empty and at most 240 characters.");
  const strategy = text(raw.strategy || "failover").toLowerCase();
  if (!STRATEGIES.has(strategy)) throw new Error("Combo strategy must be failover or round-robin.");
  const sticky = raw.sticky === undefined ? false : raw.sticky;
  if (typeof sticky !== "boolean") throw new Error("Combo sticky must be a boolean.");
  const stickyLimit = raw.stickyLimit === undefined ? DEFAULT_STICKY_LIMIT : raw.stickyLimit;
  if (!Number.isInteger(stickyLimit) || stickyLimit < 1 || stickyLimit > MAX_STICKY_LIMIT) throw new Error("Combo stickyLimit must be a positive integer no greater than 100000.");
  if (!Array.isArray(raw.targets) || raw.targets.length === 0 || raw.targets.length > MAX_TARGETS) throw new Error(`Combo targets must contain between 1 and ${MAX_TARGETS} entries.`);
  const targets = raw.targets.map(normalizeTarget);
  const seen = new Set();
  for (const target of targets) {
    const key = targetKey(target);
    if (seen.has(key)) throw new Error(`Combo targets contain duplicate ${key}.`);
    seen.add(key);
  }
  return Object.freeze({ id, displayName, strategy, sticky, stickyLimit, targets: Object.freeze(targets) });
}

export function validateComboDefinition(raw) {
  try {
    return { ok: true, definition: normalizeComboDefinition(raw), errors: [] };
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
}

function cloneState(raw) {
  const state = { version: 1, cursors: {}, affinity: {} };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return state;
  for (const [comboId, value] of Object.entries(raw.cursors || {})) {
    if (COMBO_ID.test(comboId) && Number.isInteger(value) && value >= 0) state.cursors[comboId] = value;
  }
  for (const [comboId, sessions] of Object.entries(raw.affinity || {})) {
    if (!COMBO_ID.test(comboId) || !sessions || typeof sessions !== "object" || Array.isArray(sessions)) continue;
    const entries = Object.entries(sessions).slice(0, MAX_SESSIONS);
    state.affinity[comboId] = {};
    for (const [session, value] of entries) {
      if (!identifier(session) || !value || typeof value !== "object" || Array.isArray(value)) continue;
      const target = identifier(value.target);
      const count = Number.isInteger(value.count) && value.count > 0 ? value.count : 0;
      if (target && count) state.affinity[comboId][session] = { target, count };
    }
  }
  return state;
}

export function normalizeComboState(raw) {
  if (raw !== undefined && raw !== null && (typeof raw !== "object" || Array.isArray(raw))) throw new Error("Combo state must be an object.");
  return cloneState(raw);
}

export function createComboState() {
  return normalizeComboState();
}

function modelForTarget(target, models) {
  if (!Array.isArray(models)) return undefined;
  return models.find((model) => modelProvider(model) === target.provider && modelIdentity(model) === target.slug);
}

function expandedTargets(targets) {
  return targets.flatMap((target) => Array.from({ length: target.weight }, () => target));
}

function nextCursorFor(targets, current, selectedKey, failed) {
  const cycle = expandedTargets(targets);
  if (!cycle.length) return 0;
  const start = ((current % cycle.length) + cycle.length) % cycle.length;
  let selected = start;
  while (targetKey(cycle[selected]) !== selectedKey) selected = (selected + 1) % cycle.length;
  if (failed) {
    let candidate = (selected + 1) % cycle.length;
    while (candidate !== selected && targetKey(cycle[candidate]) === selectedKey) candidate = (candidate + 1) % cycle.length;
    return candidate;
  }
  return (selected + 1) % cycle.length;
}

function resolveWithState(combo, options) {
  const state = normalizeComboState(options.state ?? options.affinityState);
  const requestedSession = identifier(options.sessionKey);
  const skipped = [];
  const eligible = [];
  for (const target of combo.targets) {
    const model = modelForTarget(target, options.models);
    if (!model) {
      skipped.push({ target: targetKey(target), reason: "missing-model-metadata" });
      continue;
    }
    const capability = capabilityStatus(model, options.requiredCapabilities, options.estimatedTokens);
    if (!capability.eligible) {
      skipped.push({ target: targetKey(target), reason: capability.reason });
      continue;
    }
    let health;
    if (typeof options.isHealthy === "function") {
      const observed = options.isHealthy(target, model);
      health = observed === true
        ? { healthy: true }
        : { healthy: false, reason: observed === false ? "unhealthy" : "health-unknown" };
    } else {
      health = healthForTarget(target, options.health);
    }
    if (!health.healthy) {
      skipped.push({ target: targetKey(target), reason: health.reason });
      continue;
    }
    eligible.push(target);
  }
  const diagnostics = {
    combo: combo.id,
    strategy: combo.strategy,
    requestedCapabilities: normalizedCapabilities(options.requiredCapabilities),
    candidateCount: combo.targets.length,
    eligibleCount: eligible.length,
    skipped,
    stickyHit: false,
  };
  if (!eligible.length) {
    diagnostics.reason = skipped.length && skipped.every((entry) => ["unhealthy", "cooldown", "health-unknown"].includes(entry.reason))
      ? "no-healthy-target"
      : "no-eligible-target";
    return { ok: false, reason: diagnostics.reason, state, affinityState: state.affinity, diagnostics };
  }

  const affinity = requestedSession && combo.sticky ? state.affinity[combo.id]?.[requestedSession] : undefined;
  const stickyTarget = affinity && affinity.count < combo.stickyLimit
    ? eligible.find((target) => targetKey(target) === affinity.target)
    : undefined;
  let selected = stickyTarget;
  let cursor = Number.isInteger(state.cursors[combo.id]) ? state.cursors[combo.id] : 0;
  if (selected) diagnostics.stickyHit = true;
  if (!selected && combo.strategy === "failover") {
    const expired = affinity?.count >= combo.stickyLimit ? affinity.target : undefined;
    selected = eligible.find((target) => targetKey(target) !== expired) || eligible[0];
  }
  if (!selected && combo.strategy === "round-robin") {
    const cycle = expandedTargets(combo.targets);
    cursor = ((cursor % cycle.length) + cycle.length) % cycle.length;
    for (let offset = 0; offset < cycle.length; offset += 1) {
      const candidate = cycle[(cursor + offset) % cycle.length];
      if (eligible.some((entry) => targetKey(entry) === targetKey(candidate))) {
        cursor = (cursor + offset) % cycle.length;
        selected = candidate;
        break;
      }
    }
  }
  if (!selected) {
    diagnostics.reason = "no-selection";
    return { ok: false, reason: diagnostics.reason, state, affinityState: state.affinity, diagnostics };
  }
  const selectedKey = targetKey(selected);
  const attempt = Object.freeze({ version: 1, comboId: combo.id, targetKey: selectedKey, sessionKey: requestedSession || undefined, cursor });
  diagnostics.selected = selectedKey;
  diagnostics.reason = diagnostics.stickyHit ? "sticky" : "selected";
  return {
    ok: true,
    combo: { id: combo.id, displayName: combo.displayName, strategy: combo.strategy },
    target: selected,
    targetKey: selectedKey,
    attempt,
    state,
    affinityState: state.affinity,
    diagnostics,
  };
}

export function beginComboAttempt(definition, options = {}) {
  return resolveWithState(normalizeComboDefinition(definition), options);
}

export function resolveComboTarget(definition, options = {}) {
  return beginComboAttempt(definition, options);
}

export function completeComboAttempt(definition, rawState, attempt, { outcome = "success" } = {}) {
  const combo = normalizeComboDefinition(definition);
  const state = normalizeComboState(rawState);
  if (!attempt || attempt.version !== 1 || attempt.comboId !== combo.id) throw new Error("Combo attempt does not belong to this combo.");
  if (!OUTCOMES.has(outcome)) throw new Error("Combo attempt outcome is invalid.");
  const target = combo.targets.find((candidate) => targetKey(candidate) === attempt.targetKey);
  if (!target) throw new Error("Combo attempt target is not part of this combo.");
  if (combo.strategy === "round-robin") {
    const current = Number.isInteger(state.cursors[combo.id]) ? state.cursors[combo.id] : 0;
    if (Number.isInteger(attempt.cursor) && current !== attempt.cursor) throw new Error("Combo attempt is stale; refusing to overwrite the persisted cursor.");
    state.cursors[combo.id] = nextCursorFor(combo.targets, current, attempt.targetKey, outcome === "retryable_failure");
  }
  const session = identifier(attempt.sessionKey);
  if (combo.sticky && session) {
    if (outcome === "success") {
      if (!state.affinity[combo.id]) state.affinity[combo.id] = {};
      const previous = state.affinity[combo.id][session];
      const count = previous?.target === attempt.targetKey ? Math.min(combo.stickyLimit, previous.count + 1) : 1;
      state.affinity[combo.id][session] = { target: attempt.targetKey, count };
    } else if (state.affinity[combo.id]?.[session]?.target === attempt.targetKey) {
      delete state.affinity[combo.id][session];
    }
  }
  return state;
}

export function comboTargetKey(target) {
  const provider = identifier(target?.provider || target?.providerId);
  let slug = identifier(targetSlug(target));
  if (!provider || !slug) throw new Error("Combo target must include provider and slug.");
  if (!slug.includes("/")) slug = `${provider}/${slug}`;
  if (!slug.startsWith(`${provider}/`)) throw new Error("Combo target slug must be namespaced under its provider.");
  return slug;
}

export function comboModelIdentity(model) {
  return modelIdentity(model);
}
