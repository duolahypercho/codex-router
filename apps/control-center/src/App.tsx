import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Boxes,
  Braces,
  BrainCircuit,
  CircleGauge,
  LayoutDashboard,
  HardDrive,
  LoaderCircle,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Search,
  Settings,
  Sun,
} from "lucide-react";
import routerIcon from "../assets/32x32.png";
import { Badge, Button, InlineNotice, LoadingState } from "./components";
import { classNames } from "./lib";
import { ContextPage } from "./pages/ContextPage";
import { DashboardPage } from "./pages/DashboardPage";
import { HarnessPage } from "./pages/HarnessPage";
import { LocalPage } from "./pages/LocalPage";
import { ModelsPage } from "./pages/ModelsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { StatusPage } from "./pages/StatusPage";
import { UsagePage } from "./pages/UsagePage";
import { SearchDialog } from "./SearchDialog";
import {
  applyDocumentLanguage,
  detectLanguage,
  storeLanguage,
  translate,
  type LanguageId,
  type MessageKey,
} from "./i18n";
import type {
  AccountUsage,
  ChatGptAccountPool,
  ChatGptSessionStatus,
  ModelViewFocus,
  ModelViewFocusRequest,
  OperationEvent,
  PresenceSnapshot,
  ProviderSetupSnapshot,
  ProviderUsageSnapshot,
  RouterHealth,
  RouterSnapshot,
  ViewId,
} from "./types";

const THEME_KEY = "model-router-control-center-theme";
const VIEW_KEY = "model-router-control-center-view";
const ACTIVE_MLX_STATES = new Set(["preparing", "downloading", "loading", "starting-server", "verifying", "publishing"]);

const NAV_ITEMS: Array<{
  id: ViewId;
  label: string;
  description: string;
  icon: typeof Boxes;
}> = [
  { id: "dashboard", label: "Dashboard", description: "Router at a glance", icon: LayoutDashboard },
  { id: "usage", label: "Usage", description: "Quotas, balance, traffic", icon: CircleGauge },
  { id: "status", label: "Status", description: "Agents, speed, savings, requests", icon: Activity },
  { id: "models", label: "Models", description: "Providers, credentials, and catalog", icon: Boxes },
  { id: "local", label: "Local", description: "Runtime and on-device models", icon: HardDrive },
  { id: "harness", label: "Harness", description: "Codex and Deep Code", icon: Braces },
  { id: "context", label: "Context Manager", description: "Sessions across harnesses", icon: BrainCircuit },
  { id: "settings", label: "Settings", description: "Routing and desktop", icon: Settings },
];

function initialTheme(): "light" | "dark" {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return "light";
}

function initialView(): ViewId {
  const stored = localStorage.getItem(VIEW_KEY);
  if (stored === "models" || stored === "providers") return "models";
  return NAV_ITEMS.some((item) => item.id === stored) ? stored as ViewId : "dashboard";
}

