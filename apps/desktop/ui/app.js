import {
  buildQuotaCards,
  chartGeometry,
  compactTokens,
  dailySeries,
  exactTokens,
  formatReset,
  sevenDayTokens,
  sourceOptions,
  todayTokens,
} from "./model.mjs";
import { createThinkingOrb } from "./thinking-orb.mjs";

const invoke = window.__TAURI__?.core?.invoke;
const view = new URLSearchParams(window.location.search).get("view") || "panel";

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
    health: null,
    platform: null,
    settings: null,
    selectedSource: null,
    sourceWasChosen: false,
    busyProvider: null,
    keyProvider: null,
    toastTimer: null,
  };

  const elements = {
    tabs: [...document.querySelectorAll(".tab")],
    usageView: document.getElementById("usage-view"),
    connectionsView: document.getElementById("connections-view"),
    close: document.getElementById("close-panel"),
    routerStatus: document.getElementById("router-status"),
    liveState: document.getElementById("live-state"),
    source: document.getElementById("usage-source"),
    today: document.getElementById("today-tokens"),
    week: document.getElementById("week-tokens"),
    chartWrap: document.getElementById("chart-wrap"),
    chartLine: document.getElementById("chart-line-path"),
    chartArea: document.getElementById("chart-area-path"),
    chartPoints: document.getElementById("chart-points"),
    chartDays: document.getElementById("chart-days"),
    chartTooltip: document.getElementById("chart-tooltip"),
    quotaCards: document.getElementById("quota-cards"),
    providers: document.getElementById("provider-list"),
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
  };

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
  elements.islandSwitch.addEventListener("change", handleIslandToggle);
  elements.keyForm.addEventListener("submit", saveKey);
  elements.closeDialog.addEventListener("click", closeKeyDialog);
  elements.cancelKey.addEventListener("click", closeKeyDialog);
  elements.keyDialog.addEventListener("close", () => {
    elements.keyInput.value = "";
    state.keyProvider = null;
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !elements.keyDialog.open) call("hide_panel");
  });

  if (!invoke) {
    elements.routerStatus.textContent = "Desktop bridge unavailable";
    showToast("Open this surface from the Model Router desktop app.", true);
    return;
  }

  refreshPanel();
  window.setInterval(refreshHealth, 1_200);
  window.setInterval(() => refreshPanel({ quiet: true }), 60_000);

  function selectTab(tab) {
    const usage = tab === "usage";
    elements.usageView.hidden = !usage;
    elements.connectionsView.hidden = usage;
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
  }

  function renderPanel() {
    renderStatus();
    renderSourcePicker();
    renderUsage();
    renderQuotas();
    renderProviders();
    renderIslandSetting();
  }

  function renderStatus() {
    const activity = state.health?.activity || {};
    const activityState = state.health?.ok === false ? "offline" : activity.state || "idle";
    const labels = {
      generating: "Thinking",
      starting: "Starting",
      offline: "Offline",
      error: "Error",
      idle: "Idle",
    };
    elements.liveState.dataset.state = activityState;
    elements.liveState.querySelector("span").textContent = labels[activityState] || "Idle";
    if (state.health?.ok) {
      const model = activity.model ? ` · ${activity.model}` : "";
      elements.routerStatus.textContent = `Router online${model}`;
    } else {
      elements.routerStatus.textContent = "Router offline · usage remains available";
    }
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
      : '<option value="">No connected usage</option>';
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
              <progress max="100" value="${progress}" aria-label="${escapeHtml(card.label)} ${percent} used"></progress>
              <p>${escapeHtml(formatReset(card.resetAt))}</p>
            </article>`;
          })
          .join("")
      : '<div class="empty-state">Connect OAuth or add an API key to show provider limits here.</div>';
  }

  function renderProviders() {
    const providers = state.providerSetup?.providers || [];
    const enabled = new Set(state.snapshot?.targets?.codex?.enabledProviders || []);
    elements.providers.innerHTML = providers.length
      ? providers.map((provider) => providerRow(provider, enabled.has(provider.id))).join("")
      : '<div class="empty-state">Provider setup is unavailable while the router files cannot be found.</div>';
  }

  function providerRow(provider, enabled) {
    const isBusy = state.busyProvider === provider.id;
    const kind = provider.kind === "oauth" ? "OAuth" : "API key";
    let detail = provider.configured ? `${kind} connected` : `${kind} not connected`;
    let action = "";
    let actionLabel = "";
    if (provider.kind === "oauth") {
      action = provider.cliInstalled ? "login" : "install";
      actionLabel = provider.cliInstalled ? (provider.configured ? "Reconnect" : "Sign in") : "Install CLI";
    } else {
      action = "key";
      actionLabel = provider.configured ? "Replace key" : "Add key";
    }
    if (isBusy) detail = "Working…";
    return `<article class="provider-row">
      <div><strong>${escapeHtml(provider.displayName)}</strong><small>${escapeHtml(detail)}</small></div>
      <div class="provider-actions">
        <button class="mini-button" type="button" data-action="${action}" data-provider="${escapeHtml(provider.id)}"${isBusy ? " disabled" : ""}>${actionLabel}</button>
        ${
          provider.configured
            ? `<label class="provider-check"><input type="checkbox" data-provider="${escapeHtml(provider.id)}" aria-label="Enable ${escapeHtml(provider.displayName)}"${enabled ? " checked" : ""}${isBusy ? " disabled" : ""}></label>`
            : ""
        }
      </div>
    </article>`;
  }

  function renderIslandSetting() {
    const supported = state.platform?.islandSupported !== false;
    elements.islandSwitch.disabled = !supported;
    elements.islandSwitch.checked = supported && state.settings?.islandEnabled !== false;
    elements.islandSwitchLabel.title = supported ? "" : state.platform?.islandReason || "Unavailable";
    elements.islandNote.textContent = supported
      ? "Top-center live activity · hover for daily graph"
      : state.platform?.islandReason || "Unavailable on this desktop session";
  }

  async function handleProviderClick(event) {
    const button = event.target.closest("button[data-provider]");
    if (!button) return;
    const provider = button.dataset.provider;
    const action = button.dataset.action;
    if (action === "key") {
      const setup = state.providerSetup?.providers?.find((item) => item.id === provider);
      state.keyProvider = provider;
      elements.keyTitle.textContent = setup?.configured
        ? `Replace ${setup.displayName} key`
        : `Add ${setup?.displayName || "API"} key`;
      elements.keyDialog.showModal();
      requestAnimationFrame(() => elements.keyInput.focus());
      return;
    }

    state.busyProvider = provider;
    renderProviders();
    try {
      if (action === "install") {
        await call("install_provider_cli", { provider });
        showToast("Official provider CLI installed. Sign in to continue.");
      } else if (action === "login") {
        await call("connect_oauth", { provider });
        showToast("Provider connected. Restart Codex to refresh its model picker.");
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
      showToast(enabled ? "Provider enabled." : "Provider hidden from Codex.");
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
      showToast("API key saved. Restart Codex to refresh its model picker.");
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
    elements.state.textContent = "Unavailable";
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
    const labels = {
      generating: "Thinking",
      starting: "Starting",
      offline: "Offline",
      error: "Error",
      idle: "Idle",
    };
    elements.root.dataset.state = activityState;
    elements.state.textContent = labels[activityState] || "Idle";
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
      : source?.name || "Model Router";
    elements.tokens.textContent = source ? compactTokens(todayTokens(source)) : "—";
    elements.week.textContent = source ? `${compactTokens(sevenDayTokens(source))} tokens` : "No usage yet";

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
      `${labels[activityState] || "Idle"}. ${source ? `${exactTokens(todayTokens(source))} tokens today.` : "No usage data."}`,
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
      elements.chartTooltip.querySelector("strong").textContent = `${exactTokens(series[index].tokens)} tokens`;
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
  if (!invoke) return Promise.reject(new Error("Desktop bridge unavailable."));
  return invoke(command, args);
}

function errorMessage(error) {
  const message = typeof error === "string" ? error : error?.message || "The operation could not be completed.";
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
