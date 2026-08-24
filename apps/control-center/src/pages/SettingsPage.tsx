import { useEffect, useMemo, useState } from "react";
import { AppWindow, Eye, LogIn, Moon, Plus, RefreshCw, Server, ShieldCheck, Sun, Trash2, UserRound, Wrench } from "lucide-react";
import { Badge, Button, Dialog, InlineNotice, PageHeader, SectionHeading, Toggle } from "../components";
import { compactNumber } from "../lib";
import { LANGUAGE_OPTIONS, type LanguageId, type Translate } from "../i18n";
import type { ChatGptAccountPool, ChatGptSessionStatus, DoctorSnapshot, PresenceSnapshot, RouterControlApi, RouterHealth, RouterTarget, VisionEngine } from "../types";
import { useOptimisticValues, type RunAction } from "../useOptimisticValues";

// Mirrors RETENTION_MIN/MAX/DEFAULT_TTL_DAYS in src/tool-result-retention.mjs.
// `0` is not "no retention" -- it is the stored answer meaning "keep the
// archived originals until I say otherwise", so it gets its own option rather
// than being folded in with the default.
const RETENTION_DEFAULT_TTL_DAYS = 7;
const RETENTION_CHOICES = [1, 3, 7, 14, 30, 90];

function formatBytes(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

export function SettingsPage({ target, health, presence, chatgptSession, accountPool, api, theme, onTheme, language, onLanguage, t, refreshing, onRefresh, runAction }: {
  target?: RouterTarget;
  health?: RouterHealth;
  presence?: PresenceSnapshot;
  chatgptSession?: ChatGptSessionStatus;
  accountPool?: ChatGptAccountPool;
  api?: RouterControlApi;
  theme: "light" | "dark";
  onTheme: (theme: "light" | "dark") => void;
  language: LanguageId;
  onLanguage: (language: LanguageId) => void;
  t: Translate;
  refreshing: boolean;
  onRefresh: () => void;
  runAction: RunAction;
}) {
  const [confirmTrayDisable, setConfirmTrayDisable] = useState(false);
  const [confirmSessionSharing, setConfirmSessionSharing] = useState(false);
  const [confirmRepair, setConfirmRepair] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [repairReport, setRepairReport] = useState<DoctorSnapshot | null>(null);
  const [newAccountLabel, setNewAccountLabel] = useState("");
  const [removeAccountId, setRemoveAccountId] = useState<string | null>(null);
  const [trayCapability, setTrayCapability] = useState<{ supported?: boolean; why?: string }>();
  useEffect(() => {
    let active = true;
    if (!api) {
      setTrayCapability(undefined);
      return () => { active = false; };
    }
    void api.controlTray("status").then((result) => {
      if (!active) return;
      const status = (result as { status?: { supported?: boolean; why?: string } } | undefined)?.status;
      setTrayCapability(status);
    }).catch(() => {
      if (active) setTrayCapability(undefined);
    });
    return () => { active = false; };
  }, [api, refreshing]);
  const trayControlsUnavailable = trayCapability?.supported === false;
  const repairFailures = useMemo(
    () => (repairReport?.checks ?? []).filter((check) => check.status === "fail"),
    [repairReport],
  );
  const sessionSharingEnabled = chatgptSession?.sharing === "enabled";
  const sessionLoginLabel = chatgptSession?.session === "usable"
    ? (typeof chatgptSession.expiresInHours === "number"
      ? t("settings.chatgptSession.status.loginUsableHours", { hours: chatgptSession.expiresInHours })
      : t("settings.chatgptSession.status.loginUsable"))
    : chatgptSession?.session === "expired"
      ? t("settings.chatgptSession.status.loginExpired")
      : chatgptSession?.present
        ? t("settings.chatgptSession.status.loginUnavailableDetected")
        : t("settings.chatgptSession.status.loginUnavailableLogin");
  const sessionSharingLabel = chatgptSession
    ? `${t(sessionSharingEnabled
      ? "settings.chatgptSession.status.sharingEnabled"
      : "settings.chatgptSession.status.sharingDisabled")} · ${sessionLoginLabel}`
    : t("settings.chatgptSession.status.unavailable");
  // Revoked records are cleanup tombstones from older router versions. They
  // are not usable accounts and must never reappear as "Account 1/2" rows.
  // Keep paused records visible so a future resume control can explain them.
  const subscriptionAccounts = Object.values(accountPool?.accounts || {})
    .filter((account) => account.state !== "revoked");
  const usableSubscriptionAccounts = subscriptionAccounts.filter((account) => account.state === "active" && account.subscription?.usable === true);
  const activeAccountId = accountPool?.profile?.active;
  const accountMode = accountPool?.policy.mode === "pool" ? "pool" : "switch";
  const accountSelection = accountPool?.policy.enabled
    ? accountPool.policy.selectedAccountId || "auto"
    : activeAccountId || usableSubscriptionAccounts[0]?.id || "auto";

  // Repair reinstalls and restarts the service, so it can outlast several
  // ordinary actions. `runAction` owns the toast and the refresh; the report
  // is kept here as well because runAction discards the resolved value and a
  // repair that finishes with checks still failing needs to say which ones.
  const runRepair = async () => {
    if (!api || repairing) return;
    setRepairing(true);
    setRepairReport(null);
    try {
      await runAction(t("settings.maintenance.fix"), async () => {
        const report = await api.repairInstall();
        setRepairReport(report);
        if (!report.ok) {
          const failed = report.checks?.find((check) => check.status === "fail");
          throw new Error(failed ? `${failed.name}: ${failed.detail || "check failed"}` : "Repair finished with failing checks.");
        }
        return report;
      });
    } finally {
      setRepairing(false);
    }
  };

  const aging = target?.modelSettings?.toolResultAging;
  const agingLocked = aging?.environmentOverride === true;
  const stats = aging?.stats;
  const hasSavings = typeof stats?.estimatedTokensSaved === "number" && stats.estimatedTokensSaved > 0;
  // `retentionTtlDays` is absent only when nobody has answered, which is a
  // different state from a stored 0. Keep them apart in the select.
  const ttlValue = aging?.retentionTtlDays === undefined ? "default" : String(aging.retentionTtlDays);
  const ttlChoices = aging?.retentionTtlDays !== undefined && aging.retentionTtlDays > 0
      && !RETENTION_CHOICES.includes(aging.retentionTtlDays)
    ? [...RETENTION_CHOICES, aging.retentionTtlDays].sort((left, right) => left - right)
    : RETENTION_CHOICES;

  const bridge = target?.modelSettings?.visionBridge;
  const toggleStates = useMemo(() => new Map([
    ["signed-routing", target?.signedRouting === true],
    ["tool-result-aging", aging?.enabled === true],
    ["native-tool-result-aging", aging?.nativeEnabled === true],
    ["vision-bridge", bridge?.enabled === true],
  ]), [aging?.enabled, aging?.nativeEnabled, bridge?.enabled, target?.signedRouting]);
  const optimisticToggles = useOptimisticValues(toggleStates, runAction);
  const toolResultAgingEnabled = optimisticToggles.value("tool-result-aging", aging?.enabled === true);
  // Same split the tray menu shows: the models the operator already pays for,
  // then the ones their ChatGPT plan covers. Which bill a choice lands on is
  // the only thing separating two otherwise identical engine names.
  const paidEngines = bridge?.paidEngines ?? [];
  const nativeEngines = bridge?.nativeEngines ?? [];
  const selectedEngine = bridge?.engine || "auto";
  const selectedEngineMeta = [...paidEngines, ...nativeEngines].find((engine) => engine.slug === selectedEngine);
  // A pinned engine can leave both lists -- a native model that dropped out of
  // the picker, a provider switched off. The tray keeps naming it; carry it as
  // its own entry so the select cannot silently fall back to its first option
  // and report an engine the router is not using.
  const unlistedEngine: VisionEngine | null = selectedEngine !== "auto" && selectedEngine !== "local" && !selectedEngineMeta
    ? { slug: selectedEngine, displayName: bridge?.resolvedEngineName || bridge?.resolvedEngine || selectedEngine }
    : null;
  const engineEfforts = selectedEngineMeta?.efforts?.length
    ? selectedEngineMeta.efforts
    : bridge?.availableEfforts ?? [];
  const selectedEffort = bridge?.effort || "default";
  // Same reason as the engine above: show the pinned level even when the
  // engine that declared it is no longer listed.
  const effortOptions = selectedEffort !== "default" && !engineEfforts.includes(selectedEffort)
    ? [...engineEfforts, selectedEffort]
    : engineEfforts;

  return (
    <>
      <PageHeader eyebrow={t("settings.eyebrow")} title={t("settings.title")} description={t("settings.description")} onRefresh={onRefresh} refreshing={refreshing} />
      <div className="settings-columns">
        <div className="page-stack">
          <section className="panel-section">
            <SectionHeading title={t("settings.routing.title")} description={t("settings.routing.description")} />
            <div className="settings-list">
              <div className="setting-row">
                <div><strong>Account mode</strong><small>{accountMode === "pool" ? "Keep the selected login active and route native requests through the other saved accounts automatically." : "Activate the selected login in Codex. Other saved accounts remain untouched."}</small></div>
                <select
                  aria-label="ChatGPT account mode"
                  value={accountMode}
                  disabled={!api || !accountPool}
                  onChange={(event) => api && void runAction("Change ChatGPT account mode", () => api.setChatGptAccountPoolMode(event.target.value as "switch" | "pool"))}
                >
                  <option value="switch">Switch account</option>
                  <option value="pool">Pool (automatic)</option>
                </select>
              </div>
              <div className="setting-row">
                <div><strong>{t("settings.signedRouting.title")}</strong><small>{t("settings.signedRouting.detail")}</small></div>
                <Toggle checked={optimisticToggles.value("signed-routing", target?.signedRouting === true)} disabled={!api || !target} label={t("settings.signedRouting.title")} onChange={(enabled) => api && void optimisticToggles.mutate("signed-routing", enabled, "Change signed routing", () => api.setSignedRouting(enabled))} />
              </div>
              <div className="setting-row">
                <div>
                  <strong>{t("settings.chatgptSession.title")}</strong>
                  <small>{t("settings.chatgptSession.detail")} {sessionSharingLabel}</small>
                </div>
                <Toggle
                  checked={sessionSharingEnabled}
                  disabled={!api || !chatgptSession || (!sessionSharingEnabled && chatgptSession.session !== "usable")}
                  label={t("settings.chatgptSession.title")}
                  onChange={(enabled) => {
                    if (!api) return;
                    if (enabled) setConfirmSessionSharing(true);
                    else void runAction(t("settings.chatgptSession.action.disable"), () => api.setChatGptSessionSharing(false));
                  }}
                />
              </div>
            </div>
            <InlineNotice tone="neutral" title={t("settings.restart.title")}>{t("settings.restart.body")}</InlineNotice>
          </section>

          <section className="panel-section">
            <SectionHeading
              title="ChatGPT subscription pool"
              description="Save multiple ChatGPT logins and choose which one native Codex chats use. Provider routes keep their own credentials."
            />
            {accountPool?.profile?.pending ? (
              <InlineNotice tone="neutral" title="Account switch pending">
                Close Codex completely. The selected login will be activated before the next launch.
              </InlineNotice>
            ) : null}
            <div className="settings-list">
              <div className="setting-row">
                <div><strong>Account to use</strong><small>Choose one saved login or let the account pool select automatically.</small></div>
                <select
                  aria-label="ChatGPT account to use"
                  value={accountSelection}
                  disabled={!api || !accountPool}
                  onChange={(event) => api && void runAction("Change ChatGPT account", () => api.setChatGptAccountSelection(event.target.value))}
                >
                  <option value="auto" disabled={usableSubscriptionAccounts.length === 0}>Automatic pool</option>
                  {subscriptionAccounts.map((account) => (
                    <option key={account.id} value={account.id} disabled={account.subscription?.usable !== true}>
                      {account.subscription?.email || account.label || account.id}
                    </option>
                  ))}
                </select>
              </div>
              <div className="setting-row">
                <div><strong>Selection strategy</strong><small>Quota prefers the account with more remaining capacity.</small></div>
                <select
                  aria-label="ChatGPT subscription pool strategy"
                  value={accountPool?.policy.strategy || "quota"}
                  disabled={!api || !accountPool || accountMode !== "pool"}
                  onChange={(event) => api && void runAction("Change ChatGPT pool strategy", () => api.setChatGptAccountPoolStrategy(event.target.value as "quota" | "round-robin" | "fill-first"))}
                >
                  <option value="quota">Quota</option>
                  <option value="round-robin">Round-robin</option>
                  <option value="fill-first">Fill first</option>
                </select>
              </div>
            </div>
            <div className="settings-actions subscription-account-create">
              <input
                aria-label="New ChatGPT account label"
                value={newAccountLabel}
                maxLength={120}
                placeholder="Account label (optional)"
                onChange={(event) => setNewAccountLabel(event.target.value)}
              />
              <Button
                variant="secondary"
                disabled={!api}
                onClick={() => {
                  if (!api) return;
                  void runAction("Add ChatGPT subscription account", async () => {
                    const result = await api.addChatGptSubscriptionAccount(newAccountLabel.trim());
                    setNewAccountLabel("");
                    return result;
                  });
                }}
              ><Plus aria-hidden size={14} strokeWidth={1.7} /> Add account</Button>
            </div>
            <div className="settings-list">
              {subscriptionAccounts.map((account) => {
                const status = account.subscription?.usable ? "Ready" : account.subscription?.expired ? "Session expired" : "Sign-in required";
                const title = account.subscription?.email || account.label || account.id;
                const label = account.subscription?.email && account.label ? `${account.label} · ` : "";
                return (
                  <div className="setting-row subscription-account-row" key={account.id}>
                    <div>
                      <strong><UserRound aria-hidden size={14} strokeWidth={1.7} /> {title} {accountSelection === account.id ? <Badge tone="accent">Selected</Badge> : null}</strong>
                      <small>{label}{status} · {account.id} · {account.subscription?.expiresInHours !== undefined ? `${account.subscription.expiresInHours}h remaining` : ""}</small>
                    </div>
                    <div className="settings-actions">
                      <Button
                        variant="ghost"
                        disabled={!api || account.state !== "active" || account.subscription?.usable === true}
                        onClick={() => api && void runAction(`Login ${account.label || account.id}`, () => api.loginChatGptSubscriptionAccount(account.id))}
                      ><LogIn aria-hidden size={13} strokeWidth={1.7} /> Login</Button>
                      <Button variant="ghost" disabled={!api || account.state === "revoked"} onClick={() => setRemoveAccountId(account.id)}><Trash2 aria-hidden size={13} strokeWidth={1.7} /> Remove</Button>
                    </div>
                  </div>
                );
              })}
            </div>
            {!subscriptionAccounts.length ? (
              <div className="surface-summary"><ShieldCheck aria-hidden size={20} strokeWidth={1.6} /><div><strong>No saved ChatGPT accounts</strong><small>Add a login to create its isolated account profile.</small></div></div>
            ) : null}
          </section>

          <section className="panel-section">
            <SectionHeading title={t("settings.service.title")} description={t("settings.service.description")} />
            <div className="settings-list">
              <div className="setting-row">
                <div><strong>{t("settings.presence.title")}</strong><small>{t("settings.presence.detail")}</small></div>
                <select
                  aria-label={t("settings.presence.title")}
                  value={presence?.mode || "always"}
                  disabled={!api}
                  onChange={(event) => api && void runAction("Change presence mode", () => api.setPresence(event.target.value as "always" | "follow-codex"))}
                >
                  <option value="always">{t("settings.presence.always")}</option>
                  <option value="follow-codex">{t("settings.presence.followCodex")}</option>
                </select>
              </div>
              <div className="setting-row static-row">
                <div><strong>{t("settings.serviceState.title")}</strong><small>{t("settings.serviceState.detail")}</small></div>
                <Badge tone={health?.ok ? "success" : "danger"}>{health?.ok ? t("settings.serviceState.running") : t("settings.serviceState.offline")}</Badge>
              </div>
            </div>
            <div className="settings-actions">
              <Button variant="secondary" disabled={!api} onClick={() => api && void runAction("Start router service", () => api.controlService("start"))}><Server aria-hidden size={14} strokeWidth={1.7} /> {t("settings.action.start")}</Button>
            </div>
          </section>

          <section className="panel-section">
            <SectionHeading title={t("settings.context.title")} description={t("settings.context.description")} />
            {aging ? (
              <>
                <div className="settings-list">
                  <div className="setting-row">
                    <div><strong>{t("settings.context.enable.title")}</strong><small>{t("settings.context.enable.detail")}</small></div>
                    <Toggle checked={toolResultAgingEnabled} disabled={!api || agingLocked} label={t("settings.context.enable.title")} onChange={(enabled) => api && void optimisticToggles.mutate("tool-result-aging", enabled, "Change tool result compaction", () => api.setToolResultAging(enabled))} />
                  </div>
                  <div className="setting-row">
                    <div><strong>{t("settings.context.native.title")}</strong><small>{t("settings.context.native.detail")}</small></div>
                    <Toggle checked={optimisticToggles.value("native-tool-result-aging", aging.nativeEnabled === true)} disabled={!api || agingLocked || !toolResultAgingEnabled} label={t("settings.context.native.title")} onChange={(enabled) => api && void optimisticToggles.mutate("native-tool-result-aging", enabled, "Change native tool result compaction", () => api.setNativeToolResultAging(enabled))} />
                  </div>
                  <div className="setting-row">
                    <div><strong>{t("settings.context.ttl.title")}</strong><small>{t("settings.context.ttl.detail")}</small></div>
                    <select
                      aria-label={t("settings.context.ttl.title")}
                      value={ttlValue}
                      disabled={!api || agingLocked}
                      onChange={(event) => {
                        const raw = event.target.value;
                        const days = raw === "default" ? "default" : Number(raw);
                        if (api) void runAction("Change retention window", () => api.setToolResultRetentionTtl(days));
                      }}
                    >
                      <option value="default">{t("settings.context.ttl.default", { days: RETENTION_DEFAULT_TTL_DAYS })}</option>
                      {ttlChoices.map((days) => <option key={days} value={String(days)}>{t("settings.context.ttl.days", { days })}</option>)}
                      <option value="0">{t("settings.context.ttl.forever")}</option>
                    </select>
                  </div>
                </div>
                {agingLocked ? (
                  <InlineNotice tone="warning" title={t("settings.context.envOverride.title")}>{t("settings.context.envOverride.body")}</InlineNotice>
                ) : null}
                <p className="section-footnote">
                  {hasSavings
                    ? t("settings.context.savings", {
                        tokens: compactNumber(stats?.estimatedTokensSaved),
                        size: formatBytes(stats?.bytesSaved),
                        requests: compactNumber(stats?.requests),
                      })
                    : t("settings.context.noSavings")}
                </p>
              </>
            ) : <InlineNotice tone="neutral" title={t("settings.context.title")}>{t("settings.context.unavailable")}</InlineNotice>}
          </section>
        </div>

        <div className="page-stack">
          <section className="panel-section">
            <SectionHeading title={t("settings.vision.title")} description={t("settings.vision.description")} />
            {bridge ? (
              <>
                <div className="settings-list">
                  <div className="setting-row">
                    <div><strong>{t("settings.vision.enable.title")}</strong><small>{t("settings.vision.enable.detail")}</small></div>
                    <Toggle checked={optimisticToggles.value("vision-bridge", bridge.enabled === true)} disabled={!api} label={t("settings.vision.enable.title")} onChange={(enabled) => api && void optimisticToggles.mutate("vision-bridge", enabled, "Change vision bridge", () => api.setVisionBridgeEnabled(enabled))} />
                  </div>
                  <div className="setting-row">
                    <div><strong>{t("settings.vision.engine.title")}</strong><small>{t("settings.vision.engine.detail")}</small></div>
                    <select
                      aria-label={t("settings.vision.engine.title")}
                      value={selectedEngine}
                      disabled={!api}
                      onChange={(event) => api && void runAction("Change vision engine", () => api.setVisionBridgeEngine(event.target.value))}
                    >
                      {/* No standing "Auto" choice, matching the tray: the ranking behind it
                          scored cost by slug spelling, so it tied across a normal install and
                          resolved alphabetically. It stays visible only while the install is
                          still on it, so the row reports the truth without offering it back. */}
                      {selectedEngine === "auto" ? <option value="auto">{t("settings.vision.engine.auto", { name: bridge.resolvedEngineName || bridge.resolvedEngine || "—" })}</option> : null}
                      {unlistedEngine ? <option value={unlistedEngine.slug}>{unlistedEngine.displayName}</option> : null}
                      {paidEngines.length ? (
                        <optgroup label={t("settings.vision.engine.paid")}>
                          {paidEngines.map((engine) => <option key={engine.slug} value={engine.slug}>{engine.displayName}</option>)}
                        </optgroup>
                      ) : null}
                      {nativeEngines.length ? (
                        <optgroup label={t("settings.vision.engine.native")}>
                          {nativeEngines.map((engine) => <option key={engine.slug} value={engine.slug}>{engine.displayName}</option>)}
                        </optgroup>
                      ) : null}
                      {bridge.local ? <option value="local">{t("settings.vision.engine.local", { name: bridge.local.model || "runtime" })}</option> : null}
                    </select>
                  </div>
                  <div className="setting-row">
                    <div><strong>{t("settings.vision.effort.title")}</strong><small>{effortOptions.length ? t("settings.vision.effort.detail") : t("settings.vision.effort.none")}</small></div>
                    <select
                      aria-label={t("settings.vision.effort.title")}
                      value={selectedEffort}
                      disabled={!api || !effortOptions.length}
                      onChange={(event) => api && void runAction("Change vision effort", () => api.setVisionBridgeEffort(event.target.value))}
                    >
                      <option value="default">{t("settings.vision.effort.default")}</option>
                      {effortOptions.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
                    </select>
                  </div>
                </div>
                <div className="surface-summary">
                  <Eye aria-hidden size={20} strokeWidth={1.6} />
                  <div><strong>{bridge.resolvedEngineName || bridge.resolvedEngine || bridge.engine || "—"}</strong><small>{t("settings.vision.localNote")}</small></div>
                </div>
              </>
            ) : <InlineNotice tone="neutral" title={t("settings.vision.title")}>{t("settings.vision.unavailable")}</InlineNotice>}
          </section>

          <section className="panel-section">
            <SectionHeading title={t("settings.desktop.title")} description={t("settings.desktop.description")} />
            <div className="surface-summary">
              <AppWindow aria-hidden size={20} strokeWidth={1.6} />
              <div><strong>{t("settings.desktop.tray.title")}</strong><small>{t("settings.desktop.tray.detail")}</small></div>
            </div>
            <div className="settings-actions">
              <Button variant="secondary" disabled={!api || trayControlsUnavailable} onClick={() => api && void runAction("Enable desktop tray", () => api.controlTray("enable"))}>{t("settings.desktop.enable")}</Button>
              <Button variant="secondary" disabled={!api || trayControlsUnavailable} onClick={() => api && void runAction("Restart desktop tray", () => api.controlTray("restart"))}>{t("settings.desktop.restart")}</Button>
              <Button variant="ghost" disabled={!api || trayControlsUnavailable} onClick={() => setConfirmTrayDisable(true)}>{t("settings.desktop.disable")}</Button>
            </div>
            {trayControlsUnavailable ? (
              <InlineNotice tone="neutral" title={t("settings.desktop.unavailable.title")}>
                {t("settings.desktop.unavailable.body")}
              </InlineNotice>
            ) : null}
          </section>

          <section className="panel-section">
            <SectionHeading title={t("settings.appearance.title")} description={t("settings.appearance.description")} />
            <div className="theme-picker" role="radiogroup" aria-label={t("settings.appearance.aria")}>
              <button role="radio" aria-checked={theme === "light"} className={theme === "light" ? "is-active" : ""} onClick={() => onTheme("light")}><Sun aria-hidden size={16} strokeWidth={1.7} /><span><strong>{t("settings.appearance.light")}</strong><small>{t("settings.appearance.lightDetail")}</small></span></button>
              <button role="radio" aria-checked={theme === "dark"} className={theme === "dark" ? "is-active" : ""} onClick={() => onTheme("dark")}><Moon aria-hidden size={16} strokeWidth={1.7} /><span><strong>{t("settings.appearance.dark")}</strong><small>{t("settings.appearance.darkDetail")}</small></span></button>
            </div>
            <div className="settings-list">
              <div className="setting-row">
                <div><strong>{t("settings.language.title")}</strong><small>{t("settings.language.detail")}</small></div>
                <select
                  aria-label={t("settings.language.aria")}
                  value={language}
                  onChange={(event) => onLanguage(event.target.value as LanguageId)}
                >
                  {LANGUAGE_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                </select>
              </div>
            </div>
          </section>

          <section className="panel-section">
            <SectionHeading title={t("settings.maintenance.title")} description={t("settings.maintenance.description")} />
            <div className="surface-summary">
              <Wrench aria-hidden size={20} strokeWidth={1.6} />
              <div><strong>{t("settings.maintenance.repairTitle")}</strong><small>{t("settings.maintenance.footnote")}</small></div>
            </div>
            <div className="settings-actions">
              <Button variant="primary" disabled={!api || repairing} onClick={() => setConfirmRepair(true)}>
                {repairing ? t("settings.maintenance.fixRunning") : t("settings.maintenance.fix")}
              </Button>
            </div>
            {repairReport && repairReport.ok ? (
              <InlineNotice tone="success" title={t("settings.maintenance.fixDone")}>
                {t("settings.maintenance.fixDoneDetail")}
              </InlineNotice>
            ) : null}
            {repairFailures.length ? (
              <InlineNotice tone="danger" title={t("settings.maintenance.fixIncomplete")}>
                {/* Repair ran; these checks still fail. Naming them with their
                    own remedy is the whole point of showing the report -- a
                    bare "it failed" would send the user back to the terminal
                    the button exists to replace. */}
                {repairFailures.map((check) => `${check.name}: ${check.detail || ""}${check.fix ? ` — ${check.fix}` : ""}`).join(" · ")}
              </InlineNotice>
            ) : null}
            <InlineNotice tone="neutral" title={t("settings.maintenance.update")}>
              {t("settings.maintenance.updateNote")}
            </InlineNotice>
          </section>
        </div>
      </div>

      <Dialog
        open={confirmSessionSharing}
        title={t("settings.chatgptSession.confirm.title")}
        description={t("settings.chatgptSession.confirm.description")}
        onClose={() => setConfirmSessionSharing(false)}
      >
        <p className="dialog-copy">{t("settings.chatgptSession.confirm.body")}</p>
        <div className="dialog-actions">
          <Button variant="secondary" onClick={() => setConfirmSessionSharing(false)}>{t("settings.desktop.confirm.cancel")}</Button>
          <Button variant="primary" onClick={() => {
            setConfirmSessionSharing(false);
            if (api) void runAction(t("settings.chatgptSession.action.enable"), () => api.setChatGptSessionSharing(true));
          }}>{t("settings.chatgptSession.confirm.enable")}</Button>
        </div>
      </Dialog>

      <Dialog
        open={confirmRepair}
        title={t("settings.maintenance.confirm.title")}
        description={t("settings.maintenance.confirm.description")}
        onClose={() => setConfirmRepair(false)}
      >
        <p className="dialog-copy">{t("settings.maintenance.confirm.body")}</p>
        <div className="dialog-actions">
          <Button variant="secondary" onClick={() => setConfirmRepair(false)}>{t("settings.desktop.confirm.cancel")}</Button>
          <Button variant="primary" onClick={() => {
            setConfirmRepair(false);
            void runRepair();
          }}>{t("settings.maintenance.fix")}</Button>
        </div>
      </Dialog>

      <Dialog open={confirmTrayDisable} title={t("settings.desktop.confirm.title")} description={t("settings.desktop.confirm.description")} onClose={() => setConfirmTrayDisable(false)}>
        <p className="dialog-copy">{t("settings.desktop.confirm.body")}</p>
        <div className="dialog-actions">
          <Button variant="secondary" onClick={() => setConfirmTrayDisable(false)}>{t("settings.desktop.confirm.cancel")}</Button>
          <Button variant="danger" disabled={trayControlsUnavailable} onClick={() => {
            setConfirmTrayDisable(false);
            if (api) void runAction("Disable desktop tray", () => api.controlTray("disable"));
          }}>{t("settings.desktop.disable")}</Button>
        </div>
      </Dialog>

      <Dialog
        open={Boolean(removeAccountId)}
        title="Remove ChatGPT subscription account?"
        description="This revokes the pool entry and deletes its isolated Codex login profile."
        onClose={() => setRemoveAccountId(null)}
      >
        <p className="dialog-copy">The account's local OAuth profile will be removed. Your main Codex login is not changed.</p>
        <div className="dialog-actions">
          <Button variant="secondary" onClick={() => setRemoveAccountId(null)}>Cancel</Button>
          <Button variant="danger" disabled={!api || !removeAccountId} onClick={() => {
            const id = removeAccountId;
            setRemoveAccountId(null);
            if (api && id) void runAction("Remove ChatGPT subscription account", () => api.removeChatGptSubscriptionAccount(id));
          }}>Remove account</Button>
        </div>
      </Dialog>
    </>
  );
}
