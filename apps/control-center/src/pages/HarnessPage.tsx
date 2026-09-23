import { backendText } from "../backend-text";
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  AppWindow,
  ArrowUpCircle,
  Boxes,
  Globe2,
  LoaderCircle,
  Route,
  SquareTerminal,
} from "lucide-react";
import cursorLogo from "../assets/clients/cursor.svg";
import cursorDarkLogo from "../assets/clients/cursor-dark.svg";
import codexDarkLogo from "../assets/clients/codex-dark.svg";
import codexLightLogo from "../assets/clients/codex-light.svg";
import deepSeekHarnessLogo from "../assets/clients/deepseek-harness.svg";
import claudeLogo from "../assets/clients/claude.svg";
import geminiLogo from "../assets/providers/gemini.svg";
import openclawLogo from "../assets/clients/openclaw.svg";
import piLogo from "../assets/clients/pi.svg";
import ompLogo from "../assets/clients/omp.svg";
// opencode, Command Code, and Nous Research already ship a mark in this app as
// *providers*. A client row is the same organization, so it reuses that asset
// rather than committing a second copy that would then have to be kept in step.
import opencodeLogo from "../assets/providers/opencode.png";
import commandCodeLogo from "../assets/providers/commandcode.svg";
import nousResearchLogo from "../assets/providers/nousresearch.png";
import { Badge, Button, InlineNotice, PageHeader, PanelSkeleton, SectionHeading, StatStrip, Toggle } from "../components";
import { useI18n } from "../i18n-react";
import type { Translate } from "../i18n";
import type {
  AgentBridgeDescriptor,
  AgentBridgeSnapshot,
  ContextSessionsSnapshot,
  HarnessDescriptor,
  HarnessId,
  HarnessSnapshot,
  OperationEvent,
  RouterControlApi,
  RouterTarget,
  ViewId,
} from "../types";
import "./local-harness-context.css";

type RunAction = (label: string, action: () => Promise<unknown>) => Promise<void>;

interface HarnessPageProps {
  target?: RouterTarget;
  api?: RouterControlApi;
  refreshing: boolean;
  operation?: OperationEvent | null;
  onRefresh: () => void;
  runAction: RunAction;
  onNavigate: (view: ViewId) => void;
}

// The six clients that predate the shared publisher keep their order; the five
// document-configured harnesses follow, so an existing user's rows do not move
// under them on upgrade.
const CLIENT_ORDER: HarnessId[] = [
  "openclaw", "cursor", "claude", "gemini", "dsh", "codex",
  "opencode", "pi", "omp", "commandcode", "hermes",
];
const TERMINAL_ONLY_CLIENTS = new Set<HarnessId>(["opencode", "pi", "omp", "commandcode", "hermes"]);
const CLIENT_LOGOS: Record<HarnessId, { light: string; dark?: string; mode: "artwork" | "mask" }> = {
  cursor: { light: cursorLogo, dark: cursorDarkLogo, mode: "artwork" },
  dsh: { light: deepSeekHarnessLogo, mode: "mask" },
  codex: { light: codexLightLogo, dark: codexDarkLogo, mode: "artwork" },
  claude: { light: claudeLogo, mode: "artwork" },
  gemini: { light: geminiLogo, mode: "artwork" },
  openclaw: { light: openclawLogo, mode: "artwork" },
  opencode: { light: opencodeLogo, mode: "artwork" },
  pi: { light: piLogo, mode: "artwork" },
  // omp's official mark is drawn in near-white for a dark ground. Painting it
  // in the surrounding text colour is what keeps it legible in both themes.
  omp: { light: ompLogo, mode: "mask" },
  commandcode: { light: commandCodeLogo, mode: "artwork" },
  hermes: { light: nousResearchLogo, mode: "mask" },
};

const CURSOR_OPERATION_ACTIONS = new Set([
  "connectCursor",
  "disconnectCursor",
  "disconnectHarness",
  "Connect Cursor",
  "Disconnect Cursor",
  "prepareCursorTunnel",
  "Install Cloudflare connector",
  "Sign in to Cloudflare Tunnel",
  "Configure Cursor",
]);

