export type ViewId =
  | "dashboard"
  | "models"
  | "local"
  | "harness"
  | "context"
  | "settings"
  | "usage"
  | "status";

export type ModelViewFocus = "providers" | "models";

export interface ModelViewFocusRequest {
  region: ModelViewFocus;
  id: number;
}

export interface RouterModel {
  slug: string;
  displayName: string;
  description?: string;
  provider: string;
  gatewayModel?: string;
  enabled: boolean;
  native?: boolean;
  /** Base native Codex entries stay client-managed; variants remain router-managed. */
  nativeClientManaged?: boolean;
  multiAgentVersion?: "v1" | "v2" | string;
  /** Repository verdict; unlike `multiAgentVersion`, preserves unknown vs explicit v1. */
  subagentCertification?: "v1" | "v2" | "unknown";
  visible: boolean;
  defaultEffort?: string;
  reasoningLevels?: string[];
  contextWindow?: number;
  autoCompact?: number;
  inputModalities?: string[];
  isFree?: boolean;
  /** False only for a checked-in research route that is not currently routable. */
  available?: boolean;
}

export interface RouterKnownModel {
  slug: string;
  displayName: string;
  provider: string;
  available: boolean;
  contextWindow?: number;
  inputModalities?: string[];
  isFree?: boolean;
}

export interface SubagentSettings {
  mode: "all" | "selected" | "proven";
  enabled: string[];
  disabled: string[];
  efforts?: Record<string, string>;
  /** Machine-local v2 capability evidence, populated by the live probe. */
  proofs?: Record<string, {
    status: "checking" | "candidate" | "experimental" | "proven" | "failed" | string;
    reason?: string;
  }>;
  all?: boolean;
}

export interface LocalModel {
  tag: string;
  family?: string;
  variant?: string;
  displayName?: string;
  label?: string;
  sizeGb?: number;
  enabled?: boolean;
  installed?: boolean;
  tools?: boolean;
  context?: number;
  inputModalities?: string[];
  speed?: number;
  observedTokensPerSecond?: number;
  codex?: string;
  fit?: string;
  diskFit?: string;
  accuracy?: string;
  recommended?: boolean;
  fits?: boolean;
  downloadable?: boolean;
  measured?: { percent?: number; textPercent?: number; seconds?: number };
  measuredLocally?: boolean;
  note?: string;
  researchStatus?: string;
  researchCapabilities?: string[];
  researchNote?: string;
}

export interface LocalModelsSnapshot {
  available?: boolean | LocalModel[];
  installed?: string[] | number;
  enabled?: string[] | number;
  models?: LocalModel[];
  availableExplore?: LocalModel[];
  availableVision?: LocalModel[];
  families?: Array<{ family: string; displayName: string; variants?: string[] }>;
  machine?: string;
  totalGb?: number;
  runtime?: {
    installed?: boolean;
    running?: boolean;
    managed?: boolean;
    version?: string;
    command?: string;
    modelsPath?: string;
  };
  download?: {
    tag?: string;
    status?: string;
    percent?: number;
    detail?: string;
  } | null;
  mlx?: {
    host?: {
      supported: boolean;
      platform?: string;
      arch?: string;
      reason?: string;
    };
    model: {
      id: string;
      slug: string;
      source: string;
      precision: string;
      contextLength: number;
    };
    prerequisites: {
      lms: { available: boolean; automaticWithYes?: boolean; source?: string; installHint?: string };
      uvx: { available: boolean; automaticWithYes?: boolean; source?: string; installHint?: string };
    };
    operation: {
      status: "idle" | "preparing" | "downloading" | "loading" | "starting-server" | "verifying" | "publishing" | "done" | "error" | "cancelled";
      detail?: string;
      percent?: number;
      progressMode?: "determinate" | "indeterminate";
      startedAt?: number | null;
      updatedAt?: number | null;
      controllerPid?: number | null;
      workerPid?: number | null;
      error?: string;
    };
    runtime: {
      loopbackReachable: boolean;
      served: boolean;
      published: boolean;
    };
  };
}

export interface VisionEngine {
  slug: string;
  displayName: string;
  efforts?: string[];
}

