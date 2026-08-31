import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  AppWindow,
  BookOpen,
  Boxes,
  BrainCircuit,
  Globe2,
  LoaderCircle,
  Route,
  Settings2,
  SquareTerminal,
} from "lucide-react";
import cursorLogo from "../assets/clients/cursor.svg";
import cursorDarkLogo from "../assets/clients/cursor-dark.svg";
import codexDarkLogo from "../assets/clients/codex-dark.svg";
import codexLightLogo from "../assets/clients/codex-light.svg";
import deepSeekHarnessLogo from "../assets/clients/deepseek-harness.svg";
import claudeLogo from "../assets/clients/claude.svg";
import geminiLogo from "../assets/providers/gemini.svg";
import { Badge, Button, InlineNotice, PageHeader, PanelSkeleton, SectionHeading, StatStrip } from "../components";
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

const CLIENT_ORDER: HarnessId[] = ["cursor", "claude", "gemini", "dsh", "codex"];
const CLIENT_LOGOS: Record<HarnessId, { light: string; dark?: string; mode: "artwork" | "mask" }> = {
  cursor: { light: cursorLogo, dark: cursorDarkLogo, mode: "artwork" },
  dsh: { light: deepSeekHarnessLogo, mode: "mask" },
  codex: { light: codexLightLogo, dark: codexDarkLogo, mode: "artwork" },
  claude: { light: claudeLogo, mode: "artwork" },
  gemini: { light: geminiLogo, mode: "artwork" },
};