export function HarnessPage({ target, api, refreshing, operation, onRefresh, runAction, onNavigate }: HarnessPageProps) {
  const t = useI18n();
  const [snapshot, setSnapshot] = useState<HarnessSnapshot>();
  const [sessions, setSessions] = useState<ContextSessionsSnapshot>();
  const [agentBridges, setAgentBridges] = useState<AgentBridgeSnapshot>();
  const [error, setError] = useState<string>();
  const [cursorHostname, setCursorHostname] = useState("");
  const [pendingHarnessId, setPendingHarnessId] = useState<HarnessId>();
  const loadHarnesses = useCallback(async () => {
    if (!api) return;
    try {
      const [nextHarnesses, nextSessions] = await Promise.all([
        api.getHarnesses(),
        api.getContextSessions(),
      ]);
      setSnapshot(nextHarnesses);
      setSessions(nextSessions);
      setError(undefined);
      if (typeof api.getAgentBridges === "function") {
        try {
          setAgentBridges(await api.getAgentBridges());
        } catch {
          // Agent bridges are optional client-owned sessions. Their detection
          // must never hide the routed Cursor, DeepSeek, and Codex rows.
          setAgentBridges(undefined);
        }
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("harness.loadError"));
    }
  }, [api]);

  useEffect(() => { void loadHarnesses(); }, [loadHarnesses]);
  useEffect(() => {
    const saved = snapshot?.harnesses.find((harness) => harness.id === "cursor")?.tunnel?.hostname;
    if (saved) setCursorHostname(saved);
  }, [snapshot]);

  const clients = useMemo(
    () => CLIENT_ORDER.map((id) => snapshot?.harnesses.find((harness) => harness.id === id)).filter(Boolean) as HarnessDescriptor[],
    [snapshot],
  );
  const routedModelCount = target?.models.filter(
    (model) => model.visible && (model.enabled || model.native),
  ).length ?? 0;
  const cursorOperationActive = Boolean(
    pendingHarnessId === "cursor"
    || (operation?.status === "started" && CURSOR_OPERATION_ACTIONS.has(operation.action || "")),
  );
  const refresh = () => {
    onRefresh();
    void loadHarnesses();
  };
  const act = async (label: string, action: () => Promise<unknown>) => {
    await runAction(label, action);
    await loadHarnesses();
  };
  const runHarnessAction = async (harnessId: HarnessId, label: string, action: () => Promise<unknown>) => {
    setPendingHarnessId(harnessId);
    try {
      await act(label, action);
    } finally {
      setPendingHarnessId(undefined);
    }
  };
  const sessionCount = (id: HarnessId) => sessions?.counts[id] ?? 0;
  const routingEnabled = (harness: HarnessDescriptor) => (
    harness.id === "cursor" ? Boolean(harness.appConfigured) : harness.configured
  );
  const toggleRouting = async (harness: HarnessDescriptor, enabled: boolean) => {
    if (!api) return;
    if (enabled) {
      if (harness.id === "cursor") {
        await runHarnessAction("cursor", t("harness.connectLabel", { name: "Cursor" }), () => api.connectCursor(cursorHostname.trim() || undefined));
        return;
      }
      await runHarnessAction(harness.id, t("harness.configureLabel", { name: harness.displayName }), () => api.setupHarness(harness.id));
      return;
    }
    if (harness.id === "cursor" && api.disconnectCursor) {
      await runHarnessAction("cursor", t("harness.disconnectLabel", { name: "Cursor" }), () => api.disconnectCursor());
      return;
    }
    if (!api.disconnectHarness) return;
    await runHarnessAction(
      harness.id,
      t("harness.disconnectLabel", { name: harness.displayName }),
      () => api.disconnectHarness(harness.id),
    );
  };
  const setup = async (harness: HarnessDescriptor) => {
    if (!api) return;
    if (harness.id === "cursor") {
      await runHarnessAction("cursor", t("harness.connectLabel", { name: "Cursor" }), () => api.connectCursor(cursorHostname.trim() || undefined));
    } else {
      await runHarnessAction(harness.id, t("harness.configureLabel", { name: harness.displayName }), () => api.setupHarness(harness.id));
    }
  };
  const openSurface = async (harness: HarnessDescriptor, surface: "app" | "terminal") => {
    if (!api) return;
    await act(
      surface === "app" ? t("harness.openAppLabel", { name: harness.displayName }) : t("harness.openTerminalLabel", { name: harness.displayName }),
      () => api.launchHarness(harness.id, surface),
    );
  };
  // Updating is its own action, never a step inside setup: publishing a model
  // list must not be the reason somebody's global coding agent changed version.
  const update = async (harness: HarnessDescriptor) => {
    if (!api?.updateHarness) return;
    await act(t("harness.updateLabel", { name: harness.displayName }), () => api.updateHarness(harness.id));
  };
  const updatableClients = clients.filter((client) => client.canUpdate);
  const updateAll = async () => {
    if (!api?.updateHarness) return;
    await act(t("harness.updateAllLabel"), () => api.updateHarness("all"));
  };
  const busy = (harness: HarnessDescriptor) => (
    pendingHarnessId === harness.id
    || (harness.id === "cursor" && cursorOperationActive)
  );

  return (
    <>
      <PageHeader
        eyebrow={t("harness.eyebrow")}
        title={t("harness.title")}
        description={t("harness.description")}
        onRefresh={refresh}
        refreshing={refreshing}
      />
      <div className="lhc-harness-summary">
        <StatStrip items={[
          { label: t("harness.stats.clients"), value: clients.length, detail: t("harness.stats.clientsDetail") },
          { label: t("harness.stats.configured"), value: clients.filter((client) => client.configured).length, detail: t("harness.stats.configuredDetail") },
          { label: t("harness.stats.sessions"), value: sessions?.counts.total ?? 0, detail: t("harness.stats.sessionsDetail") },
          { label: t("harness.stats.routedModels"), value: routedModelCount, detail: t("harness.stats.routedModelsDetail") },
        ]} />
        {updatableClients.length ? (
          <Button
            variant="secondary"
            disabled={!api?.updateHarness}
            title={t("harness.updateAll.title", { list: updatableClients.map((client) => client.displayName).join(", ") })}
            onClick={() => void updateAll()}
          >
            <ArrowUpCircle aria-hidden size={14} strokeWidth={1.7} /> {t("harness.updateAll.label", { count: updatableClients.length })}
          </Button>
        ) : null}
      </div>

      {error ? <InlineNotice tone="warning" title={t("harness.detectionIncomplete")}>{error}</InlineNotice> : null}

      <div className="lhc-harness-list">
        {!snapshot && !error ? <PanelSkeleton label={t("harness.detecting")} variant="list" count={CLIENT_ORDER.length} /> : null}
        {clients.length ? (
          <div className="lhc-harness-table-head" aria-hidden>
            <span>{t("harness.table.client")}</span>
            <span>{t("harness.table.models")}</span>
            <span>{t("harness.table.sessions")}</span>
            <span>{t("harness.table.actions")}</span>
          </div>
        ) : null}
        {clients.map((harness) => {
          const enabled = routingEnabled(harness);
          const harnessBusy = busy(harness);
          const hintId = `harness-hint-${harness.id}`;
          const models = modelFact(harness, routedModelCount, t);
          return (
            <HarnessRow
              key={harness.id}
              harness={harness}
              sessions={sessionCount(harness.id)}
              models={models}
              bridge={bridgeForHarness(harness.id, agentBridges)}
              onSessions={() => onNavigate("context")}
              setupControl={harness.id === "cursor" && harnessBusy ? (
                <div className="lhc-harness-progress" role="status" aria-live="polite">
                  <div>
                    <LoaderCircle aria-hidden size={14} strokeWidth={1.7} className="spin" />
                    <span>{operation?.status === "started" ? backendText(operation.message, t) || t("harness.cursor.preparing") : t("harness.cursor.refreshing")}</span>
                  </div>
                  <progress aria-label={t("harness.cursor.progressAria")} />
                </div>
              ) : harness.id === "cursor" && harness.appInstalled && !enabled ? (
                <div className="lhc-cursor-connect">
                  <div className="lhc-harness-prerequisite">
                    <Globe2 aria-hidden size={14} strokeWidth={1.7} />
                    <span>{cursorTunnelHelp(harness, t)}</span>
                  </div>
                  <details>
                    <summary>{t("harness.cursor.existingHostname")}</summary>
                    <label className="lhc-harness-origin">
                      <span>{t("harness.cursor.hostname")}</span>
                      <input
                        value={cursorHostname}
                        placeholder="cursor-router.example.com"
                        spellCheck={false}
                        autoCapitalize="none"
                        onChange={(event) => setCursorHostname(event.target.value)}
                      />
                      <small>{t("harness.cursor.hostnameOptional")}</small>
                    </label>
                  </details>
                </div>
              ) : undefined}
              actions={
                <div className="lhc-harness-actions">
                  <div className="lhc-harness-toolbar">
                    <span className="lhc-harness-hint">
                      <Toggle
                        checked={enabled}
                        disabled={!api || harnessBusy || (!enabled && !harness.canInstall)}
                        label={t("harness.routeToggle", { name: harness.displayName })}
                        onChange={(next) => void toggleRouting(harness, next)}
                      />
                      <span id={hintId} role="tooltip" className="lhc-harness-hint-tooltip">
                        {harnessHint(harness, t)}
                      </span>
                    </span>
                    <div className="lhc-harness-launch">
                      {enabled ? (
                        <>
                          <Button
                            className="lhc-harness-icon-btn"
                            variant="primary"
                            aria-label={t("harness.openAppAria", { name: harness.displayName })}
                            disabled={!api || harnessBusy}
                            title={harness.appInstalled ? t("harness.openAppTitle", { name: harness.displayName }) : t("harness.openSiteTitle", { name: harness.displayName })}
                            onClick={() => void openSurface(harness, "app")}
                          >
                            {harnessBusy
                              ? <LoaderCircle aria-hidden size={14} strokeWidth={1.7} className="spin" />
                              : <AppWindow aria-hidden size={14} strokeWidth={1.7} />}
                          </Button>
                          <Button
                            className="lhc-harness-icon-btn"
                            variant="secondary"
                            aria-label={t("harness.openTerminalAria", { name: harness.displayName })}
                            disabled={!api || harnessBusy || !harness.cliInstalled || !snapshot?.terminalAvailable}
                            title={
                              !snapshot?.terminalAvailable
                                ? t("harness.terminalMacOnly")
                                : !harness.cliInstalled
                                  ? t("harness.cliNotInstalled", { name: harness.displayName })
                                  : t("harness.openTerminalTitle", { name: harness.displayName })
                            }
                            onClick={() => void openSurface(harness, "terminal")}
                          >
                            <SquareTerminal aria-hidden size={14} strokeWidth={1.7} />
                          </Button>
                        </>
                      ) : (
                        <Button
                          className="lhc-harness-setup-btn"
                          variant="primary"
                          aria-label={t("harness.setupAria", { name: harness.displayName })}
                          disabled={!api || harnessBusy || !harness.canInstall}
                          title={backendText(harness.installRequirement, t)}
                          onClick={() => void setup(harness)}
                        >
                          {harnessBusy
                            ? <LoaderCircle aria-hidden size={14} strokeWidth={1.7} className="spin" />
                            : harness.id === "cursor" ? t("harness.connect") : t("harness.setUp")}
                        </Button>
                      )}
                    </div>
                    {harness.canUpdate ? (
                      <Button
                        className="lhc-harness-icon-btn"
                        variant="ghost"
                        aria-label={t("harness.updateAria", { name: harness.displayName })}
                        disabled={!api?.updateHarness || harnessBusy}
                        title={harness.updateCommand
                          ? t("harness.runsCommand", { command: harness.updateCommand })
                          : t("harness.updateTitle", { name: harness.displayName })}
                        onClick={() => void update(harness)}
                      >
                        <ArrowUpCircle aria-hidden size={14} strokeWidth={1.7} />
                      </Button>
                    ) : null}
                  </div>
                </div>
              }
            />
          );
        })}
      </div>

      <section className="panel-section">
        <SectionHeading title={t("harness.continuum.title", { count: clients.length })} description={t("harness.continuum.description")} />
        <div className="lhc-continuity-map">
          <article>
            <Route aria-hidden size={18} strokeWidth={1.7} />
            <div><strong>{t("harness.continuum.catalogTitle")}</strong><small>{t("harness.continuum.catalogBody", { count: routedModelCount })}</small></div>
            <Badge tone={target?.active ? "success" : "neutral"}>{target?.active ? t("harness.continuum.active") : t("harness.continuum.inactive")}</Badge>
          </article>
          <article>
            <Globe2 aria-hidden size={18} strokeWidth={1.7} />
            <div><strong>{t("harness.continuum.cursorEdgeTitle")}</strong><small>{t("harness.continuum.cursorEdgeBody")}</small></div>
            <Badge tone={clients.find((client) => client.id === "cursor")?.configured ? "success" : "neutral"}>{t("harness.continuum.isolated")}</Badge>
          </article>
          <article>
            <Boxes aria-hidden size={18} strokeWidth={1.7} />
            <div><strong>{t("harness.continuum.ownershipTitle")}</strong><small>{t("harness.continuum.ownershipBody")}</small></div>
            <Badge tone="accent">{t("harness.continuum.local")}</Badge>
          </article>
        </div>
      </section>
    </>
  );
}

