import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AppWindow,
  Archive,
  BrainCircuit,
  Clock3,
  Folder,
  Layers3,
  SearchX,
  SquareTerminal,
  Waypoints,
} from "lucide-react";
import {
  Badge,
  Button,
  EmptyState,
  InlineNotice,
  PageHeader,
  PanelSkeleton,
  SearchField,
  SectionHeading,
  StatStrip,
} from "../components";
import { compactNumber, formatDateTime } from "../lib";
import type {
  ContextSessionsSnapshot,
  HarnessId,
  HarnessSession,
  HarnessSnapshot,
  RouterControlApi,
  RouterTarget,
} from "../types";
import "./local-harness-context.css";

type RunAction = (label: string, action: () => Promise<unknown>) => Promise<void>;

interface ContextPageProps {
  target?: RouterTarget;
  api?: RouterControlApi;
  refreshing: boolean;
  onRefresh: () => void;
  runAction: RunAction;
}

export function ContextPage({ target, api, refreshing, onRefresh, runAction }: ContextPageProps) {
  const [snapshot, setSnapshot] = useState<ContextSessionsSnapshot>();
  const [harnesses, setHarnesses] = useState<HarnessSnapshot>();
  const [search, setSearch] = useState("");
  const [harnessFilter, setHarnessFilter] = useState<"all" | HarnessId>("all");
  const [showArchived, setShowArchived] = useState(false);
  const [codexModel, setCodexModel] = useState("");
  const [visibleCount, setVisibleCount] = useState(200);
  const [error, setError] = useState<string>();

  const loadSessions = useCallback(async () => {
    if (!api) return;
    try {
      const [nextSessions, nextHarnesses] = await Promise.all([api.getContextSessions(), api.getHarnesses()]);
      setSnapshot(nextSessions);
      setHarnesses(nextHarnesses);
      setError(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Session indexes could not be read.");
    }
  }, [api]);

  useEffect(() => { void loadSessions(); }, [loadSessions]);

  const enabledModels = target?.models.filter((model) => model.enabled || model.native) ?? [];
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (snapshot?.sessions ?? []).filter((session) => {
      if (!showArchived && session.archived) return false;
      if (harnessFilter !== "all" && session.harnessId !== harnessFilter) return false;
      if (!needle) return true;
      return `${session.title} ${session.model || ""} ${session.workspace || ""} ${session.harnessId}`.toLowerCase().includes(needle);
    });
  }, [harnessFilter, search, showArchived, snapshot]);
  const visibleSessions = filtered.slice(0, visibleCount);

  useEffect(() => { setVisibleCount(200); }, [harnessFilter, search, showArchived]);

  const workspaceCount = new Set((snapshot?.sessions ?? []).map((session) => session.workspace).filter(Boolean)).size;
  const modelCount = new Set((snapshot?.sessions ?? []).flatMap((session) => session.modelHistory?.length ? session.modelHistory : session.model ? [session.model] : [])).size;
  const inputTokens = (snapshot?.sessions ?? []).reduce((total, session) => total + (session.inputTokens || 0), 0);
  const cachedTokens = (snapshot?.sessions ?? []).reduce((total, session) => total + (session.cachedInputTokens || 0), 0);
  const cachePercent = inputTokens ? Math.round((cachedTokens / inputTokens) * 100) : 0;

  const refresh = () => {
    onRefresh();
    void loadSessions();
  };
  const openSession = async (session: HarnessSession, surface: "app" | "terminal") => {
    if (!api) return;
    const model = session.harnessId === "codex" && surface === "terminal" && codexModel ? codexModel : undefined;
    await runAction(`Open ${session.title}`, () => api.openHarnessSession(session.harnessId, session.id, surface, model));
  };

  return (
    <>
      <PageHeader
        eyebrow="Cross-harness history"
        title="Context Manager"
        description="Find and resume Codex, DeepSeek Harness, and Cursor sessions from one continuity view."
        onRefresh={refresh}
        refreshing={refreshing}
      />
      <StatStrip items={[
        { label: "Sessions", value: snapshot?.counts.total ?? 0, detail: `${snapshot?.counts.codex ?? 0} Codex · ${snapshot?.counts.dsh ?? 0} DeepSeek · ${snapshot?.counts.cursor ?? 0} Cursor` },
        { label: "Workspaces", value: workspaceCount, detail: "Local project roots" },
        { label: "Models used", value: modelCount, detail: "Across indexed sessions" },
        { label: "Cached context", value: inputTokens ? `${cachePercent}%` : "Unreported", detail: inputTokens ? `${compactNumber(cachedTokens)} reused tokens` : "Session metadata only" },
      ]} />

      <InlineNotice tone="neutral" title="Continuity keeps ownership intact">
        Opening a task resumes its original transcript in its owning harness. The control center does not copy or migrate conversation data between harnesses.
      </InlineNotice>
      {error ? <InlineNotice tone="warning" title="Some session history is unavailable">{error}</InlineNotice> : null}

      <section className="panel-section lhc-context-controls">
        <SectionHeading title="Resume behavior" description="A Codex terminal resume can keep the saved model or start the next turn with another enabled model." />
        <div className="lhc-context-options">
          <label>
            <span>Codex terminal model</span>
            <select value={codexModel} disabled={!enabledModels.length} onChange={(event) => setCodexModel(event.target.value)}>
              <option value="">Keep session model</option>
              {enabledModels.map((model) => <option key={model.slug} value={model.slug}>{model.displayName}</option>)}
            </select>
            <small>This affects terminal resumes only. Desktop tasks keep their own model state.</small>
          </label>
          <div className="lhc-context-boundary">
            <Waypoints aria-hidden size={19} strokeWidth={1.6} />
            <div><strong>One index, separate stores</strong><small>Codex, DeepSeek Harness, and Cursor continue to own their files, permissions, compaction, and credentials.</small></div>
          </div>
        </div>
      </section>

      <section className="panel-section">
        <SectionHeading title="Sessions" description="Titles and timestamps come from bounded client indexes. Conversation messages are never returned to this view." />
        <div className="lhc-session-toolbar">
          <SearchField value={search} onChange={setSearch} placeholder="Search sessions, models, or workspaces" />
          <div className="segmented-control compact" role="radiogroup" aria-label="Filter sessions by harness">
            {(["all", "cursor", "dsh", "codex"] as const).map((value) => (
              <button key={value} role="radio" aria-checked={harnessFilter === value} className={harnessFilter === value ? "is-active" : ""} onClick={() => setHarnessFilter(value)}>
                {value === "all" ? "All" : harnessName(value)}
              </button>
            ))}
          </div>
          <label className="check-label"><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} /> Show archived</label>
          <span className="lhc-session-count">{filtered.length} shown</span>
        </div>

        {!snapshot && !error ? (
          <PanelSkeleton label="Loading task history" variant="list" count={5} />
        ) : filtered.length ? (
          <div className="lhc-session-list" role="list">
            {visibleSessions.map((session) => (
              <SessionRow
                key={`${session.harnessId}:${session.id}`}
                session={session}
                appAvailable={session.harnessId === "codex" && Boolean(harnesses?.harnesses.find((item) => item.id === "codex")?.appInstalled)}
                terminalAvailable={Boolean(harnesses?.terminalAvailable && harnesses.harnesses.find((item) => item.id === session.harnessId)?.cliInstalled)}
                modelOverride={session.harnessId === "codex" ? codexModel : ""}
                onOpen={openSession}
              />
            ))}
            {visibleSessions.length < filtered.length ? (
              <div className="lhc-session-more">
                <Button variant="secondary" onClick={() => setVisibleCount((count) => count + 200)}>
                  Show 200 more
                </Button>
                <span>{visibleSessions.length} of {filtered.length} rendered</span>
              </div>
            ) : null}
          </div>
        ) : (
          <EmptyState icon={<SearchX size={20} />} title="No sessions match" body={snapshot?.sessions.length ? "Clear a filter or include archived tasks." : "Start a task in Codex, DeepSeek Harness, or Cursor, then refresh this view."} />
        )}
      </section>
    </>
  );
}