export function HarnessPage({ target, api, refreshing, operation, onRefresh, runAction, onNavigate }: HarnessPageProps) {
  const [snapshot, setSnapshot] = useState<HarnessSnapshot>();
  const [sessions, setSessions] = useState<ContextSessionsSnapshot>();
  const [agentBridges, setAgentBridges] = useState<AgentBridgeSnapshot>();
  const [error, setError] = useState<string>();
  const [cursorHostname, setCursorHostname] = useState("");
  const [cursorActionPending, setCursorActionPending] = useState(false);
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
      setError(reason instanceof Error ? reason.message : "Client detection failed.");
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
  const cursorOperationActive = cursorActionPending || operation?.status === "started" && [
    "connectCursor",
    "Connect Cursor",
    "prepareCursorTunnel",
    "Install Cloudflare connector",
    "Sign in to Cloudflare Tunnel",
    "Configure Cursor",
  ].includes(operation.action || "");
  const refresh = () => {
    onRefresh();
    void loadHarnesses();
  };
  const act = async (label: string, action: () => Promise<unknown>) => {
    await runAction(label, action);
    await loadHarnesses();
  };
  const runCursorSetup = async (label: string, action: () => Promise<unknown>) => {
    setCursorActionPending(true);
    try {
      await act(label, action);
    } finally {
      setCursorActionPending(false);
    }
  };
  const sessionCount = (id: HarnessId) => sessions?.counts[id] ?? 0;
  const setup = async (harness: HarnessDescriptor) => {
    if (!api) return;
    if (harness.id === "cursor" && harness.configured) {
      if (harness.appInstalled && harness.appConfigured) {
        await act("Open Cursor", () => api.launchHarness("cursor", "app"));
      } else {
        await act("Open Cursor Agent", () => api.launchHarness("cursor", "terminal"));
      }
      return;
    }
    if (harness.id === "cursor") {
      await runCursorSetup("Connect Cursor", () => api.connectCursor(cursorHostname.trim() || undefined));
    } else if (harness.id === "claude" && harness.configured) {
      await act("Open Claude Code", () => api.launchHarness("claude", "terminal"));
    } else {
      await act(`Configure ${harness.displayName}`, () => api.setupHarness(harness.id));
    }
  };

  return (
    <>
      <PageHeader
        eyebrow="Coding clients"
        title="Harness"
        description="Load local sessions and publish the same routed model catalog into each coding client."
        onRefresh={refresh}
        refreshing={refreshing}
      />
      <div className="lhc-harness-summary">
        <StatStrip items={[
          { label: "Clients", value: clients.length, detail: "Supported clients" },
          { label: "Configured", value: clients.filter((client) => client.configured).length, detail: "Using this router" },
          { label: "Sessions", value: sessions?.counts.total ?? 0, detail: "Indexed metadata" },
          { label: "Routed models", value: routedModelCount, detail: "Shared picker" },
        ]} />
      </div>

      {error ? <InlineNotice tone="warning" title="Client detection is incomplete">{error}</InlineNotice> : null}

      <div className="lhc-harness-list">
        {!snapshot && !error ? <PanelSkeleton label="Detecting coding clients" variant="list" count={5} /> : null}
        {clients.length ? (
          <div className="lhc-harness-table-head" aria-hidden>
            <span>Client</span>
            <span>Runtime</span>
            <span>Models</span>
            <span>Sessions</span>
            <span>Actions</span>
          </div>
        ) : null}
        {clients.map((harness) => (
          <HarnessRow
            key={harness.id}
            harness={harness}
            sessions={sessionCount(harness.id)}
            facts={clientFacts(harness, routedModelCount)}
            bridge={bridgeForHarness(harness.id, agentBridges)}
            onSessions={() => onNavigate("context")}
            setupControl={harness.id === "cursor" && cursorOperationActive ? (
              <div className="lhc-harness-progress" role="status" aria-live="polite">
                <div>
                  <LoaderCircle aria-hidden size={14} strokeWidth={1.7} className="spin" />
                  <span>{operation?.status === "started" ? operation.message || "Preparing Cursor setup…" : "Refreshing Cursor setup…"}</span>
                </div>
                <progress aria-label="Cursor setup progress" />
              </div>
            ) : harness.id === "cursor" && harness.appInstalled && !harness.appConfigured ? (
              <div className="lhc-cursor-connect">
                <div className="lhc-harness-prerequisite">
                  <Globe2 aria-hidden size={14} strokeWidth={1.7} />
                  <span>{cursorTunnelHelp(harness)}</span>
                </div>
                <details>
                  <summary>Use an existing Cloudflare hostname</summary>
                  <label className="lhc-harness-origin">
                    <span>Hostname</span>
                    <input
                      value={cursorHostname}
                      placeholder="cursor-router.example.com"
                      spellCheck={false}
                      autoCapitalize="none"
                      onChange={(event) => setCursorHostname(event.target.value)}
                    />
                    <small>Optional. Leave blank to create one under the domain you authorize.</small>
                  </label>
                </details>
              </div>
            ) : undefined}
            actions={
              <>
                <div className={`lhc-harness-actions${harness.id === "cursor" ? " is-cursor" : ""}`}>
                  <Button
                    variant="primary"
                    disabled={
                      !api || !harness.canInstall || cursorOperationActive
                    }
                    title={harness.installRequirement}
                    onClick={() => void setup(harness)}
                  >
                    {harness.id === "cursor" && cursorOperationActive
                      ? <><LoaderCircle aria-hidden size={14} strokeWidth={1.7} className="spin" /> Working…</>
                      : harness.id === "cursor" && harness.configured
                      ? harness.appInstalled && harness.appConfigured
                        ? <><AppWindow aria-hidden size={14} strokeWidth={1.7} /> Open Cursor</>
                        : <><SquareTerminal aria-hidden size={14} strokeWidth={1.7} /> Open agent</>
                      : harness.id === "claude" && harness.configured
                        ? <><SquareTerminal aria-hidden size={14} strokeWidth={1.7} /> Open Claude Code</>
                        : <><Settings2 aria-hidden size={14} strokeWidth={1.7} /> {harness.id === "cursor" ? "Connect Cursor" : harness.configured ? "Refresh" : "Set up"}</>}
                  </Button>
                  {harness.id === "cursor" ? (
                    <Button
                      variant="ghost"
                      aria-label="Open Cursor Agent"
                      title="Open Cursor Agent"
                      disabled={!api || !harness.configured || !harness.agentConfigured || !snapshot?.terminalAvailable}
                      onClick={() => api && void act("Open Cursor Agent", () => api.launchHarness("cursor", "terminal"))}
                    >
                      <SquareTerminal aria-hidden size={14} strokeWidth={1.7} />
                    </Button>
                  ) : (
                    <Button
                      variant="secondary"
                      disabled={!api || !harness.appInstalled}
                      onClick={() => api && void act(`Open ${harness.displayName}`, () => api.launchHarness(harness.id, "app"))}
                    >
                      <AppWindow aria-hidden size={14} strokeWidth={1.7} /> Open
                    </Button>
                  )}
                  {harness.id !== "cursor" ? (
                    <Button
                      variant="ghost"
                      aria-label={`Open ${harness.displayName} terminal`}
                      title={`Open ${harness.displayName} terminal`}
                      disabled={!api || !snapshot?.terminalAvailable || !harness.cliInstalled}
                      onClick={() => api && void act(`Open ${harness.displayName} terminal`, () => api.launchHarness(harness.id, "terminal"))}
                    >
                      <SquareTerminal aria-hidden size={14} strokeWidth={1.7} />
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    aria-label={`Open ${harness.displayName} documentation`}
                    title={`Open ${harness.displayName} documentation`}
                    disabled={!api}
                    onClick={() => api && void act(`Open ${harness.displayName} documentation`, () => api.openExternal(harness.docsUrl))}
                  >
                    <BookOpen aria-hidden size={14} strokeWidth={1.7} />
                  </Button>
                </div>
              </>
            }
          />
        ))}
      </div>

      <section className="panel-section">
        <SectionHeading title="One router plane, five client stores" description="Model routes and provider credentials are shared; sessions and client-owned settings remain separate." />
        <div className="lhc-continuity-map">
          <article>
            <Route aria-hidden size={18} strokeWidth={1.7} />
            <div><strong>Shared routed catalog</strong><small>{routedModelCount} selected models are republished into every configured client.</small></div>
            <Badge tone={target?.active ? "success" : "neutral"}>{target?.active ? "Active" : "Inactive"}</Badge>
          </article>
          <article>
            <Globe2 aria-hidden size={18} strokeWidth={1.7} />
            <div><strong>Cursor public edge</strong><small>Cursor App reaches only the separately keyed app edge; the main loopback capability stays private.</small></div>
            <Badge tone={clients.find((client) => client.id === "cursor")?.configured ? "success" : "neutral"}>Isolated</Badge>
          </article>
          <article>
            <Boxes aria-hidden size={18} strokeWidth={1.7} />
            <div><strong>Session ownership</strong><small>The index reads bounded metadata only. Conversation messages stay inside each coding client.</small></div>
            <Badge tone="accent">Local</Badge>
          </article>
        </div>
      </section>
    </>
  );
}

function HarnessRow({ harness, sessions, facts, bridge, setupControl, actions, onSessions }: {
  harness: HarnessDescriptor;
  sessions: number;
  facts: string[];
  bridge?: AgentBridgeDescriptor;
  setupControl?: ReactNode;
  actions: ReactNode;
  onSessions: () => void;
}) {
  return (
    <section className={`lhc-harness-row is-${harness.id}`}>
      <header>
        <span className="lhc-harness-mark" aria-hidden><HarnessMark id={harness.id} /></span>
        <div>
          <div className="lhc-harness-title">
            <h2>{harness.displayName}</h2>
            <Badge tone={harness.configured ? "success" : harness.cliInstalled || harness.appInstalled ? "accent" : "neutral"}>
              {harness.configured ? "Router ready" : harness.cliInstalled || harness.appInstalled ? "Detected" : "Not installed"}
            </Badge>
          </div>
          <p>{harness.description}</p>
          {bridge ? (
            <div
              className={`lhc-harness-bridge${bridge.installed ? " is-available" : ""}`}
              title="Optional delegated runs use the official client's own login and never add subscription models to the router catalog."
            >
              <BrainCircuit aria-hidden size={11} strokeWidth={1.8} />
              <span>Official-client agent</span>
              <strong>{bridge.installed ? "Available" : "Not detected"}</strong>
              <span>· {bridge.sessions} delegated {bridge.sessions === 1 ? "run" : "runs"}</span>
            </div>
          ) : null}
        </div>
      </header>
      <div className="lhc-harness-facts">
        <div className="lhc-harness-runtime"><span>{facts[0]}</span></div>
        <div className="lhc-harness-catalog"><span>{facts[1]}</span></div>
        <button className="lhc-harness-sessions" type="button" onClick={onSessions}>
          <BrainCircuit aria-hidden size={13} strokeWidth={1.8} />
          <span>{sessions} indexed</span>
        </button>
      </div>
      {setupControl ? <div className="lhc-harness-setup">{setupControl}</div> : !harness.configured ? <div className="lhc-harness-setup"><small>{harness.installRequirement}</small></div> : null}
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

function clientFacts(harness: HarnessDescriptor, modelCount: number): string[] {
  const client = harness.cliInstalled
    ? harness.cliVersion || "CLI detected"
    : harness.appInstalled ? "Desktop app detected" : "Client not detected";
  const config = harness.id === "cursor"
    ? harness.configured ? `${modelCount} available` : "Ready after setup"
    : harness.configured ? `${modelCount} published` : "Not published";
  return [client, config];
}

function cursorTunnelHelp(harness: HarnessDescriptor): string {
  if (!harness.tunnel?.binaryInstalled) {
    return "One guided setup installs the connector, opens Cloudflare authorization, publishes every selected model, verifies it, and reopens Cursor.";
  }
  if (!harness.tunnel.loggedIn) {
    return "Click Connect Cursor once, then authorize a domain in the browser. Setup resumes here automatically.";
  }
  return "Click Connect Cursor. The app chooses a private connector hostname, publishes every selected model, verifies it, and reopens Cursor.";
}