function HarnessRow({ harness, sessions, models, bridge, setupControl, actions, onSessions }: {
  harness: HarnessDescriptor;
  sessions: number;
  models: { label: string; title: string };
  bridge?: AgentBridgeDescriptor;
  setupControl?: ReactNode;
  actions: ReactNode;
  onSessions: () => void;
}) {
  const t = useI18n();
  return (
    <section className={`lhc-harness-row is-${harness.id}`}>
      <header>
        <span className="lhc-harness-mark" aria-hidden><HarnessMark id={harness.id} /></span>
        <div>
          <div className="lhc-harness-title">
            <h2>{harness.displayName}</h2>
            <Badge tone={harness.configured ? "success" : harness.cliInstalled || harness.appInstalled ? "accent" : "neutral"}>
              {harness.configured ? t("harness.row.ready") : harness.cliInstalled || harness.appInstalled ? t("harness.row.detected") : t("harness.row.missing")}
            </Badge>
          </div>
          {bridge?.installed ? (
            <p className="lhc-harness-bridge is-available" title={t("harness.row.bridgeTitle")}>
              {bridge.sessions > 0 ? t("harness.row.agentCount", { count: bridge.sessions }) : t("harness.row.agent")}
            </p>
          ) : null}
        </div>
      </header>
      <div className="lhc-harness-facts">
        <div className="lhc-harness-catalog" title={models.title}><span>{models.label}</span></div>
        <button
          className="lhc-harness-sessions"
          type="button"
          title={t("harness.row.indexedSessions", { count: sessions })}
          onClick={onSessions}
        >
          <span>{sessions}</span>
        </button>
      </div>
      {setupControl ? <div className="lhc-harness-setup">{setupControl}</div> : null}
      <footer>{actions}</footer>
    </section>
  );
}