export interface VisionBridgeSnapshot {
  enabled: boolean;
  configured?: boolean;
  engine?: string | null;
  effort?: string | null;
  resolvedEngine?: string | null;
  resolvedEngineName?: string | null;
  paidEngines?: VisionEngine[];
  nativeEngines?: VisionEngine[];
  availableEngines?: string[];
  availableEfforts?: string[];
  local?: { model?: string; baseUrl?: string } | null;
  localModels?: LocalModel[];
  download?: LocalModelsSnapshot["download"];
}

export interface ToolResultAgingRangeCache {
  agedRate?: number | null;
  unagedRate?: number | null;
  agedTurns?: number;
  unagedTurns?: number;
}

export interface ToolResultAgingRange {
  savedTokens?: number;
  requests?: number;
  buckets?: number[];
  cache?: ToolResultAgingRangeCache;
}

export interface ToolResultAgingStats {
  requests?: number;
  evaluatedRequests?: number;
  largestResultBytes?: number;
  resultsAged?: number;
  resultsShaped?: number;
  bytesSaved?: number;
  estimatedTokensSaved?: number;
  firstAt?: string;
  lastAt?: string;
  ranges?: Record<string, ToolResultAgingRange>;
}

export interface ToolResultAgingSnapshot {
  version?: number;
  enabled: boolean;
  nativeEnabled?: boolean;
  // `0` is a real stored answer meaning "keep retained originals forever" and
  // must survive a round trip untouched; `defaulted` says nobody has answered.
  retentionTtlDays?: number;
  configured?: boolean;
  defaulted?: boolean;
  environmentOverride?: boolean;
  path?: string;
  stats?: ToolResultAgingStats;
}

export interface RouterTarget {
  target: string;
  configured: boolean;
  active: boolean;
  enabledProviders: string[];
  providers: Array<{ id: string; displayName: string; kind: string }>;
  models: RouterModel[];
  selectedModel?: string;
  loginFree?: boolean;
  loginFreeManaged?: boolean;
  signedRouting?: boolean;
  signedRoutingManaged?: boolean;
  routerDefaultModel?: string;
  routerDefaultManaged?: boolean;
  usageEvents?: UsageEvent[];
  modelSettings?: {
    subagents: SubagentSettings;
    picker: { hidden: string[]; visible?: string[]; hasExplicitVisibility?: boolean; path?: string };
    localModels: LocalModelsSnapshot;
    visionBridge: VisionBridgeSnapshot;
    toolResultAging?: ToolResultAgingSnapshot;
  };
}

export interface RouterSnapshot {
  targets: { codex?: RouterTarget; [target: string]: RouterTarget | undefined };
  /** The router-owned model policy, independent of any client adapter. */
  catalog?: RouterCatalogSnapshot;
  /** Safe consent/login projection. Never contains token, account, or path data. */
  chatgptSession?: ChatGptSessionStatus;
  accountPool?: ChatGptAccountPool;
}

export interface ChatGptSessionStatus {
  sharing: "enabled" | "disabled";
  session: "usable" | "expired" | "unavailable";
  present: boolean;
  expiresInHours?: number;
  email?: string;
}

export interface ChatGptSubscriptionAccount {
  id: string;
  state: "active" | "paused" | "revoked" | string;
  paused: boolean;
  priority: number;
  label?: string;
  createdAt?: string;
  subscription?: {
    status?: "pending" | "usable" | "expired" | "invalid" | string;
    authenticated?: boolean;
    usable?: boolean;
    expired?: boolean;
    hasAccountId?: boolean;
    expiresInHours?: number;
    email?: string;
  };
  health?: { state?: string; lastStatus?: number; lastError?: string };
  turns: number;
  requests: number;
}

export interface ChatGptAccountPool {
  version: number;
  policy: { enabled: boolean; mode?: "switch" | "pool" | string; strategy: "quota" | "round-robin" | "fill-first" | string; selectedAccountId?: string };
  accounts: Record<string, ChatGptSubscriptionAccount>;
  sessions: { count: number };
  profile?: ChatGptProfileSwitch;
}

export interface ChatGptProfileSwitch {
  desired: string;
  active: string;
  pending: boolean;
  running?: boolean;
}

