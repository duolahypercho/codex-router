import {
  buildQuotaCards,
  chartGeometry,
  compactTokens,
  dailySeries,
  exactTokens,
  formatReset,
  observedModelSpeed,
  sevenDayTokens,
  sourceOptions,
  todayTokens,
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
    modelSettings: null,
    health: null,
    platform: null,
    settings: null,
    selectedSource: null,
    sourceWasChosen: false,
    busyProvider: null,
    modelSettingsBusy: false,
    localModelBusy: null,
    localRemoveArmed: null,
    localPollTimer: null,
    lastActivityState: null,
    loginFreeBusy: false,
    toolResultAgingBusy: false,
    keyProvider: null,
    removeProvider: null,
    toastTimer: null,
  };

  const elements = {
    tabs: [...document.querySelectorAll(".tab")],
    usageView: document.getElementById("usage-view"),
    connectionsView: document.getElementById("connections-view"),
    modelsView: document.getElementById("models-view"),
    close: document.getElementById("close-panel"),
    routerStatus: document.getElementById("router-status"),
    liveState: document.getElementById("live-state"),
    source: document.getElementById("usage-source"),
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
    providers: document.getElementById("provider-list"),
    subagentSummary: document.getElementById("subagent-summary"),
    pickerSummary: document.getElementById("picker-summary"),
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
    loginFreeSwitch: document.getElementById("login-free-switch"),
    loginFreeSwitchLabel: document.getElementById("login-free-switch-label"),
    loginFreeNote: document.getElementById("login-free-note"),
    toolResultAgingSwitch: document.getElementById("tool-result-aging-switch"),
    toolResultAgingSwitchLabel: document.getElementById("tool-result-aging-switch-label"),
    toolResultAgingNote: document.getElementById("tool-result-aging-note"),
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
  elements.localModelList.addEventListener("click", handleLocalModelClick);
  elements.localModelList.addEventListener("change", handleLocalModelToggle);
  elements.localQuickPicks.addEventListener("click", handleLocalModelClick);
  elements.localModelForm.addEventListener("submit", handleLocalModelInstall);
  elements.loginFreeSwitch.addEventListener("change", handleLoginFreeToggle);
  elements.toolResultAgingSwitch.addEventListener("change", handleToolResultAgingToggle);
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
    const models = tab === "models";
    elements.usageView.hidden = !usage;
    elements.connectionsView.hidden = usage || models;
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
      ["localModels", "local_models"],
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

  function renderPanel() {
    renderStatus();
    renderSourcePicker();
    renderUsage();
    renderQuotas();
    renderProviders();
    renderLoginFreeSetting();
    renderIslandSetting();
    renderModelSettings();
    renderToolResultAgingSetting();
    renderLocalModels();
  }

  function renderStatus() {
    const activity = state.health?.activity || {};
    const activityState = state.health?.ok === false ? "offline" : activity.state || "idle";
    const labels = activityLabels();
    elements.liveState.dataset.state = activityState;
    elements.liveState.querySelector("span").textContent = labels[activityState] || t("status.idle");
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
    const observed = observedModelSpeed(state.providerUsage, provider, model);
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
    const series = dailySeries(source?.buckets || []);
    elements.today.textContent = source ? compactTokens(todayTokens(source)) : "—";
    elements.week.textContent = source ? compactTokens(sevenDayTokens(source)) : "—";
    renderChart(series, elements);
  }

  function renderQuotas() {
    const cards = buildQuotaCards(state);
    elements.quotaCards.innerHTML = cards.length
      ? cards
          .map((card) => {
            const percent = card.usedPercent === null ? "—" : `${Math.round(card.usedPercent)}%`;
            const progress = card.usedPercent === null ? 0 : card.usedPercent;
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
      action = provider.cliInstalled ? "login" : "install";
      actionLabel = provider.cliInstalled
        ? provider.configured ? t("connections.reconnect") : t("connections.signIn")
        : t("connections.installCli");
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
      : `<button class="mini-button" type="button" data-action="${action}" data-provider="${escapeHtml(provider.id)}"${isBusy ? " disabled" : ""}>${escapeHtml(actionLabel)}</button>`;
    return `<article class="provider-row">
      <div><strong>${escapeHtml(provider.displayName)}</strong><small>${escapeHtml(detail)}</small>${provider.planNote ? `<small>${escapeHtml(localizeProviderPlan(provider.planNote))}</small>` : ""}${provider.anonymousNote ? `<small>${escapeHtml(provider.anonymousNote)}</small>` : ""}</div>
      <div class="provider-actions">
        ${actionButton}
        ${
          canRemove
            ? `<button class="mini-button danger" type="button" data-action="remove-key" data-provider="${escapeHtml(provider.id)}" aria-label="${escapeHtml(t("connections.removeCredentialAria", { provider: provider.displayName }))}"${isBusy ? " disabled" : ""}>${escapeHtml(t("actions.remove"))}</button>`
            : ""
        }
        ${
          provider.configured
            ? `<label class="provider-check"><input type="checkbox" data-provider="${escapeHtml(provider.id)}" aria-label="${escapeHtml(t("connections.enableProviderAria", { provider: provider.displayName }))}"${enabled ? " checked" : ""}${isBusy ? " disabled" : ""}></label>`
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
    const settings = snapshot?.modelSettings;
    const models = snapshot?.models || [];
    const enabledProviders = new Set(snapshot?.enabledProviders || []);
    const enabledModels = models.filter(
      (model) => model.enabled && enabledProviders.has(model.provider),
    );
    const pickerModels = models.filter((model) => model.enabled);
    const subagent = settings?.subagents || { mode: "proven", enabled: [], disabled: [] };
    const disabledSubagents = new Set(subagent.disabled || []);
    const hiddenModels = new Set(settings?.picker?.hidden || []);
    const providerNames = new Map(
      (snapshot?.providers || []).map((provider) => [provider.id, provider.displayName]),
    );
    providerNames.set("openai", "OpenAI");

    function providerLabel(provider) {
      return providerNames.get(provider) || provider;
    }

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
      return groups
        .map(
          (group) => `<details class="model-provider-group" open>
            <summary><span>${escapeHtml(providerLabel(group.provider))}</span><span class="model-provider-count">${escapeHtml(groupSummary(group))}</span></summary>
            <div class="model-provider-toolbar">
              <button class="text-button" type="button" data-provider-setting="${setting}" data-provider="${escapeHtml(group.provider)}" data-enabled="true">${onLabel}</button>
              <button class="text-button" type="button" data-provider-setting="${setting}" data-provider="${escapeHtml(group.provider)}" data-enabled="false">${offLabel}</button>
            </div>
            <div class="model-settings-list">${group.items.map(rowMarkup).join("")}</div>
          </details>`,
        )
        .join("");
    }

    elements.subagentAllSwitch.disabled = state.modelSettingsBusy;
    elements.subagentAllSwitch.checked = subagent.mode === "all";
    elements.subagentAllSwitchLabel.title = t("models.onlyProvenV2");

    // Models hidden from the picker are forced off as subagents, so their
    // rows here were permanently locked noise. They are filtered out; the
    // note under the list keeps the count visible and points at the picker
    // section, which is where unhiding brings a model back.
    const subagentModels = enabledModels.filter(
      (model) =>
        !model.native && model.visible !== false && model.multiAgentVersion === "v2",
    );
    const hiddenSubagentCount = enabledModels.filter(
      (model) =>
        !model.native && model.visible === false && model.multiAgentVersion === "v2",
    ).length;
    const subagentGroups = groupModels(subagentModels);
    const isSubagentOn = (model) =>
      model.visible === false
        ? false
        : !disabledSubagents.has(model.slug);
    const subagentRow = (model) => {
        const checked = isSubagentOn(model);
        const badge = t("models.provenV2");
        return `<label class="model-setting-row">
          <span><strong>${escapeHtml(model.displayName)}</strong><small>${escapeHtml(badge)}</small></span>
          <span class="provider-check"><input type="checkbox" data-subagent="${escapeHtml(model.slug)}" aria-label="${escapeHtml(t("models.useModelAria", { model: model.displayName }))}"${checked ? " checked" : ""}${state.modelSettingsBusy ? " disabled" : ""}></span>
        </label>`;
      };

    const hiddenSubagentNote = hiddenSubagentCount
      ? `<div class="model-settings-note">${escapeHtml(t(
          hiddenSubagentCount === 1 ? "models.hiddenFromPickerOne" : "models.hiddenFromPickerMany",
          { count: hiddenSubagentCount },
        ))}</div>`
      : "";
    elements.subagentModelList.innerHTML = subagentGroups.length
      ? providerGroupsMarkup(
          subagentGroups,
          subagentRow,
          "subagents",
          (group) => t("models.providerCountOn", {
            on: group.items.filter(isSubagentOn).length,
            total: group.items.length,
          }),
        ) + hiddenSubagentNote
      : `<div class="empty-state">${escapeHtml(t("models.enableProviderForSubagents"))}</div>${hiddenSubagentNote}`;
    const subagentCount = subagentModels.filter(
      (model) => !disabledSubagents.has(model.slug),
    ).length;
    elements.subagentSummary.textContent = t("models.subagentSummary", {
      count: subagentCount,
      plural: subagentCount === 1 ? "" : "s",
      mode: localizeSubagentMode(subagent.mode),
    });

    const pickerGroups = groupModels(pickerModels);
    const pickerRow = (model) => {
        const visible = !hiddenModels.has(model.slug);
        return `<label class="model-setting-row">
          <span><strong>${escapeHtml(model.displayName)}</strong><small>${escapeHtml(model.slug)}</small></span>
          <span class="provider-check"><input type="checkbox" data-picker="${escapeHtml(model.slug)}" aria-label="${escapeHtml(t("models.showModelAria", { model: model.displayName }))}"${visible ? " checked" : ""}${state.modelSettingsBusy ? " disabled" : ""}></span>
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
      : `<div class="empty-state">${escapeHtml(t("models.noEnabledModels"))}</div>`;
    const pickerCount = pickerModels.filter((model) => !hiddenModels.has(model.slug)).length;
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
    return `Saved ~${tokens} tokens (${mb} MB) across ${stats.requests} requests · `;
  }

  function renderToolResultAgingSetting() {
    const aging = state.snapshot?.targets?.codex?.modelSettings?.toolResultAging;
    const overridden = aging?.environmentOverride === true;
    elements.toolResultAgingSwitch.checked = aging?.enabled !== false;
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
    elements.localModelSummary.textContent = installed.length
      ? t("models.installedSummary", {
          count: installed.length,
          size: (Number(local.totalGb) || 0).toFixed(1),
        })
      : t("models.noneInstalled");

    elements.localModelOperation.hidden = !busy;
    if (busy) {
      const label = busy.kind === "uninstall"
        ? t("status.uninstalling")
        : busy.kind === "install" ? t("status.installing") : t("status.applying");
      elements.localModelOperation.innerHTML = `<span class="operation-pulse" aria-hidden="true"></span><span><strong>${escapeHtml(label)} ${escapeHtml(t("models.localModel"))}</strong><small>${escapeHtml(busy.tag)}</small></span><span class="operation-spinner" aria-hidden="true"></span>`;
      elements.localModelOperation.classList.toggle("is-danger", busy.kind === "uninstall");
    }

    if (download) {
      const running = download.status === "downloading";
      const failed = download.status === "error";
      const percent = Math.max(0, Math.min(100, Number(download.percent) || 0));
      const title = failed
        ? t("status.localModelInstallFailed")
        : running ? t("status.installingLocalModel") : t("status.localModelReady");
      elements.localDownloadStatus.innerHTML = `<div class="download-status${failed ? " is-error" : running ? " is-running" : " is-ready"}">
        <div><span class="operation-pulse" aria-hidden="true"></span><strong>${title}</strong><span>${failed ? "" : `${percent}%`}</span></div>
        <small>${escapeHtml(download.tag || t("models.localLlms"))}${download.error || download.detail ? ` · ${escapeHtml(download.error || localizeDownloadDetail(download.detail))}` : ""}</small>
        ${running ? `<progress max="100" value="${percent}" aria-label="${escapeHtml(t("status.installingLocalModel"))} ${escapeHtml(download.tag || t("models.localLlms"))} ${percent}%"></progress>` : ""}
      </div>`;
    } else {
      elements.localDownloadStatus.innerHTML = "";
    }

    elements.localModelList.innerHTML = installed.length
      ? installed.map((model) => localModelRow(model, busy)).join("")
      : `<div class="empty-state local-empty">${escapeHtml(t("models.nothingInstalled"))}</div>`;

    const installBusy = Boolean(busy) || download?.status === "downloading";
    elements.localModelInput.disabled = installBusy;
    elements.localModelForm.querySelector("button").disabled = installBusy;
    const picks = (local.available || []).slice(0, 4);
    elements.localQuickPicks.innerHTML = picks.length
      ? `<div class="local-section-label"><span>${escapeHtml(t("models.quickPicks"))}</span><small>${escapeHtml(t("models.recommendedForMachine"))}</small></div>${picks
          .map(
            (model) => `<button type="button" class="quick-pick" data-local-action="install" data-model="${escapeHtml(model.tag)}"${installBusy ? " disabled" : ""}>
              <span><strong>${escapeHtml(model.tag)}</strong><small>${escapeHtml(model.codex === "verified" ? t("models.verifiedInCodex") : model.fit || t("models.untested"))}</small></span>
              <span>${Number(model.sizeGb || 0).toFixed(1)} GB</span>
            </button>`,
          )
          .join("")}`
      : "";
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
    return `<article class="local-model-row${isBusy ? " is-busy" : ""}">
      <label class="provider-check"><input type="checkbox" data-local-toggle="${escapeHtml(model.tag)}" aria-label="${escapeHtml(t("models.enableLocalAria", { model: model.tag }))}"${model.enabled ? " checked" : ""}${busy || model.tools !== true ? " disabled" : ""}></label>
      <div><strong>${escapeHtml(model.tag)}</strong><small>${escapeHtml(detail)}</small></div>
      <span class="local-size">${Number(model.sizeGb || 0).toFixed(1)} GB</span>
      <button class="mini-button danger" type="button" data-local-action="${armed ? "confirm-remove" : "remove"}" data-model="${escapeHtml(model.tag)}"${busy ? " disabled" : ""}>${armed ? escapeHtml(t("actions.confirm")) : escapeHtml(t("actions.remove"))}</button>
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
    const button = event.target.closest("button[data-local-action]");
    if (!button) return;
    const model = button.dataset.model;
    if (button.dataset.localAction === "install") {
      await startLocalInstall(model);
      return;
    }
    if (button.dataset.localAction === "remove") {
      state.localRemoveArmed = model;
      renderLocalModels();
      return;
    }
    if (button.dataset.localAction !== "confirm-remove") return;
    const startedAt = Date.now();
    state.localRemoveArmed = null;
    state.localModelBusy = { kind: "uninstall", tag: model };
    renderLocalModels();
    try {
      state.localModels = await call("uninstall_local_model", { model });
      const remaining = 800 - (Date.now() - startedAt);
      if (remaining > 0) await new Promise((resolve) => window.setTimeout(resolve, remaining));
      showToast(t("models.localModelRemoved", { model }));
      await refreshPanel({ quiet: true });
    } catch (error) {
      showToast(errorMessage(error), true);
    } finally {
      state.localModelBusy = null;
      renderLocalModels();
    }
  }

  async function handleLocalModelToggle(event) {
    const checkbox = event.target.closest("input[data-local-toggle]");
    if (!checkbox) return;
    const model = checkbox.dataset.localToggle;
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
    state.localRemoveArmed = null;
    state.localModelBusy = { kind: "install", tag: model };
    state.localModels = {
      ...(state.localModels || {}),
      download: { tag: model, status: "downloading", detail: "starting", percent: 0 },
    };
    renderLocalModels();
    try {
      // The router installs and starts Ollama headlessly as part of this call
      // when it is missing, so one action covers the runtime and the model.
      await call("install_local_model", { model, force });
      await pollLocalInstall(model);
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
    window.clearTimeout(state.localPollTimer);
    try {
      state.localModels = await call("local_models");
      renderLocalModels();
      const download = state.localModels?.download;
      if (download?.status === "downloading") {
        state.localPollTimer = window.setTimeout(() => pollLocalInstall(model), 1_000);
        return;
      }
      state.localModelBusy = null;
      if (download?.status === "done") {
        showToast(t("models.localModelReadyRestart", { model: download.tag || model }));
      } else if (download?.status === "error") {
        showToast(download.error || t("models.localModelInstallError"), true);
      }
      await refreshPanel({ quiet: true });
    } catch (error) {
      state.localPollTimer = window.setTimeout(() => pollLocalInstall(model), 1_500);
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
      if (action === "install") {
        await call("install_provider_cli", { provider });
        showToast(t("connections.officialCliInstalled"));
      } else if (action === "login") {
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
    const labels = activityLabels();
    elements.root.dataset.state = activityState;
    elements.state.textContent = labels[activityState] || t("status.idle");
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
    elements.percent.textContent = weekly?.usedPercent === null || weekly?.usedPercent === undefined
      ? "—"
      : `${Math.round(weekly.usedPercent)}%`;

    const series = dailySeries(source?.buckets || []);
    const geometry = chartGeometry(series, 368, 42, 3);
    elements.line.setAttribute("d", geometry.line);
    elements.area.setAttribute("d", geometry.area);
    elements.root.setAttribute(
      "aria-label",
      t("island.ariaLabel", {
        state: labels[activityState] || t("status.idle"),
        details: source
          ? t("island.tokensToday", { count: exactTokens(todayTokens(source)) })
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

function activityLabels() {
  return {
    generating: t("status.thinking"),
    starting: t("status.starting"),
    offline: t("status.offline"),
    error: t("status.error"),
    idle: t("status.idle"),
  };
}

function localizeProviderPlan(note) {
  const value = String(note || "");
  if (getLanguage() === "zh-CN") {
    if (value.includes("Needs the Command Code Provider plan")) return "需要 Command Code Provider 方案。";
    if (value.includes("Requires Copilot access")) return "需要 Copilot 访问权限。连接后，请运行 ./bin/curate-models github-copilot。";
    if (value.includes("Requires an active ClinePass subscription")) return "需要有效的 ClinePass 订阅。";
    if (value.includes("Runs on this machine")) return "在此设备上运行。使用这些模型前请先启动 Ollama。";
  }
  return value;
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
  elements.chartPoints.replaceChildren();
  geometry.points.forEach((point, index) => {
    const dot = svgElement("circle", {
      class: "chart-point",
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
    const show = () => {
      elements.chartPoints.querySelectorAll(".chart-point").forEach((item) => item.classList.remove("is-active"));
      dot.classList.add("is-active");
      elements.chartTooltip.querySelector("span").textContent = series[index].longLabel;
      elements.chartTooltip.querySelector("strong").textContent = t("usage.tooltipTokens", {
        count: exactTokens(series[index].tokens),
      });
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
  return invoke(command, args);
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