function bridgeForHarness(id: HarnessId, snapshot?: AgentBridgeSnapshot): AgentBridgeDescriptor | undefined {
  const bridgeId = id === "claude" ? "anthropic" : id === "cursor" || id === "gemini" ? id : undefined;
  return bridgeId ? snapshot?.bridges.find((bridge) => bridge.id === bridgeId) : undefined;
}

function HarnessMark({ id }: { id: HarnessId }) {
  const logo = CLIENT_LOGOS[id];
  return (
    <span
      className={`lhc-harness-logo is-${logo.mode}`}
      data-client-logo={id}
      style={{
        "--lhc-client-logo": `url("${logo.light}")`,
        "--lhc-client-logo-dark": `url("${logo.dark || logo.light}")`,
      } as CSSProperties}
    />
  );
}

function modelFact(harness: HarnessDescriptor, modelCount: number, t: Translate): { label: string; title: string } {
  if (harness.id === "cursor") {
    return harness.configured
      ? { label: String(modelCount), title: t("harness.fact.available", { count: modelCount }) }
      : { label: "—", title: t("harness.fact.readyAfterSetup") };
  }
  return harness.configured
    ? { label: String(modelCount), title: t("harness.fact.published", { count: modelCount }) }
    : { label: "—", title: t("harness.fact.notPublished") };
}

function cursorTunnelHelp(harness: HarnessDescriptor, t: Translate): string {
  if (!harness.tunnel?.binaryInstalled) {
    return t("harness.cursor.helpInstall");
  }
  if (!harness.tunnel.loggedIn) {
    return t("harness.cursor.helpAuthorize");
  }
  return t("harness.cursor.helpPublish");
}

function harnessHint(harness: HarnessDescriptor, t: Translate): ReactNode {
  if (harness.id === "cursor") {
    return (
      t("harness.hint.cursor")
    );
  }
  if (TERMINAL_ONLY_CLIENTS.has(harness.id)) {
    return t("harness.hint.terminalOnly");
  }
  if (harness.id === "codex") {
    return t("harness.hint.codex");
  }
  return t("harness.hint.default", { name: harness.displayName });
}
