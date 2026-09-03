export type PresenceMode = "always" | "follow-codex";
export type SubagentMode = "all" | "selected" | "proven";
export type VisionEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra" | "default";
export type ServiceAction = "status" | "start";
export type TrayAction = "enable" | "disable" | "status" | "restart";
export type HarnessId = "codex" | "dsh" | "gemini" | "cursor" | "claude" | "openclaw";
export type HarnessSurface = "app" | "terminal";

export interface HarnessDescriptor {
  id: HarnessId;
  displayName: string;
  ownership: "openai" | "deepseek" | "google" | "cursor" | "anthropic" | "openclaw";
  description: string;
  cliInstalled: boolean;
  cliVersion?: string;
  appInstalled: boolean;
  configured: boolean;
  canInstall: boolean;
  installRequirement?: string;
  publicOrigin?: string;
  agentConfigured?: boolean;
  appConfigured?: boolean;
  tunnel?: {
    provider: "cloudflare";
    binaryInstalled: boolean;
    loggedIn: boolean;
    configured: boolean;
    hostname?: string;
    nextAction: "install-cloudflared" | "login" | "choose-hostname" | "ready";
  };
  docsUrl: string;
}

export interface HarnessSnapshot {
  platform: string;
  terminalAvailable: boolean;
  harnesses: HarnessDescriptor[];
}

export type AgentBridgeId = "anthropic" | "cursor" | "gemini";
export interface AgentBridgeDescriptor {
  id: AgentBridgeId;
  displayName: string;
  protocol: "claude-code" | "acp" | string;
  installed: boolean;
  sessions: number;
  authentication: "client-owned" | "unavailable" | string;
}
export interface AgentBridgeSnapshot { version: 1; bridges: AgentBridgeDescriptor[]; }

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
  counts: { total: number; codex: number; dsh: number; cursor: number; claude: number; gemini: number; openclaw: number; archived: number };
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
    usage?: { period: "weekly" | "monthly" | "current"; remainingPercent: number; resetsAt?: number | null };
  };
  health?: { state?: string; lastStatus?: number; lastError?: string };
  turns: number;
  requests: number;
}

export interface ChatGptAccountPool {
  version: number;
  policy: {
    enabled: boolean;
    mode: "switch";
    selectedAccountId?: string;
  };
  accounts: Record<string, ChatGptSubscriptionAccount>;
  loginAttempts?: Record<string, {
    status: "pending" | "failed";
    error?: string;
    retryable?: boolean;
  }>;
  sessions: { count: number };
  profile?: ChatGptProfileSwitch;
}

export interface ChatGptProfileSwitch {
  desired?: string;
  active?: string;
  pending: boolean;
  running?: boolean;
}

export interface RouterControl {
  readonly platform: string;
  minimizeWindow(): Promise<unknown>;
  toggleMaximizeWindow(): Promise<unknown>;
  closeWindow(): Promise<unknown>;
  getSnapshot(): Promise<unknown>;
  getChatGptSession(): Promise<ChatGptSessionStatus>;
  getChatGptAccountPool(): Promise<ChatGptAccountPool>;
  getHealth(): Promise<unknown>;
  getProviders(): Promise<unknown>;
  discoverProviderModels(provider: string, options?: { refresh?: boolean }): Promise<unknown>;
  getAccountUsage(): Promise<unknown>;
  getProviderUsage(): Promise<unknown>;
  getLocalModels(): Promise<unknown>;
  getVisionBridge(): Promise<unknown>;
  getToolResultAging(): Promise<unknown>;
  getDoctor(): Promise<unknown>;
  getPresence(): Promise<unknown>;
  getHarnesses(): Promise<HarnessSnapshot>;
  getAgentBridges(): Promise<AgentBridgeSnapshot>;
  getContextSessions(): Promise<ContextSessionsSnapshot>;
  refreshAll(): Promise<unknown>;
  setProviderEnabled(provider: string, enabled: boolean): Promise<unknown>;
  addProviderModels(provider: string, modelIds: string[]): Promise<unknown>;
  connectProvider(provider: string): Promise<unknown>;
  saveProviderCredential(provider: string, credential: string): Promise<unknown>;
  removeProviderCredential(provider: string): Promise<unknown>;
  setSubagentMode(mode: SubagentMode): Promise<unknown>;
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
  setVisionBridgeEnabled(enabled: boolean): Promise<unknown>;
  setVisionBridgeEngine(engine: string, effort?: VisionEffort): Promise<unknown>;
  setVisionBridgeEffort(effort: VisionEffort): Promise<unknown>;
  downloadVisionModel(model: string): Promise<unknown>;
  useLocalVisionModel(model: string): Promise<unknown>;
  benchmarkVisionModel(model: string): Promise<unknown>;
  setToolResultAging(enabled: boolean): Promise<unknown>;
  setNativeToolResultAging(enabled: boolean): Promise<unknown>;
  setToolResultRetentionTtl(days: number | "default" | "off"): Promise<unknown>;
  setDefaultModel(model: string): Promise<unknown>;
  setRouterDefault(model: string): Promise<unknown>;
  clearRouterDefault(): Promise<unknown>;
  setSignedRouting(enabled: boolean): Promise<unknown>;
  setChatGptSessionSharing(enabled: boolean): Promise<ChatGptSessionStatus>;
  addChatGptSubscriptionAccount(label?: string): Promise<unknown>;
  loginChatGptSubscriptionAccount(accountId: string): Promise<unknown>;
  removeChatGptSubscriptionAccount(accountId: string): Promise<unknown>;
  setChatGptAccountSelection(selection: string): Promise<unknown>;
  setPresence(mode: PresenceMode): Promise<unknown>;
  controlService(action: ServiceAction): Promise<unknown>;
  controlTray(action: TrayAction): Promise<unknown>;
  launchHarness(harnessId: HarnessId, surface: HarnessSurface): Promise<unknown>;
  probeAgentBridge(bridgeId: AgentBridgeId): Promise<unknown>;
  loginAgentBridge(bridgeId: AgentBridgeId): Promise<unknown>;
  setupHarness(harnessId: HarnessId, hostname?: string): Promise<unknown>;
  prepareCursorTunnel(): Promise<unknown>;
  connectCursor(hostname?: string): Promise<unknown>;
  openHarnessSession(harnessId: HarnessId, sessionId: string, surface: HarnessSurface, model?: string): Promise<unknown>;
  openExternal(url: string): Promise<void>;
  onNavigation?(listener: (request: {
    destination: "usage" | "usage-resets";
    sourceId?: string;
  }) => void): () => void;
  onOperation(listener: (event: { id?: string; name?: string; action?: string; status: string; message?: string; error?: string }) => void): () => void;
}
