import type { RouterHealth, RouterServiceHealth } from "./types";
import { createTranslator, detectLanguage, type Translate } from "./i18n.ts";

export type ServiceHealthState = "ready" | "degraded" | "offline" | "standby" | "unknown";
export type ServiceHealthTone = "success" | "warning" | "danger" | "neutral";

export interface ServiceHealthRow {
  id: string;
  label: string;
  state: ServiceHealthState;
  status: string;
  detail: string;
  tone: ServiceHealthTone;
}

// Which forwarders the router can report on. The ids live here so the row
// order cannot drift from the keys `printHealth` projects; wording goes
// through the shared dictionary so every locale renders the same rows.
const FORWARDERS = [
  ["oauth", "serviceHealth.forwarder.oauth"],
  ["api", "serviceHealth.forwarder.api"],
  ["grokOauth", "serviceHealth.forwarder.grokOauth"],
] as const;

function dependencyRow(
  id: string,
  label: string,
  service: RouterServiceHealth | undefined,
  degraded: Set<string>,
  t: Translate,
  routerOk?: boolean,
): ServiceHealthRow {
  if (!service) {
    const offline = degraded.has(id);
    // An absent per-service payload is not the same as no information. A
    // router that reported `ok` has already probed every dependency it knows
    // about, so an id missing from `degraded` is reachable -- rendering it as
    // Unknown made a healthy install look like it had never answered.
    if (!offline && routerOk === true) {
      return { id, label, state: "ready", status: t("serviceHealth.ready"), detail: t("serviceHealth.reachable"), tone: "success" };
    }
    return {
      id,
      label,
      state: offline ? "offline" : "unknown",
      status: offline ? t("serviceHealth.offline") : t("serviceHealth.unknown"),
      detail: offline ? t("serviceHealth.unreachable") : t("serviceHealth.waiting"),
      tone: offline ? "danger" : "neutral",
    };
  }
  if (service.enabled === false && !degraded.has(id)) {
    return { id, label, state: "standby", status: t("serviceHealth.standby"), detail: t("serviceHealth.notEnabled"), tone: "neutral" };
  }
  if (service.reachable !== true || degraded.has(id)) {
    return {
      id,
      label,
      state: service.reachable === false || degraded.has(id) ? "offline" : "unknown",
      status: service.reachable === false || degraded.has(id) ? t("serviceHealth.offline") : t("serviceHealth.unknown"),
      detail: service.reachable === false || degraded.has(id) ? t("serviceHealth.unreachable") : t("serviceHealth.waiting"),
      tone: service.reachable === false || degraded.has(id) ? "danger" : "neutral",
    };
  }
  return { id, label, state: "ready", status: t("serviceHealth.ready"), detail: t("serviceHealth.reachable"), tone: "success" };
}

export function serviceHealthRows(health: RouterHealth | undefined, t: Translate = createTranslator(detectLanguage())): ServiceHealthRow[] {
  const degraded = new Set((health?.degraded ?? []).map(String));
  const hasHealth = Boolean(health);
  const routerOk = health?.ok;
  const rows: ServiceHealthRow[] = [{
    id: "router",
    label: t("serviceHealth.router"),
    state: !hasHealth ? "unknown" : routerOk ? "ready" : degraded.size ? "degraded" : "offline",
    status: !hasHealth ? t("serviceHealth.unknown") : routerOk ? t("serviceHealth.ready") : degraded.size ? t("serviceHealth.degraded") : t("serviceHealth.offline"),
    detail: !hasHealth
      ? t("serviceHealth.waiting")
      : routerOk
        ? t("serviceHealth.servingLocally")
        : degraded.size
          ? (degraded.size === 1 ? t("serviceHealth.dependencyAttention", { count: degraded.size }) : t("serviceHealth.dependenciesAttention", { count: degraded.size }))
          : health?.error || t("serviceHealth.endpointUnavailable"),
    tone: !hasHealth ? "neutral" : routerOk ? "success" : degraded.size ? "warning" : "danger",
  }];

  rows.push(dependencyRow("gateway", t("serviceHealth.gateway"), health?.gateway, degraded, t, routerOk));

  const forwarders = FORWARDERS.filter(([id]) => health?.[id] || degraded.has(id));
  for (const [id, labelKey] of forwarders) {
    rows.push(dependencyRow(id, t(labelKey), health?.[id], degraded, t, routerOk));
  }
  if (!forwarders.length) {
    rows.push({
      id: "forwarders",
      label: t("serviceHealth.externalForwarders"),
      state: hasHealth ? "standby" : "unknown",
      status: hasHealth ? t("serviceHealth.standby") : t("serviceHealth.unknown"),
      detail: hasHealth ? t("serviceHealth.noForwarders") : t("serviceHealth.waiting"),
      tone: "neutral",
    });
  }
  return rows;
}
