import { useMemo, useState, type FormEvent } from "react";
import {
  ChevronDown,
  Download,
  Eye,
  Gauge,
  HardDrive,
  Play,
  RefreshCw,
  SearchX,
  Trash2,
} from "lucide-react";
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  InlineNotice,
  PageHeader,
  PanelSkeleton,
  SearchField,
  SectionHeading,
  StatStrip,
  Toggle,
} from "../components";
import { compactNumber, formatBytesGb } from "../lib";
import { BrandLogo, brandForLocalModel } from "../provider-branding";
import { backendText } from "../backend-text";
import { effortLabel, uiText } from "../ui-text";
import type { LocalModel, LocalModelsSnapshot, OperationEvent, RouterControlApi, RouterDataReady, RouterTarget, VisionEngine } from "../types";
import { useOptimisticValues, type RunAction } from "../useOptimisticValues";
import "./local-harness-context.css";

/** Ollama install and remove actions embed the model tag in the label the
 *  operation toast shows, so the progress guard has to recognize the verb in
 *  whichever language started the run. */
function startsWithActionVerb(action: string, verb: string): boolean {
  return action.startsWith(`${verb} `) || action.startsWith(`${uiText(verb)} `);
}

// The router reports capacity as one composed hardware sentence
// ("16.0 GB unified memory · GPU budget ~12.0 GB · 120.0 GB free disk"). The
// figures are the operator's own measurements and stay untouched; the unit
// wording is interface copy, so the known fragments follow the UI language.
// Longer phrases come first because they contain the shorter ones.
const MACHINE_PHRASES: Array<[RegExp, string]> = [
  [/no GPU memory detected; models run on the CPU/gi, "no GPU memory detected; models run on the CPU"],
  [/unified memory/gi, "unified memory"],
  [/GPU budget/gi, "GPU budget"],
  [/GPU memory/gi, "GPU memory"],
  [/free disk/gi, "free disk"],
  [/\bRAM\b/g, "RAM"],
];

function machineSummary(machine: string | undefined): string {
  const text = (machine || "").trim();
  if (!text) return uiText("Machine capacity has not been measured yet.");
  return MACHINE_PHRASES.reduce((current, [pattern, source]) => current.replace(pattern, () => uiText(source)), text);
}

interface LocalPageProps {
  target?: RouterTarget;
  api?: RouterControlApi;
  refreshing: boolean;
  dataReady: RouterDataReady;
  operation?: OperationEvent | null;
  onRefresh: () => void;
  runAction: RunAction;
}

