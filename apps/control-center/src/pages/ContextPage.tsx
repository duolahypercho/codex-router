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
import { useI18n } from "../i18n-react";
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
  const t = useI18n();
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
      setError(reason instanceof Error ? reason.message : t("context.loadError"));
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
    await runAction(t("app.action.openSession", { title: session.title }), () => api.openHarnessSession(session.harnessId, session.id, surface, model));
  };

  return (
    <>
      <PageHeader
        eyebrow={t("context.eyebrow")}
        title={t("context.title")}
        description={t("context.description")}
        onRefresh={refresh}
        refreshing={refreshing}
      />
      <StatStrip items={[
        { label: t("context.stats.sessions"), value: snapshot?.counts.total ?? 0, detail: t("context.stats.sessionsDetail", { codex: snapshot?.counts.codex ?? 0, dsh: snapshot?.counts.dsh ?? 0, cursor: snapshot?.counts.cursor ?? 0 }) },
        { label: t("context.stats.workspaces"), value: workspaceCount, detail: t("context.stats.workspacesDetail") },
        { label: t("context.stats.models"), value: modelCount, detail: t("context.stats.modelsDetail") },
        { label: t("context.stats.cachedContext"), value: inputTokens ? `${cachePercent}%` : t("context.stats.unreported"), detail: inputTokens ? t("context.stats.reusedTokens", { count: compactNumber(cachedTokens) }) : t("context.stats.metadataOnly") },
      ]} />

      <InlineNotice tone="neutral" title={t("context.continuity.title")}>
        {t("context.continuity.body")}
      </InlineNotice>
      {error ? <InlineNotice tone="warning" title={t("context.historyUnavailable")}>{error}</InlineNotice> : null}

      <section className="panel-section lhc-context-controls">
        <SectionHeading title={t("context.resume.title")} description={t("context.resume.description")} />
        <div className="lhc-context-options">
          <label>
            <span>{t("context.resume.modelLabel")}</span>
            <select value={codexModel} disabled={!enabledModels.length} onChange={(event) => setCodexModel(event.target.value)}>
              <option value="">{t("context.resume.keepModel")}</option>
              {enabledModels.map((model) => <option key={model.slug} value={model.slug}>{model.displayName}</option>)}
            </select>
            <small>{t("context.resume.modelNote")}</small>
          </label>
          <div className="lhc-context-boundary">
            <Waypoints aria-hidden size={19} strokeWidth={1.6} />
            <div><strong>{t("context.resume.oneIndex")}</strong><small>{t("context.resume.separateStores")}</small></div>
          </div>
        </div>
      </section>

      <section className="panel-section">
        <SectionHeading title={t("context.sessions.title")} description={t("context.sessions.description")} />
        <div className="lhc-session-toolbar">
          <SearchField value={search} onChange={setSearch} placeholder={t("context.searchPlaceholder")} />
          <div className="segmented-control compact" role="radiogroup" aria-label={t("context.filterAria")}>
            {(["all", "cursor", "dsh", "codex"] as const).map((value) => (
              <button key={value} role="radio" aria-checked={harnessFilter === value} className={harnessFilter === value ? "is-active" : ""} onClick={() => setHarnessFilter(value)}>
                {value === "all" ? t("context.filterAll") : harnessName(value)}
              </button>
            ))}
          </div>
          <label className="check-label"><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} /> {t("context.showArchived")}</label>
          <span className="lhc-session-count">{t("context.shownCount", { count: filtered.length })}</span>
        </div>

        {!snapshot && !error ? (
          <PanelSkeleton label={t("context.loadingHistory")} variant="list" count={5} />
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
                  {t("context.showMore")}
                </Button>
                <span>{t("context.renderedCount", { shown: visibleSessions.length, total: filtered.length })}</span>
              </div>
            ) : null}
          </div>
        ) : (
          <EmptyState icon={<SearchX size={20} />} title={t("context.empty.title")} body={snapshot?.sessions.length ? t("context.empty.filteredBody") : t("context.empty.noSessionsBody")} />
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
  const t = useI18n();
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
          {session.status ? <Badge tone={tone}>{session.archived ? t("context.row.archived") : readableStatus(session.status)}</Badge> : null}
        </div>
        <div className="lhc-session-meta">
          <span><Folder aria-hidden size={11} strokeWidth={1.7} /> {session.workspaceLabel || t("context.row.workspaceMissing")}</span>
          <span><BrainCircuit aria-hidden size={11} strokeWidth={1.7} /> {session.model || t("context.row.modelMissing")}</span>
          <span><Clock3 aria-hidden size={11} strokeWidth={1.7} /> {formatDateTime(session.updatedAt, t)}</span>
        </div>
        <div className="lhc-session-usage">
          <span>{session.activeTokens !== undefined ? t("context.row.activeTokens", { count: compactNumber(session.activeTokens) }) : t("context.row.activeUnreported")}</span>
          <span>{session.totalTokens !== undefined ? t("context.row.totalTokens", { count: compactNumber(session.totalTokens) }) : t("context.row.totalUnreported")}</span>
          {contextPercent !== undefined ? <span>{t("context.row.contextPercent", { percent: contextPercent, count: compactNumber(session.contextWindow) })}</span> : null}
        </div>
      </div>
      <div className="lhc-session-actions">
        {session.archived ? (
          <span className="lhc-archived-note"><Archive aria-hidden size={13} strokeWidth={1.7} /> {t("context.row.restoreFirst", { harness: harnessName(session.harnessId) })}</span>
        ) : (
          <>
            {session.harnessId === "codex" ? (
              <Button variant="secondary" disabled={!appAvailable} onClick={() => void onOpen(session, "app")}><AppWindow aria-hidden size={13} strokeWidth={1.7} /> {t("context.row.openApp")}</Button>
            ) : null}
            <Button
              variant={session.harnessId === "codex" ? "ghost" : "primary"}
              disabled={!terminalAvailable || !session.resumable}
              title={!session.resumable ? t("context.row.cursorFirst") : modelOverride ? t("context.row.resumeWith", { model: modelOverride }) : undefined}
              onClick={() => void onOpen(session, "terminal")}
            >
              <SquareTerminal aria-hidden size={13} strokeWidth={1.7} /> {t("context.row.resume")}
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