function SessionRow({ session, appAvailable, terminalAvailable, modelOverride, onOpen }: {
  session: HarnessSession;
  appAvailable: boolean;
  terminalAvailable: boolean;
  modelOverride: string;
  onOpen: (session: HarnessSession, surface: "app" | "terminal") => Promise<void>;
}) {
  const contextPercent = session.contextWindow && session.activeTokens
    ? Math.min(100, Math.round((session.activeTokens / session.contextWindow) * 100))
    : undefined;
  const tone = session.archived
    ? "neutral"
    : session.status === "failed" || session.status === "permission_denied"
      ? "danger"
      : session.status === "processing" || session.status === "waiting_for_user" || session.status === "ask_permission"
        ? "accent"
        : "success";
  return (
    <article className="lhc-session-row" role="listitem">
      <div className={`lhc-session-icon is-${session.harnessId}`} aria-hidden>
        {session.harnessId === "codex" ? <BrainCircuit size={17} strokeWidth={1.6} /> : <Layers3 size={17} strokeWidth={1.6} />}
      </div>
      <div className="lhc-session-main">
        <div className="lhc-session-title">
          <strong>{session.title}</strong>
          <Badge tone={session.harnessId === "codex" ? "accent" : "neutral"}>{harnessName(session.harnessId)}</Badge>
          {session.status ? <Badge tone={tone}>{session.archived ? "Archived" : readableStatus(session.status)}</Badge> : null}
        </div>
        <div className="lhc-session-meta">
          <span><Folder aria-hidden size={11} strokeWidth={1.7} /> {session.workspaceLabel || "Workspace not indexed"}</span>
          <span><BrainCircuit aria-hidden size={11} strokeWidth={1.7} /> {session.model || "Model not indexed"}</span>
          <span><Clock3 aria-hidden size={11} strokeWidth={1.7} /> {formatDateTime(session.updatedAt)}</span>
        </div>
        <div className="lhc-session-usage">
          <span>{session.activeTokens !== undefined ? `${compactNumber(session.activeTokens)} active` : "Active context unreported"}</span>
          <span>{session.totalTokens !== undefined ? `${compactNumber(session.totalTokens)} total tokens` : "Lifetime usage unreported"}</span>
          {contextPercent !== undefined ? <span>{contextPercent}% of {compactNumber(session.contextWindow)} context</span> : null}
        </div>
      </div>
      <div className="lhc-session-actions">
        {session.archived ? (
          <span className="lhc-archived-note"><Archive aria-hidden size={13} strokeWidth={1.7} /> Restore in {harnessName(session.harnessId)} first</span>
        ) : (
          <>
            {session.harnessId === "codex" ? (
              <Button variant="secondary" disabled={!appAvailable} onClick={() => void onOpen(session, "app")}><AppWindow aria-hidden size={13} strokeWidth={1.7} /> Open app</Button>
            ) : null}
            <Button
              variant={session.harnessId === "codex" ? "ghost" : "primary"}
              disabled={!terminalAvailable || !session.resumable}
              title={!session.resumable ? "Open this session in its owning Cursor app first." : modelOverride ? `Resume with ${modelOverride}` : undefined}
              onClick={() => void onOpen(session, "terminal")}
            >
              <SquareTerminal aria-hidden size={13} strokeWidth={1.7} /> Resume
            </Button>
          </>
        )}
      </div>
    </article>
  );
}

function readableStatus(status: string): string {
  return status.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function harnessName(harnessId: HarnessId): string {
  if (harnessId === "codex") return "Codex";
  if (harnessId === "dsh") return "DeepSeek Harness";
  return "Cursor";
}