export default function App() {
  const api = window.routerControl;
  const nativeTitlebar = api?.platform === "darwin";
  const [view, setView] = useState<ViewId>(initialView);
  const [modelFocusRequest, setModelFocusRequest] = useState<ModelViewFocusRequest>();
  const modelFocusSequence = useRef(0);
  const [viewHistory, setViewHistory] = useState<ViewId[]>(() => [initialView()]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [theme, setTheme] = useState<"light" | "dark">(initialTheme);
  const [language, setLanguage] = useState<LanguageId>(detectLanguage);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarSearchOpen, setSidebarSearchOpen] = useState(false);
  const searchTriggerRef = useRef<HTMLButtonElement>(null);
  const [snapshot, setSnapshot] = useState<RouterSnapshot>();
  const [health, setHealth] = useState<RouterHealth>();
  const [providers, setProviders] = useState<ProviderSetupSnapshot>();
  const [accountUsage, setAccountUsage] = useState<AccountUsage>();
  const [accountPool, setAccountPool] = useState<ChatGptAccountPool>();
  const [chatgptSession, setChatgptSession] = useState<ChatGptSessionStatus>();
  const [providerUsage, setProviderUsage] = useState<ProviderUsageSnapshot>();
  const [presence, setPresence] = useState<PresenceSnapshot>();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [operation, setOperation] = useState<OperationEvent | null>(null);
  const [toast, setToast] = useState<{ tone: "neutral" | "success" | "danger"; message: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const downloadPollInFlight = useRef(false);
  const previousActivityState = useRef<string | undefined>(undefined);

  const target = snapshot?.targets.codex;
  const localDownloadActive = target?.modelSettings?.localModels?.download?.status === "downloading";
  const mlxOperationActive = ACTIVE_MLX_STATES.has(target?.modelSettings?.localModels?.mlx?.operation?.status || "idle");
  const visionDownloadActive = target?.modelSettings?.visionBridge?.download?.status === "downloading";
  const downloadActive = localDownloadActive || mlxOperationActive || visionDownloadActive;

  const refreshHealth = useCallback(async () => {
    if (!api) return;
    try {
      setHealth(await api.getHealth());
    } catch (error) {
      setHealth({ ok: false, error: readableError(error), activity: { state: "offline", active: [], activeCount: 0 } });
    }
  }, [api]);

  const refreshCore = useCallback(async () => {
    if (!api) return;
    const [nextSnapshot, nextProviders, nextPresence, nextHealth, nextAccountPool, nextChatgptSession] = await Promise.allSettled([
      api.getSnapshot(),
      api.getProviders(),
      api.getPresence(),
      api.getHealth(),
      typeof api.getChatGptAccountPool === "function"
        ? api.getChatGptAccountPool()
        : Promise.resolve(undefined),
      typeof api.getChatGptSession === "function"
        ? api.getChatGptSession()
        : Promise.resolve(undefined),
    ]);
    if (nextSnapshot.status === "fulfilled") setSnapshot(nextSnapshot.value);
    if (nextProviders.status === "fulfilled") setProviders(nextProviders.value);
    if (nextPresence.status === "fulfilled") setPresence(nextPresence.value);
    if (nextHealth.status === "fulfilled") setHealth(nextHealth.value);
    if (nextAccountPool.status === "fulfilled") setAccountPool(nextAccountPool.value);
    if (nextChatgptSession.status === "fulfilled" && nextChatgptSession.value !== undefined) {
      setChatgptSession(nextChatgptSession.value);
    }
    // Account-pool support is additive; an older installed router may not
    // expose the read command yet, so do not make the whole dashboard fail to
    // load when that optional surface is unavailable.
    const failure = [nextSnapshot, nextProviders, nextPresence, nextHealth]
      .find((result) => result.status === "rejected") as PromiseRejectedResult | undefined;
    if (failure) throw failure.reason;
  }, [api]);

  const refreshUsage = useCallback(async () => {
    if (!api) return;
    const [account, provider] = await Promise.allSettled([api.getAccountUsage(), api.getProviderUsage()]);
    if (account.status === "fulfilled") setAccountUsage(account.value);
    if (provider.status === "fulfilled") setProviderUsage(provider.value);
  }, [api]);

  const refreshDownloadProgress = useCallback(async () => {
    if (!api || downloadPollInFlight.current) return;
    downloadPollInFlight.current = true;
    try {
      const [localModels, visionBridge] = await Promise.allSettled([
        localDownloadActive || mlxOperationActive ? api.getLocalModels() : Promise.resolve(undefined),
        visionDownloadActive ? api.getVisionBridge() : Promise.resolve(undefined),
      ]);
      setSnapshot((current) => {
        const currentTarget = current?.targets.codex;
        const currentSettings = currentTarget?.modelSettings;
        if (!current || !currentTarget || !currentSettings) return current;
        return {
          ...current,
          targets: {
            ...current.targets,
            codex: {
              ...currentTarget,
              modelSettings: {
                ...currentSettings,
                ...(localModels.status === "fulfilled" && localModels.value !== undefined
                  ? { localModels: localModels.value }
                  : {}),
                ...(visionBridge.status === "fulfilled" && visionBridge.value !== undefined
                  ? { visionBridge: visionBridge.value }
                  : {}),
              },
            },
          },
        };
      });
    } finally {
      downloadPollInFlight.current = false;
    }
  }, [api, localDownloadActive, mlxOperationActive, visionDownloadActive]);

  const refreshAll = useCallback(async () => {
    if (!api) {
      setLoading(false);
      setLoadError("The Electron bridge is unavailable. Open this UI through the Codex Router desktop app.");
      return;
    }
    setRefreshing(true);
    setLoadError(null);
    const results = await Promise.allSettled([refreshCore(), refreshUsage()]);
    const failure = results.find((result) => result.status === "rejected") as PromiseRejectedResult | undefined;
    if (failure) setLoadError(readableError(failure.reason));
    setLoading(false);
    setRefreshing(false);
  }, [api, refreshCore, refreshUsage]);

  // The router appends the usage event before it clears a completed request
  // from health. Use that transition as a local completion signal: it gives
  // the status graph the just-saved tokens without tightening the five-minute
  // idle polling interval that protects large retained ledgers.
  useEffect(() => {
    const currentState = health?.activity?.state;
    if (!currentState) return;
    const finishedGenerating = previousActivityState.current === "generating"
      && currentState !== "generating"
      && currentState !== "offline";
    previousActivityState.current = currentState;
    if (!finishedGenerating) return;
    void Promise.all([refreshCore(), refreshUsage()])
      .catch((error) => setLoadError(readableError(error)));
  }, [health?.activity?.state, refreshCore, refreshUsage]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(VIEW_KEY, view);
  }, [view]);

  useEffect(() => {
    applyDocumentLanguage(language);
    storeLanguage(language);
  }, [language]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    if (!api) return;
    const healthTimer = window.setInterval(() => void refreshHealth(), 1_000);
    // Provider usage reparses the retained append-only ledger in a fresh
    // control process. Five minutes keeps background cost bounded as the file
    // grows; startup, manual refresh, and post-action refresh remain immediate.
    const usageTimer = window.setInterval(() => void refreshUsage(), 5 * 60_000);
    const snapshotTimer = window.setInterval(() => {
      void refreshCore().catch((error) => setLoadError(readableError(error)));
    }, 5 * 60_000);
    return () => {
      window.clearInterval(healthTimer);
      window.clearInterval(usageTimer);
      window.clearInterval(snapshotTimer);
    };
  }, [api, refreshHealth, refreshUsage, refreshCore]);

  useEffect(() => {
    if (!api || !downloadActive) return;
    void refreshDownloadProgress();
    const downloadTimer = window.setInterval(() => void refreshDownloadProgress(), 4_000);
    return () => window.clearInterval(downloadTimer);
  }, [api, downloadActive, refreshDownloadProgress]);

  useEffect(() => api?.onOperation?.((event) => setOperation(event)), [api]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const runAction = useCallback(async (label: string, action: () => Promise<unknown>) => {
    setOperation({ action: label, status: "started", message: label });
    try {
      const result = await action();
      const actionResult = result !== null && typeof result === "object"
        ? result as { accepted?: unknown; pending?: unknown; alreadyAuthenticated?: unknown; inProgress?: unknown }
        : undefined;
      if (actionResult?.alreadyAuthenticated === true || actionResult?.pending === true) {
        const message = actionResult.alreadyAuthenticated === true
          ? `${label} is already signed in.`
          : actionResult.inProgress === true
            ? `${label} is already open in the browser.`
            : `${label} opened in the browser. Finish sign-in there.`;
        setToast({ tone: "neutral", message });
        // The detached Codex OAuth process updates the isolated profile after
        // the browser callback. Reconcile a few times without keeping a
        // permanent spinner or claiming that OAuth has already finished.
        await Promise.allSettled([refreshCore()]);
        if (actionResult.pending === true && actionResult.alreadyAuthenticated !== true) {
          for (const delay of [1_000, 3_000, 10_000, 30_000]) {
            window.setTimeout(() => {
              void refreshCore().catch((error) => setLoadError(readableError(error)));
            }, delay);
          }
        }
        setOperation({ action: label, status: "completed", message });
        return;
      }
      if (
        actionResult?.accepted === true
      ) {
        // Detached tray work can outlive (and intentionally close) this app.
        // Spawn acceptance is not scheduler/build success, so never render the
        // generic "completed" state for it; the supervisor status remains the
        // source of truth after the replacement app opens.
        const message = `${label} started.`;
        setToast({ tone: "neutral", message });
        setOperation({ action: label, status: "started", message });
        return;
      }
      setToast({ tone: "success", message: `${label} completed.` });
      await Promise.allSettled([refreshCore(), refreshUsage()]);
    } catch (error) {
      const message = readableError(error);
      setToast({ tone: "danger", message });
      setOperation({ action: label, status: "failed", message });
      // Some control transactions persist their safe local decision before
      // republishing installed client catalogs. A later publication failure
      // rejects the command even though the durable state changed, so reconcile
      // immediately instead of displaying the opposite consent for five minutes.
      await Promise.allSettled([refreshCore(), refreshUsage()]);
      return;
    }
    setOperation({ action: label, status: "completed", message: `${label} completed.` });
  }, [refreshCore, refreshUsage]);

  const t = useCallback(
    (key: MessageKey, values?: Record<string, string | number>) => translate(language, key, values),
    [language],
  );
  // Nav ids stay the source of truth; only the copy is localized, so a missing
  // translation degrades to the English label rather than an empty button.
  const navItems = useMemo(
    () => NAV_ITEMS.map((item) => ({
      ...item,
      label: translate(language, `nav.${item.id}` as MessageKey) || item.label,
      description: translate(language, `nav.${item.id}.desc` as MessageKey) || item.description,
    })),
    [language],
  );
  const activeMeta = useMemo(() => navItems.find((item) => item.id === view) ?? navItems[0], [navItems, view]);
  const navigateTo = useCallback((next: ViewId, modelFocus?: ModelViewFocus) => {
    if (next === "models" && modelFocus) {
      modelFocusSequence.current += 1;
      setModelFocusRequest({ region: modelFocus, id: modelFocusSequence.current });
    }
    if (next === view) return;
    const nextHistory = [...viewHistory.slice(0, historyIndex + 1), next];
    setViewHistory(nextHistory);
    setHistoryIndex(nextHistory.length - 1);
    setView(next);
  }, [historyIndex, view, viewHistory]);
  const moveHistory = useCallback((direction: -1 | 1) => {
    const nextIndex = historyIndex + direction;
    const next = viewHistory[nextIndex];
    if (!next) return;
    setHistoryIndex(nextIndex);
    setView(next);
  }, [historyIndex, viewHistory]);
  const closeSidebarSearch = useCallback(() => {
    setSidebarSearchOpen(false);
    window.setTimeout(() => searchTriggerRef.current?.focus(), 0);
  }, []);
  const page = (() => {
    const shared = { target, api, refreshing, onRefresh: () => void refreshAll(), runAction };
    switch (view) {
      case "dashboard": return <DashboardPage target={target} health={health} account={accountUsage} providerUsage={providerUsage} setup={providers} presence={presence} api={api} refreshing={refreshing} onRefresh={() => void refreshAll()} onNavigate={navigateTo} />;
      case "usage": return <UsagePage target={target} account={accountUsage} providerUsage={providerUsage} api={api} refreshing={refreshing} onRefresh={() => void refreshAll()} />;
      case "status": return <StatusPage {...shared} health={health} account={accountUsage} providerUsage={providerUsage} />;
      case "models": return <ModelsPage {...shared} catalog={snapshot?.catalog} setup={providers} usage={providerUsage} focusRequest={modelFocusRequest} />;
      case "local": return <LocalPage {...shared} operation={operation} />;
      case "harness": return <HarnessPage {...shared} />;
      case "context": return <ContextPage {...shared} />;
      case "settings": return <SettingsPage {...shared} health={health} presence={presence} chatgptSession={chatgptSession ?? snapshot?.chatgptSession} accountPool={accountPool} theme={theme} onTheme={setTheme} language={language} onLanguage={setLanguage} t={t} />;
    }
  })();

  return (
    <div className={classNames("app-shell", nativeTitlebar && "native-titlebar", !sidebarOpen && "sidebar-collapsed")}>
      <aside className="app-sidebar" aria-label="Codex Router sidebar" inert={sidebarSearchOpen ? true : undefined}>
        <header className="sidebar-window-row">
          <button className="sidebar-toggle" type="button" aria-label="Collapse sidebar" onClick={() => setSidebarOpen(false)}><PanelLeftClose aria-hidden size={15} strokeWidth={1.7} /></button>
          <button className="sidebar-toggle" type="button" aria-label="Go back" disabled={historyIndex === 0} onClick={() => moveHistory(-1)}><ArrowLeft aria-hidden size={15} strokeWidth={1.7} /></button>
          <button className="sidebar-toggle" type="button" aria-label="Go forward" disabled={historyIndex >= viewHistory.length - 1} onClick={() => moveHistory(1)}><ArrowRight aria-hidden size={15} strokeWidth={1.7} /></button>
        </header>
        <div className="router-wordmark">
          <img className="router-logo" src={routerIcon} alt="" aria-hidden />
          <strong><i>codex</i> router</strong>
          <button ref={searchTriggerRef} className="sidebar-search-toggle" type="button" aria-label="Search control center" aria-haspopup="dialog" aria-expanded={sidebarSearchOpen} onClick={() => setSidebarSearchOpen(true)}><Search aria-hidden size={15} strokeWidth={1.7} /></button>
        </div>
        <nav className="primary-nav" aria-label="Control center sections">
          {navItems.map((item) => {
            const Icon = item.icon;
            const selected = item.id === view;
            return (
              <div className="nav-entry" key={item.id}>
                <button title={item.description} className={selected ? "is-active" : ""} aria-current={selected ? "page" : undefined} onClick={() => navigateTo(item.id)}>
                  <Icon aria-hidden size={15} strokeWidth={1.7} />
                  <strong>{item.label}</strong>
                </button>
              </div>
            );
          })}
        </nav>
        <footer className="sidebar-footer">
          <div className="sidebar-health"><span className={health?.ok ? "is-online" : "is-offline"}><i /></span><div><strong>{health?.ok ? "Router online" : "Router offline"}</strong><small>{health?.activity?.state === "generating" ? "Thinking" : health?.activity?.activeCount ? `${health.activity.activeCount} active` : target?.enabledProviders.length ? `${target.enabledProviders.length} provider routes` : "Waiting for setup"}</small></div></div>
          <button type="button" aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>{theme === "dark" ? <Sun aria-hidden size={14} strokeWidth={1.7} /> : <Moon aria-hidden size={14} strokeWidth={1.7} />}</button>
        </footer>
      </aside>

      <main className="app-main" inert={sidebarSearchOpen ? true : undefined}>
        <div className="titlebar">
          {!sidebarOpen ? <button className="titlebar-toggle" type="button" aria-label="Expand sidebar" onClick={() => setSidebarOpen(true)}><PanelLeftOpen aria-hidden size={15} strokeWidth={1.7} /></button> : null}
          <div className="title-tabs"><strong>{activeMeta.label}</strong><span>Overview</span></div>
          <div className="titlebar-spacer" />
          {operation?.status === "started" ? <span className="title-operation"><LoaderCircle aria-hidden size={12} strokeWidth={1.7} className="spin" />{operation.message || operation.action}</span> : null}
          <button className="title-refresh" type="button" aria-label="Refresh all data" disabled={refreshing} onClick={() => void refreshAll()}><RefreshCw aria-hidden size={13} strokeWidth={1.7} className={refreshing ? "spin" : ""} /></button>
        </div>
        <div className={classNames("page-scroll", `page-scroll-${view}`)}>
          {loadError ? <InlineNotice tone="warning" title="Some router data could not load">{loadError}</InlineNotice> : null}
          {loading ? <LoadingState /> : page}
        </div>
      </main>

      {sidebarSearchOpen ? (
        <SearchDialog
          activeView={view}
          items={navItems}
          onClose={closeSidebarSearch}
          onNavigate={navigateTo}
        />
      ) : null}

      {toast ? <div className={classNames("toast", `toast-${toast.tone}`)} role="status">{toast.tone === "success" ? <Badge tone="success">Done</Badge> : toast.tone === "danger" ? <Badge tone="danger">Error</Badge> : <Badge tone="neutral">Started</Badge>}<span>{toast.message}</span></div> : null}
    </div>
  );
}

function readableError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "The router operation did not finish.";
}