export interface RouterCatalogSnapshot {
  source: "codex-router" | string;
  configured: boolean;
  enabledProviders: string[];
  models: RouterModel[];
  /** Safe checked-in inventory; never implies that a route is publishable. */
  knownModels?: RouterKnownModel[];
  picker: { hidden: string[]; visible?: string[]; hasExplicitVisibility?: boolean; path?: string };
  subagents: SubagentSettings;
}

export interface ProviderSetup {
  id: string;
  displayName: string;
  kind: "oauth" | "api" | "anonymous" | "per-model";
  configured: boolean;
  action: string;
  planNote?: string;
  catalogSources?: Array<{
    id: string;
    displayName: string;
    kind: "models-endpoint" | "devin" | string;
  }>;
  credentialLabel?: string;
  cliInstalled?: boolean;
  cliRunnable?: boolean;
  signIn?: boolean;
  signedIn?: boolean;
  signInAction?: string;
}

export interface ProviderCatalog {
  provider: string;
  discovered: string[];
  registered: string[];
  unregistered: string[];
  /** Unregistered models whose protocol route is certified for curation. */
  addable: string[];
  /** Non-addable model id to the reason its route is withheld. */
  blocked: Record<string, string>;
  unavailable: string[];
  contextLengths?: Record<string, number>;
  free?: string[];
  /** True when the list came from the stored copy rather than a live request. */
  cached?: boolean;
  /** True when the stored copy is past its trust window and wants re-reading. */
  stale?: boolean;
  /** ISO timestamp of the last time the provider itself published this list. */
  fetchedAt?: string;
  note?: string;
}

export interface ProviderSetupSnapshot {
  providers: ProviderSetup[];
}