export function LocalPage({ target, api, refreshing, dataReady, operation, onRefresh, runAction }: LocalPageProps) {
  const [installRef, setInstallRef] = useState("");
  const [forceInstall, setForceInstall] = useState(false);
  const [pendingRemoval, setPendingRemoval] = useState<string | null>(null);
  const [catalogQuery, setCatalogQuery] = useState("");
  const [expandedFamilies, setExpandedFamilies] = useState<Set<string>>(new Set());
  const local = target?.modelSettings?.localModels;
  const mlx = local?.mlx;
  const mlxStatus = mlx?.operation?.status || "idle";
  const mlxActive = ["preparing", "downloading", "loading", "starting-server", "verifying", "publishing"].includes(mlxStatus);
  const mlxPublished = mlx?.runtime?.published === true;
  const mlxReady = mlxPublished && mlx?.runtime?.served === true;
  const mlxSupported = mlx?.host?.supported !== false;
  const activeAction = operation?.action || "";
  const ollamaMutationActive = ["downloading", "uninstalling"].includes(local?.download?.status || "") || (
    operation?.status === "started" && (
      activeAction === "installLocalModel" ||
      activeAction === "uninstallLocalModel" ||
      startsWithActionVerb(activeAction, "Install") ||
      startsWithActionVerb(activeAction, "Remove")
    )
  );
  const bridge = target?.modelSettings?.visionBridge;
  const installed = local?.models?.filter((model) => model.installed !== false) ?? [];
  const installedCount = typeof local?.installed === "number"
    ? local.installed
    : Array.isArray(local?.installed)
      ? local.installed.length
      : installed.length;
  const enabledTags = Array.isArray(local?.enabled)
    ? local.enabled
    : installed.filter((model) => model.enabled === true).map((model) => model.tag);
  const localEnabledStates = useMemo(() => {
    const enabled = Array.isArray(local?.enabled) ? new Set(local.enabled) : undefined;
    return new Map((local?.models ?? [])
      .filter((model) => model.installed !== false)
      .map((model) => [model.tag, enabled?.has(model.tag) || model.enabled === true]));
  }, [local?.enabled, local?.models]);
  const visionEnabledStates = useMemo(() => new Map([
    ["vision", bridge?.enabled === true],
  ]), [bridge?.enabled]);
  const optimisticLocalModels = useOptimisticValues(localEnabledStates, runAction);
  const optimisticVision = useOptimisticValues(visionEnabledStates, runAction);
  const enabledCount = installed.filter((model) => optimisticLocalModels.value(
    model.tag,
    enabledTags.includes(model.tag) || model.enabled === true,
  )).length;
  const localReaders = bridge?.localModels ?? local?.availableVision ?? [];
  const readerDownloadActive = bridge?.download?.status === "downloading";
  const engines: Array<VisionEngine & { group: string }> = [
    ...(bridge?.nativeEngines ?? []).map((engine) => ({ ...engine, group: "ChatGPT plan" })),
    ...(bridge?.paidEngines ?? []).map((engine) => ({ ...engine, group: "Connected provider" })),
  ];
  const selectedEngine = bridge?.engine || "auto";
  const selectedEngineMeta = engines.find((engine) => engine.slug === selectedEngine);
  const effortOptions = selectedEngineMeta?.efforts?.length
    ? selectedEngineMeta.efforts
    : bridge?.availableEfforts ?? [];
  const catalogModels = local?.availableExplore ?? [];
  const quickPicks = useMemo(
    () => [
      ...(Array.isArray(local?.available) ? local.available : []),
      ...(local?.availableVision ?? []),
    ].slice(0, 8),
    [local?.available, local?.availableVision],
  );
  const catalogFamilies = useMemo(
    () => groupCatalogModels(catalogModels, local?.families, catalogQuery),
    [catalogModels, catalogQuery, local?.families],
  );

  async function installLocal(event: FormEvent) {
    event.preventDefault();
    const model = installRef.trim();
    if (!model || !api) return;
    setInstallRef("");
    await runAction(uiText("Install {name}", { name: model }), () => api.installLocalModel(model, forceInstall));
  }

  if (!target) {
    return (
      <div className="local-page">
        <PageHeader
          eyebrow={uiText("On-device inference")}
          title={uiText("Local")}
          description={uiText("Run, install, measure, and expose Ollama and curated MLX models without leaving the control center.")}
          onRefresh={onRefresh}
          refreshing={refreshing}
        />
        {!dataReady.snapshot ? (
          <section className="panel-section" aria-label={uiText("Loading local models")} aria-busy="true">
            <PanelSkeleton label={uiText("Loading local model runtime")} count={5} />
          </section>
        ) : (
          <EmptyState icon={<SearchX size={22} />} title={uiText("Local runtime unavailable")} body={uiText("Start the router or refresh after setup completes.")} />
        )}
      </div>
    );
  }

  return (
    <div className="local-page">
      <PageHeader
        eyebrow={uiText("On-device inference")}
        title={uiText("Local")}
        description={uiText("Run, install, measure, and expose Ollama and curated MLX models without leaving the control center.")}
        onRefresh={onRefresh}
        refreshing={refreshing}
      />

      <StatStrip items={[
        { label: uiText("Runtime"), value: local?.runtime?.running ? uiText("Online") : uiText("Offline"), detail: local?.runtime?.version ? `Ollama ${local.runtime.version}` : "Ollama" },
        { label: uiText("Installed"), value: installedCount, detail: uiText("{count} in Codex", { count: enabledCount }) },
        { label: uiText("Model storage"), value: formatBytesGb(local?.totalGb), detail: local?.runtime?.modelsPath || uiText("Location managed by Ollama") },
        {
          label: uiText("Image reader"),
          value: bridge?.engine === "local" ? uiText("Local") : bridge?.resolvedEngineName || uiText("Automatic"),
          detail: optimisticVision.value("vision", bridge?.enabled === true) ? uiText("Bridge enabled") : uiText("Bridge disabled"),
        },
      ]} />

      <InlineNotice tone={local?.runtime?.running ? "success" : "warning"} title={local?.runtime?.running ? uiText("Ollama is ready") : uiText("Ollama is not running")}>
        {machineSummary(local?.machine)}
      </InlineNotice>

      <section className="panel-section mlx-install-card">
        <SectionHeading
          title="Qwen 3.8 27B · MLX"
          description={uiText("A separate Apple-silicon runtime served through LM Studio and wired into the Codex proxy.")}
          action={<Badge tone={mlxReady ? "success" : mlxActive ? "accent" : mlxStatus === "error" ? "danger" : "neutral"}>{mlxReady ? uiText("In Codex") : !mlxSupported ? uiText("Unsupported host") : mlxPublished ? uiText("Repair needed") : mlxActive ? mlxStageLabel(mlxStatus) : mlxStatus === "error" ? uiText("Needs attention") : uiText("Not installed")}</Badge>}
        />
        <div className="mlx-install-layout">
          <div className="mlx-install-copy">
            <strong>Qwen3.8-27B-Uncensored · 4-bit MLX</strong>
            <p>{uiText("One click installs any missing official local-runtime prerequisites, downloads about 15 GB of weights, starts the loopback server, verifies the model, and publishes {slug} to Codex.", { slug: mlx?.model?.slug || "lmstudio/qwen38-27b-uncensored-mlx" })}</p>
            <div className="mlx-prerequisites" aria-label={uiText("MLX prerequisites")}>
              <span><i className={mlx?.prerequisites?.lms?.available ? "is-ready" : ""} /> LM Studio CLI {mlx?.prerequisites?.lms?.available ? uiText("ready") : uiText("installed during setup")}</span>
              <span><i className={mlx?.prerequisites?.uvx?.available ? "is-ready" : ""} /> {uiText("Hugging Face downloader")} {mlx?.prerequisites?.uvx?.available ? uiText("ready") : uiText("installed during setup")}</span>
              <span><i className={mlx?.runtime?.loopbackReachable ? "is-ready" : ""} /> {uiText("Loopback only")}</span>
            </div>
            {!mlx?.prerequisites?.lms?.available && mlx?.prerequisites?.lms?.installHint ? <small>{backendText(mlx.prerequisites.lms.installHint)}</small> : null}
            {!mlx?.prerequisites?.uvx?.available && mlx?.prerequisites?.uvx?.installHint ? <small>{backendText(mlx.prerequisites.uvx.installHint)}</small> : null}
          </div>
          <div className="mlx-install-actions">
            {mlxActive ? (
              <Button variant="secondary" disabled={!api} onClick={() => api && void runAction(uiText("Cancel Qwen MLX installation"), () => api.cancelLocalMlx())}>{uiText("Cancel")}</Button>
            ) : (
              <Button variant="primary" disabled={!api || mlxReady || !mlxSupported || ollamaMutationActive} onClick={() => api && void runAction(uiText("Start Qwen MLX installation"), () => api.installLocalMlx())}>
                <Download aria-hidden size={14} strokeWidth={1.7} /> {mlxReady ? uiText("Installed") : mlxPublished ? uiText("Repair and reconnect") : mlxStatus === "error" || mlxStatus === "cancelled" ? uiText("Retry install") : uiText("Install and add to Codex")}
              </Button>
            )}
            <small>{uiText("By continuing, you consent to the runtime installation, model download, and local proxy publication.")}</small>
          </div>
        </div>
        <InlineNotice tone="warning" title={uiText("Reduced guardrails; local access only")}>{uiText("This uncensored checkpoint intentionally weakens model safeguards. The router binds it to loopback only; treat its output and any generated tool arguments as untrusted.")}</InlineNotice>
        {!mlxSupported ? <InlineNotice tone="warning" title={uiText("Apple silicon required")}>{backendText(mlx?.host?.reason) || uiText("This MLX model can only be installed on a supported Apple-silicon Mac.")}</InlineNotice> : null}
        {ollamaMutationActive && !mlxActive ? <InlineNotice tone="warning" title={uiText("Another local-model change is running")}>{uiText("Wait for the Ollama download or removal to finish before starting MLX setup.")}</InlineNotice> : null}
        {mlxActive ? <DownloadProgress tag={mlxStageLabel(mlxStatus)} percent={mlx?.operation?.percent} detail={backendText(mlx?.operation?.detail) || uiText("Working in the background")} indeterminate={mlx?.operation?.progressMode === "indeterminate"} /> : null}
        {mlxStatus === "error" ? <InlineNotice tone="danger" title={uiText("MLX installation stopped")}>{backendText(mlx?.operation?.error) || backendText(mlx?.operation?.detail) || uiText("The installer reported an unknown error. Retry or review the prerequisite hints above.")}</InlineNotice> : null}
        {mlxStatus === "cancelled" ? <InlineNotice tone="warning" title={uiText("MLX installation cancelled")}>{uiText("Downloaded files are kept so a retry can resume without starting over.")}</InlineNotice> : null}
        {mlxReady ? <InlineNotice tone="success" title={uiText("Ready in Codex")}>{uiText("Fully quit and reopen Codex to refresh its model picker, then choose {slug}.", { slug: mlx?.model?.slug || "lmstudio/qwen38-27b-uncensored-mlx" })}</InlineNotice> : null}
      </section>

      <div className="lhc-local-grid">
        <section className="panel-section lhc-local-installed">
            <SectionHeading
              title={uiText("Installed models")}
              description={uiText("Enabled models appear in Codex after the picker catalog refreshes.")}
              action={
                <div className="row-actions">
                  {!local?.runtime?.running ? (
                    <Button variant="ghost" disabled={!api} onClick={() => api && void runAction(uiText("Start local runtime"), () => api.controlLocalRuntime("start"))}>
                      <Play aria-hidden size={13} strokeWidth={1.7} /> {uiText("Start runtime")}
                    </Button>
                  ) : null}
                  {local?.runtime?.installed ? (
                    <Button variant="ghost" disabled={!api} onClick={() => api && void runAction(uiText("Update local runtime"), () => api.controlLocalRuntime("update"))}>
                      <RefreshCw aria-hidden size={13} strokeWidth={1.7} /> {uiText("Update Ollama")}
                    </Button>
                  ) : null}
              </div>
            }
          />
          {installed.length ? (
            <div className="table-list">
              {installed.map((model) => (
                <LocalModelRow
                  key={model.tag}
                  model={model}
                  enabled={optimisticLocalModels.value(model.tag, enabledTags.includes(model.tag) || model.enabled === true)}
                  disabled={!api}
                    onToggle={(next) => api && void optimisticLocalModels.mutate(
                      model.tag,
                      next,
                      next ? uiText("Enable {name}", { name: model.tag }) : uiText("Disable {name}", { name: model.tag }),
                      () => api.setLocalModelEnabled(model.tag, next),
                    )}
                    onBenchmark={() => api && void runAction(uiText("Benchmark {name}", { name: model.tag }), () => api.benchmarkLocalModel(model.tag))}
                  onRemove={() => setPendingRemoval(model.tag)}
                />
              ))}
            </div>
          ) : (
            <EmptyState icon={<HardDrive size={21} />} title={uiText("No local models installed")} body={uiText("Install an Ollama model below. Progress remains visible while the download runs.")} />
          )}
        </section>

        <section className="panel-section lhc-runtime-facts">
          <SectionHeading title={uiText("Runtime details")} description={uiText("Read-only facts reported by the router and Ollama.")} />
          <dl>
            <div><dt>{uiText("State")}</dt><dd>{local?.runtime?.running ? uiText("Running") : local?.runtime?.installed ? uiText("Stopped") : uiText("Not installed")}</dd></div>
            <div><dt>{uiText("Version")}</dt><dd>{local?.runtime?.version || uiText("Not reported")}</dd></div>
            <div><dt>{uiText("Managed")}</dt><dd>{local?.runtime?.managed ? uiText("Router managed") : uiText("External runtime")}</dd></div>
            <div><dt>{uiText("Models path")}</dt><dd title={local?.runtime?.modelsPath}>{local?.runtime?.modelsPath || uiText("Ollama default")}</dd></div>
          </dl>
        </section>
      </div>

      <section className="panel-section">
        <SectionHeading title={uiText("Install a model")} description={uiText("Enter an Ollama tag or an HTTPS ollama.com model page. The runtime is installed only after this explicit action.")} />
        <form className="install-form" onSubmit={(event) => void installLocal(event)}>
          <label htmlFor="local-model-ref">{uiText("Model tag or Ollama URL")}</label>
          <div>
            <input id="local-model-ref" value={installRef} onChange={(event) => setInstallRef(event.target.value)} placeholder="qwen3.5:9b" spellCheck={false} />
            <Button variant="primary" disabled={!api || !installRef.trim()} type="submit"><Download aria-hidden size={14} strokeWidth={1.7} /> {uiText("Install")}</Button>
          </div>
        </form>
        <label className="check-label install-override"><input type="checkbox" checked={forceInstall} onChange={(event) => setForceInstall(event.target.checked)} /> {uiText("Allow a model larger than the router recommends for this machine")}</label>
          {local?.download?.status && local.download.status !== "done" ? (
            <DownloadProgress tag={local.download.tag} percent={local.download.percent} detail={backendText(local.download.detail || local.download.status)} />
        ) : null}
        {quickPicks.length ? (
          <div className="lhc-local-quick-picks">
              <div className="lhc-local-subheading"><strong>{uiText("Quick picks")}</strong><span>{uiText("Shortlist for this machine")}</span></div>
            <div className="lhc-recommendations">
              {quickPicks.map((model) => (
                <button key={model.tag} type="button" disabled={model.downloadable === false} onClick={() => setInstallRef(model.tag)}>
                  <BrandLogo brand={brandForLocalModel(model)} size="small" />
                    <span><strong>{model.displayName || model.label || model.tag}</strong><small>{formatBytesGb(model.sizeGb)} · {backendText(model.fit) || uiText("fit unknown")}</small></span>
                    {model.downloadable === false ? <Badge tone="neutral">{uiText("Cloud only")}</Badge> : model.recommended ? <Badge tone="accent">{uiText("Recommended")}</Badge> : null}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {catalogModels.length ? (
          <div className="lhc-catalog-browser">
            <div className="lhc-catalog-toolbar">
                <SearchField value={catalogQuery} onChange={setCatalogQuery} placeholder={uiText("Search Ollama families or tags")} />
                <span>{catalogFamilies.length === 1
                  ? uiText("1 family")
                  : uiText("{families} families", { families: catalogFamilies.length })}
                  {" · "}
                  {catalogQuery.trim()
                    ? uiText("{count} matches", { count: catalogVisibleTagCount(catalogFamilies) })
                    : uiText("{count} tags", { count: catalogVisibleTagCount(catalogFamilies) })}
                </span>
            </div>
            {catalogFamilies.length ? catalogFamilies.map((family) => {
              const expanded = expandedFamilies.has(family.id);
              return (
                <section className="lhc-catalog-family" key={family.id} data-expanded={expanded}>
                  <button
                    type="button"
                    className="lhc-catalog-family-trigger"
                    aria-expanded={expanded}
                    onClick={() => setExpandedFamilies((current) => {
                      const next = new Set(current);
                      if (next.has(family.id)) next.delete(family.id);
                      else next.add(family.id);
                      return next;
                    })}
                  >
                    <BrandLogo brand={brandForLocalModel(family.models[0])} size="medium" />
                    <div>
                      <strong>{family.displayName}</strong>
                      <small>{uiText("{count} tags", { count: family.models.length })} · {familySummary(family.models)}</small>
                    </div>
                    <ChevronDown aria-hidden size={15} strokeWidth={1.7} />
                  </button>
                  {expanded ? (
                    <div className="lhc-catalog-family-panel">
                      {family.researchStatus ? <small className="lhc-catalog-research">{backendText(family.researchStatus)}{family.researchCapabilities.length ? ` · ${family.researchCapabilities.map((capability) => backendText(capability)).join(" · ")}` : ""}</small> : null}
                      {family.researchNote ? <p className="lhc-catalog-note">{backendText(family.researchNote)}</p> : null}
                      <div className="lhc-catalog-model-list">
                        {family.models.map((model) => (
                          <CatalogModelRow key={model.tag} model={model} allowOversized={forceInstall} onSelect={() => setInstallRef(model.tag)} />
                        ))}
                      </div>
                    </div>
                  ) : null}
                </section>
              );
            }) : (
                <EmptyState icon={<SearchX size={18} />} title={uiText("No Ollama tags match")} body={uiText("Try a family name, size, or exact tag.")} />
            )}
          </div>
        ) : null}
      </section>

      <section className="panel-section">
        <SectionHeading title={uiText("Image reading")} description={uiText("Choose how text-only models read pasted images. Local readers stay on this machine.")} />
          <div className="lhc-vision-settings">
            <div className="setting-row">
              <div><strong>{uiText("Read pasted images")}</strong><small>{uiText("The selected reader runs only when the target model cannot accept images.")}</small></div>
              <Toggle
                checked={optimisticVision.value("vision", bridge?.enabled === true)}
                disabled={!api || !bridge}
                label={uiText("Enable vision bridge")}
                onChange={(next) => api && void optimisticVision.mutate(
                  "vision",
                  next,
                  next ? uiText("Enable vision bridge") : uiText("Disable vision bridge"),
                  () => api.setVisionBridgeEnabled(next),
                )}
              />
            </div>
            <div className="form-grid">
              <label>
                <span>{uiText("Reader")}</span>
                <select value={selectedEngine} disabled={!api || !bridge} onChange={(event) => api && void runAction(uiText("Change image reader"), () => api.setVisionBridgeEngine(event.target.value))}>
                  <option value="auto">{uiText("Automatic")}</option>
                  {engines.filter((engine) => engine.group === "ChatGPT plan").length ? (
                    <optgroup label={uiText("ChatGPT plan")}>
                      {engines.filter((engine) => engine.group === "ChatGPT plan").map((engine) => <option key={engine.slug} value={engine.slug}>{engine.displayName}</option>)}
                    </optgroup>
                  ) : null}
                  {engines.filter((engine) => engine.group === "Connected provider").length ? (
                    <optgroup label={uiText("Connected providers")}>
                      {engines.filter((engine) => engine.group === "Connected provider").map((engine) => <option key={engine.slug} value={engine.slug}>{engine.displayName}</option>)}
                    </optgroup>
                  ) : null}
                  {bridge?.local ? <option value="local">{uiText("Local: {name}", { name: bridge.local.model || uiText("configured runtime") })}</option> : null}
                </select>
              </label>
              <label>
                <span>{uiText("Reasoning effort")}</span>
                <select value={bridge?.effort || "default"} disabled={!api || !bridge} onChange={(event) => api && void runAction(uiText("Change image-reader effort"), () => api.setVisionBridgeEffort(event.target.value))}>
                  <option value="default">{uiText("Reader default")}</option>
                  {effortOptions.map((effort) => <option key={effort} value={effort}>{effortLabel(effort)}</option>)}
                </select>
              </label>
            </div>
            <InlineNotice tone={bridge?.resolvedEngine ? "success" : "warning"} title={bridge?.resolvedEngine ? uiText("Reader resolved") : uiText("No reader available")}>
              {bridge?.resolvedEngineName
                ? uiText("{name} will transcribe images.", { name: bridge.resolvedEngineName })
                : uiText("Connect a vision provider or download a local image reader.")}
            </InlineNotice>
        </div>

          {readerDownloadActive ? <DownloadProgress tag={bridge?.download?.tag} percent={bridge?.download?.percent} detail={backendText(bridge?.download?.detail) || uiText("Downloading local reader")} /> : null}
        {localReaders.length ? (
          <div className="local-reader-grid lhc-reader-grid">
            {localReaders.map((reader) => {
              const active = bridge?.engine === "local" && bridge.local?.model === reader.tag;
              return (
                <article className="reader-card" key={reader.tag}>
                  <header>
                    <BrandLogo brand={brandForLocalModel(reader)} size="medium" />
                      <div><strong>{reader.label || reader.displayName || reader.tag}</strong><small>{formatBytesGb(reader.sizeGb)} · {backendText(reader.accuracy) || uiText("untested")}</small></div>
                      {active ? <Badge tone="success">{uiText("Active")}</Badge> : reader.recommended ? <Badge tone="accent">{uiText("Recommended")}</Badge> : null}
                    </header>
                    <p>{backendText(reader.note) || uiText("Local model for pasted-image transcription.")}</p>
                    {reader.measured?.percent !== undefined ? <small className="reader-score">{uiText("Reference score {percent}%{local}", { percent: Math.round(reader.measured.percent), local: reader.measuredLocally ? ` · ${uiText("measured here")}` : "" })}</small> : null}
                    <footer>
                      {reader.installed ? (
                        <>
                          <Button variant="ghost" disabled={!api || active} onClick={() => api && void runAction(uiText("Use {name} as image reader", { name: reader.tag }), () => api.useLocalVisionModel(reader.tag))}><Eye aria-hidden size={13} strokeWidth={1.7} /> {active ? uiText("In use") : uiText("Use reader")}</Button>
                          <Button variant="ghost" disabled={!api} onClick={() => api && void runAction(uiText("Measure {name}", { name: reader.tag }), () => api.benchmarkVisionModel(reader.tag))}><Gauge aria-hidden size={13} strokeWidth={1.7} /> {uiText("Measure")}</Button>
                        </>
                      ) : (
                        <Button variant="secondary" disabled={!api || readerDownloadActive || reader.fits === false} onClick={() => api && void runAction(uiText("Download {name}", { name: reader.tag }), () => api.downloadVisionModel(reader.tag))}><Download aria-hidden size={13} strokeWidth={1.7} /> {uiText("Download")}</Button>
                      )}
                    </footer>
                </article>
              );
            })}
          </div>
          ) : <EmptyState title={uiText("No local image readers listed")} body={uiText("Refresh after Ollama and the local vision catalog are available.")} />}
        </section>

        <Dialog open={Boolean(pendingRemoval)} title={uiText("Remove local model")} description={uiText("This deletes the model weights from this machine.")} onClose={() => setPendingRemoval(null)}>
          <p className="dialog-copy">{uiText("Remove {name}? You can download it again later.", { name: pendingRemoval || "" })}</p>
          <div className="dialog-actions">
            <Button variant="secondary" onClick={() => setPendingRemoval(null)}>{uiText("Cancel")}</Button>
            <Button variant="danger" onClick={() => {
              const tag = pendingRemoval;
              setPendingRemoval(null);
              if (tag && api) void runAction(uiText("Remove {name}", { name: tag }), () => api.uninstallLocalModel(tag));
            }}><Trash2 aria-hidden size={14} strokeWidth={1.7} /> {uiText("Remove")}</Button>
        </div>
      </Dialog>
    </div>
  );
}

function mlxStageLabel(status: string) {
  switch (status) {
    case "preparing": return uiText("Preparing");
    case "downloading": return uiText("Downloading 4-bit weights");
    case "loading": return uiText("Loading into MLX");
    case "starting-server": return uiText("Starting loopback server");
    case "verifying": return uiText("Verifying model");
    case "publishing": return uiText("Adding to Codex");
    default: return uiText("MLX setup");
  }
}

interface CatalogFamily {
  id: string;
  displayName: string;
  models: LocalModel[];
  researchStatus?: string;
  researchCapabilities: string[];
  researchNote?: string;
}

function groupCatalogModels(
  models: LocalModel[],
  knownFamilies: LocalModelsSnapshot["families"] | undefined,
  query: string,
): CatalogFamily[] {
  const needle = query.trim().toLocaleLowerCase();
  const groups = new Map<string, CatalogFamily>();
  for (const model of models) {
    const familyId = model.family || model.tag.split(":", 1)[0] || model.tag;
    const searchable = `${model.tag} ${model.displayName || ""} ${model.family || ""}`.toLocaleLowerCase();
    if (needle && !searchable.includes(needle)) continue;
    const known = knownFamilies?.find((family) => family.family === familyId);
    const current = groups.get(familyId) || {
      id: familyId,
      displayName: (known?.displayName || model.displayName || familyId).split(" · ")[0],
      models: [],
      researchStatus: model.researchStatus,
      researchCapabilities: model.researchCapabilities || [],
      researchNote: model.researchNote,
    };
    current.models.push(model);
    if (!current.researchStatus && model.researchStatus) current.researchStatus = model.researchStatus;
    if (!current.researchCapabilities.length && model.researchCapabilities?.length) current.researchCapabilities = model.researchCapabilities;
    if (!current.researchNote && model.researchNote) current.researchNote = model.researchNote;
    groups.set(familyId, current);
  }
  return [...groups.values()]
    .map((family) => ({
      ...family,
      models: [...family.models].sort(catalogModelSort),
    }))
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

function catalogModelSort(left: LocalModel, right: LocalModel): number {
  const leftLatest = left.variant === "latest";
  const rightLatest = right.variant === "latest";
  if (leftLatest !== rightLatest) return leftLatest ? -1 : 1;
  const leftFit = localModelFits(left);
  const rightFit = localModelFits(right);
  if (leftFit !== rightFit) return leftFit ? -1 : 1;
  return (left.tag || "").localeCompare(right.tag || "");
}

function localModelFits(model: LocalModel): boolean {
  return model.downloadable !== false && model.fit !== "too-large" && model.diskFit !== "too-large";
}

function catalogVisibleTagCount(families: CatalogFamily[]): number {
  return families.reduce((count, family) => count + family.models.length, 0);
}

function familySummary(models: LocalModel[]): string {
  const fit = models.filter(localModelFits).length;
  const cloud = models.filter((model) => model.downloadable === false).length;
  if (cloud === models.length) return uiText("cloud only");
  if (fit === models.length) return uiText("all fit this machine");
  if (fit && cloud) return uiText("{fit} fit · {cloud} cloud", { fit, cloud });
  if (fit) return uiText("{fit} fit", { fit });
  if (cloud) return uiText("{cloud} cloud", { cloud });
  return uiText("no local variant fits");
}

function CatalogModelRow({ model, allowOversized, onSelect }: { model: LocalModel; allowOversized: boolean; onSelect: () => void }) {
  const downloadable = model.downloadable !== false;
  const tooLarge = model.fit === "too-large" || model.diskFit === "too-large";
  const fitLabel = model.downloadable === false
    ? uiText("Cloud only")
    : tooLarge
      ? uiText("Too large")
      : model.fit === "tight" || model.diskFit === "tight"
        ? uiText("Memory tight")
        : uiText("Fits this machine");
  const tone = model.downloadable === false ? "neutral" : tooLarge ? "danger" : model.fit === "tight" ? "warning" : "success";
  return (
    <article className="lhc-catalog-model">
      <BrandLogo brand={brandForLocalModel(model)} size="small" />
      <div className="lhc-catalog-model-identity">
        <strong>{model.displayName || model.label || model.tag}</strong>
          <small>{model.tag}{model.sizeGb !== undefined ? ` · ${formatBytesGb(model.sizeGb)}` : ""}{model.context ? ` · ${uiText("{count} context", { count: compactNumber(model.context) })}` : ""}</small>
        </div>
        <Badge tone={tone}>{fitLabel}</Badge>
        <Button variant="ghost" disabled={!downloadable || (tooLarge && !allowOversized)} onClick={onSelect}>
          <Download aria-hidden size={13} strokeWidth={1.7} /> {uiText("Select")}
        </Button>
    </article>
  );
}

function DownloadProgress({ tag, percent, detail, indeterminate = false }: { tag?: string; percent?: number; detail?: string; indeterminate?: boolean }) {
  return (
    <div className="download-progress">
      <div><strong>{tag || uiText("Local model")}</strong><span>{indeterminate ? uiText("Working…") : `${Math.round(percent || 0)}%`}</span></div>
      {indeterminate ? <progress max="100" /> : <progress max="100" value={percent || 0} />}
      <small>{detail || uiText("Preparing download")}</small>
    </div>
  );
}

function LocalModelRow({ model, enabled, disabled, onToggle, onBenchmark, onRemove }: {
  model: LocalModel;
  enabled: boolean;
  disabled: boolean;
  onToggle: (enabled: boolean) => void;
  onBenchmark: () => void;
  onRemove: () => void;
}) {
  const speed = model.observedTokensPerSecond ?? model.speed;
  const maker = brandForLocalModel(model);
  return (
    <article className="local-model-row">
      <div className="local-model-identity">
        <BrandLogo brand={maker} size="medium" />
        <div>
          <strong>{model.displayName || model.label || model.tag}</strong>
          <span>{maker.name}</span>
          <small>{`local/${model.tag}`}</small>
        </div>
      </div>
        <div className="local-model-facts">
          <span>{formatBytesGb(model.sizeGb)}</span>
          <span>{model.context ? uiText("{count} context", { count: compactNumber(model.context) }) : uiText("Context unreported")}</span>
          <span>{Number.isFinite(Number(speed)) ? `${Number(speed).toFixed(1)} tok/s` : uiText("Speed unmeasured")}</span>
        </div>
        <div className="local-model-controls">
          <Button variant="ghost" disabled={disabled} onClick={onBenchmark}><Gauge aria-hidden size={14} strokeWidth={1.7} /> {uiText("Measure")}</Button>
          <Button variant="ghost" disabled={disabled} aria-label={uiText("Remove {name}", { name: model.tag })} onClick={onRemove}><Trash2 aria-hidden size={14} strokeWidth={1.7} /></Button>
          <div className="local-model-control">
            <span>Codex</span>
            <Toggle checked={enabled} disabled={disabled} label={uiText("Enable {name} for Codex", { name: model.tag })} onChange={onToggle} />
          </div>
      </div>
    </article>
  );
}
