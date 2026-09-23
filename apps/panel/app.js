import {
  activityStateLabel,
  buildQuotaCards,
  chartGeometry,
  commandRefused,
  compactTokens,
  dailySeries,
  exactTokens,
  formatReset,
  localizedEffortLabel,
  modelMatchesQuery,
  observedModelSpeed,
  readOnlyCapabilities,
  serviceHealthRows,
  sevenDayTokens,
  sourceOptions,
  todayTokens,
  toolResultAgingChecked,
  visibleLocalDownload,
} from "./model.mjs";
import { createThinkingOrb } from "./thinking-orb.mjs";
import {
  applyTranslations,
  availableLanguages,
  getLanguage,
  setLanguage,
  t,
} from "./i18n.mjs";

const invoke = window.__TAURI__?.core?.invoke;
const view = new URLSearchParams(window.location.search).get("view") || "panel";

// What the surface hosting this UI is willing to run, as the surface itself
// reported it. Null until platform_info answers; an unrestricted future host
// can continue to advertise no limit, making every check below a no-op.
let capabilities = null;

applyTranslations(document);

if (view === "island") {
  document.getElementById("island").hidden = false;
  startIsland();
} else {
  document.getElementById("panel").hidden = false;
  startPanel();
}

function startPanel() {
  const state = {
    snapshot: null,
    account: null,
    providerUsage: null,
    providerSetup: null,
    localModels: null,
    lmstudioBusy: null,
    visionBridge: null,
    visionDownload: null,
    visionPollTimer: null,
    presence: null,
    modelSettings: null,
    health: null,
    platform: null,
    settings: null,
    selectedSource: null,
    usageRange: 7,
    sourceWasChosen: false,
    busyProvider: null,
    modelSettingsBusy: false,
    pickerModelFilter: "",
    localModelBusy: null,
    localCancelBusy: false,
    localRemoveArmed: null,
    localCatalogFilter: "",
    localQuickPicksExpanded: false,
    localVariantHelpExpanded: false,
    localPollTimer: null,
    lastActivityState: null,
    loginFreeBusy: false,
    signedRoutingBusy: false,
    presenceBusy: false,
    visionBusy: false,
    maintenanceBusy: null,
    localBenchmarkBusy: null,
    maintenanceResult: null,
    toolResultAgingBusy: false,
    readOnlyWatched: false,
    keyProvider: null,
    removeProvider: null,
    toastTimer: null,
  };

  const elements = {
    panel: document.getElementById("panel"),
    readOnlyNote: document.getElementById("read-only-note"),
    tabs: [...document.querySelectorAll(".tab")],
    usageView: document.getElementById("usage-view"),
    statusView: document.getElementById("status-view"),
    connectionsView: document.getElementById("connections-view"),
    modelsView: document.getElementById("models-view"),
    close: document.getElementById("close-panel"),
    routerStatus: document.getElementById("router-status"),
    liveState: document.getElementById("live-state"),
    source: document.getElementById("usage-source"),
    usageRange: document.getElementById("usage-range"),
    usageRangeLabel: document.getElementById("usage-range-label"),
    today: document.getElementById("today-tokens"),
    week: document.getElementById("week-tokens"),
    speedModel: document.getElementById("speed-model"),
    speedDetail: document.getElementById("speed-detail"),
    modelSpeed: document.getElementById("model-speed"),
    chartWrap: document.getElementById("chart-wrap"),
    chartLine: document.getElementById("chart-line-path"),
    chartArea: document.getElementById("chart-area-path"),
    chartPoints: document.getElementById("chart-points"),
    chartDays: document.getElementById("chart-days"),
    chartTooltip: document.getElementById("chart-tooltip"),
    quotaCards: document.getElementById("quota-cards"),
    usageOverview: document.getElementById("usage-overview"),
    usageSourceNote: document.getElementById("usage-source-note"),
    statusSummary: document.getElementById("status-summary"),
    serviceHealth: document.getElementById("service-health"),
    activeRequests: document.getElementById("active-requests"),
    quotaResets: document.getElementById("quota-resets"),
    providers: document.getElementById("provider-list"),
    subagentSummary: document.getElementById("subagent-summary"),
    pickerSummary: document.getElementById("picker-summary"),
    pickerModelSearch: document.getElementById("picker-model-search"),
    subagentAllSwitch: document.getElementById("subagent-all-switch"),
    subagentAllSwitchLabel: document.getElementById("subagent-all-switch-label"),
    subagentModelList: document.getElementById("subagent-model-list"),
    pickerModelList: document.getElementById("picker-model-list"),
    localModelSummary: document.getElementById("local-model-summary"),
    localModelOperation: document.getElementById("local-model-operation"),
    localDownloadStatus: document.getElementById("local-download-status"),
    localModelList: document.getElementById("local-model-list"),
    localModelForm: document.getElementById("local-model-form"),
    localModelInput: document.getElementById("local-model-input"),
    localQuickPicks: document.getElementById("local-quick-picks"),
    localCatalog: document.getElementById("local-catalog"),
    loginFreeSwitch: document.getElementById("login-free-switch"),
    loginFreeSwitchLabel: document.getElementById("login-free-switch-label"),
    loginFreeNote: document.getElementById("login-free-note"),
    signedRoutingSwitch: document.getElementById("signed-routing-switch"),
    signedRoutingSwitchLabel: document.getElementById("signed-routing-switch-label"),
    signedRoutingNote: document.getElementById("signed-routing-note"),
    presenceMode: document.getElementById("presence-mode"),
    presenceNote: document.getElementById("presence-note"),
    maintenanceStatus: document.getElementById("maintenance-status"),
    maintenanceNote: document.getElementById("maintenance-note"),
    maintenanceUpdate: document.getElementById("maintenance-update"),
    maintenanceFix: document.getElementById("maintenance-fix"),
    toolResultAgingSwitch: document.getElementById("tool-result-aging-switch"),
    toolResultAgingSwitchLabel: document.getElementById("tool-result-aging-switch-label"),
    toolResultAgingNote: document.getElementById("tool-result-aging-note"),
    visionSummary: document.getElementById("vision-summary"),
    visionNote: document.getElementById("vision-note"),
    visionSwitch: document.getElementById("vision-switch"),
    visionSwitchLabel: document.getElementById("vision-switch-label"),
    visionEngine: document.getElementById("vision-engine"),
    visionEffort: document.getElementById("vision-effort"),
    visionLocalModels: document.getElementById("vision-local-models"),
    localRuntimeActions: document.getElementById("local-runtime-actions"),
    lmstudioSection: document.getElementById("lmstudio-section"),
    refresh: document.getElementById("refresh-data"),
    islandSwitch: document.getElementById("island-switch"),
    islandSwitchLabel: document.getElementById("island-switch-label"),
    islandNote: document.getElementById("island-note"),
    toast: document.getElementById("toast"),
    keyDialog: document.getElementById("key-dialog"),
    keyTitle: document.getElementById("key-dialog-title"),
    keyForm: document.getElementById("key-form"),
    keyInput: document.getElementById("api-key"),
    closeDialog: document.getElementById("close-dialog"),
    cancelKey: document.getElementById("cancel-key"),
    removeDialog: document.getElementById("remove-dialog"),
    removeTitle: document.getElementById("remove-dialog-title"),
    removeBody: document.getElementById("remove-dialog-body"),
    removeForm: document.getElementById("remove-form"),
    closeRemoveDialog: document.getElementById("close-remove-dialog"),
    cancelRemove: document.getElementById("cancel-remove"),
    language: document.getElementById("language-select"),
  };

  // The range label is assembled from the selected range and the active
  // language, so it cannot be a static data-i18n node. Writing it before the
  // first snapshot arrives keeps the English fallback in index.html from
  // showing through in another language.
  elements.usageRangeLabel.textContent = t("usage.rangeDays", { count: state.usageRange });

  if (elements.language) {
    elements.language.innerHTML = availableLanguages()
      .map((language) => `<option value="${language.id}">${language.label}</option>`)
      .join("");
    elements.language.value = getLanguage();
    elements.language.addEventListener("change", () => {
      setLanguage(elements.language.value);
      applyTranslations(document);
      renderPanel();
    });
  }

  elements.tabs.forEach((button) => {
    button.addEventListener("click", () => selectTab(button.dataset.tab));
  });
  elements.close.addEventListener("click", () => call("hide_panel"));
  elements.refresh.addEventListener("click", () => refreshPanel());
  elements.source.addEventListener("change", () => {
    state.selectedSource = elements.source.value;
    state.sourceWasChosen = true;
    renderUsage();
  });
  elements.usageRange.addEventListener("change", () => {
    const selected = Number(elements.usageRange.value);
    state.usageRange = [7, 30, 90].includes(selected) ? selected : 7;
    renderUsage();
  });
  elements.providers.addEventListener("click", handleProviderClick);
  elements.providers.addEventListener("change", handleProviderToggle);
  document.querySelectorAll(".accordion-header").forEach((button) => {
    button.addEventListener("click", () => toggleAccordion(button));
  });
  elements.subagentAllSwitch.addEventListener("change", handleSubagentAllToggle);
  elements.subagentModelList.addEventListener("change", handleModelSettingsToggle);
  elements.subagentModelList.addEventListener("click", handleModelSettingsClick);
  elements.pickerModelList.addEventListener("change", handleModelSettingsToggle);
  elements.pickerModelList.addEventListener("click", handleModelSettingsClick);
  elements.pickerModelSearch.addEventListener("input", () => {
    state.pickerModelFilter = elements.pickerModelSearch.value;
    renderModelSettings();
  });
  elements.localModelList.addEventListener("click", handleLocalModelClick);
  elements.localModelList.addEventListener("change", handleLocalModelToggle);
  elements.localRuntimeActions.addEventListener("click", handleLocalRuntimeClick);
  elements.lmstudioSection.addEventListener("change", handleLmstudioModelToggle);
  elements.localDownloadStatus.addEventListener("click", handleLocalModelClick);
  elements.localQuickPicks.addEventListener("click", handleLocalModelClick);
  elements.localCatalog.addEventListener("click", handleLocalModelClick);
  elements.localCatalog.addEventListener("input", handleLocalCatalogInput);
  elements.visionLocalModels.addEventListener("click", handleVisionClick);
  elements.localModelForm.addEventListener("submit", handleLocalModelInstall);
  elements.loginFreeSwitch.addEventListener("change", handleLoginFreeToggle);
  elements.signedRoutingSwitch.addEventListener("change", handleSignedRoutingToggle);
  elements.presenceMode.addEventListener("change", handlePresenceModeChange);
  elements.toolResultAgingSwitch.addEventListener("change", handleToolResultAgingToggle);
  elements.visionSwitch.addEventListener("change", handleVisionToggle);
  elements.visionEngine.addEventListener("change", handleVisionEngineChange);
  elements.visionEffort.addEventListener("change", handleVisionEffortChange);
  elements.maintenanceUpdate.addEventListener("click", () => runMaintenance("update"));
  elements.maintenanceFix.addEventListener("click", () => runMaintenance("fix"));
  elements.islandSwitch.addEventListener("change", handleIslandToggle);
  elements.keyForm.addEventListener("submit", saveKey);
  elements.closeDialog.addEventListener("click", closeKeyDialog);
  elements.cancelKey.addEventListener("click", closeKeyDialog);
  elements.keyDialog.addEventListener("close", () => {
    elements.keyInput.value = "";
    state.keyProvider = null;
  });
  elements.removeForm.addEventListener("submit", removeKey);
  elements.closeRemoveDialog.addEventListener("click", closeRemoveDialog);
  elements.cancelRemove.addEventListener("click", closeRemoveDialog);
  elements.removeDialog.addEventListener("close", () => {
    state.removeProvider = null;
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !elements.keyDialog.open && !elements.removeDialog.open) {
      call("hide_panel");
    }
  });

  if (!invoke) {
    elements.routerStatus.textContent = t("status.desktopBridgeUnavailable");
    showToast(t("general.desktopBridgeHint"), true);
    return;
  }

  refreshPanel();
  window.setInterval(refreshHealth, 1_200);
  window.setInterval(() => refreshPanel({ quiet: true }), 60_000);

  function selectTab(tab) {
    const usage = tab === "usage";
    const status = tab === "status";
    const models = tab === "models";
    elements.usageView.hidden = !usage;
    elements.statusView.hidden = !status;
    elements.connectionsView.hidden = usage || status || models;
    elements.modelsView.hidden = !models;
    elements.tabs.forEach((button) => button.classList.toggle("is-active", button.dataset.tab === tab));
  }

  async function refreshPanel({ quiet = false } = {}) {
    elements.refresh.disabled = true;
    const requests = [
      ["snapshot", "control_snapshot"],
      ["account", "account_usage"],
      ["providerUsage", "provider_usage"],
      ["providerSetup", "provider_setup"],
      ["health", "router_health"],
      ["platform", "platform_info"],
      ["settings", "desktop_settings"],
    ];
    const results = await Promise.all(
      requests.map(async ([key, command]) => {
        try {
          return { key, value: await call(command) };
        } catch (error) {
          return { key, error };
        }
      }),
    );
    const errors = [];
    for (const result of results) {
      if ("value" in result) state[result.key] = result.value;
      else errors.push(result.error);
    }
    // The control snapshot already contains the local-model, vision-bridge,
    // and presence views. Reusing them avoids starting separate Node processes
    // for the same Ollama inventory and keeps all three sections consistent.
    const codexSettings = state.snapshot?.targets?.codex?.modelSettings;
    if (codexSettings?.localModels) state.localModels = codexSettings.localModels;
    if (codexSettings?.visionBridge) {
      state.visionBridge = codexSettings.visionBridge;
      state.visionDownload = codexSettings.visionBridge.download || null;
    }
    if (state.snapshot?.presence) state.presence = state.snapshot.presence;
    adoptCapabilities();
    renderPanel();
    elements.refresh.disabled = false;
    if (!quiet && errors.length && !state.snapshot) showToast(errorMessage(errors[0]), true);
  }

  async function refreshHealth() {
    try {
      state.health = await call("router_health");
      renderStatus();
    } catch {
      state.health = { ok: false, activity: { state: "offline" } };
      renderStatus();
    }
    const nextActivityState = state.health?.activity?.state || "offline";
    if (state.lastActivityState === "generating" && nextActivityState !== "generating") {
      call("provider_usage")
        .then((usage) => {
          state.providerUsage = usage;
          renderStatus();
        })
        .catch(() => {});
    }
    state.lastActivityState = nextActivityState;
  }

  // The surface reports what it will run in platform_info; a surface that says
  // nothing keeps the full table. Watching starts once, because the restriction
  // is a property of where this page is served from and cannot change while it
  // is open.
  function adoptCapabilities() {
    capabilities = readOnlyCapabilities(state.platform);
    if (!capabilities || state.readOnlyWatched) return;
    state.readOnlyWatched = true;
    watchReadOnly(elements.panel);
  }

  function renderReadOnlyNote() {
    if (!elements.readOnlyNote) return;
    elements.readOnlyNote.hidden = !capabilities;
    // Re-read on every render rather than once: switching language re-renders,
    // and a note left in the previous language is worse than no note.
    if (capabilities) elements.readOnlyNote.textContent = t("general.readOnlySurface");
  }

  function renderPanel() {
    renderReadOnlyNote();
    renderStatus();
    renderSourcePicker();
    renderUsage();
    renderQuotas();
    renderUsageOverview();
    renderStatusView();
    renderProviders();
    renderLoginFreeSetting();
    renderSignedRouting();
    renderPresence();
    renderMaintenance();
    renderIslandSetting();
    renderModelSettings();
    renderToolResultAgingSetting();
    renderVisionBridge();
    renderLocalModels();
    // Last, because every render above re-derives `disabled` from its own busy
    // state and would otherwise hand a refused control back to the user. The
    // observer covers later section rebuilds; this covers the static controls,
    // whose tooltips also have to follow a language change.
    if (capabilities) applyReadOnly(elements.panel);
  }

  function renderStatus() {
    const activity = state.health?.activity || {};
    const activityState = state.health?.ok === false ? "offline" : activity.state || "idle";
    elements.liveState.dataset.state = activityState;
    elements.liveState.querySelector("span").textContent = activityStateLabel(activityState);
    if (state.health?.ok) {
      const model = activity.model ? ` · ${activity.model}` : "";
      elements.routerStatus.textContent = t("status.routerOnline", { model });
    } else {
      elements.routerStatus.textContent = t("status.routerOffline");
    }
    renderModelSpeed(activity);
  }

  function renderModelSpeed(activity) {
    const active = activity.active?.at(-1);
    const model = active?.model || activity.model;
    const provider = active?.provider || activity.provider;
    const label = model ? String(model).split("/").at(-1) : t("status.noModelObserved");
    const isGenerating = activity.state === "generating" || (activity.active && activity.active.length > 0);
    const observed = !isGenerating ? observedModelSpeed(state.providerUsage, provider, model) : null;
    elements.speedModel.textContent = label;
    elements.modelSpeed.textContent = observed ? `${observed.speed.toFixed(1)} tok/s` : t("status.noSpeed");
    elements.modelSpeed.classList.toggle("is-measured", Boolean(observed));
    elements.speedDetail.textContent = observed
      ? t("status.observedThroughput", {
          count: observed.samples,
          reply: observed.samples === 1 ? t("status.reply") : t("status.replies"),
        })
      : t("status.appearsAfterMeteredReply");
  }

  function renderSourcePicker() {
    const options = sourceOptions(state);
    if (!state.sourceWasChosen) {
      const active = state.health?.activity?.state === "generating" ? state.health.activity.provider : null;
      state.selectedSource = options.some((option) => option.id === active)
        ? active
        : options[0]?.id || null;
    }
    if (!options.some((option) => option.id === state.selectedSource)) {
      state.selectedSource = options[0]?.id || null;
    }
    elements.source.disabled = options.length === 0;
    elements.source.innerHTML = options.length
      ? options
          .map(
            (option) =>
              `<option value="${escapeHtml(option.id)}"${option.id === state.selectedSource ? " selected" : ""}>${escapeHtml(option.name)}</option>`,
          )
          .join("")
      : `<option value="">${escapeHtml(t("usage.noConnectedUsage"))}</option>`;
  }

  function renderUsage() {
    const source = sourceOptions(state).find((option) => option.id === state.selectedSource);
    const series = dailySeries(source?.buckets || [], state.usageRange);
    const fallbackDays = series.filter((point) => point.displaySource === "router-fallback").length;
    elements.today.textContent = source ? compactTokens(todayTokens(source)) : "—";
    elements.week.textContent = source
      ? compactTokens(series.reduce((total, point) => total + point.tokens, 0))
      : "\u2014";
    elements.usageRange.value = String(state.usageRange);
    elements.usageRangeLabel.textContent = t("usage.rangeDays", { count: state.usageRange });
    if (elements.usageSourceNote) {
      elements.usageSourceNote.hidden = fallbackDays <= 0;
      elements.usageSourceNote.textContent = fallbackDays > 0
        ? t(fallbackDays === 1 ? "usage.localFallbackNoticeOne" : "usage.localFallbackNotice", { count: fallbackDays })
        : "";
    }
    renderChart(series, elements);
  }

  function renderUsageOverview() {
    const providers = (state.providerUsage?.providers || [])
      .filter((provider) => Number(provider.totalTokens) > 0 || Number(provider.requests) > 0)
      .sort((left, right) => Number(right.totalTokens || 0) - Number(left.totalTokens || 0));
    const models = providers
      .flatMap((provider) => (provider.models || []).map((model) => ({ ...model, provider: provider.displayName || provider.id })))
      .filter((model) => Number(model.totalTokens) > 0 || Number(model.requests) > 0)
      .sort((left, right) => Number(right.totalTokens || 0) - Number(left.totalTokens || 0))
      .slice(0, 8);
    if (!providers.length && !models.length) {
      elements.usageOverview.innerHTML = "";
      return;
    }
    const providerRows = providers.slice(0, 6).map((provider) => `<div class="usage-row">
      <span><strong>${escapeHtml(provider.displayName || provider.id)}</strong><small>${escapeHtml(t("usage.requests", { count: Number(provider.requests || 0).toLocaleString() }))}</small></span>
      <strong>${escapeHtml(t("usage.tok", { count: compactTokens(provider.totalTokens) }))}</strong>
    </div>`).join("");
    const modelRows = models.map((model) => `<div class="usage-row">
      <span><strong>${escapeHtml(model.displayName || model.slug)}</strong><small>${escapeHtml(model.provider)} · ${escapeHtml(t("usage.requests", { count: Number(model.requests || 0).toLocaleString() }))}</small></span>
      <strong>${escapeHtml(t("usage.tok", { count: compactTokens(model.totalTokens) }))}</strong>
    </div>`).join("");
    elements.usageOverview.innerHTML = `${providerRows ? `<article class="usage-card"><header><strong>${escapeHtml(t("usage.allUsage"))}</strong><small>${escapeHtml(t("usage.routerObserved"))}</small></header>${providerRows}</article>` : ""}${modelRows ? `<article class="usage-card"><header><strong>${escapeHtml(t("usage.tokensByModel"))}</strong><small>${escapeHtml(t("usage.heaviestFirst"))}</small></header>${modelRows}</article>` : ""}`;
  }

  function renderStatusView() {
    const activity = state.health?.activity || {};
    const active = Array.isArray(activity.active) ? activity.active : [];
    const activeCount = Number(activity.activeCount ?? active.length) || 0;
    elements.statusSummary.textContent = activeCount
      ? t("status.inFlight", {
          count: activeCount,
          request: t(activeCount === 1 ? "status.request" : "status.requests"),
          state: activityStateLabel(activity.state, "status.active"),
        })
      : t(state.health?.ok === false ? "status.routerOfflineIdle" : "status.routerReadyIdle");
    renderServiceHealth();
    elements.activeRequests.innerHTML = `<header><strong>${escapeHtml(t("status.liveRequests"))}</strong><small>${escapeHtml(activeCount ? String(activeCount) : t("status.none"))}</small></header>${active.length
      ? active.map((request) => {
          const started = Number(request.startedAt) || Date.now();
          const elapsed = Math.max(0, (Date.now() - (started > 1e12 ? started : started * 1000)) / 1000);
          const elapsedLabel = elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${String(Math.floor(elapsed % 60)).padStart(2, "0")}s` : `${elapsed.toFixed(1)}s`;
          const label = request.model
            ? String(request.model).split("/").at(-1)
            : request.provider || t("status.request");
          return `<div class="status-row"><span><strong>${escapeHtml(label)}</strong><small>${escapeHtml(request.provider || t("status.router"))}${request.isSubagent ? ` · ${escapeHtml(t("status.subagent"))}` : ""}</small></span><strong>${escapeHtml(elapsedLabel)}</strong></div>`;
        }).join("")
      : `<p class="status-empty">${escapeHtml(t("status.nothingInFlight"))}</p>`}`;
    const resets = buildQuotaCards(state).filter((card) => card.resetAt);
    elements.quotaResets.innerHTML = `<header><strong>${escapeHtml(t("status.quotaResets"))}</strong><small>${escapeHtml(resets.length ? String(resets.length) : t("status.none"))}</small></header>${resets.length
      ? resets.map((card) => `<div class="status-row"><span><strong>${escapeHtml(card.providerName)}</strong><small>${escapeHtml(card.label)}</small></span><strong>${escapeHtml(formatReset(card.resetAt))}</strong></div>`).join("")
      : `<p class="status-empty">${escapeHtml(t("status.noResetTimes"))}</p>`}`;
  }

  function renderServiceHealth() {
    const rows = serviceHealthRows(state.health);
    const attention = rows.filter((row) => row.state === "offline" || row.state === "degraded").length;
    const summary = attention
      ? t("health.summaryNeedsAttention", { count: attention })
      : rows.every((row) => row.state === "standby" || row.state === "ready")
        ? t("health.summaryAllClear")
        : t("health.summaryChecking");
    elements.serviceHealth.innerHTML = `<header><strong>${escapeHtml(t("health.serviceHealth"))}</strong><small>${escapeHtml(summary)}</small></header><div class="service-health-list">${rows
      .map((row) => `<div class="service-health-row" data-state="${row.state}"><span class="service-health-title"><i class="service-health-dot" aria-hidden="true"></i><strong>${escapeHtml(row.label)}</strong></span><span class="service-health-pill">${escapeHtml(row.status)}</span><small class="service-health-detail">${escapeHtml(row.detail)}</small></div>`)
      .join("")}</div>`;
  }

  function renderQuotas() {
    const cards = buildQuotaCards(state);
    elements.quotaCards.innerHTML = cards.length
      ? cards
          .map((card) => {
            const percent = card.remainingPercent === null ? "—" : `${Math.round(card.remainingPercent)}%`;
            const progress = card.remainingPercent === null ? 0 : card.remainingPercent;
            return `<article class="quota-card">
              <header><span class="quota-provider">${escapeHtml(card.providerName)}</span><span class="quota-value">${percent}</span></header>
              <h3>${card.label}</h3>
              <progress max="100" value="${progress}" aria-label="${escapeHtml(t("usage.used", { label: card.label, percent }))}"></progress>
              <p>${escapeHtml(formatReset(card.resetAt))}</p>
            </article>`;
          })
          .join("")
      : `<div class="empty-state">${escapeHtml(t("connections.connectToShowLimits"))}</div>`;
  }

  function renderProviders() {
    const providers = state.providerSetup?.providers || [];
    const enabled = new Set(state.snapshot?.targets?.codex?.enabledProviders || []);
    elements.providers.innerHTML = providers.length
      ? providers.map((provider) => providerRow(provider, enabled.has(provider.id))).join("")
      : `<div class="empty-state">${escapeHtml(t("connections.providerSetupUnavailable"))}</div>`;
  }

  function renderLoginFreeSetting() {
    const enabled = state.snapshot?.targets?.codex?.loginFree === true;
    elements.loginFreeSwitch.checked = enabled;
    elements.loginFreeSwitch.disabled = state.loginFreeBusy || state.busyProvider !== null;
    elements.loginFreeSwitchLabel.title = enabled
      ? t("connections.externalModeActive")
      : t("connections.localRouterWithoutLogin");
    elements.loginFreeNote.textContent = enabled
      ? t("connections.externalProvidersRestart")
      : t("connections.useConnectedModels");
  }

  function renderSignedRouting() {
    const target = state.snapshot?.targets?.codex || {};
    const enabled = target.signedRouting === true;
    const managed = target.signedRoutingManaged === true;
    elements.signedRoutingSwitch.checked = enabled;
    elements.signedRoutingSwitch.disabled = state.signedRoutingBusy || managed || state.loginFreeBusy;
    elements.signedRoutingSwitchLabel.title = managed
      ? t("connections.signedRoutingManaged")
      : enabled
        ? t("connections.signedRoutingEnabledTitle")
        : t("connections.signedRoutingDisabledTitle");
    elements.signedRoutingNote.textContent = managed
      ? t("connections.signedRoutingManaged")
      : enabled
        ? t("connections.signedRoutingEnabledNote")
        : t("connections.signedRoutingNote");
  }

  function renderPresence() {
    const mode = state.presence?.mode || "always";
    elements.presenceMode.value = mode;
    elements.presenceMode.disabled = state.presenceBusy;
    elements.presenceNote.textContent = mode === "follow-codex"
      ? t("connections.trayFollowCodex")
      : t("connections.trayNote");
  }

  function renderMaintenance() {
    const busy = Boolean(state.maintenanceBusy);
    elements.maintenanceUpdate.disabled = busy;
    elements.maintenanceFix.disabled = busy;
    if (busy) {
      elements.maintenanceStatus.textContent = state.maintenanceBusy === "fix"
        ? t("connections.maintenanceRepairing")
        : t("connections.maintenanceUpdating");
      elements.maintenanceNote.textContent = t("connections.maintenanceRunning");
      return;
    }
    const result = state.maintenanceResult;
    elements.maintenanceStatus.textContent = result?.ok
      ? t("connections.maintenanceVerified")
      : result?.error ? t("connections.maintenanceFailed") : t("connections.maintenanceReady");
    elements.maintenanceNote.textContent = result?.message || t("connections.maintenanceNote");
  }

  function renderVisionBridge() {
    const vision = state.visionBridge || {};
    state.visionBridge = vision;
    const enabled = vision.enabled === true;
    const selected = vision.engine || "auto";
    const selectedName = vision.resolvedEngineName || vision.resolvedEngine || t("models.visionNoEngine");
    elements.visionSummary.textContent = enabled
      ? t("models.visionSummaryOn", { engine: selectedName })
      : t("models.visionSummaryOff");
    elements.visionNote.textContent = enabled
      ? t("models.visionReading", { engine: selectedName, effort: vision.effort ? ` · ${localizedEffortLabel(vision.effort)}` : "" })
      : t("models.visionOff");
    elements.visionSwitch.checked = enabled;
    elements.visionSwitch.disabled = state.visionBusy;
    elements.visionSwitchLabel.title = enabled
      ? t("models.visionDisable")
      : t("models.visionEnable");

    const engineNames = new Map();
    for (const entry of [...(vision.paidEngines || []), ...(vision.nativeEngines || [])]) {
      if (entry?.slug) engineNames.set(entry.slug, entry.displayName || entry.slug);
    }
    const engineOptions = [
      `<option value="auto"${selected === "auto" || !vision.engine ? " selected" : ""}>${escapeHtml(t("models.visionAuto", { engine: selectedName }))}</option>`,
      ...[...(vision.availableEngines || [])]
        .filter((slug) => slug !== "local")
        .map((slug) => `<option value="${escapeHtml(slug)}"${slug === selected ? " selected" : ""}>${escapeHtml(engineNames.get(slug) || slug)}</option>`),
      ...(vision.localModels || []).some((model) => model.installed)
        ? [`<option value="local"${selected === "local" ? " selected" : ""}>${escapeHtml(t("models.visionLocal", { model: vision.local?.model || "Ollama" }))}</option>`]
        : [],
    ];
    elements.visionEngine.innerHTML = engineOptions.join("");
    elements.visionEngine.disabled = state.visionBusy || !enabled;
    const efforts = vision.availableEfforts || [];
    elements.visionEffort.innerHTML = efforts.length
      ? [`<option value="default"${!vision.effort ? " selected" : ""}>${escapeHtml(t("models.visionModelDefault"))}</option>`, ...efforts.map((effort) => `<option value="${escapeHtml(effort)}"${effort === vision.effort ? " selected" : ""}>${escapeHtml(localizedEffortLabel(effort))}</option>`)].join("")
      : `<option value="default">${escapeHtml(t("models.visionModelDefault"))}</option>`;
    elements.visionEffort.disabled = state.visionBusy || !enabled || !efforts.length;

    const models = vision.localModels || [];
    const operation = state.visionDownload;
    elements.visionLocalModels.innerHTML = models.length
      ? `<div class="local-section-label"><span>${escapeHtml(t("models.visionLocalReaders"))}</span><small>${escapeHtml(t("models.visionAvailable", { count: models.length }))}</small></div>${models.map((model) => {
          const installed = model.installed === true;
          const active = operation?.tag === model.tag && operation?.status === "downloading";
          const action = active ? `<button class="mini-button" type="button" disabled>${Number(operation.percent || 0)}%</button>` : installed ? `<button class="mini-button" type="button" data-command="use_local_vision_model" data-vision-action="use" data-model="${escapeHtml(model.tag)}">${escapeHtml(vision.engine === "local" && vision.local?.model === model.tag ? t("actions.using") : t("actions.use"))}</button>` : `<button class="mini-button" type="button" data-command="pull_vision_model" data-vision-action="download" data-model="${escapeHtml(model.tag)}"${state.visionBusy ? " disabled" : ""}>${escapeHtml(t("actions.download"))}</button>`;
          const tests = installed ? `<button class="text-button" type="button" data-command="benchmark_vision_model" data-vision-action="benchmark" data-model="${escapeHtml(model.tag)}"${state.localBenchmarkBusy ? " disabled" : ""}>${escapeHtml(t("actions.test"))}</button>` : "";
          return `<div class="vision-model-row"><span><strong>${escapeHtml(model.label || model.tag)}</strong><small>${escapeHtml(model.tag)} · ${escapeHtml(model.accuracy || t("models.visionUnmeasured"))}</small></span><span>${tests}${action}</span></div>`;
        }).join("")}`
      : "";
  }

  function providerRow(provider, enabled) {
    const isBusy = state.busyProvider === provider.id;
    const isAnonymous = provider.kind === "anonymous";
    const isApiKey = !provider.credentialLabel || provider.credentialLabel === "API key" || provider.credentialLabel === t("connections.apiKey");
    const credentialLabel = isAnonymous
      ? t("connections.noApiKey")
      : isApiKey
      ? t("connections.apiKey")
      : provider.credentialLabel === "GitHub token" ? t("connections.githubToken") : provider.credentialLabel;
    const kind = provider.kind === "oauth" ? t("connections.oauth") : credentialLabel;
    let detail = provider.configured
      ? t("connections.connected", { kind })
      : t("connections.notConnected", { kind });
    let action = "";
    let actionLabel = "";
    if (provider.kind === "oauth") {
      action = "connect";
      actionLabel = provider.cliInstalled
        ? provider.configured ? t("connections.reconnect") : t("connections.signIn")
        : `${t("connections.installCli")} & ${t("connections.signIn")}`;
    } else if (isAnonymous) {
      action = "none";
      actionLabel = t("connections.ready");
    } else {
      action = "key";
      actionLabel = isApiKey
        ? provider.configured ? t("connections.replaceKey") : t("connections.addKey")
        : provider.configured
          ? t("connections.replaceCredential", { credential: credentialLabel })
          : t("connections.addCredential", { credential: credentialLabel });
    }
    if (isBusy) detail = t("status.working");
    const canRemove = provider.kind === "api" && provider.configured;
    const actionButton = isAnonymous
      ? `<button class="mini-button" type="button" disabled title="${escapeHtml(provider.anonymousNote || t("connections.noApiKey"))}">${escapeHtml(actionLabel)}</button>`
      : `<button class="mini-button" type="button" data-command="${action === "connect" ? "connect_oauth" : "save_api_key"}" data-action="${action}" data-provider="${escapeHtml(provider.id)}"${isBusy ? " disabled" : ""}>${escapeHtml(actionLabel)}</button>`;
    return `<article class="provider-row">
      <div><strong>${escapeHtml(provider.displayName)}</strong><small>${escapeHtml(detail)}</small>${provider.planNote ? `<small>${escapeHtml(localizeProviderPlan(provider.planNote))}</small>` : ""}${provider.anonymousNote ? `<small>${escapeHtml(provider.anonymousNote)}</small>` : ""}</div>
      <div class="provider-actions">
        ${actionButton}
        ${
          canRemove
            ? `<button class="mini-button danger" type="button" data-command="remove_api_key" data-action="remove-key" data-provider="${escapeHtml(provider.id)}" aria-label="${escapeHtml(t("connections.removeCredentialAria", { provider: provider.displayName }))}"${isBusy ? " disabled" : ""}>${escapeHtml(t("actions.remove"))}</button>`
            : ""
        }
        ${
          provider.configured
            ? `<label class="provider-check"><input type="checkbox" data-command="set_provider_enabled" data-provider="${escapeHtml(provider.id)}" aria-label="${escapeHtml(t("connections.enableProviderAria", { provider: provider.displayName }))}"${enabled ? " checked" : ""}${isBusy ? " disabled" : ""}></label>`
            : ""
        }
      </div>
    </article>`;
  }

  function renderIslandSetting() {
    const supported = state.platform?.islandSupported !== false;
    elements.islandSwitch.disabled = !supported;
    elements.islandSwitch.checked = supported && state.settings?.islandEnabled !== false;
    elements.islandSwitchLabel.title = supported ? "" : state.platform?.islandReason || t("footer.unavailable");
    elements.islandNote.textContent = supported
      ? t("footer.topCenterGraph")
      : state.platform?.islandReason || t("general.unavailableThisSession");
  }

  function toggleAccordion(button) {
    const name = button.dataset.accordion;
    const body = document.querySelector(`[data-accordion-body="${name}"]`);
    if (!body) return;
    const open = body.hidden;
    body.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    body.classList.toggle("is-open", open);
  }

  function renderModelSettings() {
    const snapshot = state.snapshot?.targets?.codex;
    const routerCatalog = state.snapshot?.catalog;
    const settings = snapshot?.modelSettings;
    // External model identity and picker policy are router-owned. Keep
    // Codex's native entries from the client probe as the only supplement.
    const clientModels = snapshot?.models || [];
    const nativeModels = clientModels.filter((model) => model.native);
    const seenModels = new Set(nativeModels.map((model) => model.slug));
    const models = routerCatalog
      ? [...nativeModels, ...(routerCatalog.models || []).filter((model) => !seenModels.has(model.slug))]
      : clientModels;
    const enabledModels = models.filter((model) => model.enabled);
    const subagent = routerCatalog?.subagents || settings?.subagents || { mode: "proven", enabled: [], disabled: [] };
    const disabledSubagents = new Set(subagent.disabled || []);
    const selectedSubagents = new Set(subagent.enabled || []);
    const subagentProofs = subagent.proofs || {};
    const hiddenModels = new Set(routerCatalog?.picker?.hidden || settings?.picker?.hidden || []);
    const providerNames = new Map(
      (snapshot?.providers || []).map((provider) => [provider.id, provider.displayName]),
    );
    providerNames.set("openai", "OpenAI");

    function providerLabel(provider) {
      return providerNames.get(provider) || provider;
    }

    const pickerModels = enabledModels.filter((model) =>
      modelMatchesQuery(model, state.pickerModelFilter, providerLabel(model.provider))
    );

    function groupModels(list) {
      const groups = new Map();
      for (const model of list) {
        if (!groups.has(model.provider)) groups.set(model.provider, []);
        groups.get(model.provider).push(model);
      }
      return [...groups.entries()]
        .sort(([left], [right]) => String(left).localeCompare(String(right)))
        .map(([provider, items]) => ({
          provider,
          items: items.sort((left, right) => String(left.slug).localeCompare(String(right.slug))),
        }));
    }

    // `groupSummary` counts what this section actually controls. The two
    // sections list the same providers, so a click that lands in the wrong one
    // has to be visible here rather than only in Codex's picker after a
    // restart. Button labels name the setting for the same reason: two
    // identical "Unselect all" buttons is how a subagent toggle gets mistaken
    // for a picker toggle.
    function providerGroupsMarkup(groups, rowMarkup, setting, groupSummary) {
      const [onLabel, offLabel] =
        setting === "picker"
          ? [t("actions.showAll"), t("actions.hideAll")]
          : [t("actions.subagentsOn"), t("actions.subagentsOff")];
      const groupCommand = setting === "picker" ? "set_picker_provider" : "set_subagent_provider";
      return groups
        .map(
          (group) => `<details class="model-provider-group" open>
            <summary><span>${escapeHtml(providerLabel(group.provider))}</span><span class="model-provider-count">${escapeHtml(groupSummary(group))}</span></summary>
            <div class="model-provider-toolbar">
              ${setting === "picker" && group.items.every((model) => model.native === true && model.nativeClientManaged !== false) ? `<span class="model-provider-note">${escapeHtml(t("models.managedByCodex"))}</span>` : `<button class="text-button" type="button" data-command="${groupCommand}" data-provider-setting="${setting}" data-provider="${escapeHtml(group.provider)}" data-enabled="true">${onLabel}</button>
              <button class="text-button" type="button" data-command="${groupCommand}" data-provider-setting="${setting}" data-provider="${escapeHtml(group.provider)}" data-enabled="false">${offLabel}</button>`}
            </div>
            <div class="model-settings-list">${group.items.map(rowMarkup).join("")}</div>
          </details>`,
        )
        .join("");
    }

    elements.subagentAllSwitch.disabled = state.modelSettingsBusy;
    elements.subagentAllSwitch.checked = subagent.mode === "all";
    elements.subagentAllSwitchLabel.title = t("models.onlyProvenV2");

    // Every enabled model belongs here. Only repository-certified v2 routes
    // are usable subagents. Unknown routes may run one low-cost compatibility
    // test, while explicit v1 routes are never re-promoted locally.
    const subagentModels = enabledModels;
    const subagentGroups = groupModels(subagentModels);
    const subagentCertification = (model) =>
      model.subagentCertification ??
      (model.multiAgentVersion === "v2" ? "v2" : model.multiAgentVersion === "v1" ? "v1" : "unknown");
    const isCertifiedV2 = (model) => subagentCertification(model) === "v2";
    const isSubagentOn = (model) =>
      model.visible === false
        ? false
        : !disabledSubagents.has(model.slug) &&
          isCertifiedV2(model);
    const subagentRow = (model) => {
        const checked = isSubagentOn(model);
        const proof = subagentProofs[model.slug];
        const certification = subagentCertification(model);
        const certified = certification === "v2";
        const knownV1 = certification === "v1";
        const checking = !certified && !knownV1 && proof?.status === "checking";
        const candidate = !certified && !knownV1 && ["candidate", "experimental", "proven"].includes(proof?.status);
        const testActive = !certified && !knownV1 && !candidate &&
          selectedSubagents.has(model.slug);
        const badge = model.visible === false
          ? t("models.hidden")
          : certified
            ? t("models.provenV2")
            : knownV1
              ? t("models.v1Only")
            : checking
              ? t("status.working")
            : candidate
              ? t("models.certificationCandidate")
            : proof?.status === "failed"
              ? `${t("status.error")}: ${proof.reason || t("models.untested")}`
              : t("models.untested");
        return `<label class="model-setting-row">
          <span><strong>${escapeHtml(model.displayName)}</strong><small>${escapeHtml(badge)}</small></span>
          <span class="provider-check"><input type="checkbox" data-command="set_subagent_model" data-subagent="${escapeHtml(model.slug)}" aria-label="${escapeHtml(certified ? t("models.useModelAria", { model: model.displayName }) : knownV1 ? t("models.certifiedV1", { model: model.displayName }) : t("models.testForV2", { model: model.displayName }))}"${certified ? (checked ? " checked" : "") : (testActive ? " checked" : "")}${state.modelSettingsBusy || model.visible === false || knownV1 || candidate ? " disabled" : ""}></span>
        </label>`;
      };

    elements.subagentModelList.innerHTML = subagentGroups.length
      ? providerGroupsMarkup(
          subagentGroups,
          subagentRow,
          "subagents",
          (group) => t("models.providerCountOn", {
            on: group.items.filter(isSubagentOn).length,
            total: group.items.length,
          }),
        )
      : `<div class="empty-state">${escapeHtml(t("models.enableProviderForSubagents"))}</div>`;
    const subagentCount = subagentModels.filter(isSubagentOn).length;
    elements.subagentSummary.textContent = t(subagentCount === 1 ? "models.subagentSummaryOne" : "models.subagentSummary", {
      count: subagentCount,
      mode: localizeSubagentMode(subagent.mode),
    });

    const pickerGroups = groupModels(pickerModels);
    const pickerRow = (model) => {
        const nativeClientManaged = model.native === true && model.nativeClientManaged !== false;
        const visible = nativeClientManaged ? model.visible !== false : !hiddenModels.has(model.slug);
        return `<label class="model-setting-row">
          <span><strong>${escapeHtml(model.displayName)}</strong><small>${escapeHtml(model.slug)}</small></span>
          <span class="provider-check"><input type="checkbox" data-command="set_picker_model" data-picker="${escapeHtml(model.slug)}" aria-label="${escapeHtml(t("models.showModelAria", { model: model.displayName }))}"${visible ? " checked" : ""}${state.modelSettingsBusy || nativeClientManaged ? " disabled" : ""}></span>
        </label>`;
      };

    elements.pickerModelList.innerHTML = pickerGroups.length
      ? providerGroupsMarkup(
          pickerGroups,
          pickerRow,
          "picker",
          (group) =>
            t("models.providerCountVisible", {
              visible: group.items.filter((model) => !hiddenModels.has(model.slug)).length,
              total: group.items.length,
            }),
        )
      : `<div class="empty-state">${escapeHtml(t(state.pickerModelFilter.trim() ? "models.noModelsMatch" : "models.noEnabledModels"))}</div>`;
    const pickerCount = enabledModels.filter((model) => !hiddenModels.has(model.slug)).length;
    elements.pickerSummary.textContent = `${pickerCount} ${t("models.visible")} · ${hiddenModels.size} ${t("models.hidden")}`;
  }

  function formatCompactCount(value) {
    const count = Number(value) || 0;
    if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
    if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
    return String(count);
  }

  function toolResultAgingSavingsLine(stats) {
    if (!stats || !(Number(stats.requests) > 0)) return "";
    const tokens = formatCompactCount(stats.estimatedTokensSaved);
    const mb = ((Number(stats.bytesSaved) || 0) / (1024 * 1024)).toFixed(1);
    return t("models.toolAgingSavings", { tokens, mb, requests: stats.requests });
  }

  function renderToolResultAgingSetting() {
    const aging = state.snapshot?.targets?.codex?.modelSettings?.toolResultAging;
    const overridden = aging?.environmentOverride === true;
    elements.toolResultAgingSwitch.checked = toolResultAgingChecked(aging);
    elements.toolResultAgingSwitch.disabled = state.toolResultAgingBusy || overridden;
    elements.toolResultAgingSwitchLabel.title = overridden
      ? t("models.toolAgingForcedOff")
      : t("models.toolAgingNextRequest");
    elements.toolResultAgingNote.textContent = overridden
      ? t("models.toolAgingEnvironment")
      : `${toolResultAgingSavingsLine(aging?.stats)}${t("models.toolAgingNote")}`;
  }

  function renderLocalModels() {
    const local = state.localModels || {};
    const installed = local.models || [];
    const download = visibleLocalDownload(local);
    const busy = state.localModelBusy;
    const activeOperation = download && ["downloading", "uninstalling"].includes(download.status)
      ? download
      : null;
    const operation = busy || (activeOperation
      ? {
          kind: activeOperation.status === "uninstalling" ? "uninstall" : "install",
          tag: activeOperation.tag,
        }
      : null);
    elements.localModelSummary.textContent = installed.length
      ? t("models.installedSummary", {
          count: installed.length,
          size: (Number(local.totalGb) || 0).toFixed(1),
        })
      : t("models.noneInstalled");

    elements.localModelOperation.hidden = !operation;
    if (operation) {
      const label = operation.kind === "uninstall"
        ? t("status.uninstalling")
        : operation.kind === "install" ? t("status.installing") : t("status.applying");
      elements.localModelOperation.innerHTML = `<span class="operation-pulse" aria-hidden="true"></span><span><strong>${escapeHtml(label)} ${escapeHtml(t("models.localModel"))}</strong><small>${escapeHtml(operation.tag)}</small></span><span class="operation-spinner" aria-hidden="true"></span>`;
      elements.localModelOperation.classList.toggle("is-danger", operation.kind === "uninstall");
    }

    if (download) {
      const running = download.status === "downloading" || download.status === "uninstalling";
      const removal = download.kind === "uninstall";
      const failed = download.status === "error";
      const cancelled = download.status === "cancelled";
      const publicationWarning = !failed && !cancelled && Boolean(download.catalogError || download.restartError);
      const percent = Math.max(0, Math.min(100, Number(download.percent) || 0));
      const title = failed
        ? (removal ? t("models.removalFailed") : t("status.localModelInstallFailed"))
        : cancelled
          ? (removal ? t("models.removalCanceled") : t("models.downloadCanceled"))
          : running
            ? (removal ? `${t("status.uninstalling")} ${t("models.localModel")}` : t("status.installingLocalModel"))
            : removal ? t("models.removedTitle") : t("status.localModelReady");
      const statusClass = failed
        ? " is-error"
        : cancelled
          ? " is-cancelled"
          : publicationWarning
            ? " is-warning"
            : running
              ? " is-running"
              : " is-ready";
      const cancelButton = running && download.tag
        ? `<button class="mini-button danger" type="button" data-command="cancel_local_model" data-local-action="cancel-operation" data-model="${escapeHtml(download.tag)}"${state.localCancelBusy ? " disabled" : ""}>${escapeHtml(t("actions.cancel"))}</button>`
        : "";
      // A terminal download failure/cancellation must be recoverable from the
      // status card itself.  The install form is still available, but a
      // one-click retry makes an interrupted pull obvious and avoids making
      // the operator retype a long Ollama tag or URL.
      const retryButton = !running && !removal && (failed || cancelled) && download.tag
        ? `<button class="mini-button" type="button" data-command="install_local_model" data-local-action="retry-operation" data-model="${escapeHtml(download.tag)}"${state.localModelBusy || state.localCancelBusy ? " disabled" : ""}>${escapeHtml(t("actions.retry"))}</button>`
        : "";
      elements.localDownloadStatus.innerHTML = `<div class="download-status${statusClass}">
        <div class="download-status-head"><span class="operation-pulse" aria-hidden="true"></span><strong>${title}</strong><span>${failed || cancelled || removal ? "" : `${percent}%`}</span>${cancelButton}${retryButton}</div>
        <small>${escapeHtml(download.tag || t("models.localLlms"))}${download.error || download.detail ? ` · ${escapeHtml(download.error || localizeDownloadDetail(download.detail))}` : ""}</small>
        ${running && !removal ? `<progress max="100" value="${percent}" aria-label="${escapeHtml(t("status.installingLocalModel"))} ${escapeHtml(download.tag || t("models.localLlms"))} ${percent}%"></progress>` : ""}
      </div>`;
    } else {
      elements.localDownloadStatus.innerHTML = "";
    }

    const rowBusy = busy || activeOperation || state.localCancelBusy;
    elements.localModelList.innerHTML = installed.length
      ? installed.map((model) => localModelRow(model, rowBusy)).join("")
      : `<div class="empty-state local-empty">${escapeHtml(t("models.nothingInstalled"))}</div>`;

    const installBusy = Boolean(rowBusy) || Boolean(activeOperation);
    elements.localModelInput.disabled = installBusy;
    elements.localModelForm.querySelector("button").disabled = installBusy;
    const availablePicks = Array.isArray(local.available) ? local.available : [];
    const picks = state.localQuickPicksExpanded ? availablePicks : availablePicks.slice(0, 4);
    const morePicks = availablePicks.length > 4
      ? `<button type="button" class="text-button quick-picks-toggle" data-local-action="toggle-picks">${escapeHtml(state.localQuickPicksExpanded ? t("models.showFewerPicks") : t("models.showMorePicks", { count: availablePicks.length - 4 }))}</button>`
      : "";
    elements.localQuickPicks.innerHTML = picks.length
      ? `<div class="local-section-label"><span>${escapeHtml(t("models.quickPicks"))}</span><small>${escapeHtml(t("models.recommendedForMachine"))}</small></div>${picks
          .map(
            (model) => `<button type="button" class="quick-pick" data-command="install_local_model" data-local-action="install" data-model="${escapeHtml(model.tag)}"${installBusy ? " disabled" : ""}>
              <span><strong>${escapeHtml(model.tag)}</strong><small>${escapeHtml(model.codex === "verified" ? t("models.verifiedInCodex") : model.fit || t("models.untested"))}</small></span>
              <span>${Number(model.sizeGb || 0).toFixed(1)} GB</span>
            </button>`,
          )
          .join("")}${morePicks}`
      : "";
    renderLocalCatalog(local, installBusy);
    renderLmstudioSection(local.lmstudio, installBusy);
    const runtime = local.runtime || {};
    const machine = local.machine ? `<small class="muted-line">${escapeHtml(local.machine)}</small>` : "";
    elements.localRuntimeActions.innerHTML = runtime.installed
      ? `<div><small>${escapeHtml(t("models.ollamaRuntime", {
          version: runtime.version || t("models.installedFallback"),
          state: runtime.running ? t("models.ollamaRunning") : t("models.ollamaNotStarted"),
        }))}</small>${runtime.modelsPath ? `<small class="muted-line">${escapeHtml(t("models.modelsPath", { path: runtime.modelsPath }))}</small>` : ""}${machine}</div><button class="text-button" type="button" data-command="update_local_ollama" data-local-runtime-action="update"${state.maintenanceBusy || state.localModelBusy ? " disabled" : ""}>${escapeHtml(t("models.updateOllama"))}</button>`
      : `<small>${escapeHtml(t("models.ollamaMissing"))}</small>`;
  }

  // LM Studio owns loading and unloading its models, so this section is a
  // roster with checkboxes, not a lifecycle manager: checking publishes the
  // model to the picker, and a stopped server reads "not running" instead of
  // the section disappearing.
  function renderLmstudioSection(lmstudio, busy = false) {
    if (!elements.lmstudioSection) return;
    if (!lmstudio) {
      elements.lmstudioSection.innerHTML = "";
      return;
    }
    const name = lmstudio.displayName || "LM Studio";
    const header = `<div class="local-section-label"><span>${escapeHtml(name)}</span><small>${
      lmstudio.reachable
        ? escapeHtml(t("models.lmstudioRunning"))
        : escapeHtml(t("models.lmstudioStopped"))
    }</small></div>`;
    const models = Array.isArray(lmstudio.models) ? lmstudio.models : [];
    if (!models.length) {
      elements.lmstudioSection.innerHTML = lmstudio.reachable
        ? `${header}<div class="empty-state local-empty">${escapeHtml(t("models.lmstudioEmpty"))}</div>`
        : header;
      return;
    }
    const rowBusy = busy || state.lmstudioBusy;
    const rows = models
      .map((model) => {
        const isBusy = state.lmstudioBusy === model.id;
        const detail = model.served
          ? model.enabled ? t("models.lmstudioInPicker") : t("models.lmstudioServedUnchecked")
          : t("models.lmstudioCheckedNotServed");
        return `<article class="local-model-row${isBusy ? " is-busy" : ""}">
          <label class="provider-check"><input type="checkbox" data-command="set_lmstudio_model_enabled" data-lmstudio-toggle="${escapeHtml(model.id)}" aria-label="${escapeHtml(t("models.lmstudioOffer", { model: model.id }))}"${model.enabled ? " checked" : ""}${rowBusy ? " disabled" : ""}></label>
          <div><strong>${escapeHtml(model.id)}</strong><small>${escapeHtml(detail)}</small></div>
        </article>`;
      })
      .join("");
    elements.lmstudioSection.innerHTML = `${header}${rows}`;
  }

  async function handleLmstudioModelToggle(event) {
    const checkbox = event.target.closest("input[data-lmstudio-toggle]");
    if (!checkbox) return;
    const model = checkbox.dataset.lmstudioToggle;
    if (!model || state.lmstudioBusy) return;
    const enabled = checkbox.checked;
    state.lmstudioBusy = model;
    renderLmstudioSection(state.localModels?.lmstudio);
    try {
      state.localModels = await call("set_lmstudio_model_enabled", { model, enabled });
      await refreshPanel({ quiet: true });
    } catch (error) {
      showToast(errorMessage(error), true);
    } finally {
      state.lmstudioBusy = null;
      renderLocalModels();
    }
  }

  function handleLocalCatalogInput(event) {
    const input = event.target.closest("input[data-local-catalog-filter]");
    if (!input) return;
    state.localCatalogFilter = input.value;
    renderLocalCatalog(
      state.localModels || {},
      Boolean(state.localModelBusy) || state.localCancelBusy || ["downloading", "uninstalling"].includes(state.localModels?.download?.status),
    );
    const next = elements.localCatalog.querySelector("input[data-local-catalog-filter]");
    if (!next) return;
    next.focus();
    const cursor = Math.min(state.localCatalogFilter.length, input.selectionStart ?? state.localCatalogFilter.length);
    next.setSelectionRange(cursor, cursor);
  }

  function renderLocalCatalog(local, installBusy = false) {
    const explore = Array.isArray(local.availableExplore) ? local.availableExplore : [];
    if (!explore.length) {
      elements.localCatalog.innerHTML = "";
      return;
    }

    const query = state.localCatalogFilter.trim().toLocaleLowerCase();
    const visible = query
      ? explore.filter((model) => {
          const searchable = [
            model.tag,
            model.family,
            model.displayName,
            model.variant,
            model.note,
            model.researchStatus,
            model.researchNote,
            ...(Array.isArray(model.researchCapabilities) ? model.researchCapabilities : []),
          ]
            .filter(Boolean)
            .join(" ")
            .toLocaleLowerCase();
          return searchable.includes(query);
        })
      : explore;
    const groups = new Map();
    for (const model of visible) {
      const family = String(model.family || String(model.tag || "").split(":", 1)[0] || "other");
      if (!groups.has(family)) groups.set(family, []);
      groups.get(family).push(model);
    }
    const familyNames = new Map(
      (Array.isArray(local.families) ? local.families : []).map((family) => [
        family.family,
        String(family.displayName || family.family || "").split(" · ")[0],
      ]),
    );
    const installed = new Set((Array.isArray(local.models) ? local.models : []).map((model) => model.tag));
    const sortedGroups = [...groups.entries()].sort((left, right) => {
      const leftName = familyNames.get(left[0]) || left[0];
      const rightName = familyNames.get(right[0]) || right[0];
      return leftName.localeCompare(rightName);
    });
    const detail = query
      ? t("models.catalogCountFiltered", {
          visible: visible.length,
          total: explore.length,
          families: sortedGroups.length,
        })
      : t("models.catalogCount", { tags: explore.length, families: sortedGroups.length });

    elements.localCatalog.innerHTML = `
      <div class="local-catalog-heading">
        <div class="local-section-label"><span>${escapeHtml(t("models.catalogDiscover"))}</span><small>${escapeHtml(detail)}</small></div>
        <p>${escapeHtml(t("models.catalogSnapshot"))}</p>
        <button type="button" class="text-button" data-local-catalog-action="variant-help">${escapeHtml(state.localVariantHelpExpanded ? t("models.tagGuideHide") : t("models.tagGuideShow"))}</button>
        ${state.localVariantHelpExpanded ? `<p class="local-catalog-help">${escapeHtml(t("models.tagGuideBody"))}</p>` : ""}
      </div>
      <div class="local-catalog-search">
        <input type="search" data-local-catalog-filter value="${escapeHtml(state.localCatalogFilter)}" placeholder="${escapeHtml(t("models.catalogSearch"))}" autocomplete="off" spellcheck="false" aria-label="${escapeHtml(t("models.catalogSearch"))}" />
        ${query ? `<button class="text-button" type="button" data-local-catalog-clear>${escapeHtml(t("actions.clear"))}</button>` : ""}
      </div>
      ${sortedGroups.length ? sortedGroups.map(([family, models]) => {
        const familyName = familyNames.get(family) || family;
        const rows = [...models].sort(compareLocalCatalogModels);
        const fitCount = rows.filter((model) => localCatalogFit(model) === "fits" || localCatalogFit(model) === "tight").length;
        const cloudCount = rows.filter((model) => model.downloadable === false).length;
        const familyDetail = `${t(rows.length === 1 ? "models.catalogTagCountOne" : "models.catalogTagCount", { count: rows.length })}${
          fitCount ? ` · ${t("models.catalogLocalCount", { count: fitCount })}` : ""
        }${cloudCount ? ` · ${t("models.catalogCloudCount", { count: cloudCount })}` : ""}`;
        return `<details class="local-catalog-family" open>
          <summary><span><strong>${escapeHtml(familyName)}</strong><small>${escapeHtml(familyDetail)}</small></span><span class="accordion-chevron" aria-hidden="true"></span></summary>
          <div class="local-catalog-list">${rows.map((model) => localCatalogRow(model, installed, installBusy)).join("")}</div>
        </details>`;
      }).join("") : `<div class="empty-state local-empty">${escapeHtml(t("models.catalogNoMatch", { query: state.localCatalogFilter }))}</div>`}
    `;
    const clear = elements.localCatalog.querySelector("[data-local-catalog-clear]");
    clear?.addEventListener("click", () => {
      state.localCatalogFilter = "";
      renderLocalCatalog(
        state.localModels || {},
        Boolean(state.localModelBusy) || state.localCancelBusy || ["downloading", "uninstalling"].includes(state.localModels?.download?.status),
      );
      elements.localCatalog.querySelector("input[data-local-catalog-filter]")?.focus();
    });
  }

  function localCatalogRow(model, installed, installBusy) {
    const tag = String(model.tag || "");
    const downloadable = model.downloadable !== false;
    const tooLarge = downloadable && (model.fit === "too-large" || model.diskFit === "too-large");
    const fit = localCatalogFit(model);
    const fitClass = fit === "too-large" ? " is-danger" : fit === "tight" ? " is-warning" : "";
    const capabilities = Array.isArray(model.researchCapabilities) && model.researchCapabilities.length
      ? ` · ${model.researchCapabilities.join(" · ")}`
      : "";
    const title = model.displayName && model.displayName !== tag ? model.displayName : tag;
    let action;
    if (!downloadable) {
      action = `<span class="local-catalog-cloud">${escapeHtml(t("models.catalogCloudOnly"))}</span>`;
    } else if (installed.has(tag)) {
      action = `<span class="local-catalog-installed">${escapeHtml(t("models.catalogInstalled"))}</span>`;
    } else {
      action = `<button class="mini-button${tooLarge ? " danger" : ""}" type="button" data-command="install_local_model" data-local-action="install" data-model="${escapeHtml(tag)}"${installBusy ? " disabled" : ""}>${escapeHtml(tooLarge ? t("models.catalogAnyway") : t("actions.download"))}</button>`;
    }
    return `<article class="local-catalog-row${tooLarge ? " is-too-large" : ""}">
      <div class="local-catalog-copy"><strong>${escapeHtml(title)}</strong><small>${escapeHtml(tag)}${escapeHtml(capabilities)}</small></div>
      <span class="local-catalog-size">${downloadable ? `${(Number(model.sizeGb) || 0).toFixed(1)} GB` : escapeHtml(t("models.catalogCloud"))}</span>
      <span class="local-catalog-fit${fitClass}">${escapeHtml(localCatalogFitLabel(fit))}</span>
      ${action}
    </article>`;
  }

  function localCatalogFit(model) {
    if (model.downloadable === false) return "cloud";
    if (model.fit === "too-large" || model.diskFit === "too-large") return "too-large";
    if (model.fit === "tight" || model.diskFit === "tight") return "tight";
    return model.fit || model.diskFit || "untested";
  }

  // The fit keys above are sort ranks, so they stay stable English tokens and
  // only the label is translated.
  function localCatalogFitLabel(fit) {
    const key = {
      fits: "models.fitFits",
      "cloud only": "models.fitCloudOnly",
      "won’t fit": "models.fitTooLarge",
      tight: "models.fitTight",
      untested: "models.untested",
    }[fit];
    return key ? t(key) : fit;
  }

  function compareLocalCatalogModels(left, right) {
    const leftLatest = left.variant === "latest";
    const rightLatest = right.variant === "latest";
    if (leftLatest !== rightLatest) return leftLatest ? -1 : 1;
    const fitRank = { fits: 0, tight: 1, cloud: 2, "too-large": 3 };
    const leftRank = fitRank[localCatalogFit(left)] ?? 4;
    const rightRank = fitRank[localCatalogFit(right)] ?? 4;
    if (leftRank !== rightRank) return leftRank - rightRank;
    const leftSize = Number(left.sizeGb) || 0;
    const rightSize = Number(right.sizeGb) || 0;
    if (leftSize !== rightSize) return leftSize - rightSize;
    return String(left.tag || "").localeCompare(String(right.tag || ""));
  }

  function localModelRow(model, busy) {
    const isBusy = busy?.tag === model.tag;
    const armed = state.localRemoveArmed === model.tag;
    const speed = model.tokensPerSecond === null || model.tokensPerSecond === undefined
      ? Number.NaN
      : Number(model.tokensPerSecond);
      const detail = [
      model.agent === "agent" ? t("models.worksInCodex") : model.tools ? t("models.chatUntested") : t("models.noToolCalling"),
      Number.isFinite(speed) ? `${speed.toFixed(1)} tok/s` : t("models.speedUnmeasured"),
    ].join(" · ");
    const speedAction = `<button class="text-button" type="button" data-command="local_model_speed" data-local-action="measure-speed" data-model="${escapeHtml(model.tag)}"${state.localBenchmarkBusy ? " disabled" : ""}>${escapeHtml(t("actions.speed"))}</button>`;
    const visionActions = model.vision
      ? `<button class="text-button" type="button" data-command="benchmark_vision_model" data-local-action="test-image" data-model="${escapeHtml(model.tag)}"${state.localBenchmarkBusy ? " disabled" : ""}>${escapeHtml(t("actions.testImage"))}</button><button class="text-button" type="button" data-command="use_local_vision_model" data-local-action="use-image" data-model="${escapeHtml(model.tag)}"${state.visionBusy ? " disabled" : ""}>${escapeHtml(state.visionBridge?.engine === "local" && state.visionBridge?.local?.model === model.tag ? t("actions.usingImage") : t("actions.useImage"))}</button>`
      : "";
    return `<article class="local-model-row${isBusy ? " is-busy" : ""}">
      <label class="provider-check"><input type="checkbox" data-command="set_local_model_enabled" data-local-toggle="${escapeHtml(model.tag)}" aria-label="${escapeHtml(t("models.enableLocalAria", { model: model.tag }))}"${model.enabled ? " checked" : ""}${busy || model.tools !== true ? " disabled" : ""}></label>
      <div><strong>${escapeHtml(model.tag)}</strong><small>${escapeHtml(detail)}</small></div>
      <span class="local-size">${Number(model.sizeGb || 0).toFixed(1)} GB</span>
      <div class="local-model-actions">${speedAction}${visionActions}<button class="mini-button danger" type="button" data-command="uninstall_local_model" data-local-action="${armed ? "confirm-remove" : "remove"}" data-model="${escapeHtml(model.tag)}"${busy ? " disabled" : ""}>${armed ? escapeHtml(t("actions.confirm")) : escapeHtml(t("actions.remove"))}</button></div>
    </article>`;
  }

  async function handleLocalModelInstall(event) {
    event.preventDefault();
    const model = elements.localModelInput.value.trim();
    if (!model) {
      showToast(t("models.enterOllamaTag"), true);
      return;
    }
    elements.localModelInput.value = "";
    await startLocalInstall(model);
  }

  async function handleLocalModelClick(event) {
    const catalogAction = event.target.closest("button[data-local-catalog-action]");
    if (catalogAction?.dataset.localCatalogAction === "variant-help") {
      state.localVariantHelpExpanded = !state.localVariantHelpExpanded;
      renderLocalCatalog(
        state.localModels || {},
        Boolean(state.localModelBusy) || state.localCancelBusy || ["downloading", "uninstalling"].includes(state.localModels?.download?.status),
      );
      return;
    }
    const button = event.target.closest("button[data-local-action]");
    if (!button) return;
    if (button.dataset.localAction === "toggle-picks") {
      state.localQuickPicksExpanded = !state.localQuickPicksExpanded;
      renderLocalModels();
      return;
    }
    const model = button.dataset.model;
    if (button.dataset.localAction === "cancel-operation") {
      await cancelLocalModel(model);
      return;
    }
    if (button.dataset.localAction === "retry-operation") {
      if (!model || state.localModelBusy || state.localCancelBusy) return;
      await startLocalInstall(model);
      return;
    }
    if (!model) {
      showToast(t("models.missingTag"), true);
      return;
    }
    if (button.dataset.localAction === "install") {
      await startLocalInstall(model);
      return;
    }
    if (button.dataset.localAction === "measure-speed") {
      await benchmarkLocalSpeed(model);
      return;
    }
    if (button.dataset.localAction === "test-image") {
      await benchmarkVisionModel(model);
      return;
    }
    if (button.dataset.localAction === "use-image") {
      await useLocalVisionModel(model);
      return;
    }
    if (button.dataset.localAction === "remove") {
      if (state.localModelBusy || ["downloading", "uninstalling"].includes(state.localModels?.download?.status)) return;
      state.localRemoveArmed = model;
      renderLocalModels();
      return;
    }
    if (button.dataset.localAction !== "confirm-remove") return;
    if (state.localModelBusy || ["downloading", "uninstalling"].includes(state.localModels?.download?.status)) return;
    state.localRemoveArmed = null;
    state.localModelBusy = { kind: "uninstall", tag: model };
    state.localModels = {
      ...(state.localModels || {}),
      download: { kind: "uninstall", tag: model, status: "uninstalling", detail: "starting", percent: 0 },
    };
    renderLocalModels();
    try {
      state.localModels = await call("uninstall_local_model", { model });
      await pollLocalOperation(model, "uninstall");
    } catch (error) {
      try {
        state.localModels = await call("local_models");
      } catch {
        state.localModels = {
          ...(state.localModels || {}),
          download: {
            kind: "uninstall",
            tag: model,
            status: "error",
            detail: t("models.removalFailedDetail"),
            error: errorMessage(error),
          },
        };
      }
      showToast(errorMessage(error), true);
    } finally {
      if (!state.localPollTimer) {
        state.localModelBusy = null;
        renderLocalModels();
      }
    }
  }

  async function handleLocalModelToggle(event) {
    const checkbox = event.target.closest("input[data-local-toggle]");
    if (!checkbox) return;
    const model = checkbox.dataset.localToggle;
    if (!model || state.localModelBusy || state.localCancelBusy || ["downloading", "uninstalling"].includes(state.localModels?.download?.status)) {
      return;
    }
    const enabled = checkbox.checked;
    state.localModelBusy = { kind: "toggle", tag: model };
    renderLocalModels();
    try {
      state.localModels = await call("set_local_model_enabled", { model, enabled });
      await refreshPanel({ quiet: true });
    } catch (error) {
      showToast(errorMessage(error), true);
    } finally {
      state.localModelBusy = null;
      renderLocalModels();
    }
  }

  async function startLocalInstall(model, { force = false } = {}) {
    model = String(model || "").trim();
    if (!model) {
      showToast(t("models.missingTag"), true);
      return;
    }
    const active = state.localModels?.download;
    if (state.localModelBusy || state.localCancelBusy || ["downloading", "uninstalling"].includes(active?.status)) {
      showToast(
        active?.tag === model
          ? t("models.alreadyInProgress", { model })
          : t("models.operationInProgress"),
        true,
      );
      return;
    }
    state.localRemoveArmed = null;
    state.localModelBusy = { kind: "install", tag: model };
    state.localModels = {
      ...(state.localModels || {}),
      download: { kind: "download", tag: model, status: "downloading", detail: "starting", percent: 0 },
    };
    renderLocalModels();
    try {
      // The router installs and starts Ollama headlessly as part of this call
      // when it is missing, so one action covers the runtime and the model.
      const result = await call("install_local_model", { model, force });
      const operationTag = String(result?.tag || model);
      if (operationTag !== model) {
        state.localModels = {
          ...(state.localModels || {}),
          download: { ...(state.localModels?.download || {}), tag: operationTag },
        };
        renderLocalModels();
      }
      await pollLocalInstall(operationTag);
    } catch (error) {
      const detail = errorMessage(error);
      try {
        state.localModels = await call("local_models");
      } catch {}
      state.localModelBusy = null;
      renderLocalModels();
      // A model rated too large is refused once, not hidden. Ask, then retry
      // with the override so every catalog entry stays installable.
      if (!force && detail.includes("--force")) {
        if (window.confirm(`${detail}\n\n${t("models.downloadAnyway", { model })}`)) {
          await startLocalInstall(model, { force: true });
        }
        return;
      }
      showToast(detail, true);
    }
  }

  async function pollLocalInstall(model) {
    await pollLocalOperation(model, "install");
  }

  async function pollLocalOperation(model, kind) {
    window.clearTimeout(state.localPollTimer);
    try {
      state.localModels = await call("local_models");
      renderLocalModels();
      const download = state.localModels?.download;
      if (download?.tag === model && ["downloading", "uninstalling"].includes(download.status)) {
        state.localPollTimer = window.setTimeout(() => pollLocalOperation(model, kind), 1_000);
        return;
      }
      state.localPollTimer = null;
      state.localModelBusy = null;
      if (download?.status === "done") {
        showToast(kind === "uninstall" ? t("models.localModelRemoved", { model: download.tag || model }) : t("models.localModelReadyRestart", { model: download.tag || model }));
      } else if (download?.status === "cancelled") {
        showToast(kind === "uninstall"
          ? t("models.removalCanceledToast", { model: download.tag || model })
          : t("models.downloadCanceledToast", { model: download.tag || model }));
      } else if (download?.status === "error") {
        showToast(download.error || t("models.localModelInstallError"), true);
      }
      await refreshPanel({ quiet: true });
    } catch (error) {
      state.localPollTimer = window.setTimeout(() => pollLocalOperation(model, kind), 1_500);
    }
  }

  async function cancelLocalModel(model) {
    if (state.localCancelBusy) return;
    state.localCancelBusy = true;
    window.clearTimeout(state.localPollTimer);
    state.localPollTimer = null;
    renderLocalModels();
    try {
      const result = await call("cancel_local_model", { model });
      state.localModels = await call("local_models");
      showToast(result?.cancelled
        ? t("models.operationCanceled", { model })
        : t("models.noOperation"));
    } catch (error) {
      showToast(errorMessage(error), true);
    } finally {
      state.localCancelBusy = false;
      state.localModelBusy = null;
      await refreshPanel({ quiet: true });
    }
  }

  async function handleLocalRuntimeClick(event) {
    const button = event.target.closest("button[data-local-runtime-action]");
    if (!button || button.dataset.localRuntimeAction !== "update" || state.maintenanceBusy) return;
    state.maintenanceBusy = "ollama";
    renderMaintenance();
    renderLocalModels();
    try {
      await call("update_local_ollama");
      showToast(t("models.ollamaUpdated"));
      await refreshPanel({ quiet: true });
    } catch (error) {
      showToast(errorMessage(error), true);
    } finally {
      state.maintenanceBusy = null;
      renderMaintenance();
      renderLocalModels();
    }
  }

  async function benchmarkLocalSpeed(model) {
    if (!model || state.localBenchmarkBusy || state.localModelBusy) return;
    state.localBenchmarkBusy = { kind: "speed", tag: model };
    renderLocalModels();
    try {
      await call("local_model_speed", { model });
      showToast(t("models.speedMeasured", { model }));
      await refreshPanel({ quiet: true });
    } catch (error) {
      showToast(errorMessage(error), true);
    } finally {
      state.localBenchmarkBusy = null;
      renderLocalModels();
    }
  }

  async function benchmarkVisionModel(model) {
    if (!model || state.localBenchmarkBusy || state.localModelBusy) return;
    state.localBenchmarkBusy = { kind: "vision", tag: model };
    renderLocalModels();
    renderVisionBridge();
    try {
      await call("benchmark_vision_model", { model });
      showToast(t("models.visionTested", { model }));
      await refreshPanel({ quiet: true });
    } catch (error) {
      showToast(errorMessage(error), true);
    } finally {
      state.localBenchmarkBusy = null;
      renderLocalModels();
      renderVisionBridge();
    }
  }

  async function useLocalVisionModel(model) {
    if (!model || state.visionBusy) return;
    state.visionBusy = true;
    renderVisionBridge();
    renderLocalModels();
    try {
      await call("use_local_vision_model", { model });
      showToast(t("models.visionReader", { model }));
      await refreshPanel({ quiet: true });
    } catch (error) {
      showToast(errorMessage(error), true);
    } finally {
      state.visionBusy = false;
      renderVisionBridge();
      renderLocalModels();
    }
  }

  async function handleVisionClick(event) {
    const button = event.target.closest("button[data-vision-action]");
    if (!button) return;
    const model = button.dataset.model;
    if (!model) return;
    if (button.dataset.visionAction === "use") {
      await useLocalVisionModel(model);
    } else if (button.dataset.visionAction === "benchmark") {
      await benchmarkVisionModel(model);
    } else if (button.dataset.visionAction === "download") {
      await startVisionDownload(model);
    }
  }

  async function startVisionDownload(model) {
    if (!model || state.visionBusy || state.visionDownload?.status === "downloading") return;
    state.visionBusy = true;
    state.visionDownload = { tag: model, status: "downloading", percent: 0, detail: "starting" };
    renderVisionBridge();
    try {
      await call("pull_vision_model", { model });
      pollVisionDownload(model);
    } catch (error) {
      state.visionBusy = false;
      state.visionDownload = { tag: model, status: "error", error: errorMessage(error) };
      renderVisionBridge();
      showToast(errorMessage(error), true);
    }
  }

  async function pollVisionDownload(model) {
    window.clearTimeout(state.visionPollTimer);
    try {
      const status = await call("vision_pull_status");
      state.visionDownload = status;
      renderVisionBridge();
      if (status?.tag === model && status.status === "downloading") {
        state.visionPollTimer = window.setTimeout(() => pollVisionDownload(model), 1_000);
        return;
      }
      state.visionPollTimer = null;
      state.visionBusy = false;
      if (status?.status === "done") {
        showToast(t("models.visionDownloaded", { model }));
        await refreshPanel({ quiet: true });
      } else if (status?.status === "error") {
        showToast(status.error || t("models.visionDownloadFailed"), true);
      }
      renderVisionBridge();
    } catch {
      state.visionPollTimer = window.setTimeout(() => pollVisionDownload(model), 1_500);
    }
  }

  async function handleSubagentAllToggle() {
    const enabled = elements.subagentAllSwitch.checked;
    const settings = state.snapshot?.targets?.codex?.modelSettings?.subagents;
    const enabledSet = new Set(settings?.enabled || []);
    const mode = enabled ? "all" : enabledSet.size ? "selected" : "proven";
    state.modelSettingsBusy = true;
    renderModelSettings();
    try {
      state.snapshot = await call("set_subagent_mode", { mode });
      showToast(enabled ? t("models.allSubagentsEnabled") : t("models.subagentModeUpdated"));
      await refreshPanel({ quiet: true });
    } catch (error) {
      elements.subagentAllSwitch.checked = !enabled;
      showToast(errorMessage(error), true);
    } finally {
      state.modelSettingsBusy = false;
      renderModelSettings();
    }
  }

  async function handleModelSettingsClick(event) {
    const providerButton = event.target.closest("button[data-provider-setting]");
    if (providerButton) {
      const setting = providerButton.dataset.providerSetting;
      const provider = providerButton.dataset.provider;
      const enabled = providerButton.dataset.enabled === "true";
      state.modelSettingsBusy = true;
      renderModelSettings();
      try {
        if (setting === "subagents") {
          state.snapshot = await call("set_subagent_provider", { provider, enabled });
        } else {
          state.snapshot = await call("set_picker_provider", { provider, visible: enabled });
        }
        showToast(
          setting === "subagents"
            ? t(enabled ? "models.providerSubagentsOn" : "models.providerSubagentsOff", { provider })
            : t(enabled ? "models.providerShown" : "models.providerHidden", { provider }),
        );
        await refreshPanel({ quiet: true });
      } catch (error) {
        showToast(errorMessage(error), true);
      } finally {
        state.modelSettingsBusy = false;
        renderModelSettings();
      }
      return;
    }
    const button = event.target.closest("button[data-model-action]");
    if (!button) return;
    const group = button.dataset.modelAction;
    const action = button.dataset.action;
    state.modelSettingsBusy = true;
    renderModelSettings();
    try {
      if (group === "subagents") {
        const selectAll = action === "select-all";
        state.snapshot = await call("set_subagent_selection", { selectAll });
        showToast(t(selectAll ? "models.everyPickerModelSubagent" : "models.subagentSelectionCleared"));
      } else {
        const showAll = action === "show-all";
        state.snapshot = await call("set_picker_models", { showAll });
        showToast(t(showAll ? "models.everyModelVisible" : "models.allModelsHidden"));
      }
      await refreshPanel({ quiet: true });
    } catch (error) {
      showToast(errorMessage(error), true);
    } finally {
      state.modelSettingsBusy = false;
      renderModelSettings();
    }
  }

  async function handleModelSettingsToggle(event) {
    const subagent = event.target.closest('input[data-subagent]');
    const picker = event.target.closest('input[data-picker]');
    if (!subagent && !picker) return;
    state.modelSettingsBusy = true;
    renderModelSettings();
    try {
      if (subagent) {
        state.snapshot = await call("set_subagent_model", {
          slug: subagent.dataset.subagent,
          enabled: subagent.checked,
        });
        showToast(t("models.subagentSelectionUpdated"));
      } else {
        state.snapshot = await call("set_picker_model", {
          slug: picker.dataset.picker,
          visible: picker.checked,
        });
        showToast(t("models.pickerUpdated"));
      }
      await refreshPanel({ quiet: true });
    } catch (error) {
      if (subagent) subagent.checked = !subagent.checked;
      else picker.checked = !picker.checked;
      showToast(errorMessage(error), true);
    } finally {
      state.modelSettingsBusy = false;
      renderModelSettings();
    }
  }

  async function handleProviderClick(event) {
    const button = event.target.closest("button[data-provider]");
    if (!button) return;
    const provider = button.dataset.provider;
    const action = button.dataset.action;
    if (action === "key") {
      const setup = state.providerSetup?.providers?.find((item) => item.id === provider);
      const isApiKey = !setup?.credentialLabel || setup.credentialLabel === "API key" || setup.credentialLabel === t("connections.apiKey");
      const credentialLabel = isApiKey
        ? t("connections.apiKey")
        : setup.credentialLabel === "GitHub token" ? t("connections.githubToken") : setup.credentialLabel;
      const credentialNoun = credentialLabel;
      state.keyProvider = provider;
      elements.keyTitle.textContent = setup?.configured
        ? t("connections.replaceCredentialTitle", { provider: setup.displayName, credential: credentialNoun })
        : t("connections.addCredentialTitle", { provider: setup?.displayName || "API", credential: credentialNoun });
      elements.keyInput.placeholder = t("connections.pasteCredentialType", { credential: credentialNoun });
      elements.keyDialog.showModal();
      requestAnimationFrame(() => elements.keyInput.focus());
      return;
    }

    if (action === "remove-key") {
      const setup = state.providerSetup?.providers?.find((item) => item.id === provider);
      const name = setup?.displayName || t("general.provider");
      const isApiKey = !setup?.credentialLabel || setup.credentialLabel === "API key" || setup.credentialLabel === t("connections.apiKey");
      const credentialLabel = isApiKey
        ? t("connections.apiKey")
        : setup.credentialLabel === "GitHub token" ? t("connections.githubToken") : setup.credentialLabel;
      const credentialNoun = credentialLabel;
      state.removeProvider = provider;
      elements.removeTitle.textContent = t("connections.removeCredentialTitle", { provider: name, credential: credentialNoun });
      elements.removeBody.textContent = t("connections.removeBodyDynamic", { provider: name, credential: credentialNoun });
      elements.removeDialog.showModal();
      requestAnimationFrame(() => elements.cancelRemove.focus());
      return;
    }

    state.busyProvider = provider;
    renderProviders();
    try {
      if (action === "connect") {
        const setup = state.providerSetup?.providers?.find((item) => item.id === provider);
        // OAuth setup is intentionally one click: if the official CLI is not
        // present, install it and continue straight into its browser login.
        // Leaving the user at an "installed" state made the Windows tray
        // differ from the native Mac companion and invited duplicate clicks.
        if (!setup?.cliInstalled) await call("install_provider_cli", { provider });
        await call("connect_oauth", { provider });
        showToast(t("connections.providerConnected"));
      }
      await refreshPanel({ quiet: true });
    } catch (error) {
      showToast(errorMessage(error), true);
    } finally {
      state.busyProvider = null;
      renderProviders();
    }
  }

  async function handleProviderToggle(event) {
    const checkbox = event.target.closest('input[type="checkbox"][data-provider]');
    if (!checkbox) return;
    const provider = checkbox.dataset.provider;
    const enabled = checkbox.checked;
    checkbox.disabled = true;
    state.busyProvider = provider;
    try {
      state.snapshot = await call("set_provider_enabled", { provider, enabled });
      showToast(enabled ? t("connections.providerEnabled") : t("connections.providerHidden"));
      await refreshPanel({ quiet: true });
    } catch (error) {
      checkbox.checked = !enabled;
      showToast(errorMessage(error), true);
    } finally {
      state.busyProvider = null;
      renderProviders();
    }
  }

  async function handleIslandToggle() {
    const enabled = elements.islandSwitch.checked;
    elements.islandSwitch.disabled = true;
    try {
      await call("set_island_enabled", { enabled });
      state.settings = { ...(state.settings || {}), islandEnabled: enabled };
    } catch (error) {
      elements.islandSwitch.checked = !enabled;
      showToast(errorMessage(error), true);
    } finally {
      renderIslandSetting();
    }
  }

  async function handleLoginFreeToggle() {
    const enabled = elements.loginFreeSwitch.checked;
    state.loginFreeBusy = true;
    renderLoginFreeSetting();
    try {
      state.snapshot = await call("set_login_free", { enabled });
      showToast(
        enabled
          ? t("connections.openAILoginDisabled")
          : t("connections.openAILoginRestored"),
      );
    } catch (error) {
      elements.loginFreeSwitch.checked = !enabled;
      showToast(errorMessage(error), true);
    } finally {
      state.loginFreeBusy = false;
      renderLoginFreeSetting();
    }
  }

  async function handleSignedRoutingToggle() {
    const enabled = elements.signedRoutingSwitch.checked;
    state.signedRoutingBusy = true;
    renderSignedRouting();
    try {
      state.snapshot = await call("set_signed_routing", { enabled });
      showToast(
        enabled
          ? t("connections.signedRoutingEnabledToast")
          : t("connections.signedRoutingDisabledToast"),
      );
      await refreshPanel({ quiet: true });
    } catch (error) {
      elements.signedRoutingSwitch.checked = !enabled;
      showToast(errorMessage(error), true);
    } finally {
      state.signedRoutingBusy = false;
      renderSignedRouting();
    }
  }

  async function handlePresenceModeChange() {
    const mode = elements.presenceMode.value || "always";
    const previous = state.presence?.mode || "always";
    state.presenceBusy = true;
    renderPresence();
    try {
      state.presence = await call("set_presence_mode", { mode });
      showToast(mode === "follow-codex"
        ? t("connections.trayFollowToast")
        : t("connections.trayAlwaysToast"));
    } catch (error) {
      elements.presenceMode.value = previous;
      showToast(errorMessage(error), true);
    } finally {
      state.presenceBusy = false;
      renderPresence();
    }
  }

  async function handleVisionToggle() {
    const enabled = elements.visionSwitch.checked;
    state.visionBusy = true;
    renderVisionBridge();
    try {
      state.visionBridge = await call("set_vision_bridge", { enabled });
      showToast(enabled ? t("models.visionEnabledToast") : t("models.visionDisabledToast"));
      await refreshPanel({ quiet: true });
    } catch (error) {
      elements.visionSwitch.checked = !enabled;
      showToast(errorMessage(error), true);
    } finally {
      state.visionBusy = false;
      renderVisionBridge();
    }
  }

  async function handleVisionEngineChange() {
    const engine = elements.visionEngine.value || "auto";
    const effort = elements.visionEffort.value || "default";
    state.visionBusy = true;
    renderVisionBridge();
    try {
      state.visionBridge = await call("set_vision_engine", { engine, effort });
      showToast(engine === "local"
        ? t("models.visionEngineLocalToast")
        : t("models.visionEngineToast"));
      await refreshPanel({ quiet: true });
    } catch (error) {
      showToast(errorMessage(error), true);
    } finally {
      state.visionBusy = false;
      renderVisionBridge();
    }
  }

  async function handleVisionEffortChange() {
    const effort = elements.visionEffort.value || "default";
    state.visionBusy = true;
    renderVisionBridge();
    try {
      state.visionBridge = await call("set_vision_effort", { effort });
      showToast(effort === "default"
        ? t("models.visionEffortDefaultToast")
        : t("models.visionEffortToast", { effort: localizedEffortLabel(effort) }));
      await refreshPanel({ quiet: true });
    } catch (error) {
      showToast(errorMessage(error), true);
    } finally {
      state.visionBusy = false;
      renderVisionBridge();
    }
  }

  async function runMaintenance(kind) {
    if (state.maintenanceBusy) return;
    state.maintenanceBusy = kind;
    state.maintenanceResult = null;
    renderMaintenance();
    try {
      const result = await call(kind === "fix" ? "doctor_fix" : "maintenance");
      state.maintenanceResult = {
        ok: result?.ok !== false,
        message: kind === "fix"
          ? t("connections.maintenanceRepairDone")
          : result?.restartRequired
            ? t("connections.maintenanceUpdatedRestart")
            : t("connections.maintenanceUpdated"),
      };
      showToast(state.maintenanceResult.message);
      await refreshPanel({ quiet: true });
    } catch (error) {
      state.maintenanceResult = { ok: false, error: true, message: errorMessage(error) };
      showToast(errorMessage(error), true);
    } finally {
      state.maintenanceBusy = null;
      renderMaintenance();
    }
  }

  async function handleToolResultAgingToggle() {
    const enabled = elements.toolResultAgingSwitch.checked;
    state.toolResultAgingBusy = true;
    renderToolResultAgingSetting();
    try {
      await call("set_tool_result_aging", { enabled });
      await refreshPanel({ quiet: true });
      showToast(
        enabled
          ? t("models.toolAgingOn")
          : t("models.toolAgingExact"),
      );
    } catch (error) {
      elements.toolResultAgingSwitch.checked = !enabled;
      showToast(errorMessage(error), true);
    } finally {
      state.toolResultAgingBusy = false;
      renderToolResultAgingSetting();
    }
  }

  async function saveKey(event) {
    event.preventDefault();
    const provider = state.keyProvider;
    const apiKey = elements.keyInput.value;
    elements.keyInput.value = "";
    if (!provider || !apiKey.trim()) return;
    closeKeyDialog();
    state.busyProvider = provider;
    renderProviders();
    try {
      await call("save_api_key", { provider, apiKey });
      showToast(t("connections.credentialSaved"));
      await refreshPanel({ quiet: true });
    } catch (error) {
      showToast(errorMessage(error), true);
    } finally {
      state.busyProvider = null;
      renderProviders();
    }
  }

  async function removeKey(event) {
    event.preventDefault();
    const provider = state.removeProvider;
    closeRemoveDialog();
    if (!provider) return;
    state.busyProvider = provider;
    renderProviders();
    try {
      const result = await call("remove_api_key", { provider });
      showToast(removalMessage(result?.removal));
      await refreshPanel({ quiet: true });
    } catch (error) {
      showToast(errorMessage(error), true);
    } finally {
      state.busyProvider = null;
      renderProviders();
    }
  }

  function closeKeyDialog() {
    elements.keyInput.value = "";
    if (elements.keyDialog.open) elements.keyDialog.close();
  }

  function closeRemoveDialog() {
    if (elements.removeDialog.open) elements.removeDialog.close();
  }

  function showToast(message, isError = false) {
    window.clearTimeout(state.toastTimer);
    elements.toast.textContent = message;
    elements.toast.classList.toggle("is-error", isError);
    elements.toast.hidden = false;
    state.toastTimer = window.setTimeout(() => {
      elements.toast.hidden = true;
    }, 4_200);
  }
}

function startIsland() {
  const state = {
    health: { ok: false, activity: { state: "starting" } },
    account: null,
    providerUsage: null,
    providerSetup: null,
    expanded: false,
    healthPending: false,
    usagePending: false,
  };
  const elements = {
    root: document.getElementById("island"),
    orbit: document.getElementById("island-orbit"),
    state: document.getElementById("island-state"),
    provider: document.getElementById("island-provider"),
    tokens: document.getElementById("island-tokens"),
    percent: document.getElementById("island-percent"),
    week: document.getElementById("island-week"),
    line: document.getElementById("island-line-path"),
    area: document.getElementById("island-area-path"),
  };
  const thinkingOrb = elements.orbit
    ? createThinkingOrb(elements.orbit, { size: 18, dark: true })
    : null;

  elements.root.addEventListener("pointerenter", () => setExpanded(true));
  elements.root.addEventListener("pointerleave", () => setExpanded(false));
  elements.root.addEventListener("click", () => call("show_panel"));

  if (!invoke) {
    elements.state.textContent = t("status.unavailable");
    elements.root.dataset.state = "offline";
    return;
  }

  refreshIslandUsage();
  refreshIslandHealth();
  window.setInterval(refreshIslandHealth, 750);
  window.setInterval(refreshIslandUsage, 30_000);

  async function refreshIslandHealth() {
    if (state.healthPending) return;
    state.healthPending = true;
    try {
      state.health = await call("router_health");
    } catch {
      state.health = { ok: false, activity: { state: "offline" } };
    } finally {
      state.healthPending = false;
      renderIsland();
    }
  }

  async function refreshIslandUsage() {
    if (state.usagePending) return;
    state.usagePending = true;
    const requests = [
      ["account", "account_usage"],
      ["providerUsage", "provider_usage"],
      ["providerSetup", "provider_setup"],
    ];
    const results = await Promise.all(
      requests.map(async ([key, command]) => {
        try {
          return [key, await call(command)];
        } catch {
          return [key, null];
        }
      }),
    );
    for (const [key, value] of results) {
      if (value) state[key] = value;
    }
    state.usagePending = false;
    renderIsland();
  }

  function renderIsland() {
    const activity = state.health?.activity || {};
    const activityState = state.health?.ok === false ? "offline" : activity.state || "idle";
    elements.root.dataset.state = activityState;
    elements.state.textContent = activityStateLabel(activityState);
    if (elements.orbit) {
      const orbMode = {
        generating: "composing",
        idle: "shaping",
        error: "solving",
      }[activityState] || "hidden";
      elements.orbit.classList.toggle("is-thinking", orbMode !== "hidden");
      thinkingOrb?.setMode(orbMode);
    }

    const options = sourceOptions(state);
    const requested = activity.provider || "openai";
    const source = options.find((option) => option.id === requested) || options[0];
    elements.provider.textContent = activityState === "generating" && activity.model
      ? activity.model
      : source?.name || t("island.modelRouter");
    elements.tokens.textContent = source ? compactTokens(todayTokens(source)) : "—";
    elements.week.textContent = source ? `${compactTokens(sevenDayTokens(source))} ${t("usage.tokens")}` : t("island.noUsageYet");

    const weekly = buildQuotaCards(state).find(
      (card) => card.providerId === source?.id && card.window === "weekly",
    );
    elements.percent.textContent = weekly?.remainingPercent === null || weekly?.remainingPercent === undefined
      ? "—"
      : `${Math.round(weekly.remainingPercent)}%`;

    const series = dailySeries(source?.buckets || []);
    const geometry = chartGeometry(series, 368, 42, 3);
    elements.line.setAttribute("d", geometry.line);
    elements.area.setAttribute("d", geometry.area);
    const fallbackDays = series.filter((point) => point.displaySource === "router-fallback").length;
    elements.root.setAttribute(
      "aria-label",
      t("island.ariaLabel", {
        state: activityStateLabel(activityState),
        details: source
          ? `${t("island.tokensToday", { count: exactTokens(todayTokens(source)) })}${fallbackDays > 0
            ? ` ${t(fallbackDays === 1 ? "usage.localFallbackDatesOne" : "usage.localFallbackDates", { count: fallbackDays })}`
            : ""}`
          : t("usage.noUsageData"),
      }),
    );
  }

  async function setExpanded(expanded) {
    if (state.expanded === expanded) return;
    state.expanded = expanded;
    elements.root.classList.toggle("is-expanded", expanded);
    try {
      await call("set_island_expanded", { expanded });
    } catch {
      state.expanded = false;
      elements.root.classList.remove("is-expanded");
    }
  }
}

function localizeProviderPlan(note) {
  const value = String(note || "");
  // The note is the router's own English sentence, and it is what identifies
  // which plan gate the provider is behind, so it is matched rather than keyed.
  const table = PROVIDER_PLAN_NOTES[getLanguage()];
  if (!table) return value;
  for (const [needle, text] of Object.entries(table)) {
    if (value.includes(needle)) return text;
  }
  return value;
}

const PROVIDER_PLAN_NOTES = {
  "zh-CN": {
    "Needs the Command Code Provider plan": "需要 Command Code Provider 方案。",
    "Requires Copilot access": "需要 Copilot 访问权限。连接后，请运行 ./bin/curate-models github-copilot。",
    "Requires an active ClinePass subscription": "需要有效的 ClinePass 订阅。",
    "Runs on this machine": "在此设备上运行。使用这些模型前请先启动 Ollama。",
  },
  "zh-TW": {
    "Needs the Command Code Provider plan": "需要 Command Code Provider 方案。",
    "Requires Copilot access": "需要 Copilot 存取權限。連線後，請執行 ./bin/curate-models github-copilot。",
    "Requires an active ClinePass subscription": "需要有效的 ClinePass 訂閱。",
    "Runs on this machine": "在本機執行。使用這些模型前，請先啟動 Ollama。",
  },
};

// Vision effort ids come from the router, so the same ladder the control center
// renders is mapped here instead of being title-cased on screen.
function localizeEffort(effort) {
  const key = {
    default: "effort.default",
    minimal: "effort.minimal",
    low: "effort.low",
    medium: "effort.medium",
    high: "effort.high",
    xhigh: "effort.xhigh",
    max: "effort.max",
    ultra: "effort.ultra",
  }[effort];
  return key ? t(key) : effort;
}

function localizeSubagentMode(mode) {
  const key = {
    proven: "models.modeProven",
    selected: "models.modeSelected",
    all: "models.modeAll",
  }[mode];
  return key ? t(key) : mode || t("models.modeProven");
}

function localizeDownloadDetail(detail) {
  return detail === "starting" ? t("models.downloadStarting") : detail;
}

function renderChart(series, elements) {
  const geometry = chartGeometry(series);
  elements.chartLine.setAttribute("d", geometry.line);
  elements.chartArea.setAttribute("d", geometry.area);
  elements.chartLine.style.animation = "none";
  requestAnimationFrame(() => {
    elements.chartLine.style.animation = "";
  });
  elements.chartDays.innerHTML = series.map((point) => `<span>${escapeHtml(point.label)}</span>`).join("");
  elements.chartDays.style.gridTemplateColumns = `repeat(${Math.max(1, series.length)}, minmax(0, 1fr))`;
  elements.chartPoints.replaceChildren();
  geometry.points.forEach((point, index) => {
    const dot = svgElement("circle", {
      class: `chart-point${series[index].displaySource === "router-fallback" ? " router-fallback" : ""}`,
      cx: point.x,
      cy: point.y,
      r: 3.2,
    });
    const hit = svgElement("rect", {
      class: "chart-hit",
      x: point.x - 18,
      y: 0,
      width: 36,
      height: 112,
    });
    hit.setAttribute(
      "aria-label",
      `${series[index].longLabel}: ${t("usage.tooltipTokens", { count: exactTokens(series[index].tokens) })}${series[index].displaySource === "router-fallback" ? ` · ${t("usage.localFallbackPoint")}` : ""}`,
    );
    const show = () => {
      elements.chartPoints.querySelectorAll(".chart-point").forEach((item) => item.classList.remove("is-active"));
      dot.classList.add("is-active");
      elements.chartTooltip.querySelector("span").textContent = series[index].longLabel;
      elements.chartTooltip.querySelector("strong").textContent = t("usage.tooltipTokens", {
        count: exactTokens(series[index].tokens),
      }) + (series[index].displaySource === "router-fallback" ? ` · ${t("usage.localFallbackShort")}` : "");
      elements.chartTooltip.style.left = `${(point.x / 328) * 100}%`;
      elements.chartTooltip.style.top = `${point.y}px`;
      elements.chartTooltip.hidden = false;
    };
    hit.addEventListener("pointerenter", show);
    hit.addEventListener("pointermove", show);
    elements.chartPoints.append(dot, hit);
  });
  elements.chartWrap.onpointerleave = () => {
    elements.chartTooltip.hidden = true;
    elements.chartPoints.querySelectorAll(".chart-point").forEach((item) => item.classList.remove("is-active"));
  };
}

function svgElement(name, attributes) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

function call(command, args) {
  if (!invoke) return Promise.reject(new Error(t("status.desktopBridgeUnavailable")));
  // A refused command comes back as a bare 403 the bridge reports as "the
  // router command failed", which names nothing anyone can act on. Refusing it
  // here says which surface refused and where the setting does live.
  if (commandRefused(capabilities, command)) {
    return Promise.reject(new Error(t("general.readOnlyControl")));
  }
  return invoke(command, args);
}

// Every control that drives a command carries data-command, so the set to
// disable is the surface's own allowlist rather than a second list here that
// would drift the moment a command moves. The panel rebuilds whole sections
// from innerHTML in a dozen places; an observer means a new section cannot
// forget to ask, and it is installed only on a surface that is actually
// restricted, so an unrestricted host never runs it.
function applyReadOnly(root) {
  const message = t("general.readOnlyControl");
  for (const element of root.querySelectorAll("[data-command]")) {
    if (!commandRefused(capabilities, element.dataset.command)) continue;
    element.disabled = true;
    element.title = message;
    // The switches hide their input behind a styled span, which is what a
    // pointer actually rests on, so the tooltip has to live on the label too.
    const label = element.closest("label");
    if (label) label.title = message;
  }
}

function watchReadOnly(root) {
  applyReadOnly(root);
  // childList only: setting `disabled` and `title` writes attributes, and
  // observing those would have this re-enter itself on every pass.
  new MutationObserver(() => applyReadOnly(root)).observe(root, {
    childList: true,
    subtree: true,
  });
}

// A key can also come from the macOS Keychain or the environment, which the
// router cannot delete, so say so rather than reporting a clean disconnect.
function removalMessage(removal) {
  const name = removal?.displayName || t("general.provider");
  if (removal?.stillConfigured) {
    return t("general.keyRemovedStillActive", {
      provider: name,
      source: removal.remainingSource || t("general.anotherSource"),
    });
  }
  if (removal && removal.removedFiles === 0) {
    return t("general.noStoredKey", { provider: name });
  }
  return t("general.keyRemovedRestart", { provider: name });
}

function errorMessage(error) {
  const message = typeof error === "string" ? error : error?.message || t("general.operationFailed");
  return String(message).replace(/\s+/g, " ").trim().slice(0, 500);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
