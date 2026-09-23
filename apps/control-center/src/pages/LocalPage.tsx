import { backendText } from "../backend-text";
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
import { compactNumber, effortLabel, formatBytesGb } from "../lib";
import { BrandLogo, brandForLocalModel } from "../provider-branding";
import { useI18n } from "../i18n-react";
import type { Translate } from "../i18n";
import type { LocalModel, LocalModelsSnapshot, OperationEvent, RouterControlApi, RouterDataReady, RouterTarget, VisionEngine } from "../types";
import { useOptimisticValues, type RunAction } from "../useOptimisticValues";
import "./local-harness-context.css";

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
  const t = useI18n();
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
      activeAction.startsWith("Install ") ||
      activeAction.startsWith("Remove ")
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
  // The group is a stable id; the copy beside it is what gets localized, so the
  // two optgroup filters below cannot drift from their labels.
  const engines: Array<VisionEngine & { group: "chatgpt" | "provider" }> = [
    ...(bridge?.nativeEngines ?? []).map((engine) => ({ ...engine, group: "chatgpt" as const })),
    ...(bridge?.paidEngines ?? []).map((engine) => ({ ...engine, group: "provider" as const })),
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
    await runAction(t("local.action.install", { model }), () => api.installLocalModel(model, forceInstall));
  }

  if (!target) {
    return (
      <div className="local-page">
        <PageHeader
          eyebrow={t("local.eyebrow")}
          title={t("local.title")}
          description={t("local.description")}
          onRefresh={onRefresh}
          refreshing={refreshing}
        />
        {!dataReady.snapshot ? (
          <section className="panel-section" aria-label={t("local.loadingAria")} aria-busy="true">
            <PanelSkeleton label={t("local.loadingRuntime")} count={5} />
          </section>
        ) : (
          <EmptyState icon={<SearchX size={22} />} title={t("local.unavailableTitle")} body={t("local.unavailableBody")} />
        )}
      </div>
    );
  }

  return (
    <div className="local-page">
      <PageHeader
        eyebrow={t("local.eyebrow")}
        title={t("local.title")}
        description={t("local.description")}
        onRefresh={onRefresh}
        refreshing={refreshing}
      />

      <StatStrip items={[
        { label: t("local.stats.runtime"), value: local?.runtime?.running ? t("local.stats.online") : t("local.stats.offline"), detail: local?.runtime?.version ? t("local.stats.ollamaVersion", { version: local.runtime.version }) : "Ollama" },
        { label: t("local.stats.installed"), value: installedCount, detail: t("local.stats.inCodex", { count: enabledCount }) },
        { label: t("local.stats.storage"), value: formatBytesGb(local?.totalGb, t), detail: local?.runtime?.modelsPath || t("local.stats.ollamaManaged") },
        { label: t("local.stats.imageReader"), value: bridge?.engine === "local" ? t("local.stats.local") : bridge?.resolvedEngineName || t("local.stats.automatic"), detail: optimisticVision.value("vision", bridge?.enabled === true) ? t("local.stats.bridgeEnabled") : t("local.stats.bridgeDisabled") },
      ]} />

      <InlineNotice tone={local?.runtime?.running ? "success" : "warning"} title={local?.runtime?.running ? t("local.ollama.ready") : t("local.ollama.notRunning")}>
        {local?.machine || t("local.ollama.unmeasured")}
      </InlineNotice>

      <section className="panel-section mlx-install-card">
        <SectionHeading
          title="Qwen 3.8 27B · MLX"
          description={t("local.mlx.description")}
          action={<Badge tone={mlxReady ? "success" : mlxActive ? "accent" : mlxStatus === "error" ? "danger" : "neutral"}>{mlxReady ? t("local.mlx.inCodex") : !mlxSupported ? t("local.mlx.unsupported") : mlxPublished ? t("local.mlx.repairNeeded") : mlxActive ? mlxStageLabel(mlxStatus, t) : mlxStatus === "error" ? t("local.mlx.needsAttention") : t("local.mlx.notInstalled")}</Badge>}
        />
        <div className="mlx-install-layout">
          <div className="mlx-install-copy">
            <strong>Qwen3.8-27B-Uncensored · 4-bit MLX</strong>
            <p>{t("local.mlx.oneClick")} <code>{mlx?.model?.slug || "lmstudio/qwen38-27b-uncensored-mlx"}</code>{t("local.mlx.oneClickSuffix")}</p>
            <div className="mlx-prerequisites" aria-label={t("local.mlx.prerequisitesAria")}>
              <span><i className={mlx?.prerequisites?.lms?.available ? "is-ready" : ""} /> {t("local.mlx.lmsPrefix")} {mlx?.prerequisites?.lms?.available ? t("local.mlx.ready") : t("local.mlx.installedDuringSetup")}</span>
              <span><i className={mlx?.prerequisites?.uvx?.available ? "is-ready" : ""} /> {t("local.mlx.uvxPrefix")} {mlx?.prerequisites?.uvx?.available ? t("local.mlx.ready") : t("local.mlx.installedDuringSetup")}</span>
              <span><i className={mlx?.runtime?.loopbackReachable ? "is-ready" : ""} /> {t("local.mlx.loopbackOnly")}</span>
            </div>
            {!mlx?.prerequisites?.lms?.available && mlx?.prerequisites?.lms?.installHint ? <small>{backendText(mlx.prerequisites.lms.installHint, t)}</small> : null}
            {!mlx?.prerequisites?.uvx?.available && mlx?.prerequisites?.uvx?.installHint ? <small>{backendText(mlx.prerequisites.uvx.installHint, t)}</small> : null}
          </div>
          <div className="mlx-install-actions">
            {mlxActive ? (
              <Button variant="secondary" disabled={!api} onClick={() => api && void runAction(t("local.action.cancelMlx"), () => api.cancelLocalMlx())}>{t("local.mlx.cancel")}</Button>
            ) : (
              <Button variant="primary" disabled={!api || mlxReady || !mlxSupported || ollamaMutationActive} onClick={() => api && void runAction(t("local.action.startMlx"), () => api.installLocalMlx())}>
                <Download aria-hidden size={14} strokeWidth={1.7} /> {mlxReady ? t("local.mlx.installed") : mlxPublished ? t("local.mlx.repairAndReconnect") : mlxStatus === "error" || mlxStatus === "cancelled" ? t("local.mlx.retryInstall") : t("local.mlx.installAndAdd")}
              </Button>
            )}
            <small>{t("local.mlx.consent")}</small>
          </div>
        </div>
        <InlineNotice tone="warning" title={t("local.mlx.guardrailsTitle")}>{t("local.mlx.guardrailsBody")}</InlineNotice>
        {!mlxSupported ? <InlineNotice tone="warning" title={t("local.mlx.appleTitle")}>{backendText(mlx?.host?.reason, t) || t("local.mlx.appleBody")}</InlineNotice> : null}
        {ollamaMutationActive && !mlxActive ? <InlineNotice tone="warning" title={t("local.mlx.waitTitle")}>{t("local.mlx.waitBody")}</InlineNotice> : null}
        {mlxActive ? <DownloadProgress tag={mlxStageLabel(mlxStatus, t)} percent={mlx?.operation?.percent} detail={backendText(mlx?.operation?.detail, t) || t("local.mlx.working")} indeterminate={mlx?.operation?.progressMode === "indeterminate"} /> : null}
        {mlxStatus === "error" ? <InlineNotice tone="danger" title={t("local.mlx.errorTitle")}>{backendText(mlx?.operation?.error, t) || backendText(mlx?.operation?.detail, t) || t("local.mlx.errorBody")}</InlineNotice> : null}
        {mlxStatus === "cancelled" ? <InlineNotice tone="warning" title={t("local.mlx.cancelledTitle")}>{t("local.mlx.cancelledBody")}</InlineNotice> : null}
        {mlxReady ? <InlineNotice tone="success" title={t("local.mlx.readyTitle")}>{t("local.mlx.readyBody")} <code>{mlx?.model?.slug || "lmstudio/qwen38-27b-uncensored-mlx"}</code>.</InlineNotice> : null}
      </section>

      <div className="lhc-local-grid">
        <section className="panel-section lhc-local-installed">
          <SectionHeading
            title={t("local.installed.title")}
            description={t("local.installed.description")}
            action={
              <div className="row-actions">
                {!local?.runtime?.running ? (
                  <Button variant="ghost" disabled={!api} onClick={() => api && void runAction(t("local.action.startRuntime"), () => api.controlLocalRuntime("start"))}>
                    <Play aria-hidden size={13} strokeWidth={1.7} /> {t("local.installed.startRuntime")}
                  </Button>
                ) : null}
                {local?.runtime?.installed ? (
                  <Button variant="ghost" disabled={!api} onClick={() => api && void runAction(t("local.action.updateRuntime"), () => api.controlLocalRuntime("update"))}>
                    <RefreshCw aria-hidden size={13} strokeWidth={1.7} /> {t("local.installed.updateOllama")}
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
                  onToggle={(next) => api && void optimisticLocalModels.mutate(model.tag, next, t(next ? "local.action.enable" : "local.action.disable", { tag: model.tag }), () => api.setLocalModelEnabled(model.tag, next))}
                  onBenchmark={() => api && void runAction(t("local.action.benchmark", { tag: model.tag }), () => api.benchmarkLocalModel(model.tag))}
                  onRemove={() => setPendingRemoval(model.tag)}
                />
              ))}
            </div>
          ) : (
            <EmptyState icon={<HardDrive size={21} />} title={t("local.installed.emptyTitle")} body={t("local.installed.emptyBody")} />
          )}
        </section>

        <section className="panel-section lhc-runtime-facts">
          <SectionHeading title={t("local.details.title")} description={t("local.details.description")} />
          <dl>
            <div><dt>{t("local.details.state")}</dt><dd>{local?.runtime?.running ? t("local.details.running") : local?.runtime?.installed ? t("local.details.stopped") : t("local.details.notInstalled")}</dd></div>
            <div><dt>{t("local.details.version")}</dt><dd>{local?.runtime?.version || t("local.details.notReported")}</dd></div>
            <div><dt>{t("local.details.managed")}</dt><dd>{local?.runtime?.managed ? t("local.details.routerManaged") : t("local.details.external")}</dd></div>
            <div><dt>{t("local.details.modelsPath")}</dt><dd title={local?.runtime?.modelsPath}>{local?.runtime?.modelsPath || t("local.details.ollamaDefault")}</dd></div>
          </dl>
        </section>
      </div>

      <section className="panel-section">
        <SectionHeading title={t("local.install.title")} description={t("local.install.description")} />
        <form className="install-form" onSubmit={(event) => void installLocal(event)}>
          <label htmlFor="local-model-ref">{t("local.install.label")}</label>
          <div>
            <input id="local-model-ref" value={installRef} onChange={(event) => setInstallRef(event.target.value)} placeholder="qwen3.5:9b" spellCheck={false} />
            <Button variant="primary" disabled={!api || !installRef.trim()} type="submit"><Download aria-hidden size={14} strokeWidth={1.7} /> {t("local.install.submit")}</Button>
          </div>
        </form>
        <label className="check-label install-override"><input type="checkbox" checked={forceInstall} onChange={(event) => setForceInstall(event.target.checked)} /> {t("local.install.allowLarger")}</label>
        {local?.download?.status && local.download.status !== "done" ? (
          <DownloadProgress tag={local.download.tag} percent={local.download.percent} detail={backendText(local.download.detail || local.download.status, t)} />
        ) : null}
        {quickPicks.length ? (
          <div className="lhc-local-quick-picks">
            <div className="lhc-local-subheading"><strong>{t("local.quick.title")}</strong><span>{t("local.quick.detail")}</span></div>
            <div className="lhc-recommendations">
              {quickPicks.map((model) => (
                <button key={model.tag} type="button" disabled={model.downloadable === false} onClick={() => setInstallRef(model.tag)}>
                  <BrandLogo brand={brandForLocalModel(model)} size="small" />
                  <span><strong>{model.displayName || model.label || model.tag}</strong><small>{formatBytesGb(model.sizeGb, t)} · {backendText(model.fit, t) || t("local.quick.fitUnknown")}</small></span>
                  {model.downloadable === false ? <Badge tone="neutral">{t("local.badge.cloudOnly")}</Badge> : model.recommended ? <Badge tone="accent">{t("local.badge.recommended")}</Badge> : null}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {catalogModels.length ? (
          <div className="lhc-catalog-browser">
            <div className="lhc-catalog-toolbar">
              <SearchField value={catalogQuery} onChange={setCatalogQuery} placeholder={t("local.catalog.searchPlaceholder")} />
              <span>{catalogQuery.trim() ? t("local.catalog.countMatches", { families: catalogFamilies.length, tags: catalogVisibleTagCount(catalogFamilies) }) : t("local.catalog.countTags", { families: catalogFamilies.length, tags: catalogVisibleTagCount(catalogFamilies) })}</span>
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
                      <small>{t("local.catalog.familyTags", { count: family.models.length, summary: familySummary(family.models, t) })}</small>
                    </div>
                    <ChevronDown aria-hidden size={15} strokeWidth={1.7} />
                  </button>
                  {expanded ? (
                    <div className="lhc-catalog-family-panel">
                      {family.researchStatus ? <small className="lhc-catalog-research">{backendText(family.researchStatus, t)}{family.researchCapabilities.length ? ` · ${family.researchCapabilities.map((capability) => backendText(capability, t)).join(" · ")}` : ""}</small> : null}
                      {family.researchNote ? <p className="lhc-catalog-note">{backendText(family.researchNote, t)}</p> : null}
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
              <EmptyState icon={<SearchX size={18} />} title={t("local.catalog.emptyTitle")} body={t("local.catalog.emptyBody")} />
            )}
          </div>
        ) : null}
      </section>

      <section className="panel-section">
        <SectionHeading title={t("local.vision.title")} description={t("local.vision.description")} />
        <div className="lhc-vision-settings">
          <div className="setting-row">
            <div><strong>{t("local.vision.readTitle")}</strong><small>{t("local.vision.readDetail")}</small></div>
            <Toggle checked={optimisticVision.value("vision", bridge?.enabled === true)} disabled={!api || !bridge} label={t("local.vision.enableAria")} onChange={(next) => api && void optimisticVision.mutate("vision", next, t(next ? "local.action.enableVision" : "local.action.disableVision"), () => api.setVisionBridgeEnabled(next))} />
          </div>
          <div className="form-grid">
            <label>
              <span>{t("local.vision.reader")}</span>
              <select value={selectedEngine} disabled={!api || !bridge} onChange={(event) => api && void runAction(t("local.action.changeReader"), () => api.setVisionBridgeEngine(event.target.value))}>
                <option value="auto">{t("local.vision.automatic")}</option>
                {engines.filter((engine) => engine.group === "chatgpt").length ? (
                  <optgroup label={t("local.engineGroup.chatgpt")}>
                    {engines.filter((engine) => engine.group === "chatgpt").map((engine) => <option key={engine.slug} value={engine.slug}>{engine.displayName}</option>)}
                  </optgroup>
                ) : null}
                {engines.filter((engine) => engine.group === "provider").length ? (
                  <optgroup label={t("local.engineGroup.providers")}>
                    {engines.filter((engine) => engine.group === "provider").map((engine) => <option key={engine.slug} value={engine.slug}>{engine.displayName}</option>)}
                  </optgroup>
                ) : null}
                {bridge?.local ? <option value="local">{t("local.vision.localOption", { model: bridge.local.model || t("local.vision.localFallback") })}</option> : null}
              </select>
            </label>
            <label>
              <span>{t("local.vision.effort")}</span>
              <select value={bridge?.effort || "default"} disabled={!api || !bridge} onChange={(event) => api && void runAction(t("local.action.changeEffort"), () => api.setVisionBridgeEffort(event.target.value))}>
                <option value="default">{t("local.vision.readerDefault")}</option>
                {effortOptions.map((effort) => <option key={effort} value={effort}>{effortLabel(effort, t)}</option>)}
              </select>
            </label>
          </div>
          <InlineNotice tone={bridge?.resolvedEngine ? "success" : "warning"} title={bridge?.resolvedEngine ? t("local.vision.resolved") : t("local.vision.noReader")}>
            {bridge?.resolvedEngineName ? t("local.vision.willTranscribe", { name: bridge.resolvedEngineName }) : t("local.vision.connectBody")}
          </InlineNotice>
        </div>

        {readerDownloadActive ? <DownloadProgress tag={bridge?.download?.tag} percent={bridge?.download?.percent} detail={backendText(bridge?.download?.detail, t) || t("local.vision.downloadingReader")} /> : null}
        {localReaders.length ? (
          <div className="local-reader-grid lhc-reader-grid">
            {localReaders.map((reader) => {
              const active = bridge?.engine === "local" && bridge.local?.model === reader.tag;
              return (
                <article className="reader-card" key={reader.tag}>
                  <header>
                    <BrandLogo brand={brandForLocalModel(reader)} size="medium" />
                    <div><strong>{reader.label || reader.displayName || reader.tag}</strong><small>{formatBytesGb(reader.sizeGb, t)} · {backendText(reader.accuracy, t) || t("local.vision.untested")}</small></div>
                    {active ? <Badge tone="success">{t("local.badge.active")}</Badge> : reader.recommended ? <Badge tone="accent">{t("local.badge.recommended")}</Badge> : null}
                  </header>
                  <p>{backendText(reader.note, t) || t("local.vision.defaultNote")}</p>
                  {reader.measured?.percent !== undefined ? <small className="reader-score">{reader.measuredLocally ? t("local.vision.referenceScoreLocal", { percent: Math.round(reader.measured.percent) }) : t("local.vision.referenceScore", { percent: Math.round(reader.measured.percent) })}</small> : null}
                  <footer>
                    {reader.installed ? (
                      <>
                        <Button variant="ghost" disabled={!api || active} onClick={() => api && void runAction(t("local.action.useReader", { tag: reader.tag }), () => api.useLocalVisionModel(reader.tag))}><Eye aria-hidden size={13} strokeWidth={1.7} /> {active ? t("local.vision.inUse") : t("local.vision.useReader")}</Button>
                        <Button variant="ghost" disabled={!api} onClick={() => api && void runAction(t("local.action.measureReader", { tag: reader.tag }), () => api.benchmarkVisionModel(reader.tag))}><Gauge aria-hidden size={13} strokeWidth={1.7} /> {t("local.vision.measure")}</Button>
                      </>
                    ) : (
                      <Button variant="secondary" disabled={!api || readerDownloadActive || reader.fits === false} onClick={() => api && void runAction(t("local.action.downloadReader", { tag: reader.tag }), () => api.downloadVisionModel(reader.tag))}><Download aria-hidden size={13} strokeWidth={1.7} /> {t("local.vision.download")}</Button>
                    )}
                  </footer>
                </article>
              );
            })}
          </div>
        ) : <EmptyState title={t("local.vision.emptyTitle")} body={t("local.vision.emptyBody")} />}
      </section>

      <Dialog open={Boolean(pendingRemoval)} title={t("local.remove.title")} description={t("local.remove.description")} onClose={() => setPendingRemoval(null)}>
        <p className="dialog-copy">{t("local.remove.bodyPrefix")} <strong>{pendingRemoval}</strong>{t("local.remove.bodySuffix")}</p>
        <div className="dialog-actions">
          <Button variant="secondary" onClick={() => setPendingRemoval(null)}>{t("local.remove.cancel")}</Button>
          <Button variant="danger" onClick={() => {
            const tag = pendingRemoval;
            setPendingRemoval(null);
            if (tag && api) void runAction(t("local.action.remove", { tag }), () => api.uninstallLocalModel(tag));
          }}><Trash2 aria-hidden size={14} strokeWidth={1.7} /> {t("local.remove.confirm")}</Button>
        </div>
      </Dialog>
    </div>
  );
}

function mlxStageLabel(status: string, t: Translate) {
  switch (status) {
    case "preparing": return t("local.mlx.stage.preparing");
    case "downloading": return t("local.mlx.stage.downloading");
    case "loading": return t("local.mlx.stage.loading");
    case "starting-server": return t("local.mlx.stage.startingServer");
    case "verifying": return t("local.mlx.stage.verifying");
    case "publishing": return t("local.mlx.stage.publishing");
    default: return t("local.mlx.stage.default");
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

function familySummary(models: LocalModel[], t: Translate): string {
  const fit = models.filter(localModelFits).length;
  const cloud = models.filter((model) => model.downloadable === false).length;
  if (cloud === models.length) return t("local.family.cloudOnly");
  if (fit === models.length) return t("local.family.allFit");
  if (fit && cloud) return t("local.family.fitCloud", { fit, cloud });
  if (fit) return t("local.family.fit", { fit });
  if (cloud) return t("local.family.cloud", { cloud });
  return t("local.family.noFit");
}

function CatalogModelRow({ model, allowOversized, onSelect }: { model: LocalModel; allowOversized: boolean; onSelect: () => void }) {
  const t = useI18n();
  const downloadable = model.downloadable !== false;
  const tooLarge = model.fit === "too-large" || model.diskFit === "too-large";
  const fitLabel = model.downloadable === false
    ? t("local.fit.cloudOnly")
    : tooLarge
      ? t("local.fit.tooLarge")
      : model.fit === "tight" || model.diskFit === "tight"
        ? t("local.fit.memoryTight")
        : t("local.fit.fitsMachine");
  const tone = model.downloadable === false ? "neutral" : tooLarge ? "danger" : model.fit === "tight" ? "warning" : "success";
  return (
    <article className="lhc-catalog-model">
      <BrandLogo brand={brandForLocalModel(model)} size="small" />
      <div className="lhc-catalog-model-identity">
        <strong>{model.displayName || model.label || model.tag}</strong>
        <small>{model.tag}{model.sizeGb !== undefined ? ` · ${formatBytesGb(model.sizeGb, t)}` : ""}{model.context ? t("local.fit.contextSuffix", { count: compactNumber(model.context) }) : ""}</small>
      </div>
      <Badge tone={tone}>{fitLabel}</Badge>
      <Button variant="ghost" disabled={!downloadable || (tooLarge && !allowOversized)} onClick={onSelect}>
        <Download aria-hidden size={13} strokeWidth={1.7} /> {t("local.fit.select")}
      </Button>
    </article>
  );
}

function DownloadProgress({ tag, percent, detail, indeterminate = false }: { tag?: string; percent?: number; detail?: string; indeterminate?: boolean }) {
  const t = useI18n();
  return (
    <div className="download-progress">
      <div><strong>{tag || t("local.progress.defaultTag")}</strong><span>{indeterminate ? t("local.progress.working") : `${Math.round(percent || 0)}%`}</span></div>
      {indeterminate ? <progress max="100" /> : <progress max="100" value={percent || 0} />}
      <small>{detail || t("local.progress.preparing")}</small>
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
  const t = useI18n();
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
        <span>{formatBytesGb(model.sizeGb, t)}</span>
        <span>{model.context ? t("local.model.context", { count: compactNumber(model.context) }) : t("local.model.contextUnreported")}</span>
        <span>{Number.isFinite(Number(speed)) ? `${Number(speed).toFixed(1)} tok/s` : t("local.model.speedUnmeasured")}</span>
      </div>
      <div className="local-model-controls">
        <Button variant="ghost" disabled={disabled} onClick={onBenchmark}><Gauge aria-hidden size={14} strokeWidth={1.7} /> {t("local.model.measure")}</Button>
        <Button variant="ghost" disabled={disabled} aria-label={t("local.action.remove", { tag: model.tag })} onClick={onRemove}><Trash2 aria-hidden size={14} strokeWidth={1.7} /></Button>
        <div className="local-model-control">
          <span>Codex</span>
          <Toggle checked={enabled} disabled={disabled} label={t("local.model.enableAria", { tag: model.tag })} onChange={onToggle} />
        </div>
      </div>
    </article>
  );
}