export interface UsageBucket {
  startDate: string;
  tokens: number;
  requests?: number;
  /** Router-only token mix; account APIs generally publish totals only. */
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export interface UsageMetric {
  kind: "quota" | "balance" | string;
  label: string;
  usedPercent?: number;
  remainingPercent?: number;
  used?: number;
  limit?: number;
  remaining?: number;
  value?: number;
  currency?: string;
  unit?: string;
  detail?: string;
  resetAt?: number;
  resetsAt?: number;
  windowDurationMins?: number;
}

export interface AccountUsage {
  fetchedAt?: string;
  accountSelection?: string;
  accountEmail?: string | null;
  profilePending?: boolean;
  planType?: string;
  primary?: UsageMetric | null;
  secondary?: UsageMetric | null;
  dailyUsageBuckets?: UsageBucket[];
  summary?: {
    lifetimeTokens?: number;
    peakDailyTokens?: number;
    currentStreakDays?: number;
  };
}

export interface ProviderModelUsage {
  slug?: string;
  displayName?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  requests?: number;
  observedTokensPerSecond?: number | null;
  speedSampleCount?: number;
  successfulRequests?: number;
  meteredRequests?: number;
  lastUsedAt?: string;
}

export interface ProviderUsage {
  id: string;
  displayName: string;
  credentialType?: string;
  inputTokens?: number;
  regularInputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  requests?: number;
  successfulRequests?: number;
  meteredRequests?: number;
  last24hInputTokens?: number;
  last24hRegularInputTokens?: number;
  last24hCachedInputTokens?: number;
  last24hOutputTokens?: number;
  last24hTokens?: number;
  last24hRequests?: number;
  last24hMeteredRequests?: number;
  dailyUsageBuckets?: UsageBucket[];
  models?: ProviderModelUsage[];
  account?: {
    status?: string;
    source?: string;
    metrics?: UsageMetric[];
    message?: string;
    dashboardUrl?: string;
  };
}

export interface ProviderUsageSnapshot {
  fetchedAt?: string;
  scope?: string;
  retained?: {
    fetchedAt?: string;
    scope?: string;
    from?: string | null;
    to?: string | null;
    providers: ProviderUsage[];
  };
  contextEfficiency?: {
    last24hCachedInputTokens?: number;
    dailyCachedInputTokens?: Array<{
      startDate: string;
      cachedInputTokens: number;
    }>;
  };
  providers: ProviderUsage[];
}

export interface UsageEvent {
  meteringVersion?: number;
  at: string;
  model?: string;
  provider?: string;
  status?: number;
  durationMs?: number;
  /** Milliseconds until the upstream response headers arrived. */
  responseStartMs?: number;
  /** Milliseconds until the first generated token reached the client. */
  firstTokenMs?: number;
  inputTokens?: number;
  billedInputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  billedOutputTokens?: number;
  totalTokens?: number;
  estimatedInputTokens?: number;
  retries?: number;
  streamAborted?: boolean;
  emptyCompletion?: boolean;
  emptyCompletionRetried?: boolean;
  progressOnlyRetried?: boolean;
  emptyCompletionUnrepairable?: boolean;
  emptyCompletionGuardReleased?: boolean;
}

export interface ActiveRequest {
  id?: string;
  model?: string;
  provider?: string;
  startedAt?: number | string;
  elapsedMs?: number;
  sessionTitle?: string;
  sessionName?: string;
  sessionId?: string;
  threadId?: string;
  parentThreadId?: string;
  agentName?: string;
  agentNickname?: string;
  isSubagent?: boolean;
}

export interface RouterServiceHealth {
  reachable?: boolean;
  enabled?: boolean;
}

export interface RouterHealth {
  ok: boolean;
  version?: string;
  error?: string;
  degraded?: string[];
  gateway?: RouterServiceHealth;
  oauth?: RouterServiceHealth;
  api?: RouterServiceHealth;
  grokOauth?: RouterServiceHealth;
  activity?: {
    state?: "idle" | "starting" | "generating" | "error" | "offline" | string;
    activeCount?: number;
    active?: ActiveRequest[];
    model?: string;
    provider?: string;
  };
}

export interface DoctorCheck {
  status: "ok" | "warn" | "fail" | string;
  name: string;
  detail?: string;
  fix?: string;
}

export interface DoctorSnapshot {
  ok: boolean;
  checks: DoctorCheck[];
}

export interface PresenceSnapshot {
  mode: "always" | "follow-codex" | string;
}

export interface OperationEvent {
  id?: string;
  action?: string;
  status?: "started" | "completed" | "failed" | string;
  message?: string;
}

export type HarnessId = "codex" | "deepcode";
export type HarnessSurface = "app" | "terminal";

export interface HarnessDescriptor {
  id: HarnessId;
  displayName: string;
  ownership: "openai" | "third-party";
  description: string;
  cliInstalled: boolean;
  cliVersion?: string;
  appInstalled: boolean;
  configured: boolean;
  canInstall: boolean;
  installRequirement?: string;
  docsUrl: string;
}

export interface HarnessSnapshot {
  platform: string;
  terminalAvailable: boolean;
  harnesses: HarnessDescriptor[];
}

export interface HarnessSession {
  id: string;
  harnessId: HarnessId;
  title: string;
  updatedAt: string;
  createdAt?: string;
  workspace?: string;
  workspaceLabel?: string;
  model?: string;
  modelHistory?: string[];
  provider?: string;
  effort?: string;
  originator?: string;
  status?: string;
  archived: boolean;
  resumable: boolean;
  activeTokens?: number;
  contextWindow?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
  requestCount?: number;
}

export interface ContextSessionsSnapshot {
  fetchedAt: string;
  sessions: HarnessSession[];
  counts: {
    total: number;
    codex: number;
    deepcode: number;
    archived: number;
  };
}

export interface RouterControlApi {
  readonly platform: string;
  minimizeWindow(): Promise<unknown>;
  toggleMaximizeWindow(): Promise<unknown>;
  closeWindow(): Promise<unknown>;
  getSnapshot(): Promise<RouterSnapshot>;
  getChatGptSession(): Promise<ChatGptSessionStatus>;
  getChatGptAccountPool(): Promise<ChatGptAccountPool>;
  getHealth(): Promise<RouterHealth>;
  getProviders(): Promise<ProviderSetupSnapshot>;
  discoverProviderModels(provider: string, options?: { refresh?: boolean }): Promise<ProviderCatalog>;
  getAccountUsage(): Promise<AccountUsage>;
  getProviderUsage(): Promise<ProviderUsageSnapshot>;
  getLocalModels(): Promise<LocalModelsSnapshot>;
  getVisionBridge(): Promise<VisionBridgeSnapshot>;
  getToolResultAging(): Promise<ToolResultAgingSnapshot>;
  getDoctor(): Promise<DoctorSnapshot>;
  repairInstall(): Promise<DoctorSnapshot>;
  getPresence(): Promise<PresenceSnapshot>;
  getHarnesses(): Promise<HarnessSnapshot>;
  getContextSessions(): Promise<ContextSessionsSnapshot>;
  refreshAll(): Promise<unknown>;
  setProviderEnabled(provider: string, enabled: boolean): Promise<unknown>;
  addProviderModels(provider: string, modelIds: string[]): Promise<unknown>;
  connectProvider(provider: string): Promise<unknown>;
  saveProviderCredential(provider: string, credential: string): Promise<unknown>;
  removeProviderCredential(provider: string): Promise<unknown>;
  setSubagentMode(mode: "all" | "selected" | "proven"): Promise<unknown>;
  setSubagentModel(slug: string, enabled: boolean): Promise<unknown>;
  setSubagentEffort(slug: string, effort: string): Promise<unknown>;
  setSubagentSelection(selectAll: boolean): Promise<unknown>;
  setPickerModel(slug: string, visible: boolean): Promise<unknown>;
  setPickerModels(showAll: boolean): Promise<unknown>;
  installLocalModel(model: string, force?: boolean): Promise<unknown>;
  installLocalMlx(): Promise<unknown>;
  cancelLocalMlx(): Promise<unknown>;
  uninstallLocalModel(model: string): Promise<unknown>;
  setLocalModelEnabled(model: string, enabled: boolean): Promise<unknown>;
  benchmarkLocalModel(model: string): Promise<unknown>;
  controlLocalRuntime(action: "start" | "update"): Promise<unknown>;
  setVisionBridgeEnabled(enabled: boolean): Promise<VisionBridgeSnapshot>;
  setVisionBridgeEngine(engine: string, effort?: string): Promise<VisionBridgeSnapshot>;
  setVisionBridgeEffort(effort: string): Promise<VisionBridgeSnapshot>;
  downloadVisionModel(model: string): Promise<unknown>;
  useLocalVisionModel(model: string): Promise<VisionBridgeSnapshot>;
  benchmarkVisionModel(model: string): Promise<unknown>;
  setToolResultAging(enabled: boolean): Promise<ToolResultAgingSnapshot>;
  setNativeToolResultAging(enabled: boolean): Promise<ToolResultAgingSnapshot>;
  setToolResultRetentionTtl(days: number | "default" | "off"): Promise<ToolResultAgingSnapshot>;
  setDefaultModel(model: string): Promise<unknown>;
  setRouterDefault(model: string): Promise<unknown>;
  clearRouterDefault(): Promise<unknown>;
  setSignedRouting(enabled: boolean): Promise<unknown>;
  setChatGptSessionSharing(enabled: boolean): Promise<ChatGptSessionStatus>;
  addChatGptSubscriptionAccount(label?: string): Promise<unknown>;
  loginChatGptSubscriptionAccount(accountId: string): Promise<unknown>;
  removeChatGptSubscriptionAccount(accountId: string): Promise<unknown>;
  setChatGptAccountPoolEnabled(enabled: boolean): Promise<unknown>;
  setChatGptAccountPoolMode(mode: "switch" | "pool"): Promise<unknown>;
  setChatGptAccountPoolStrategy(strategy: "quota" | "round-robin" | "fill-first"): Promise<unknown>;
  setChatGptAccountSelection(selection: "auto" | string): Promise<unknown>;
  setPresence(mode: "always" | "follow-codex"): Promise<PresenceSnapshot>;
  controlService(action: "status" | "start"): Promise<unknown>;
  controlTray(action: "enable" | "disable" | "status" | "restart"): Promise<unknown>;
  launchHarness(harnessId: HarnessId, surface: HarnessSurface): Promise<unknown>;
  installHarness(harnessId: "deepcode"): Promise<unknown>;
  openHarnessSession(harnessId: HarnessId, sessionId: string, surface: HarnessSurface, model?: string): Promise<unknown>;
  openExternal(url: string): Promise<void>;
  onOperation?(listener: (event: OperationEvent) => void): () => void;
}

declare global {
  interface Window {
    routerControl?: RouterControlApi;
  }
}
