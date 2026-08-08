import AppKit
import Combine
import Foundation
import ServiceManagement
import SwiftUI

let routerAccent = Color(red: 0.36, green: 0.66, blue: 0.91)
let routerMint = Color(red: 0.38, green: 0.82, blue: 0.61)
let routerYellow = Color(red: 0.94, green: 0.68, blue: 0.25)
let routerRed = Color(red: 0.91, green: 0.35, blue: 0.32)
let routerInk = Color(red: 0.035, green: 0.043, blue: 0.055)
let routerMuted = Color.secondary.opacity(0.72)
let routerMutedStrong = Color.secondary.opacity(0.96)
let removalArmWindow: TimeInterval = 4

enum RouterActivityState: String, Decodable {
  case idle
  case generating
  case starting
  case error

  var tint: Color {
    switch self {
    case .idle: return routerMint
    case .generating: return routerYellow
    case .starting: return routerAccent
    case .error: return routerRed
    }
  }

  var label: String {
    switch self {
    case .idle: return "Idle"
    case .generating: return "Thinking"
    case .starting: return "Starting"
    case .error: return "Error"
    }
  }
}

@main
struct ModelRouterTrayApp: App {
  @NSApplicationDelegateAdaptor private var appDelegate: AppDelegate
  @ObservedObject private var store = RouterStore.shared

  var body: some Scene {
    // The insertion binding is read-only from our side: visibility is decided
    // by the presence mode, not by the system writing back.
    MenuBarExtra(isInserted: Binding(
      get: { store.surfacesVisible },
      set: { _ in }
    )) {
      TrayView(store: store)
        .frame(width: 352, height: 560)
    } label: {
      StatusItemLabel(store: store)
    }
    .menuBarExtraStyle(.window)
  }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  let store = RouterStore.shared
  private var islandController: IslandWindowController?
  private var desktopPanelController: DesktopPanelWindowController?
  private var surfaceVisibility: AnyCancellable?

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)
    islandController = IslandWindowController(store: store)
    desktopPanelController = DesktopPanelWindowController(store: store)
    surfaceVisibility = store.$surfacesVisible
      .combineLatest(store.$islandMode)
      .sink { [weak self] visible, mode in
        self?.islandController?.setVisible(visible && mode == .notch)
        self?.desktopPanelController?.setVisible(visible && mode == .desktop)
      }
    store.retireLoginItem()
    store.startHostAppObservation()
    Task { await store.startPolling() }
    Task { await store.startActivityPolling() }
    Task { await store.startAccountUsagePolling() }
    Task { await store.startProviderPolling() }
  }

  func applicationWillTerminate(_ notification: Notification) {
    store.restoreServiceOnQuit()
  }
}

@MainActor
final class RouterStore: ObservableObject {
  static let shared = RouterStore()

  @Published private(set) var snapshot = RouterSnapshot.empty
  @Published private(set) var isRefreshing = false
  @Published private(set) var message: String?
  @Published private(set) var lastUpdated: Date?
  @Published private(set) var selectedUsageProviderID: String
  @Published private(set) var activityState: RouterActivityState = .idle
  @Published private(set) var activeRequests: [RouterActiveRequest] = []
  @Published private(set) var activeRequestCount: Int = 0
  @Published private(set) var activeModel: String?
  @Published private(set) var activitySessionName: String?
  @Published private(set) var accountUsage: CodexAccountUsage?
  @Published private(set) var accountUsageError: String?
  @Published private(set) var providerUsage: ProviderUsageSnapshot?
  @Published private(set) var providerUsageError: String?
  @Published private(set) var providerSetup: [String: ProviderSetupState] = [:]
  @Published private(set) var providerOperation: String?
  @Published private(set) var visionDownload: VisionDownloadState?
  @Published private(set) var benchmarkingTag: String?
  @Published private(set) var maintenanceMessage: String?
  @Published private(set) var maintenanceSucceeded = false
  @Published private(set) var islandMode: IslandMode
  @Published private(set) var presenceMode: TrayPresenceMode
  @Published private(set) var hostAppRunning = false
  @Published private(set) var surfacesVisible = true

  private var polling = false
  private var activityPolling = false
  private var accountUsagePolling = false
  private var providerPolling = false
  private let defaults = UserDefaults.standard
  private let islandVisibilityKey = "ModelRouterTray.islandVisible"
  private let islandModeKey = "ModelRouterTray.islandMode"
  // Named for the retired login item because `update` still reads this default
  // to locate a tray installed outside the standard paths.
  private let loginItemBundlePathKey = "ModelRouterTray.loginItemBundlePath"
  private let presenceModeKey = "ModelRouterTray.presenceMode"
  // The Codex desktop app plus the ChatGPT desktop app, either of which counts
  // as "Codex is open" for the follow mode.
  private let hostAppBundleIDs = ["com.openai.codex", "com.openai.chat"]
  private var workspaceObservers: [NSObjectProtocol] = []
  private var pendingServiceStop: Task<Void, Never>?
  private var serviceWork: Task<Void, Never>?
  private var serviceIntent: ServiceIntent = .unknown
  // Codex relaunches itself to apply updates, so a momentary disappearance must
  // not bounce the router. Wait the absence out and re-check before stopping.
  private let hostAppAbsenceGrace = Duration.seconds(30)
  // A request in flight outlives the window that started it; retry rather than
  // cutting a generation off mid-stream.
  private let activeRequestRecheck = Duration.seconds(15)
  private var accountUsageResolved = false
  private var hasResolvedInitialUsageProvider = false
  private var hasObservedActiveProvider = false
  private var manuallySelectedUsageProvider = false
  private var latestObservedActivityRequestID: String?
  private var lastObservedSessionID: String?
  private var activityHealthFailureStartedAt: Date?
  private var dailyUsageCache: [DailyUsageCacheKey: [DailyUsagePoint]] = [:]
  private var localUsageTotalsCache: [LocalUsageTotalsCacheKey: UsageTotals] = [:]

  private struct DailyUsageCacheBucket: Hashable {
    let startDate: String
    let tokens: Int64
  }

  private struct DailyUsageCacheKey: Hashable {
    let providerID: String
    let days: Int
    let today: Date
    let buckets: [DailyUsageCacheBucket]
  }

  private struct LocalUsageTotalsCacheBucket: Hashable {
    let startDate: String
    let tokens: Int64
    let requests: Int
  }

  private struct LocalUsageTotalsCacheKey: Hashable {
    let providerID: String
    let days: Int
    let today: Date
    let buckets: [LocalUsageTotalsCacheBucket]
  }

  private struct UsageTotals {
    let tokens: Double
    let requests: Int
  }

  private static let dayKeyFormatter: DateFormatter = {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.calendar = Calendar(identifier: .gregorian)
    formatter.dateFormat = "yyyy-MM-dd"
    return formatter
  }()

  init() {
    selectedUsageProviderID = "openai"
    if let raw = defaults.string(forKey: islandModeKey), let mode = IslandMode(rawValue: raw) {
      islandMode = mode
    } else if defaults.object(forKey: islandVisibilityKey) == nil {
      islandMode = .notch
    } else {
      // Migrate the pre-desktop-mode boolean setting.
      islandMode = defaults.bool(forKey: islandVisibilityKey) ? .notch : .off
    }
    if let raw = defaults.string(forKey: presenceModeKey),
      let mode = TrayPresenceMode(rawValue: raw)
    {
      presenceMode = mode
    } else {
      presenceMode = .always
    }
  }

  var codexActive: Bool {
    snapshot.targets["codex"]?.active == true
  }

  var loginFree: Bool {
    snapshot.targets["codex"]?.loginFree == true
  }

  var maintenanceRunning: Bool {
    providerOperation == "maintenance" || providerOperation == "doctor"
  }

  // Startup belongs entirely to the launchd agent: it opens the tray at login
  // *and* restarts it when it exits abnormally, which a login item never did.
  // The tray no longer registers a login item of its own -- running both opened
  // two trays every login -- so this only clears one an earlier build left
  // behind. Recording the bundle path is unrelated to startup: `update` reads
  // it to find a tray installed outside the standard paths.
  func retireLoginItem() {
    // SMAppService needs a real bundle identity; a bare `swift run` binary has
    // none, and asking it to unregister would throw rather than no-op.
    guard Bundle.main.bundleIdentifier != nil else { return }
    defaults.set(Bundle.main.bundlePath, forKey: loginItemBundlePathKey)
    defaults.removeObject(forKey: "ModelRouterTray.loginItemAutoRegistered")
    let service = SMAppService.mainApp
    guard service.status == .enabled else { return }
    try? service.unregister()
  }

  // In follow mode every tray surface tracks the Codex/ChatGPT desktop apps.
  // The process itself stays resident as the watcher — quitting on app exit
  // would leave nothing around to notice the next launch.
  func startHostAppObservation() {
    // The mode lives in two places: UserDefaults for the tray and presence.json
    // for doctor. Only a toggle used to write the second one, so a reinstall or
    // a cleared state directory left doctor believing the router should always
    // be up while the tray was quietly stopping it. Republish on every launch.
    persistPresenceMode(presenceMode)
    let center = NSWorkspace.shared.notificationCenter
    for name in [
      NSWorkspace.didLaunchApplicationNotification,
      NSWorkspace.didTerminateApplicationNotification,
    ] {
      workspaceObservers.append(
        center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
          Task { @MainActor in self?.refreshHostAppRunning() }
        }
      )
    }
    refreshHostAppRunning()
  }

  func setPresenceMode(_ mode: TrayPresenceMode) {
    presenceMode = mode
    defaults.set(mode.rawValue, forKey: presenceModeKey)
    refreshSurfacesVisible()
    // doctor reads the mode from the router's own state directory: without it a
    // service the tray stopped on purpose reads as a crash and drives the Fix
    // button into a full repair.
    persistPresenceMode(mode)
    reconcileService()
  }

  private func refreshHostAppRunning() {
    hostAppRunning = hostAppBundleIDs.contains { identifier in
      NSRunningApplication.runningApplications(withBundleIdentifier: identifier)
        .contains { !$0.isTerminated }
    }
    refreshSurfacesVisible()
    reconcileService()
  }

  private func refreshSurfacesVisible() {
    surfacesVisible = presenceMode == .always || hostAppRunning
  }

  private func persistPresenceMode(_ mode: TrayPresenceMode) {
    enqueueServiceWork { [weak self] in
      _ = try? await self?.runControl(arguments: ["presence", "set", mode.controlValue])
    }
  }

  // In follow mode the router runs only while Codex or ChatGPT is open. Starts
  // are immediate so the gateway is warming while the user walks to the prompt.
  // Stops are deferred: Codex restarts itself, and a request can outlive the
  // window that issued it.
  private func reconcileService() {
    pendingServiceStop?.cancel()
    pendingServiceStop = nil
    guard presenceMode == .followCodex else {
      // Leaving follow mode hands the router back to launchd's always-on
      // contract, so anything the tray stopped has to come back up.
      if serviceIntent == .stopped { startService() }
      serviceIntent = .unknown
      return
    }
    if hostAppRunning {
      startService()
      return
    }
    pendingServiceStop = Task { [weak self] in
      guard let self else { return }
      try? await Task.sleep(for: self.hostAppAbsenceGrace)
      guard !Task.isCancelled else { return }
      await self.stopServiceWhenIdle()
    }
  }

  private func stopServiceWhenIdle() async {
    while !Task.isCancelled {
      guard presenceMode == .followCodex, !hostAppRunning else { return }
      if activityState == .idle { break }
      try? await Task.sleep(for: activeRequestRecheck)
    }
    guard !Task.isCancelled, presenceMode == .followCodex, !hostAppRunning else { return }
    guard serviceIntent != .stopped else { return }
    serviceIntent = .stopped
    enqueueServiceWork { [weak self] in
      await self?.runServiceCommand("stop")
    }
  }

  private func startService() {
    guard serviceIntent != .running else { return }
    serviceIntent = .running
    enqueueServiceWork { [weak self] in
      await self?.runServiceCommand("start")
    }
  }

  // launchctl rejects overlapping bootstrap/bootout for the same label, so every
  // service call queues behind the previous one.
  private func enqueueServiceWork(_ work: @escaping @Sendable () async -> Void) {
    let previous = serviceWork
    serviceWork = Task { [weak self] in
      _ = await previous?.value
      guard self != nil else { return }
      await work()
    }
  }

  private func runServiceCommand(_ action: String) async {
    do {
      _ = try await runControl(arguments: ["service", action])
    } catch {
      // A failed stop is harmless; a failed start is not, so surface it and let
      // the next Codex launch retry from a known-unknown intent.
      serviceIntent = .unknown
      message = "Router \(action): \(error.localizedDescription)"
    }
    await refresh()
  }

  // The tray is the only watcher in follow mode. If it goes away with the router
  // stopped, nothing is left to notice the next Codex launch, so hand the router
  // back to launchd on the way out. Detached so quitting never blocks on the
  // gateway's health wait.
  func restoreServiceOnQuit() {
    pendingServiceStop?.cancel()
    guard presenceMode == .followCodex, serviceIntent == .stopped else { return }
    guard let root = try? sourceRoot() else { return }
    let task = Process()
    task.executableURL = root.appendingPathComponent("bin/control")
    task.arguments = ["service", "start"]
    task.currentDirectoryURL = root
    try? task.run()
  }

  private static let providerShortNames: [String: String] = [
    "grok-oauth": "Grok",
    "kimi-oauth": "Kimi",
    "deepseek": "DeepSeek",
    "grok-api": "Grok API",
    "kimi-api": "Kimi API",
    "anthropic-api": "Claude",
    "zai-coding": "GLM",
    "qwen-plan": "Qwen",
    "ollama-cloud": "Ollama",
    "commandcode": "Command Code",
  ]

  static func shortName(forRegistryProvider provider: RouterProviderInfo) -> String {
    if let short = providerShortNames[provider.id] { return short }
    let base = provider.displayName.split(separator: "(").first.map(String.init)
      ?? provider.displayName
    let trimmed = base.trimmingCharacters(in: .whitespaces)
    return trimmed.count > 12 ? String(trimmed.prefix(12)) : trimmed
  }

  // Provider choices come from the router's registry snapshot so newly added
  // providers appear without a tray update; the static list is only a
  // fallback for routers that predate the snapshot's providers field.
  var usageProviderChoices: [UsageProviderChoice] {
    let target = snapshot.targets["codex"]
    let enabled = Set(target?.enabledProviders ?? [])
    let registryProviders = target?.providers ?? RouterProviderInfo.legacyFallback
    var choices = [
      UsageProviderChoice(
        id: "openai", displayName: "ChatGPT", shortName: "ChatGPT",
        detail: "Codex subscription", isEnabled: true),
    ]
    for provider in registryProviders {
      choices.append(UsageProviderChoice(
        id: provider.id,
        displayName: provider.displayName,
        shortName: Self.shortName(forRegistryProvider: provider),
        detail: providerDetail(provider.id, enabled: enabled),
        isEnabled: enabled.contains(provider.id)))
    }
    return choices
  }

  var selectedUsageProvider: UsageProviderChoice {
    usageProviderChoices.first(where: { $0.id == selectedUsageProviderID }) ?? usageProviderChoices[0]
  }

  var selectedUsageText: String? {
    if selectedUsageUsesChatGPT {
      guard let primary = accountUsage?.primary else { return nil }
      return "\(primary.remainingPercent)% left"
    }
    guard providerUsage != nil else { return nil }
    if let metric = selectedAccountMetric { return formattedAccountMetric(metric) }
    return localUsageSummary(for: selectedUsageProviderID, days: 7)
  }

  var selectedUsageUsesChatGPT: Bool {
    selectedUsageProviderID == "openai"
  }

  var selectedProviderUsage: RouterProviderUsage? {
    providerUsage(for: selectedUsageProviderID)
  }

  var selectedAccountMetric: ProviderAccountMetric? {
    selectedProviderUsage?.account.metrics.first
  }

  var selectedTodayTokens: Double {
    dailyUsage(days: 1).last?.tokens ?? 0
  }

  var selectedUsageResetDate: Date? {
    if selectedUsageUsesChatGPT { return accountUsage?.primary?.resetDate }
    return selectedAccountMetric?.resetDate
  }

  /// Running chats, not in-flight HTTP requests. One chat fans out into many
  /// requests (turns, subagents, compactions) and counting those reads as a
  /// runaway number that never matches what the user has open.
  var activeChatCount: Int {
    var seen = Set<String>()
    for request in activeRequests {
      seen.insert(request.sessionId ?? request.sessionName ?? "request-\(request.id)")
    }
    return seen.count
  }

  var hasConcurrentActivity: Bool {
    activeChatCount > 1
  }

  var activitySummaryLabel: String {
    if activityState == .generating, activeChatCount > 1 {
      return "\(activeChatCount) chats"
    }
    return activityState.label
  }

  var compactActivityProvidersLabel: String {
    let names = uniqueActiveProviderShortNames
    if names.isEmpty { return selectedUsageProvider.shortName }
    if names.count == 1 { return names[0] }
    if names.count == 2 { return "\(names[0]) + \(names[1])" }
    return "\(names[0]) +\(names.count - 1)"
  }

  var uniqueActiveProviderShortNames: [String] {
    var seen = Set<String>()
    var names: [String] = []
    for request in activeRequests {
      let name = shortName(forProvider: request.provider)
      if seen.insert(name).inserted {
        names.append(name)
      }
    }
    return names
  }

  func shortName(forProvider providerID: String) -> String {
    usageProviderChoices.first(where: { $0.id == providerID })?.shortName
      ?? providerID
  }

  func displayName(forProvider providerID: String) -> String {
    usageProviderChoices.first(where: { $0.id == providerID })?.displayName
      ?? providerID
  }

  func modelLabel(for request: RouterActiveRequest) -> String {
    guard let model = request.model, !model.isEmpty else {
      return displayName(forProvider: request.provider)
    }
    if let slash = model.lastIndex(of: "/") {
      return String(model[model.index(after: slash)...])
    }
    return model
  }

  func sessionName(for request: RouterActiveRequest) -> String {
    guard let sessionName = request.sessionName?.trimmingCharacters(in: .whitespacesAndNewlines),
          !sessionName.isEmpty
    else { return "Active session" }
    return sessionName
  }

  var visibleUsageProviders: [UsageProviderChoice] {
    usageProviderChoices.filter { usageProviderHasCredentials($0.id) }
  }

  var visibleUsageCards: [UsageOverviewCard] {
    visibleUsageProviders.flatMap(usageCards(for:))
  }

  /// Every model the router has served, across all providers, heaviest first.
  var overallModelUsage: [ModelUsageRow] {
    guard let snapshot = providerUsage else { return [] }
    return snapshot.providers
      .flatMap { provider in
        (provider.models ?? []).map { model in
          ModelUsageRow(
            providerID: provider.id,
            providerName: provider.displayName,
            model: model
          )
        }
      }
      .filter { $0.model.requests > 0 }
      .sorted {
        if $0.model.totalTokens != $1.model.totalTokens {
          return $0.model.totalTokens > $1.model.totalTokens
        }
        return $0.model.requests > $1.model.requests
      }
  }

  var overallTokenTotal: Int64 {
    overallModelUsage.reduce(0) { $0 + $1.model.totalTokens }
  }

  var overallRequestTotal: Int {
    overallModelUsage.reduce(0) { $0 + $1.model.requests }
  }

  func usageCards(for provider: UsageProviderChoice) -> [UsageOverviewCard] {
    if provider.id == "openai" {
      var cards: [UsageOverviewCard] = []
      if let primary = accountUsage?.primary {
        cards.append(
          UsageOverviewCard(
            id: "openai-primary",
            provider: provider,
            metric: nil,
            kindLabel: primary.durationLabel,
            remainingPercent: Double(primary.remainingPercent),
            resetDate: primary.resetDate
          )
        )
      } else {
        cards.append(
          UsageOverviewCard(
            id: "openai-primary",
            provider: provider,
            metric: nil,
            kindLabel: nil,
            remainingPercent: nil,
            resetDate: nil
          )
        )
      }
      if let secondary = accountUsage?.secondary {
        cards.append(
          UsageOverviewCard(
            id: "openai-secondary",
            provider: provider,
            metric: nil,
            kindLabel: secondary.durationLabel,
            remainingPercent: Double(secondary.remainingPercent),
            resetDate: secondary.resetDate
          )
        )
      }
      return cards
    }

    let metrics = providerUsage(for: provider.id)?.account.metrics ?? []
    if !metrics.isEmpty {
      return metrics.enumerated().map { index, metric in
        let kindLabel = metric.kind == "quota"
          ? standardizedLimitLabel(metric.label)
          : metric.label
        return UsageOverviewCard(
          id: "\(provider.id)-metric-\(index)",
          provider: provider,
          metric: metric,
          kindLabel: kindLabel,
          remainingPercent: metric.remainingPercent,
          resetDate: metric.resetDate
        )
      }
    }

    return [
      UsageOverviewCard(
        id: "\(provider.id)-local",
        provider: provider,
        metric: nil,
        kindLabel: nil,
        remainingPercent: nil,
        resetDate: nil
      )
    ]
  }

  func providerUsage(for providerID: String) -> RouterProviderUsage? {
    providerUsage?.providers.first(where: { $0.id == providerID })
  }

  func startPolling() async {
    guard !polling else { return }
    polling = true
    defer { polling = false }
    while !Task.isCancelled {
      await refresh()
      do {
        try await Task.sleep(nanoseconds: 5 * 60 * 1_000_000_000)
      } catch {
        return
      }
    }
  }

  func refresh() async {
    isRefreshing = true
    defer { isRefreshing = false }
    do {
      let output = try await runControl(arguments: ["--json"])
      snapshot = try JSONDecoder().decode(RouterSnapshot.self, from: output)
      resolveInitialUsageProvider()
      lastUpdated = .now
      message = nil
    } catch {
      message = error.localizedDescription
    }
  }

  func startActivityPolling() async {
    guard !activityPolling else { return }
    activityPolling = true
    defer { activityPolling = false }
    while !Task.isCancelled {
      await refreshActivity()
      do {
        try await Task.sleep(nanoseconds: 350_000_000)
      } catch {
        return
      }
    }
  }

  private func focusUsageProvider(_ providerID: String) {
    guard usageProviderChoices.contains(where: { $0.id == providerID }) else { return }
    guard selectedUsageProviderID != providerID else { return }
    selectedUsageProviderID = providerID
    Task {
      if providerID == "openai" {
        await refreshAccountUsage()
      } else {
        await refreshProviderUsage()
      }
    }
  }

  func setIslandMode(_ mode: IslandMode) {
    islandMode = mode
    defaults.set(mode.rawValue, forKey: islandModeKey)
  }

  // Every vendor quota window the desktop panel can show at a glance:
  // the ChatGPT rate-limit windows plus each connected provider's account
  // quota metrics.
  var desktopQuotaRows: [DesktopQuotaRow] {
    var rows: [DesktopQuotaRow] = []
    if let account = accountUsage {
      for (suffix, window) in [("primary", account.primary), ("secondary", account.secondary)] {
        guard let window else { continue }
        rows.append(DesktopQuotaRow(
          id: "openai-\(suffix)",
          providerID: "openai",
          providerName: "ChatGPT",
          label: window.durationLabel,
          usedPercent: Double(window.usedPercent),
          resetAt: window.resetsAt))
      }
    }
    for provider in usageProviderChoices where provider.id != "openai" && provider.isEnabled {
      guard let usage = providerUsage(for: provider.id) else { continue }
      for (index, metric) in usage.account.metrics.enumerated() where metric.kind == "quota" {
        guard let used = metric.usedPercent else { continue }
        rows.append(DesktopQuotaRow(
          id: "\(provider.id)-\(index)",
          providerID: provider.id,
          providerName: provider.shortName,
          label: metric.label,
          usedPercent: used,
          resetAt: metric.resetAt))
      }
    }
    return rows
  }

  func startAccountUsagePolling() async {
    guard !accountUsagePolling else { return }
    accountUsagePolling = true
    defer { accountUsagePolling = false }
    while !Task.isCancelled {
      await refreshAccountUsage()
      await refreshProviderUsage()
      do {
        try await Task.sleep(nanoseconds: 30 * 1_000_000_000)
      } catch {
        return
      }
    }
  }

  func refreshAccountUsage() async {
    do {
      let output = try await runControl(arguments: ["account", "--json"])
      let nextUsage = try JSONDecoder().decode(CodexAccountUsage.self, from: output)
      if accountUsage != nextUsage { accountUsage = nextUsage }
      if accountUsageError != nil { accountUsageError = nil }
    } catch {
      let nextError = error.localizedDescription
      if accountUsageError != nextError { accountUsageError = nextError }
    }
    accountUsageResolved = true
    resolveInitialUsageProvider()
  }

  func refreshProviderUsage() async {
    do {
      let output = try await runControl(arguments: ["provider-usage", "--json"])
      let nextUsage = try JSONDecoder().decode(ProviderUsageSnapshot.self, from: output)
      if providerUsage != nextUsage { providerUsage = nextUsage }
      if providerUsageError != nil { providerUsageError = nil }
      resolveInitialUsageProvider()
    } catch {
      let nextError = error.localizedDescription
      if providerUsageError != nextError { providerUsageError = nextError }
    }
  }

  func startProviderPolling() async {
    guard !providerPolling else { return }
    providerPolling = true
    defer { providerPolling = false }
    while !Task.isCancelled {
      await refreshProviderSetup()
      do {
        try await Task.sleep(nanoseconds: 60 * 1_000_000_000)
      } catch {
        return
      }
    }
  }

  func refreshProviderSetup() async {
    do {
      let output = try await runControl(arguments: ["providers", "--json"])
      let snapshot = try JSONDecoder().decode(ProviderSetupSnapshot.self, from: output)
      let nextSetup = Dictionary(uniqueKeysWithValues: snapshot.providers.map { ($0.id, $0) })
      if providerSetup != nextSetup { providerSetup = nextSetup }
      resolveInitialUsageProvider()
    } catch {
      let nextMessage = error.localizedDescription
      if message != nextMessage { message = nextMessage }
    }
  }

  func selectUsageProvider(_ providerID: String) {
    manuallySelectedUsageProvider = true
    focusUsageProvider(providerID)
  }

  // One click covers the whole route into a provider: install the official CLI
  // when it is missing, then go straight into its browser sign-in. Stopping
  // after the install left a row that looked finished but still had no
  // credential, and made connecting a two-click ritual for no reason.
  // install-cli is a no-op when the CLI is already present, so an unknown
  // state costs a lookup rather than a wrong branch.
  func connectProvider(_ provider: String) async {
    let reconnecting = providerSetup[provider]?.configured == true
    let needsInstall = providerSetup[provider]?.cliInstalled != true
    await performProviderOperation(
      provider,
      successMessage: reconnecting
        ? "Provider reconnected."
        : "Provider connected. Restart Codex to refresh its model picker."
    ) {
      if needsInstall {
        _ = try await runControl(arguments: ["install-cli", provider])
      }
      _ = try await runControl(arguments: ["login", provider])
      if !reconnecting {
        try await updateProviderSelection(provider, enabled: true)
      }
    }
  }

  func loginProvider(_ provider: String) async {
    let reconnecting = providerSetup[provider]?.configured == true
    await performProviderOperation(
      provider,
      successMessage: reconnecting
        ? "Provider reconnected."
        : "Provider connected. Restart Codex to refresh its model picker."
    ) {
      _ = try await runControl(arguments: ["login", provider])
      if !reconnecting {
        try await updateProviderSelection(provider, enabled: true)
      }
    }
  }

  func saveProviderKey(_ provider: String, key: String) async {
    let secret = Data(key.utf8)
    await performProviderOperation(
      provider,
      successMessage: "API key saved. Restart Codex to refresh its model picker."
    ) {
      _ = try await runControl(arguments: ["credential", provider], stdin: secret)
      try await updateProviderSelection(provider, enabled: true)
    }
  }

  // The control plane already drops the provider from the Codex selection when
  // the key file is deleted; this only makes that selection live.
  func removeProviderKey(_ provider: String) async {
    await performProviderOperation(
      provider,
      successMessage: "API key removed. Restart Codex to refresh its model picker."
    ) {
      _ = try await runControl(arguments: ["credential", provider, "--remove"])
      _ = try? await runControl(arguments: ["apply", "--targets", "codex", "--activate"])
    }
  }

  func dailyTokens(days: Int) -> [Double] {
    dailyUsage(days: days).map(\.tokens)
  }

  func dailyUsage(days: Int) -> [DailyUsagePoint] {
    let buckets: [DailyUsageCacheBucket]
    if selectedUsageUsesChatGPT {
      buckets = accountUsage?.dailyUsageBuckets.map {
        DailyUsageCacheBucket(startDate: $0.startDate, tokens: $0.tokens)
      } ?? []
    } else {
      buckets = selectedProviderUsage?.dailyUsageBuckets.map {
        DailyUsageCacheBucket(startDate: $0.startDate, tokens: $0.tokens)
      } ?? []
    }
    let calendar = Calendar.current
    let today = calendar.startOfDay(for: .now)
    let cacheKey = DailyUsageCacheKey(
      providerID: selectedUsageProviderID,
      days: days,
      today: today,
      buckets: buckets
    )
    if let cached = dailyUsageCache[cacheKey] { return cached }

    let indexed = Dictionary(uniqueKeysWithValues: buckets.map {
      ($0.startDate, Double($0.tokens))
    })
    let points = (0..<days).map { offset in
      let date = calendar.date(byAdding: .day, value: offset - (days - 1), to: today) ?? today
      return DailyUsagePoint(
        date: date,
        tokens: indexed[Self.dayKeyFormatter.string(from: date)] ?? 0
      )
    }
    if dailyUsageCache.count >= 24 { dailyUsageCache.removeAll(keepingCapacity: true) }
    dailyUsageCache[cacheKey] = points
    return points
  }

  func localUsageTotals(days: Int) -> (tokens: Double, requests: Int) {
    localUsageTotals(for: selectedUsageProviderID, days: days)
  }

  func localUsageTotals(for providerID: String, days: Int) -> (tokens: Double, requests: Int) {
    guard providerID != "openai", let usage = providerUsage(for: providerID) else { return (0, 0) }
    let calendar = Calendar.current
    let today = calendar.startOfDay(for: .now)
    let buckets = usage.dailyUsageBuckets.map {
      LocalUsageTotalsCacheBucket(
        startDate: $0.startDate,
        tokens: $0.tokens,
        requests: $0.requests
      )
    }
    let cacheKey = LocalUsageTotalsCacheKey(
      providerID: providerID,
      days: days,
      today: today,
      buckets: buckets
    )
    if let cached = localUsageTotalsCache[cacheKey] {
      return (cached.tokens, cached.requests)
    }

    let firstDay = calendar.date(byAdding: .day, value: -(days - 1), to: today) ?? today
    let totals = usage.dailyUsageBuckets.reduce(into: (tokens: 0.0, requests: 0)) { totals, bucket in
      guard let date = Self.dayKeyFormatter.date(from: bucket.startDate),
            date >= firstDay,
            date <= today
      else { return }
      totals.tokens += Double(bucket.tokens)
      totals.requests += bucket.requests
    }
    if localUsageTotalsCache.count >= 48 {
      localUsageTotalsCache.removeAll(keepingCapacity: true)
    }
    localUsageTotalsCache[cacheKey] = UsageTotals(tokens: totals.tokens, requests: totals.requests)
    return totals
  }

  func localUsageSummary(for providerID: String, days: Int = 7) -> String {
    let totals = localUsageTotals(for: providerID, days: days)
    if totals.tokens > 0 {
      return "\(compactTokenCount(totals.tokens)) tok"
    }
    if totals.requests > 0 {
      return "\(totals.requests) req"
    }
    return "No traffic"
  }


  func setProvider(_ provider: String, enabled: Bool) async {
    guard providerOperation == nil else { return }
    providerOperation = provider
    defer { providerOperation = nil }
    do {
      try await updateProviderSelection(provider, enabled: enabled)
      await refresh()
      await refreshProviderUsage()
      message = enabled
        ? "Provider added. Restart Codex to refresh its model picker."
        : "Provider hidden. Restart Codex to refresh its model picker."
    } catch {
      message = error.localizedDescription
      await refresh()
    }
  }

  func updateAndVerify() async {
    guard providerOperation == nil else { return }
    providerOperation = "maintenance"
    maintenanceMessage = "Running update and doctor…"
    maintenanceSucceeded = false
    defer { providerOperation = nil }
    do {
      _ = try await runControl(arguments: ["maintenance"])
      await refresh()
      await refreshAccountUsage()
      await refreshProviderUsage()
      await refreshProviderSetup()
      maintenanceSucceeded = true
      maintenanceMessage = "Verified. Restart Codex to load updated models and agents."
    } catch {
      maintenanceMessage = error.localizedDescription
      await refresh()
    }
  }

  func fixAndVerify() async {
    guard providerOperation == nil else { return }
    providerOperation = "doctor"
    maintenanceMessage = "Running doctor --fix…"
    maintenanceSucceeded = false
    defer { providerOperation = nil }
    do {
      _ = try await runControl(arguments: ["doctor", "--fix"])
      await refresh()
      await refreshAccountUsage()
      await refreshProviderUsage()
      await refreshProviderSetup()
      maintenanceSucceeded = true
      maintenanceMessage = "Fixed. Restart Codex if models changed."
    } catch {
      maintenanceMessage = error.localizedDescription
      await refresh()
    }
  }

  func setLoginFree(_ enabled: Bool) async {
    guard providerOperation == nil else { return }
    providerOperation = "auth-mode"
    defer { providerOperation = nil }
    do {
      _ = try await runControl(arguments: ["auth-mode", enabled ? "on" : "off"])
    } catch {
      let errorMessage = error.localizedDescription
      await refresh()
      message = errorMessage
      return
    }

    await refresh()
    do {
      try await restartCodexApp()
      message = enabled
        ? "Codex restarted with external-provider mode."
        : "Codex restarted with OpenAI login restored."
    } catch {
      message = "Mode changed, but Codex could not restart: \(error.localizedDescription)"
    }
  }

  func setSubagentMode(_ mode: String) async {
    await applyModelSettings(arguments: ["subagents", "mode", mode])
  }

  func setSubagentModel(_ slug: String, enabled: Bool) async {
    await applyModelSettings(
      arguments: ["subagents", "set", slug, enabled ? "on" : "off"]
    )
  }

  func setPickerModel(_ slug: String, visible: Bool) async {
    await applyModelSettings(
      arguments: ["picker", "set", slug, visible ? "show" : "hide"]
    )
  }

  func selectAllSubagents() async {
    await applyModelSettings(arguments: ["subagents", "select-all"])
  }

  func unselectAllSubagents() async {
    await applyModelSettings(arguments: ["subagents", "unselect-all"])
  }

  func showAllPickerModels() async {
    await applyModelSettings(arguments: ["picker", "all", "show"])
  }

  func hideAllPickerModels() async {
    await applyModelSettings(arguments: ["picker", "all", "hide"])
  }

  func setVisionBridgeEnabled(_ enabled: Bool) async {
    await applyModelSettings(arguments: ["vision-bridge", enabled ? "on" : "off"])
  }

  /// Picks a paid cloud engine ("auto" or a model slug) as the image reader.
  func setVisionBridgeEngine(_ value: String) async {
    await applyModelSettings(arguments: ["vision-bridge", "engine", value])
  }

  func setLocalModelEnabled(_ tag: String, enabled: Bool) async {
    await applyModelSettings(arguments: ["local-models", "set", tag, enabled ? "on" : "off"])
  }

  /// Deletes the model from disk. Irreversible short of downloading it again,
  /// so the tray arms the row before this is reachable.
  func uninstallLocalModel(_ tag: String) async {
    await applyModelSettings(arguments: ["local-models", "uninstall", tag, "--yes"])
  }

  /// Switches the reader to an already-installed local model.
  func useLocalVisionModel(_ tag: String) async {
    await applyModelSettings(arguments: ["vision-bridge", "local", tag])
  }

  /// Scores an installed model against the checked-in ground-truth image. This
  /// is what makes "not benchmarked" actionable in the tray: download any
  /// model, then measure whether it actually reads before trusting it.
  func benchmarkLocalVisionModel(_ tag: String) async {
    guard benchmarkingTag == nil else { return }
    benchmarkingTag = tag
    defer { benchmarkingTag = nil }
    do {
      _ = try await runControl(arguments: ["vision-bridge", "benchmark", tag])
      await refresh()
      message = "\(tag) tested. The score is on its row."
    } catch {
      message = error.localizedDescription
    }
  }

  /// Downloads a local vision model with Ollama, then pins it. The tray row
  /// shows the size, so the click is the consent for the download.
  ///
  /// Gigabytes take minutes: the control command starts a detached worker and
  /// returns at once, and this polls progress so the row shows a live
  /// percentage instead of a frozen panel. Only the download buttons are
  /// disabled meanwhile — the rest of the tray stays usable.
  func downloadLocalVisionModel(_ tag: String) async {
    guard visionDownload?.isRunning != true else { return }
    visionDownload = VisionDownloadState(
      tag: tag, status: "downloading", detail: "starting", percent: 0, error: nil
    )
    do {
      _ = try await runControl(arguments: ["vision-bridge", "pull", tag])
    } catch {
      message = error.localizedDescription
      visionDownload = nil
      return
    }
    await pollVisionDownload()
  }

  private func pollVisionDownload() async {
    while !Task.isCancelled {
      try? await Task.sleep(nanoseconds: 1_000_000_000)
      guard let data = try? await runControl(arguments: ["vision-bridge", "pull-status"]),
        let state = try? JSONDecoder().decode(VisionDownloadState.self, from: data)
      else { continue }
      visionDownload = state
      if state.isRunning { continue }
      // Terminal: refresh so the row flips to "in use" and the engine label
      // catches up, then report what happened.
      await refresh()
      message = state.status == "done"
        ? "\(state.tag ?? "Model") downloaded. Restart Codex to refresh its picker."
        : (state.error ?? "The download failed.")
      visionDownload = nil
      return
    }
  }

  private func applyModelSettings(arguments: [String]) async {
    guard providerOperation == nil else { return }
    providerOperation = "models"
    defer { providerOperation = nil }
    do {
      _ = try await runControl(arguments: arguments)
      await refresh()
      message = "Model settings applied. Restart Codex to refresh its picker."
    } catch {
      message = error.localizedDescription
      await refresh()
    }
  }

  private func performProviderOperation(
    _ provider: String,
    successMessage: String,
    operation: () async throws -> Void
  ) async {
    guard providerOperation == nil else { return }
    providerOperation = provider
    defer { providerOperation = nil }
    do {
      try await operation()
      await refreshProviderSetup()
      await refresh()
      await refreshProviderUsage()
      message = successMessage
    } catch {
      message = error.localizedDescription
      await refreshProviderSetup()
    }
  }

  private func updateProviderSelection(_ provider: String, enabled: Bool) async throws {
    let wasEnabled = snapshot.targets["codex"]?.enabledProviders.contains(provider) == true
    _ = try await runControl(
      arguments: ["set", provider, enabled ? "on" : "off", "--targets", "codex"]
    )
    do {
      _ = try await runControl(arguments: ["apply", "--targets", "codex", "--activate"])
    } catch {
      _ = try? await runControl(
        arguments: ["set", provider, wasEnabled ? "on" : "off", "--targets", "codex"]
      )
      _ = try? await runControl(arguments: ["apply", "--targets", "codex", "--activate"])
      throw error
    }
  }

  private func refreshActivity() async {
    let configuredPort = ProcessInfo.processInfo.environment["MODEL_ROUTER_PORT"] ?? "4102"
    guard let url = URL(string: "http://127.0.0.1:\(configuredPort)/health") else {
      recordActivityHealthFailure()
      return
    }
    var request = URLRequest(url: url)
    request.cachePolicy = .reloadIgnoringLocalCacheData
    request.timeoutInterval = 2
    do {
      let (data, response) = try await URLSession.shared.data(for: request)
      guard (response as? HTTPURLResponse)?.statusCode == 200 else {
        throw RouterError("Router health check failed.")
      }
      let health = try JSONDecoder().decode(RouterHealth.self, from: data)
      let previousActivityState = activityState
      let nextActiveRequests = health.activity.active ?? []
      let nextActiveRequestCount = health.activity.activeCount ?? nextActiveRequests.count
      activityHealthFailureStartedAt = nil
      if activityState != health.activity.state { activityState = health.activity.state }
      if activeRequests != nextActiveRequests { activeRequests = nextActiveRequests }
      if activeRequestCount != nextActiveRequestCount {
        activeRequestCount = nextActiveRequestCount
      }
      if activeModel != health.activity.model { activeModel = health.activity.model }
      let latestActiveRequest = nextActiveRequests.last
      let activeSessionID = latestActiveRequest?.sessionId ?? latestActiveRequest?.threadId
      if let activeSessionID, activeSessionID != lastObservedSessionID {
        lastObservedSessionID = activeSessionID
        activitySessionName = nil
      }
      let activeSessionName = latestActiveRequest?.sessionName?.trimmingCharacters(in: .whitespacesAndNewlines)
      if let activeSessionID, activeSessionID == lastObservedSessionID,
         let activeSessionName, !activeSessionName.isEmpty,
         activitySessionName != activeSessionName {
        activitySessionName = activeSessionName
      } else if activeSessionID == nil,
                let sessionName = health.activity.sessionName?.trimmingCharacters(in: .whitespacesAndNewlines),
                !sessionName.isEmpty,
                lastObservedSessionID == nil {
        if activitySessionName != sessionName { activitySessionName = sessionName }
      }
      if health.activity.state == .generating,
         let provider = health.activity.provider {
        hasObservedActiveProvider = true
        if let requestID = nextActiveRequests.last?.id {
          if requestID != latestObservedActivityRequestID {
            latestObservedActivityRequestID = requestID
            manuallySelectedUsageProvider = false
          }
        } else if previousActivityState != .generating {
          // Older router health payloads may not include active request IDs.
          // Treat the transition into generating as the start of a new request.
          manuallySelectedUsageProvider = false
        }
        if !manuallySelectedUsageProvider {
          focusUsageProvider(provider)
        }
      }
    } catch {
      recordActivityHealthFailure()
    }
  }

  private func recordActivityHealthFailure() {
    if !activeRequests.isEmpty { activeRequests = [] }
    if activeRequestCount != 0 { activeRequestCount = 0 }
    if activeModel != nil { activeModel = nil }
    let now = Date()
    let nextState: RouterActivityState
    if let startedAt = activityHealthFailureStartedAt {
      nextState = now.timeIntervalSince(startedAt) < 30 ? .starting : .error
    } else {
      activityHealthFailureStartedAt = now
      nextState = .starting
    }
    if activityState != nextState { activityState = nextState }
  }

  private func resolveInitialUsageProvider() {
    guard accountUsageResolved,
          !hasResolvedInitialUsageProvider,
          !hasObservedActiveProvider
    else { return }

    let provider: String?
    if accountUsage != nil {
      provider = "openai"
    } else {
      let selectedModelProvider = snapshot.targets["codex"]?.selectedModel.flatMap { selectedModel in
        snapshot.targets["codex"]?.models.first(where: { $0.slug == selectedModel })?.provider
      }
      provider = [selectedModelProvider]
        .compactMap { $0 }
        .first(where: { $0 != "openai" && usageProviderIsAvailable($0) })
        ?? usageProviderChoices.first(where: {
          $0.id != "openai" && usageProviderIsAvailable($0.id)
        })?.id
    }

    guard let provider else { return }
    hasResolvedInitialUsageProvider = true
    focusUsageProvider(provider)
  }

  private func usageProviderIsAvailable(_ providerID: String) -> Bool {
    usageProviderHasCredentials(providerID)
  }

  private func usageProviderHasCredentials(_ providerID: String) -> Bool {
    if providerID == "openai" { return accountUsage != nil }
    return providerSetup[providerID]?.configured == true
  }

  private func providerDetail(_ providerID: String, enabled: Set<String>) -> String {
    if enabled.contains(providerID) {
      return providerID.hasSuffix("-oauth") ? "OAuth · enabled" : "API · enabled"
    }
    if providerSetup[providerID]?.configured == true { return "Ready to enable" }
    return "Needs setup"
  }

  private func restartCodexApp() async throws {
    let bundleIdentifier = "com.openai.codex"
    let workspace = NSWorkspace.shared
    let runningApplications = NSRunningApplication.runningApplications(
      withBundleIdentifier: bundleIdentifier
    )
    let applicationURL = runningApplications.compactMap(\.bundleURL).first
      ?? workspace.urlForApplication(withBundleIdentifier: bundleIdentifier)

    guard let applicationURL else {
      throw RouterError("the Codex desktop app could not be found")
    }

    for application in runningApplications where !application.isTerminated {
      guard application.terminate() else {
        throw RouterError("Codex did not accept a graceful quit request")
      }
    }

    for _ in 0..<50 {
      if runningApplications.allSatisfy({ $0.isTerminated }) { break }
      try await Task.sleep(nanoseconds: 100_000_000)
    }

    guard runningApplications.allSatisfy({ $0.isTerminated }) else {
      throw RouterError("Codex did not quit in time; restart it manually")
    }

    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = true
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      workspace.openApplication(at: applicationURL, configuration: configuration) { _, error in
        if let error {
          continuation.resume(throwing: error)
        } else {
          continuation.resume(returning: ())
        }
      }
    }
  }

  private func runControl(arguments: [String], stdin: Data? = nil) async throws -> Data {
    let root = try sourceRoot()
    return try await Task.detached {
      let task = Process()
      task.executableURL = root.appendingPathComponent("bin/control")
      task.arguments = arguments
      task.currentDirectoryURL = root
      var environment = ProcessInfo.processInfo.environment
      let home = FileManager.default.homeDirectoryForCurrentUser.path
      let preferredPaths = [
        "\(home)/.npm-global/bin",
        "\(home)/.local/bin",
        "/opt/homebrew/bin",
        "/usr/local/bin",
      ]
      environment["PATH"] = (preferredPaths + [environment["PATH"] ?? ""]).joined(separator: ":")
      task.environment = environment
      let output = Pipe()
      let errors = Pipe()
      let input = stdin.map { _ in Pipe() }
      task.standardOutput = output
      task.standardError = errors
      task.standardInput = input
      try task.run()
      let stdoutReader = Task.detached {
        output.fileHandleForReading.readDataToEndOfFile()
      }
      let stderrReader = Task.detached {
        errors.fileHandleForReading.readDataToEndOfFile()
      }
      if let stdin, let input {
        input.fileHandleForWriting.write(stdin)
        try? input.fileHandleForWriting.close()
      }
      task.waitUntilExit()
      let stdout = await stdoutReader.value
      let stderr = await stderrReader.value
      guard task.terminationStatus == 0 else {
        let detail = String(data: stderr, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
        throw RouterError(detail?.isEmpty == false ? detail! : "Model Router control command failed.")
      }
      return stdout
    }.value
  }

  private func sourceRoot() throws -> URL {
    if let configured = ProcessInfo.processInfo.environment["MODEL_ROUTER_SOURCE_ROOT"], !configured.isEmpty {
      return URL(fileURLWithPath: configured, isDirectory: true)
    }
    if let resourceURL = Bundle.main.resourceURL {
      let savedRoot = resourceURL.appendingPathComponent("router-root")
      if let contents = try? String(contentsOf: savedRoot, encoding: .utf8) {
        let root = contents.trimmingCharacters(in: .whitespacesAndNewlines)
        if !root.isEmpty { return URL(fileURLWithPath: root, isDirectory: true) }
      }
    }
    let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    guard FileManager.default.isExecutableFile(atPath: root.appendingPathComponent("bin/control").path) else {
      throw RouterError("Cannot find this Model Router checkout. Build the tray app from the router repository.")
    }
    return root
  }
}

private struct RouterHealth: Decodable {
  let activity: RouterActivity
}

private struct RouterActivity: Decodable {
  let state: RouterActivityState
  let provider: String?
  let model: String?
  let sessionName: String?
  let activeCount: Int?
  let active: [RouterActiveRequest]?
}

struct RouterActiveRequest: Decodable, Identifiable, Equatable {
  let id: String
  let provider: String
  let model: String?
  let sessionName: String?
  let sessionId: String?
  let threadId: String?
  let parentThreadId: String?
  let agentName: String?
  let agentNickname: String?
  let isSubagent: Bool?
  let startedAt: Double
}

private struct RouterError: LocalizedError {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}

struct RouterSnapshot: Decodable {
  let targets: [String: RouterTarget]
  static let empty = RouterSnapshot(targets: [:])
}

enum UsageRange: Int, CaseIterable, Identifiable {
  case week = 7
  case month = 30
  case quarter = 90

  var id: Int { rawValue }
  var label: String {
    switch self {
    case .week: return "7D"
    case .month: return "30D"
    case .quarter: return "90D"
    }
  }
}

struct CodexAccountUsage: Decodable, Equatable {
  let fetchedAt: String
  let planType: String?
  let limitId: String?
  let primary: CodexRateLimitWindow?
  let secondary: CodexRateLimitWindow?
  let dailyUsageBuckets: [CodexDailyUsageBucket]
  let summary: CodexUsageSummary

  static func == (lhs: CodexAccountUsage, rhs: CodexAccountUsage) -> Bool {
    lhs.planType == rhs.planType
      && lhs.limitId == rhs.limitId
      && lhs.primary == rhs.primary
      && lhs.secondary == rhs.secondary
      && lhs.dailyUsageBuckets == rhs.dailyUsageBuckets
      && lhs.summary == rhs.summary
  }
}

struct CodexRateLimitWindow: Decodable, Equatable {
  let usedPercent: Int
  let remainingPercent: Int
  let windowDurationMins: Int?
  let resetsAt: TimeInterval?

  var resetDate: Date? { resetsAt.map(Date.init(timeIntervalSince1970:)) }

  var durationLabel: String {
    guard let minutes = windowDurationMins else { return "Current limit" }
    if minutes >= 1_440, minutes.isMultiple(of: 1_440) {
      let days = minutes / 1_440
      if days == 1 { return "Daily limit" }
      if days == 7 { return "Weekly limit" }
      return "\(days)-day limit"
    }
    if minutes >= 60, minutes.isMultiple(of: 60) {
      return "\(minutes / 60)-hour limit"
    }
    return "\(minutes)-minute limit"
  }
}

struct CodexDailyUsageBucket: Decodable, Equatable {
  let startDate: String
  let tokens: Int64
}

struct DailyUsagePoint: Identifiable, Equatable {
  let date: Date
  let tokens: Double
  var id: Date { date }
}

struct CodexUsageSummary: Decodable, Equatable {
  let lifetimeTokens: Int64?
  let peakDailyTokens: Int64?
  let currentStreakDays: Int?
}

struct ProviderUsageSnapshot: Decodable, Equatable {
  let fetchedAt: String
  let scope: String
  let providers: [RouterProviderUsage]

  static func == (lhs: ProviderUsageSnapshot, rhs: ProviderUsageSnapshot) -> Bool {
    lhs.scope == rhs.scope && lhs.providers == rhs.providers
  }
}

struct RouterProviderUsage: Decodable, Identifiable, Equatable {
  let id: String
  let displayName: String
  let credentialType: String
  let scope: String
  let requests: Int
  let successfulRequests: Int
  let meteredRequests: Int
  let inputTokens: Int64
  let outputTokens: Int64
  let totalTokens: Int64
  let dailyUsageBuckets: [ProviderDailyUsageBucket]
  let account: ProviderAccountUsage
  // Optional so a newer tray still decodes snapshots from an older router.
  let models: [RouterModelUsage]?
}

struct RouterModelUsage: Decodable, Identifiable, Equatable {
  let slug: String
  let displayName: String
  let requests: Int
  let successfulRequests: Int
  let meteredRequests: Int
  let inputTokens: Int64
  let outputTokens: Int64
  let totalTokens: Int64
  let lastUsedAt: String?

  var id: String { slug }
}

struct ModelUsageRow: Identifiable {
  let providerID: String
  let providerName: String
  let model: RouterModelUsage

  var id: String { "\(providerID)/\(model.slug)" }
}

struct ProviderAccountUsage: Decodable, Equatable {
  let status: String
  let source: String
  let metrics: [ProviderAccountMetric]
  let message: String?
  let plan: String?
  let dashboardUrl: String?
}

struct ProviderAccountMetric: Decodable, Equatable {
  let kind: String
  let label: String
  let usedPercent: Double?
  let remainingPercent: Double?
  let used: Double?
  let limit: Double?
  let remaining: Double?
  let unit: String?
  let resetAt: TimeInterval?
  let value: Double?
  let currency: String?
  let detail: String?
  let available: Bool?

  var resetDate: Date? { resetAt.map(Date.init(timeIntervalSince1970:)) }
}

struct ProviderDailyUsageBucket: Decodable, Equatable {
  let startDate: String
  let tokens: Int64
  let requests: Int
}

struct RouterTarget: Decodable {
  let target: String
  let configured: Bool
  let active: Bool
  let enabledProviders: [String]
  let providers: [RouterProviderInfo]?
  let models: [RouterModel]
  let selectedModel: String?
  let loginFree: Bool?
  let loginFreeManaged: Bool?
  let nativeAliases: [String: String]?
  let modelSettings: ModelSettingsSnapshot?
}

struct RouterProviderInfo: Decodable {
  let id: String
  let displayName: String
  let kind: String?

  static let legacyFallback: [RouterProviderInfo] = [
    .init(id: "grok-oauth", displayName: "Grok OAuth", kind: "oauth"),
    .init(id: "kimi-oauth", displayName: "Kimi OAuth", kind: "oauth"),
    .init(id: "deepseek", displayName: "DeepSeek API", kind: "openai-compatible"),
    .init(id: "grok-api", displayName: "Grok API", kind: "openai-compatible"),
    .init(id: "kimi-api", displayName: "Kimi API", kind: "openai-compatible"),
    .init(id: "anthropic-api", displayName: "Anthropic API", kind: "openai-compatible"),
  ]
}

struct RouterModel: Decodable, Identifiable {
  let slug: String
  let displayName: String
  let provider: String
  let enabled: Bool
  let multiAgentVersion: String?
  let visible: Bool?
  var id: String { slug }
}

struct ModelSettingsSnapshot: Decodable {
  let subagents: SubagentSettingsSnapshot
  let picker: PickerSettingsSnapshot
  let localModels: LocalModelsSnapshot?
  let visionBridge: VisionBridgeSnapshot?
}

struct LocalModelsSnapshot: Decodable {
  let installed: Int
  let enabled: Int
  let usableAsChat: Int?
  let totalGb: Double
  let models: [InstalledLocalModel]
}

struct InstalledLocalModel: Decodable, Identifiable, Equatable {
  let tag: String
  let sizeGb: Double
  let modified: String?
  let enabled: Bool
  let running: Bool
  let vision: Bool
  let tools: Bool?
  let accuracy: String?
  let agent: String?
  var id: String { tag }

  /// Codex drives every turn through tool calls, so a model without them
  /// cannot be a chat model here however good it is. It stays useful as a
  /// vision reader, and the row has to say so or the checkbox looks broken.
  var canBeChatModel: Bool { tools == true }

  /// What this model is good for as a Codex chat model, from a measured run of
  /// the real client where one exists. Tool support alone is not enough: a
  /// model can call tools perfectly on a short prompt and still fall apart on
  /// Codex's real instructions.
  var chatRoleLabel: String {
    if tools != true { return "no tools — can't chat" }
    switch agent {
    case "agent": return "works in Codex"
    case "flaky": return "unreliable in Codex"
    case "not-published": return "not offered yet"
    case .some: return "fails in Codex"
    default: return "chat — untested"
    }
  }

  var chatRoleGood: Bool { tools == true && agent == "agent" }
}

struct VisionEngineOption: Decodable, Identifiable, Equatable {
  let slug: String
  let displayName: String
  var id: String { slug }
}

struct LocalVisionModel: Decodable, Identifiable, Equatable {
  let tag: String
  let label: String
  let sizeGb: Double
  let minRamGib: Double
  let fits: Bool
  let installed: Bool
  let recommended: Bool?
  let note: String?
  let accuracy: String?
  let measured: LocalVisionMeasurement?
  let measuredLocally: Bool?
  let custom: Bool?
  var id: String { tag }

  /// Measured on a checked-in benchmark image, not guessed. A caption-only
  /// model fabricates codes and numbers, so the picker has to warn rather than
  /// list it as an equal choice.
  var accuracyLabel: String {
    switch accuracy {
    case "accurate": return "reads text accurately"
    case "partial": return "reads some text"
    case "captions-only": return "captions only — invents text"
    default: return "not benchmarked"
    }
  }

  /// "12/12 text" is the number that actually decides whether a model is safe
  /// to trust; the overall percent also counts shapes and colours.
  var scoreLabel: String? {
    guard let measured else { return nil }
    return "\(measured.textPercent ?? measured.percent)% text"
  }

  var accuracyIsGood: Bool { accuracy == "accurate" }
  var accuracyIsPoor: Bool { accuracy == "captions-only" }
}

struct VisionBridgeSnapshot: Decodable {
  let enabled: Bool
  let engine: String?
  let local: VisionLocalPin?
  let resolvedEngine: String?
  let resolvedEngineName: String?
  let hostMemGib: Double?
  let paidEngines: [VisionEngineOption]
  let localModels: [LocalVisionModel]
  let download: VisionDownloadState?
}

struct VisionLocalPin: Decodable, Equatable {
  let model: String?
}

struct VisionDownloadState: Decodable, Equatable {
  let tag: String?
  let status: String
  let detail: String?
  let percent: Int?
  let error: String?

  var isRunning: Bool { status == "downloading" }
}

struct SubagentSettingsSnapshot: Decodable {
  let mode: String
  let enabled: [String]
  let disabled: [String]
  let all: Bool
}

struct PickerSettingsSnapshot: Decodable {
  let hidden: [String]
}

struct UsageProviderChoice: Identifiable {
  let id: String
  let displayName: String
  let shortName: String
  let detail: String
  let isEnabled: Bool
}

enum TrayPresenceMode: String, CaseIterable, Identifiable {
  case always
  case followCodex

  var id: String { rawValue }
  var label: String {
    switch self {
    case .always: return "Always"
    case .followCodex: return "With Codex"
    }
  }

  // `control presence` spells the modes in the router's kebab-case vocabulary.
  var controlValue: String {
    switch self {
    case .always: return "always"
    case .followCodex: return "follow-codex"
    }
  }
}

// What the tray last asked the background service to do, so a burst of
// workspace notifications does not re-issue a start the router already honored.
enum ServiceIntent {
  case unknown
  case running
  case stopped
}

enum IslandMode: String, CaseIterable, Identifiable {
  case off
  case notch
  case desktop

  var id: String { rawValue }
  var label: String {
    switch self {
    case .off: return "Off"
    case .notch: return "Notch"
    case .desktop: return "Desktop"
    }
  }
}

struct DesktopQuotaRow: Identifiable {
  let id: String
  let providerID: String
  let providerName: String
  let label: String
  let usedPercent: Double
  let resetAt: TimeInterval?
}

struct UsageOverviewCard: Identifiable {
  let id: String
  let provider: UsageProviderChoice
  let metric: ProviderAccountMetric?
  let kindLabel: String?
  let remainingPercent: Double?
  let resetDate: Date?

  var providerID: String { provider.id }
  var title: String { provider.displayName }
}

struct ProviderSetupSnapshot: Decodable {
  let providers: [ProviderSetupState]
}

struct ProviderSetupState: Decodable, Identifiable, Equatable {
  let id: String
  let displayName: String
  let kind: String
  let configured: Bool
  let cliInstalled: Bool?
  let action: String
  // An API provider whose official CLI mints its key through a browser
  // sign-in (Command Code) keeps `kind == "api"` and the key field, and adds
  // these: `signIn` marks the second route, `signedIn` says the key in play
  // came from that session, and `signInAction` is that route's next step.
  let signIn: Bool?
  let signedIn: Bool?
  let signInAction: String?
  // Set when connecting successfully still leaves the account unable to use
  // the API, because its plan does not include one. Shown before the buttons
  // rather than after a 403 lands in Codex.
  let planNote: String?
}

private struct StatusItemLabel: View {
  @ObservedObject var store: RouterStore
  private static let reservedWidth: CGFloat = 180

  var body: some View {
    HStack(spacing: 5) {
      Circle()
        .fill(store.activityState.tint)
        .frame(width: 6, height: 6)
      Text(store.hasConcurrentActivity ? store.activitySummaryLabel : store.selectedUsageProvider.shortName)
        .font(.system(size: 11, weight: .medium, design: .rounded))
        .lineLimit(1)
        .truncationMode(.tail)
      if store.hasConcurrentActivity {
        Text(store.compactActivityProvidersLabel)
          .font(.system(size: 10, weight: .medium, design: .rounded))
          .foregroundStyle(.secondary)
          .lineLimit(1)
          .truncationMode(.tail)
      } else if let usage = store.selectedUsageText {
        Text(usage)
          .font(.system(size: 10, weight: .medium, design: .monospaced))
          .foregroundStyle(.secondary)
          .lineLimit(1)
          .truncationMode(.tail)
      }
    }
    // Keep the NSStatusItem anchor stable while activity text changes.
    .frame(width: Self.reservedWidth, alignment: .leading)
    .clipped()
  }
}

enum TrayTab: String, CaseIterable, Identifiable {
  case usage
  case status
  case settings

  var id: String { rawValue }

  var label: String {
    switch self {
    case .usage: return "Usage"
    case .status: return "Status"
    case .settings: return "Settings"
    }
  }
}

private struct TrayView: View {
  @ObservedObject var store: RouterStore
  @AppStorage("trayTab") private var tab: TrayTab = .usage
  @State private var providersExpanded = true

  private var target: RouterTarget? { store.snapshot.targets["codex"] }
  private var providers: [(id: String, enabled: Bool)] {
    guard let target else { return [] }
    return Dictionary(grouping: target.models.filter { $0.provider != "openai" }, by: \.provider)
      .map { (id: $0.key, enabled: $0.value.contains(where: \.enabled)) }
      .sorted { $0.id < $1.id }
  }

  var body: some View {
    ZStack {
      VisualEffectBlur()
        .ignoresSafeArea()
      VStack(spacing: 0) {
        header
        if let target {
          content(for: target)
        } else if store.isRefreshing {
          ProgressView()
            .controlSize(.small)
            .tint(routerAccent)
            .frame(maxHeight: .infinity)
        } else {
          emptyState
        }
        footer
      }
      .padding(14)
    }
    .preferredColorScheme(.dark)
    .foregroundStyle(.primary)
    .task { await store.refresh() }
  }


  private var header: some View {
    HStack(alignment: .center, spacing: 12) {
      VStack(alignment: .leading, spacing: 3) {
        Text("Model Router")
          .font(.system(size: 15, weight: .semibold))
        Text(accountLabel)
          .font(.system(size: 10, weight: .regular))
          .foregroundStyle(routerMuted)
      }
      Spacer()
      StatusBeacon(state: store.activityState)
    }
    .padding(.bottom, 12)
  }

  private var accountLabel: String {
    if !store.selectedUsageUsesChatGPT {
      guard let provider = store.selectedProviderUsage else { return store.selectedUsageProvider.detail }
      return "\(provider.displayName) · \(provider.credentialType.uppercased())"
    }
    guard let plan = store.accountUsage?.planType else { return "Codex account" }
    return "ChatGPT \(plan.capitalized)"
  }

  private func content(for target: RouterTarget) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Picker("", selection: $tab) {
        ForEach(TrayTab.allCases) { item in
          Text(item.label).tag(item)
        }
      }
      .pickerStyle(.segmented)
      .labelsHidden()

      ScrollView(showsIndicators: false) {
        VStack(alignment: .leading, spacing: 14) {
          switch tab {
          case .usage: usageTab
          case .status: statusTab
          case .settings: settingsTab(for: target)
          }
        }
        .padding(.vertical, 1)
      }
    }
  }

  @ViewBuilder
  private var usageTab: some View {
    if store.visibleUsageProviders.isEmpty && store.overallModelUsage.isEmpty {
      emptyNotice("No usage recorded yet")
    }
    if !store.visibleUsageProviders.isEmpty {
      sectionLabel("Current usage", detail: store.selectedUsageProvider.displayName)
      ProviderUsageSection(store: store)
        .id(store.selectedUsageProviderID)
      sectionLabel("All usage", detail: "7-day snapshot")
      AllProviderUsageGrid(store: store)
    }
    if !store.overallModelUsage.isEmpty {
      sectionLabel(
        "Tokens by model",
        detail: "\(compactTokenCount(Double(store.overallTokenTotal))) tok · \(store.overallRequestTotal) req"
      )
      ModelUsageBreakdown(store: store)
    }
  }

  @ViewBuilder
  private var statusTab: some View {
    sectionLabel("Router", detail: store.activitySummaryLabel)
    HStack(spacing: 8) {
      Circle()
        .fill(store.activityState.tint)
        .frame(width: 7, height: 7)
      VStack(alignment: .leading, spacing: 2) {
        Text(store.activityState.label)
          .font(.system(size: 12, weight: .medium))
        Text(activityDetail)
          .font(.system(size: 9))
          .foregroundStyle(routerMuted)
      }
      Spacer()
    }

    sectionLabel(
      "Live requests",
      detail: store.activeRequests.isEmpty ? "None" : "\(store.activeRequests.count)"
    )
    if store.activeRequests.isEmpty {
      emptyNotice("Nothing in flight")
    } else {
      VStack(spacing: 6) {
        ForEach(store.activeRequests) { request in
          HStack(spacing: 6) {
            Text(store.modelLabel(for: request))
              .font(.system(size: 10, weight: .medium))
              .lineLimit(1)
            Text(store.displayName(forProvider: request.provider))
              .font(.system(size: 8))
              .foregroundStyle(routerMuted)
              .lineLimit(1)
            Spacer(minLength: 6)
            Text(elapsedLabel(for: request))
              .font(.system(size: 10))
              .monospacedDigit()
              .foregroundStyle(routerMuted)
          }
        }
      }
    }

    if !quotaResets.isEmpty {
      sectionLabel("Quota resets", detail: "\(quotaResets.count)")
      VStack(spacing: 5) {
        ForEach(quotaResets, id: \.id) { entry in
          HStack {
            Text(entry.title)
              .font(.system(size: 10, weight: .medium))
              .lineLimit(1)
            Spacer(minLength: 6)
            Text(usageResetCaption(entry.date))
              .font(.system(size: 9))
              .foregroundStyle(routerMuted)
          }
        }
      }
    }
  }

  private var quotaResets: [(id: String, title: String, date: Date)] {
    store.visibleUsageCards.compactMap { card in
      guard let date = card.resetDate else { return nil }
      return (id: card.id, title: card.title, date: date)
    }
  }

  private var activityDetail: String {
    guard store.activeRequestCount > 0 else { return "No traffic right now" }
    let chats = store.activeChatCount
    let requests = store.activeRequestCount
    return "\(chats) chat\(chats == 1 ? "" : "s") · \(requests) request\(requests == 1 ? "" : "s") in flight"
  }

  // `startedAt` arrives as epoch milliseconds from the router health payload.
  private func elapsedLabel(for request: RouterActiveRequest) -> String {
    let elapsed = max(0, Date().timeIntervalSince1970 - request.startedAt / 1_000)
    if elapsed >= 60 {
      return String(format: "%dm %02ds", Int(elapsed) / 60, Int(elapsed) % 60)
    }
    return String(format: "%.1fs", elapsed)
  }

  private func emptyNotice(_ text: String) -> some View {
    Text(text)
      .font(.system(size: 10))
      .foregroundStyle(routerMuted)
      .padding(.vertical, 2)
  }

  @ViewBuilder
  private func settingsTab(for target: RouterTarget) -> some View {
    HStack(spacing: 12) {
      VStack(alignment: .leading, spacing: 3) {
        Text("Show tray")
          .font(.system(size: 12, weight: .medium))
        Text(store.presenceMode == .followCodex
          ? "Appears with Codex or ChatGPT, hides when they quit"
          : "Menu bar icon stays visible")
          .font(.system(size: 10))
          .foregroundStyle(.secondary)
      }
      Spacer()
      Picker("", selection: Binding(
        get: { store.presenceMode },
        set: { store.setPresenceMode($0) }
      )) {
        ForEach(TrayPresenceMode.allCases) { mode in
          Text(mode.label).tag(mode)
        }
      }
      .pickerStyle(.segmented)
      .labelsHidden()
      .frame(width: 168)
    }
    .padding(.vertical, 2)
    HStack(spacing: 12) {
      VStack(alignment: .leading, spacing: 3) {
        Text("Dynamic Island")
          .font(.system(size: 12, weight: .medium))
        Text(store.islandMode == .desktop
          ? "Quotas and live activity pinned to the desktop"
          : "Show provider usage and activity status")
          .font(.system(size: 10))
          .foregroundStyle(.secondary)
      }
      Spacer()
      Picker("", selection: Binding(
        get: { store.islandMode },
        set: { store.setIslandMode($0) }
      )) {
        ForEach(IslandMode.allCases) { mode in
          Text(mode.label).tag(mode)
        }
      }
      .pickerStyle(.segmented)
      .labelsHidden()
      .frame(width: 168)
    }
    .padding(.vertical, 2)
    settingRow(
      title: "Use without OpenAI login",
      detail: store.loginFree
        ? "External providers · Codex restarts automatically"
        : "Use connected models and restart Codex",
      isOn: Binding(
        get: { store.loginFree },
        set: { enabled in Task { await store.setLoginFree(enabled) } }
      ),
      isDisabled: store.providerOperation != nil
    )
    maintenanceRow
    AccordionPanel(
      title: "Providers",
      summary: store.providerOperation == nil ? "Auto-saved" : "Applying…",
      expanded: $providersExpanded
    ) {
      VStack(spacing: 0) {
        ForEach(providers, id: \.id) { provider in
          ProviderSetupRow(
            provider: provider,
            setup: store.providerSetup[provider.id],
            account: store.providerUsage(for: provider.id)?.account,
            isBusy: store.providerOperation == provider.id,
            controlsDisabled: store.providerOperation != nil,
            onToggle: { enabled in
              Task { await store.setProvider(provider.id, enabled: enabled) }
            },
            onConnect: { Task { await store.connectProvider(provider.id) } },
            onLogin: { Task { await store.loginProvider(provider.id) } },
            onSaveKey: { key in Task { await store.saveProviderKey(provider.id, key: key) } },
            onRemoveKey: { Task { await store.removeProviderKey(provider.id) } }
          )
          if provider.id != providers.last?.id {
            Divider()
          }
        }
      }
    }
    ModelSettingsAccordion(store: store, target: target)
  }

  private struct ModelSettingsAccordion: View {
    @ObservedObject var store: RouterStore
    let target: RouterTarget
    @State private var subagentsExpanded = true
    @State private var pickerExpanded = true
    @State private var visionExpanded = true
    @State private var localModelsExpanded = false
    @State private var localLlmExpanded = false
    @State private var installTag = ""
    @State private var armedRemoval: String?
    @State private var customTag = ""
    @State private var collapsedProviders = Set<String>()

    private struct ProviderModels: Identifiable {
      let provider: String
      let models: [RouterModel]
      var id: String { provider }
    }

    private var settings: ModelSettingsSnapshot? { target.modelSettings }
    private var busy: Bool { store.providerOperation == "models" }

    private var enabledExternalModels: [RouterModel] {
      target.models
        .filter { $0.enabled && $0.provider != "openai" && $0.visible != false }
        .sorted {
          if $0.provider != $1.provider { return $0.provider < $1.provider }
          return $0.slug < $1.slug
        }
    }

    private var enabledModels: [RouterModel] {
      target.models
        .filter(\.enabled)
        .sorted {
          if $0.provider != $1.provider { return $0.provider < $1.provider }
          return $0.slug < $1.slug
        }
    }

    private func providerGroups(_ models: [RouterModel]) -> [ProviderModels] {
      Dictionary(grouping: models, by: \.provider)
        .map { ProviderModels(provider: $0.key, models: $0.value.sorted { $0.slug < $1.slug }) }
        .sorted { $0.provider < $1.provider }
    }

    private func providerName(_ id: String) -> String {
      if id == "openai" { return "OpenAI" }
      return target.providers?.first(where: { $0.id == id })?.displayName ?? id
    }

    private func providerBinding(_ provider: String) -> Binding<Bool> {
      Binding(
        get: { !collapsedProviders.contains(provider) },
        set: { expanded in
          if expanded {
            collapsedProviders.remove(provider)
          } else {
            collapsedProviders.insert(provider)
          }
        }
      )
    }

    var body: some View {
      VStack(alignment: .leading, spacing: 10) {
        AccordionPanel(
          title: "Subagent models",
          summary: subagentSummary,
          expanded: $subagentsExpanded
        ) {
          VStack(alignment: .leading, spacing: 8) {
            toggleRow(
              title: "All selected models",
              detail: settings?.subagents.mode == "all"
                ? "Every enabled model can run as a subagent"
                : "Only selected models can run as subagents",
              isOn: Binding(
                get: { settings?.subagents.mode == "all" },
                set: { enabled in
                  let current = settings?.subagents
                  let mode = enabled
                    ? "all"
                    : current?.enabled.isEmpty == false ? "selected" : "proven"
                  Task { await store.setSubagentMode(mode) }
                }
              ),
              disabled: busy
            )
            toolbar(
              buttons: [
                ("Select all", { Task { await store.selectAllSubagents() } }),
                ("Unselect all", { Task { await store.unselectAllSubagents() } }),
              ]
            )
            ForEach(providerGroups(enabledExternalModels)) { group in
              AccordionPanel(
                title: providerName(group.provider),
                summary: "\(group.models.count) models",
                expanded: providerBinding(group.provider)
              ) {
                VStack(alignment: .leading, spacing: 6) {
                  ForEach(group.models) { model in
                    toggleRow(
                      title: model.displayName,
                      detail: subagentDetail(for: model),
                      isOn: Binding(
                        get: { isSubagent(model) },
                        set: { enabled in
                          Task { await store.setSubagentModel(model.slug, enabled: enabled) }
                        }
                      ),
                      disabled: busy
                    )
                  }
                }
              }
            }
          }
        }

        AccordionPanel(
          title: "Model picker",
          summary: pickerSummary,
          expanded: $pickerExpanded
        ) {
          VStack(alignment: .leading, spacing: 8) {
            Text("Hidden models stay connected but are not offered by Codex.")
              .font(.system(size: 9))
              .foregroundStyle(routerMuted)
            toolbar(
              buttons: [
                ("Show all", { Task { await store.showAllPickerModels() } }),
                ("Hide all", { Task { await store.hideAllPickerModels() } }),
              ]
            )
            ForEach(providerGroups(enabledModels)) { group in
              AccordionPanel(
                title: providerName(group.provider),
                summary: "\(group.models.count) models",
                expanded: providerBinding(group.provider)
              ) {
                VStack(alignment: .leading, spacing: 6) {
                  ForEach(group.models) { model in
                    toggleRow(
                      title: model.displayName,
                      detail: model.slug,
                      isOn: Binding(
                        get: { !hiddenModels.contains(model.slug) },
                        set: { visible in
                          Task { await store.setPickerModel(model.slug, visible: visible) }
                        }
                      ),
                      disabled: busy
                    )
                  }
                }
              }
            }
          }
        }

        AccordionPanel(
          title: "Local LLMs",
          summary: localLlmSummary,
          expanded: $localLlmExpanded
        ) {
          localLlmPanel
        }

        AccordionPanel(
          title: "Vision for text-only models",
          summary: visionSummary,
          expanded: $visionExpanded
        ) {
          visionPanel
        }
      }
    }

    // Everything installed through Ollama, in one place: check the ones to keep
    // available, install more by tag, remove the ones eating disk. Checking a
    // model is not the same as downloading it and not the same as deleting it,
    // so the three actions stay visibly separate.
    @ViewBuilder private var localLlmPanel: some View {
      VStack(alignment: .leading, spacing: 8) {
        Text("Models running on this Mac through Ollama. Checked models stay available to the router.")
          .font(.system(size: 9))
          .foregroundStyle(routerMuted)
        if (localModels?.models ?? []).isEmpty {
          Text("Nothing installed yet. Add one below, or install Ollama first.")
            .font(.system(size: 9))
            .foregroundStyle(routerMutedStrong)
        }
        ForEach(localModels?.models ?? []) { model in
          installedLocalRow(model)
        }
        Divider().padding(.vertical, 2)
        HStack(spacing: 6) {
          TextField("Install by tag, e.g. gemma3:4b", text: $installTag)
            .textFieldStyle(.roundedBorder)
            .font(.system(size: 10))
            .disabled(busy || store.visionDownload?.isRunning == true)
            .onSubmit { submitInstall() }
          Button("Install") { submitInstall() }
            .buttonStyle(.borderless)
            .font(.system(size: 9, weight: .medium))
            .foregroundStyle(canInstall ? routerMint : routerMutedStrong)
            .disabled(!canInstall)
        }
        if let download = store.visionDownload, download.isRunning {
          HStack(spacing: 6) {
            ProgressView(value: Double(download.percent ?? 0), total: 100)
              .progressViewStyle(.linear)
              .tint(routerMint)
            Text("\(download.tag ?? "") \(download.percent ?? 0)%")
              .font(.system(size: 9, weight: .medium))
              .foregroundStyle(routerMint)
              .monospacedDigit()
          }
        }
      }
    }

    @ViewBuilder private func installedLocalRow(_ model: InstalledLocalModel) -> some View {
      HStack(spacing: 10) {
        Toggle("", isOn: Binding(
          get: { model.enabled },
          set: { on in Task { await store.setLocalModelEnabled(model.tag, enabled: on) } }
        ))
        .labelsHidden()
        .toggleStyle(.checkbox)
        .controlSize(.mini)
        .disabled(busy)
        VStack(alignment: .leading, spacing: 2) {
          HStack(spacing: 6) {
            Text(model.tag)
              .font(.system(size: 11, weight: .medium))
              .lineLimit(1)
            if model.running {
              Text("loaded").font(.system(size: 8, weight: .medium)).foregroundStyle(routerMint)
            }
          }
          HStack(spacing: 6) {
            Text(String(format: "%.1f GB", model.sizeGb))
              .font(.system(size: 9))
              .foregroundStyle(routerMutedStrong)
            // The two roles a local model can fill, stated separately: one
            // model may be good at reading images and useless as an agent.
            if model.vision {
              Text("reads images").font(.system(size: 9)).foregroundStyle(routerMint)
            }
            Text(model.chatRoleLabel)
              .font(.system(size: 9))
              .foregroundStyle(model.chatRoleGood ? routerMint : routerYellow)
            if let accuracy = model.accuracy {
              Text(accuracy)
                .font(.system(size: 9))
                .foregroundStyle(accuracy == "accurate" ? routerMint : routerRed)
            }
          }
        }
        Spacer()
        // The vision role is chosen per model, independently of whether it is
        // offered to Codex as a chat model: the best image reader here cannot
        // call tools, and the best agent cannot see.
        if model.vision {
          if isVisionEngine(model) {
            Text("reading images")
              .font(.system(size: 9, weight: .medium))
              .foregroundStyle(routerMint)
          } else {
            Button("Use for vision") { Task { await store.useLocalVisionModel(model.tag) } }
              .buttonStyle(.borderless)
              .font(.system(size: 9))
              .foregroundStyle(routerMint)
              .disabled(busy)
          }
        }
        // Two-step, because this deletes gigabytes and there is no undo.
        if armedRemoval == model.tag {
          Button("Confirm") {
            armedRemoval = nil
            Task { await store.uninstallLocalModel(model.tag) }
          }
          .buttonStyle(.borderless)
          .font(.system(size: 9, weight: .medium))
          .foregroundStyle(routerRed)
          .disabled(busy)
        } else {
          Button("Remove") { armedRemoval = model.tag }
            .buttonStyle(.borderless)
            .font(.system(size: 9))
            .foregroundStyle(routerMutedStrong)
            .disabled(busy)
        }
      }
      .padding(.horizontal, 2)
    }

    private var localModels: LocalModelsSnapshot? { settings?.localModels }

    private func isVisionEngine(_ model: InstalledLocalModel) -> Bool {
      vision?.engine == "local" && vision?.local?.model == model.tag
    }

    private var localLlmSummary: String {
      guard let localModels, localModels.installed > 0 else { return "none installed" }
      let chat = localModels.usableAsChat ?? 0
      return "\(localModels.installed) installed · \(chat) for Codex · \(String(format: "%.1f", localModels.totalGb)) GB"
    }

    private var canInstall: Bool {
      !busy && store.visionDownload?.isRunning != true
        && !installTag.trimmingCharacters(in: .whitespaces).isEmpty
    }

    private func submitInstall() {
      let tag = installTag.trimmingCharacters(in: .whitespaces)
      guard canInstall else { return }
      installTag = ""
      Task { await store.downloadLocalVisionModel(tag) }
    }

    // Lets a text-only model (DeepSeek, GLM, ...) answer about a pasted image by
    // having a vision model read it. The engine defaults to an enabled paid
    // model; the operator can switch to a local model once it is downloaded in
    // the picker below. Everything maps to a `control vision-bridge` command, so
    // the tray never needs the agent.
    @ViewBuilder private var visionPanel: some View {
      VStack(alignment: .leading, spacing: 8) {
        Text("Text-only models can't see images. When on, a vision model reads the paste and hands over the text.")
          .font(.system(size: 9))
          .foregroundStyle(routerMuted)
        toggleRow(
          title: "Read images for text-only models",
          detail: vision?.enabled == true
            ? "Reading via \(currentEngineLabel)"
            : "Off — text-only models refuse pasted images",
          isOn: Binding(
            get: { vision?.enabled == true },
            set: { on in Task { await store.setVisionBridgeEnabled(on) } }
          ),
          disabled: busy
        )
        if vision?.enabled == true {
          HStack(spacing: 8) {
            Text("Engine")
              .font(.system(size: 11, weight: .medium))
            Spacer()
            engineMenu
          }
          .padding(.horizontal, 2)

          AccordionPanel(
            title: "Local models",
            summary: localModelsSummary,
            expanded: $localModelsExpanded
          ) {
            localModelsList
          }
        }
      }
    }

    @ViewBuilder private var engineMenu: some View {
      Menu {
        Button("Auto · cheapest paid model") {
          Task { await store.setVisionBridgeEngine("auto") }
        }
        if !(vision?.paidEngines ?? []).isEmpty {
          Section("Paid (cloud)") {
            ForEach(vision?.paidEngines ?? []) { option in
              Button(option.displayName) {
                Task { await store.setVisionBridgeEngine(option.slug) }
              }
            }
          }
        }
        let installedLocal = (vision?.localModels ?? []).filter(\.installed)
        if !installedLocal.isEmpty {
          Section("Local (downloaded)") {
            ForEach(installedLocal) { model in
              Button("\(model.label) · local") {
                Task { await store.useLocalVisionModel(model.tag) }
              }
            }
          }
        }
      } label: {
        HStack(spacing: 4) {
          Text(currentEngineLabel).lineLimit(1)
          Image(systemName: "chevron.up.chevron.down").font(.system(size: 8))
        }
        .font(.system(size: 10, weight: .medium))
        .foregroundStyle(routerMint)
      }
      .menuStyle(.borderlessButton)
      .fixedSize()
      .disabled(busy)
    }

    // The downloadable picker. Each row shows size and whether it fits this
    // machine's memory, so the choice is informed before the download starts.
    @ViewBuilder private var localModelsList: some View {
      VStack(alignment: .leading, spacing: 6) {
        Text("Free, private, offline. Downloads run through Ollama.")
          .font(.system(size: 9))
          .foregroundStyle(routerMuted)
        ForEach(vision?.localModels ?? []) { model in
          localModelRow(model)
        }
        Divider().padding(.vertical, 2)
        // The curated list is deliberately short and benchmarked, so this is
        // the escape hatch: any Ollama tag, including `hf.co/user/repo:quant`.
        // Unlisted models carry no accuracy claim -- the operator chose them.
        VStack(alignment: .leading, spacing: 4) {
          Text("Any other Ollama model")
            .font(.system(size: 10, weight: .medium))
          HStack(spacing: 6) {
            TextField("e.g. minicpm-v or hf.co/user/repo:Q4_K_M", text: $customTag)
              .textFieldStyle(.roundedBorder)
              .font(.system(size: 10))
              .disabled(busy || vision?.download?.isRunning == true)
              .onSubmit { submitCustomTag() }
            Button("Add") { submitCustomTag() }
              .buttonStyle(.borderless)
              .font(.system(size: 9, weight: .medium))
              .foregroundStyle(canSubmitCustomTag ? routerMint : routerMutedStrong)
              .disabled(!canSubmitCustomTag)
          }
          Text("Downloads it if needed, then uses it. Not benchmarked — check its reading yourself.")
            .font(.system(size: 9))
            .foregroundStyle(routerMuted)
        }
      }
    }

    private var canSubmitCustomTag: Bool {
      !busy && vision?.download?.isRunning != true
        && !customTag.trimmingCharacters(in: .whitespaces).isEmpty
    }

    private func submitCustomTag() {
      let tag = customTag.trimmingCharacters(in: .whitespaces)
      guard canSubmitCustomTag else { return }
      customTag = ""
      Task { await store.downloadLocalVisionModel(tag) }
    }

    @ViewBuilder private func localModelRow(_ model: LocalVisionModel) -> some View {
      HStack(spacing: 10) {
        VStack(alignment: .leading, spacing: 2) {
          HStack(spacing: 6) {
            Text(model.label)
              .font(.system(size: 11, weight: .medium))
              .lineLimit(1)
            if model.recommended == true {
              Text("recommended")
                .font(.system(size: 8, weight: .medium))
                .foregroundStyle(routerMint)
            }
          }
          HStack(spacing: 6) {
            Text(String(format: "%.1f GB", model.sizeGb))
              .font(.system(size: 9))
              .foregroundStyle(routerMutedStrong)
            Text(model.fits ? "fits your Mac" : "needs \(Int(model.minRamGib)) GB RAM")
              .font(.system(size: 9))
              .foregroundStyle(model.fits ? routerMint : routerYellow)
            Text("·").font(.system(size: 9)).foregroundStyle(routerMuted)
            Text(model.accuracyLabel)
              .font(.system(size: 9))
              .foregroundStyle(
                model.accuracyIsGood
                  ? routerMint
                  : model.accuracyIsPoor ? routerRed : routerMutedStrong
              )
            if let score = model.scoreLabel {
              Text(model.measuredLocally == true ? "\(score) here" : score)
                .font(.system(size: 9))
                .foregroundStyle(routerMuted)
            }
          }
        }
        Spacer()
        localModelAction(model)
      }
      .padding(.horizontal, 2)
    }

    @ViewBuilder private func localModelAction(_ model: LocalVisionModel) -> some View {
      let download = store.visionDownload
      let downloadingThis = download?.isRunning == true && download?.tag == model.tag
      if downloadingThis {
        // A percentage is the whole point of the async path: a multi-gigabyte
        // pull that shows nothing reads as a hang.
        HStack(spacing: 6) {
          ProgressView(value: Double(download?.percent ?? 0), total: 100)
            .progressViewStyle(.linear)
            .tint(routerMint)
            .frame(width: 54)
          Text("\(download?.percent ?? 0)%")
            .font(.system(size: 9, weight: .medium))
            .foregroundStyle(routerMint)
            .monospacedDigit()
        }
      } else if model.installed {
        HStack(spacing: 8) {
          // Any installed model can be measured here, so a downloaded model is
          // never stuck reading "not benchmarked" with no way to fix it.
          if store.benchmarkingTag == model.tag {
            Text("testing…")
              .font(.system(size: 9, weight: .medium))
              .foregroundStyle(routerYellow)
          } else {
            Button("Test") { Task { await store.benchmarkLocalVisionModel(model.tag) } }
              .buttonStyle(.borderless)
              .font(.system(size: 9))
              .foregroundStyle(routerMutedStrong)
              .disabled(busy || store.benchmarkingTag != nil)
          }
          if isCurrentLocal(model) {
            Text("in use")
              .font(.system(size: 9, weight: .medium))
              .foregroundStyle(routerMint)
          } else {
            Button("Use") { Task { await store.useLocalVisionModel(model.tag) } }
              .buttonStyle(.borderless)
              .font(.system(size: 9, weight: .medium))
              .foregroundStyle(routerMint)
              .disabled(busy)
          }
        }
      } else {
        Button("Download") {
          Task { await store.downloadLocalVisionModel(model.tag) }
        }
        .buttonStyle(.borderless)
        .font(.system(size: 9, weight: .medium))
        .foregroundStyle(model.fits ? routerMint : routerMutedStrong)
        // Only one pull at a time; other rows stay clickable otherwise.
        .disabled(busy || download?.isRunning == true)
      }
    }

    private var vision: VisionBridgeSnapshot? { settings?.visionBridge }

    private func isCurrentLocal(_ model: LocalVisionModel) -> Bool {
      vision?.engine == "local" && vision?.local?.model == model.tag
    }

    private var currentEngineLabel: String {
      guard let vision else { return "none" }
      if vision.engine == "local" {
        return "Local · \(vision.local?.model ?? "model")"
      }
      if vision.engine == nil {
        return "Auto · \(vision.resolvedEngineName ?? vision.resolvedEngine ?? "none")"
      }
      return vision.resolvedEngineName ?? vision.resolvedEngine ?? vision.engine ?? "none"
    }

    private var localModelsSummary: String {
      let models = vision?.localModels ?? []
      let installed = models.filter(\.installed).count
      return "\(installed) downloaded · \(models.count) available"
    }

    private var visionSummary: String {
      guard let vision, vision.enabled else { return "off" }
      return currentEngineLabel
    }

    private var hiddenModels: Set<String> {
      Set(settings?.picker.hidden ?? [])
    }

    private var enabledSubagentSet: Set<String> {
      Set(settings?.subagents.enabled ?? [])
    }

    private var disabledSubagentSet: Set<String> {
      Set(settings?.subagents.disabled ?? [])
    }

    private func isSubagent(_ model: RouterModel) -> Bool {
      if disabledSubagentSet.contains(model.slug) { return false }
      switch settings?.subagents.mode ?? "proven" {
      case "all":
        return true
      case "selected":
        return model.multiAgentVersion == "v2" || enabledSubagentSet.contains(model.slug)
      default:
        return model.multiAgentVersion == "v2"
      }
    }

    private func subagentDetail(for model: RouterModel) -> String {
      if isSubagent(model) {
        return model.multiAgentVersion == "v2" ? "Proven v2" : "Subagent"
      }
      return "Not selected"
    }

    private var subagentSummary: String {
      let count = enabledExternalModels.filter { isSubagent($0) }.count
      return "\(count) enabled · \(settings?.subagents.mode ?? "proven")"
    }

    private var pickerSummary: String {
      let visible = enabledModels.filter { !hiddenModels.contains($0.slug) }.count
      return "\(visible) visible · \(hiddenModels.count) hidden"
    }

    private func toggleRow(
      title: String,
      detail: String,
      isOn: Binding<Bool>,
      disabled: Bool
    ) -> some View {
      HStack(spacing: 12) {
        VStack(alignment: .leading, spacing: 2) {
          Text(title)
            .font(.system(size: 11, weight: .medium))
            .lineLimit(1)
          Text(detail)
            .font(.system(size: 9))
            .foregroundStyle(routerMutedStrong)
            .lineLimit(1)
        }
        Spacer()
        Toggle("", isOn: isOn)
          .labelsHidden()
          .toggleStyle(.switch)
          .controlSize(.mini)
          .tint(routerMint)
          .disabled(disabled)
      }
      .padding(.horizontal, 2)
    }

    private func toolbar(
      buttons: [(String, () -> Void)]
    ) -> some View {
      HStack {
        Spacer()
        ForEach(Array(buttons.enumerated()), id: \.offset) { _, entry in
          Button(entry.0, action: entry.1)
            .buttonStyle(.borderless)
            .font(.system(size: 9, weight: .medium))
            .foregroundStyle(routerMint)
            .disabled(busy)
        }
      }
    }
  }

  private struct AccordionPanel<Content: View>: View {
    let title: String
    let summary: String
    @Binding var expanded: Bool
    @ViewBuilder var content: () -> Content

    var body: some View {
      VStack(spacing: 0) {
        Button(action: {
          withAnimation(.easeInOut(duration: 0.16)) {
            expanded.toggle()
          }
        }) {
          HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
              Text(title)
                .font(.system(size: 12, weight: .medium))
                .lineLimit(1)
              if !summary.isEmpty {
                Text(summary)
                  .font(.system(size: 9))
                  .foregroundStyle(routerMutedStrong)
                  .lineLimit(1)
              }
            }
            Spacer()
            Image(systemName: expanded ? "chevron.down" : "chevron.right")
              .font(.system(size: 10, weight: .semibold))
              .foregroundStyle(routerMuted)
              .frame(width: 14)
          }
          .padding(10)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)

        if expanded {
          content()
            .padding(.horizontal, 10)
            .padding(.bottom, 10)
        }
      }
      .background(
        Color.primary.opacity(0.045),
        in: RoundedRectangle(cornerRadius: 10, style: .continuous)
      )
    }
  }

  private func sectionLabel(_ title: String, detail: String) -> some View {
    HStack {
      Text(title)
        .font(.system(size: 11, weight: .medium))
        .foregroundStyle(.secondary)
      Spacer()
      Text(detail)
        .font(.system(size: 9, weight: .regular))
        .foregroundStyle(routerMuted)
    }
    .padding(.horizontal, 2)
    .padding(.top, 1)
  }

  private func settingRow(
    title: String,
    detail: String,
    isOn: Binding<Bool>,
    isDisabled: Bool = false
  ) -> some View {
    HStack(spacing: 12) {
      VStack(alignment: .leading, spacing: 3) {
        Text(title)
          .font(.system(size: 12, weight: .medium))
        Text(detail)
          .font(.system(size: 9))
          .foregroundStyle(routerMuted)
      }
      Spacer()
      Toggle("", isOn: isOn)
        .labelsHidden()
        .toggleStyle(.switch)
        .controlSize(.small)
        .tint(routerMint)
        .disabled(isDisabled)
    }
    .padding(.vertical, 1)
  }

  private var maintenanceRow: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 12) {
        Text(maintenanceStatus)
          .font(.system(size: 10, weight: .medium))
          .foregroundStyle(
            store.maintenanceMessage == nil
              ? routerMutedStrong
              : store.maintenanceSucceeded
                ? routerMint
                : store.maintenanceRunning
                  ? routerAccent
                  : routerRed
          )
          .lineLimit(2)
        Spacer(minLength: 8)
        if store.maintenanceRunning {
          ProgressView()
            .controlSize(.small)
            .tint(routerAccent)
            .frame(width: 94)
            .accessibilityLabel("Running Codex Router maintenance")
        } else {
          Button {
            Task { await store.updateAndVerify() }
          } label: {
            Label("Update", systemImage: "arrow.triangle.2.circlepath")
          }
          .buttonStyle(AccentButtonStyle())
          .disabled(store.providerOperation != nil)
          .opacity(store.providerOperation == nil ? 1 : 0.5)
          .help("Apply the checked-out router revision, then run the Codex doctor")
          .accessibilityLabel("Update and verify Codex Router")
          Button {
            Task { await store.fixAndVerify() }
          } label: {
            Label("Fix", systemImage: "wrench.and.screwdriver")
          }
          .buttonStyle(AccentButtonStyle())
          .disabled(store.providerOperation != nil)
          .opacity(store.providerOperation == nil ? 1 : 0.5)
          .help("Run the Codex doctor and repair managed router files")
          .accessibilityLabel("Fix Codex Router installation")
        }
      }
      if maintenanceFailed {
        Text(maintenanceHint)
          .font(.system(size: 9))
          .foregroundStyle(routerRed.opacity(0.9))
          .lineLimit(3)
      }
    }
    .padding(10)
    .background(
      Color.primary.opacity(0.045),
      in: RoundedRectangle(cornerRadius: 10, style: .continuous)
    )
  }

  private var maintenanceStatus: String {
    if store.maintenanceRunning {
      return "Working…"
    }
    if store.maintenanceSucceeded {
      return store.maintenanceMessage ?? "All good"
    }
    if maintenanceFailed {
      return "Update or fix failed"
    }
    return store.maintenanceMessage ?? "Router ready"
  }

  private var maintenanceFailed: Bool {
    store.maintenanceMessage != nil &&
      !store.maintenanceSucceeded &&
      !store.maintenanceRunning
  }

  private var maintenanceHint: String {
    guard let message = store.maintenanceMessage else { return "" }
    return "\(message)\nIf this keeps failing, run ./bin/support-bundle and share the path."
  }

  private var emptyState: some View {
    VStack(spacing: 10) {
      Text("Router unavailable")
        .font(.system(size: 13, weight: .semibold))
      Text("Run setup, then refresh this panel.")
        .font(.system(size: 11))
        .foregroundStyle(routerMuted)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private var footer: some View {
    HStack(spacing: 9) {
      Button(store.isRefreshing ? "Refreshing…" : "Refresh") {
        Task {
          await store.refresh()
          await store.refreshAccountUsage()
          await store.refreshProviderUsage()
          await store.refreshProviderSetup()
        }
      }
      .buttonStyle(.plain)
      .font(.system(size: 11, weight: .medium))
      .foregroundStyle(routerAccent)
      .disabled(store.isRefreshing)

      if let message = store.message {
        Text(message)
          .lineLimit(1)
          .font(.system(size: 10))
          .foregroundStyle(Color(red: 1, green: 0.61, blue: 0.52))
      } else {
        Spacer()
        Text(store.lastUpdated.map { "Updated \($0.formatted(date: .omitted, time: .shortened))" } ?? "Awaiting data")
          .font(.system(size: 10, weight: .regular))
          .foregroundStyle(routerMuted)
      }

      Button("Quit") { NSApp.terminate(nil) }
        .buttonStyle(.plain)
        .font(.system(size: 11, weight: .medium))
        .foregroundStyle(routerMuted)
    }
    .padding(.top, 10)
  }

}

private struct ProviderSetupRow: View {
  let provider: (id: String, enabled: Bool)
  let setup: ProviderSetupState?
  let account: ProviderAccountUsage?
  let isBusy: Bool
  let controlsDisabled: Bool
  let onToggle: (Bool) -> Void
  let onConnect: () -> Void
  let onLogin: () -> Void
  let onSaveKey: (String) -> Void
  let onRemoveKey: () -> Void

  @State private var showingKeyField = false
  @State private var apiKey = ""
  // A sheet or confirmation dialog resigns key and closes the menu bar popover
  // before it can be answered, so removal is confirmed by arming the button.
  @State private var removalArmed = false
  @State private var armGeneration = 0

  var body: some View {
    VStack(alignment: .leading, spacing: 9) {
      HStack(spacing: 10) {
        VStack(alignment: .leading, spacing: 2) {
          Text(setup?.displayName ?? provider.id)
            .font(.system(size: 12, weight: .medium))
          Text(detail)
            .font(.system(size: 9, weight: .regular))
            .foregroundStyle(detailTint)
        }
        Spacer()
        actionControl
      }

      if let planNote = setup?.planNote {
        HStack(alignment: .top, spacing: 5) {
          Image(systemName: "creditcard")
            .font(.system(size: 9, weight: .semibold))
          Text(planNote)
            .font(.system(size: 9))
            .fixedSize(horizontal: false, vertical: true)
        }
        .foregroundStyle(routerYellow.opacity(0.9))
      }

      if showingKeyField, setup?.kind == "api" {
        VStack(alignment: .leading, spacing: 5) {
          Text(setup?.configured == true ? "Replacement API key" : "API key")
            .font(.system(size: 9, weight: .medium))
            .foregroundStyle(routerMuted)
          HStack(spacing: 7) {
            SecureField("Paste key", text: $apiKey)
              .textFieldStyle(.plain)
              .font(.system(size: 11, design: .monospaced))
              .padding(.horizontal, 9)
              .padding(.vertical, 7)
              .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 6))
            Button("Save") {
              let key = apiKey
              apiKey = ""
              showingKeyField = false
              onSaveKey(key)
            }
            .buttonStyle(AccentButtonStyle())
            .disabled(apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          }
        }
        .transition(.opacity.combined(with: .move(edge: .top)))
      }
    }
    .padding(.vertical, 7)
    .animation(.easeOut(duration: 0.18), value: showingKeyField)
    .animation(.easeOut(duration: 0.15), value: removalArmed)
    .onChange(of: setup?.configured) { configured in
      if configured == true {
        apiKey = ""
        showingKeyField = false
        disarmRemoval()
      }
    }
  }

  private var detailTint: Color {
    if removalArmed { return routerRed }
    return setup?.configured == true ? routerMuted : routerYellow.opacity(0.9)
  }

  private var detail: String {
    if removalArmed { return "Click the check again to delete this key" }
    guard let setup else { return "Checking setup…" }
    if oauthNeedsReconnect {
      return "Session expired · reconnect for account usage"
    }
    if setup.configured {
      let visibility = provider.enabled ? "Available in Codex" : "Hidden from Codex"
      return setup.signedIn == true
        ? "Signed in · \(visibility)"
        : "Ready · \(visibility)"
    }
    switch setup.action {
    case "install": return "Official CLI required"
    case "login": return "Sign in with the official CLI"
    case "add-key":
      return offersSignIn ? "Sign in or paste an API key" : "API key required"
    default: return "Setup required"
    }
  }

  private var offersSignIn: Bool { setup?.signIn == true }

  // Names both halves when both will run, so one click never does more than
  // the label promised.
  private var signInTitle: String {
    setup?.signInAction == "install" ? "Install & Sign In" : "Sign In"
  }

  @ViewBuilder
  private var actionControl: some View {
    if isBusy {
      ProgressView()
        .controlSize(.small)
        .tint(routerAccent)
        .frame(width: 42)
    } else if setup?.configured == true {
      HStack(spacing: 8) {
        if setup?.kind == "oauth" {
          if oauthNeedsReconnect {
            Button("Reconnect", action: onLogin)
              .buttonStyle(.plain)
              .font(.system(size: 10, weight: .medium))
              .foregroundStyle(routerYellow)
              .disabled(controlsDisabled)
          } else {
            Button(action: onLogin) {
              Image(systemName: "arrow.triangle.2.circlepath")
                .font(.system(size: 10, weight: .semibold))
                .frame(width: 20, height: 20)
            }
            .buttonStyle(.plain)
            .foregroundStyle(routerAccent)
            .help("Reconnect OAuth")
            .disabled(controlsDisabled)
          }
        }
        // A key that came from the CLI sign-in can only be renewed by signing
        // in again, so the row keeps that route reachable after connecting.
        if offersSignIn {
          Button(action: { onConnect() }) {
            Image(systemName: "arrow.triangle.2.circlepath")
              .font(.system(size: 10, weight: .semibold))
              .frame(width: 20, height: 20)
          }
          .buttonStyle(.plain)
          .foregroundStyle(routerAccent)
          .help(setup?.signInAction == "install"
            ? "Install the official CLI and sign in"
            : "Sign in again with the official CLI")
          .disabled(controlsDisabled)
        }
        if setup?.kind == "api" {
          Button(action: { toggleKeyField() }) {
            Image(systemName: showingKeyField ? "xmark" : "pencil")
              .font(.system(size: 10, weight: .semibold))
              .frame(width: 20, height: 20)
          }
          .buttonStyle(.plain)
          .foregroundStyle(routerAccent)
          .help(showingKeyField ? "Cancel key replacement" : "Replace API key")
          .disabled(controlsDisabled)

          Button(action: { tapRemove() }) {
            Image(systemName: removalArmed ? "checkmark.circle.fill" : "trash")
              .font(.system(size: removalArmed ? 12 : 10, weight: .semibold))
              .frame(width: 20, height: 20)
          }
          .buttonStyle(.plain)
          .foregroundStyle(removalArmed ? routerRed : routerYellow)
          .help(removalArmed ? "Click again to delete the stored key" : "Remove stored API key")
          .disabled(controlsDisabled)
        }
        Toggle("", isOn: Binding(get: { provider.enabled }, set: onToggle))
          .labelsHidden()
          .toggleStyle(.switch)
          .controlSize(.mini)
          .tint(routerMint)
          .disabled(controlsDisabled)
      }
    } else {
      HStack(spacing: 10) {
        // Two ways in, both first-class: the browser sign-in the CLI drives,
        // and the Studio key someone may already hold.
        if offersSignIn {
          Button(signInTitle) { onConnect() }
            .buttonStyle(.plain)
            .font(.system(size: 10, weight: .medium))
            .foregroundStyle(routerAccent)
            .disabled(controlsDisabled)
        }
        Button(actionTitle) { performAction() }
          .buttonStyle(.plain)
          .font(.system(size: 10, weight: .medium))
          .foregroundStyle(offersSignIn ? routerMuted : routerAccent)
          .disabled(controlsDisabled || setup == nil)
      }
    }
  }

  private var actionTitle: String {
    switch setup?.action {
    case "install": return "Install & Sign In"
    case "login": return "Sign In"
    case "add-key": return showingKeyField ? "Cancel" : "Add Key"
    default: return "Checking…"
    }
  }

  private var oauthNeedsReconnect: Bool {
    guard setup?.kind == "oauth", account?.status == "unavailable" else { return false }
    return account?.message?.localizedCaseInsensitiveContains("login") == true
  }

  private func performAction() {
    switch setup?.action {
    case "install", "login": onConnect()
    case "add-key": toggleKeyField()
    default: break
    }
  }

  private func toggleKeyField() {
    apiKey = ""
    disarmRemoval()
    showingKeyField.toggle()
  }

  // First click arms, second click deletes. The armed state expires on its own
  // so a stray click never leaves a live delete button sitting in the row.
  private func tapRemove() {
    if removalArmed {
      disarmRemoval()
      apiKey = ""
      showingKeyField = false
      onRemoveKey()
      return
    }
    removalArmed = true
    armGeneration += 1
    let generation = armGeneration
    DispatchQueue.main.asyncAfter(deadline: .now() + removalArmWindow) {
      if generation == armGeneration { removalArmed = false }
    }
  }

  private func disarmRemoval() {
    armGeneration += 1
    removalArmed = false
  }
}

private struct ProviderUsageSection: View {
  @ObservedObject var store: RouterStore
  @State private var range: UsageRange = .week

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      if quotaCards.isEmpty {
        HStack(alignment: .firstTextBaseline) {
          VStack(alignment: .leading, spacing: 3) {
            Text(sectionTitle)
              .font(.system(size: 12, weight: .medium))
            Text(limitDetail)
              .font(.system(size: 9))
              .foregroundStyle(routerMuted)
          }
          Spacer()
          Text(primaryMetric)
            .font(.system(size: 20, weight: .semibold))
            .monospacedDigit()
        }
      } else {
        HStack(alignment: .top, spacing: 8) {
          ForEach(quotaCards) { card in
            CurrentUsageLimitCard(card: card)
          }
        }
      }

      HStack(alignment: .firstTextBaseline) {
        Text(store.selectedUsageUsesChatGPT ? "Daily token usage" : "Router traffic")
          .font(.system(size: 10, weight: .medium))
          .foregroundStyle(routerMuted)
        Spacer()
        UsageRangePicker(selection: $range)
      }

      UsageBarChart(points: store.dailyUsage(days: range.rawValue), tint: routerAccent)
        .id("\(store.selectedUsageProviderID)-\(range.rawValue)")
        .frame(height: 88)

      HStack {
        Text(rangeCaption)
        Spacer()
        if store.selectedUsageUsesChatGPT,
           let streak = store.accountUsage?.summary.currentStreakDays {
          Text("\(streak)-day streak")
        }
      }
      .font(.system(size: 9))
      .foregroundStyle(routerMuted)

      if let error = usageError {
        Text(error)
          .font(.system(size: 10))
          .foregroundStyle(routerRed)
          .lineLimit(2)
      }

      if let accountMessage {
        Text(accountMessage)
          .font(.system(size: 9))
          .foregroundStyle(routerMuted)
          .lineLimit(2)
      }

      if let dashboardURL {
        Button("Open usage dashboard") {
          NSWorkspace.shared.open(dashboardURL)
        }
        .buttonStyle(.link)
        .font(.system(size: 9))
      }
    }
    .padding(.vertical, 2)
  }

  private var dashboardURL: URL? {
    guard !store.selectedUsageUsesChatGPT,
          let raw = store.selectedProviderUsage?.account.dashboardUrl
    else { return nil }
    return URL(string: raw)
  }

  private var sectionTitle: String {
    if store.selectedUsageUsesChatGPT { return "ChatGPT subscription" }
    return store.selectedProviderUsage?.displayName ?? store.selectedUsageProvider.displayName
  }

  private var primaryMetric: String {
    if store.selectedUsageUsesChatGPT {
      guard let value = store.accountUsage?.primary?.remainingPercent else { return "—" }
      return "\(value)% left"
    }
    guard store.providerUsage != nil else { return "—" }
    if let metric = store.selectedAccountMetric { return formattedAccountMetric(metric) }
    return compactTokenCount(store.localUsageTotals(days: range.rawValue).tokens)
  }

  private var quotaCards: [UsageOverviewCard] {
    store.usageCards(for: store.selectedUsageProvider).filter { card in
      if store.selectedUsageUsesChatGPT {
        return card.remainingPercent != nil
      }
      return card.metric?.kind == "quota"
    }
  }

  private var limitDetail: String {
    if !store.selectedUsageUsesChatGPT {
      guard store.selectedUsageProvider.isEnabled else { return store.selectedUsageProvider.detail }
      guard let usage = store.selectedProviderUsage else { return "Loading provider usage…" }
      if let metric = usage.account.metrics.first {
        if let detail = metric.detail, !detail.isEmpty { return detail }
        return standardizedLimitLabel(metric.label)
      }
      return "\(usage.credentialType.uppercased()) traffic · measured on this Mac"
    }
    return "Loading native Codex usage…"
  }

  private var rangeCaption: String {
    let total = store.dailyTokens(days: range.rawValue).reduce(0, +)
    if !store.selectedUsageUsesChatGPT {
      let requests = store.localUsageTotals(days: range.rawValue).requests
      return "\(compactTokenCount(total)) tokens · \(requests) requests over \(range.rawValue) days"
    }
    return "\(compactTokenCount(total)) tokens over \(range.rawValue) days"
  }

  private var usageError: String? {
    if store.selectedUsageUsesChatGPT {
      return store.accountUsage == nil ? store.accountUsageError : nil
    }
    return store.providerUsage == nil ? store.providerUsageError : nil
  }

  private var accountMessage: String? {
    guard !store.selectedUsageUsesChatGPT else { return nil }
    guard store.selectedUsageProvider.isEnabled else {
      return "Set up this provider below to fetch its account usage."
    }
    guard store.selectedProviderUsage?.account.metrics.isEmpty == true else { return nil }
    return store.selectedProviderUsage?.account.message
  }
}

private struct CurrentUsageLimitCard: View {
  let card: UsageOverviewCard

  var body: some View {
    VStack(alignment: .leading, spacing: 7) {
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Text(card.kindLabel ?? "Usage limit")
          .font(.system(size: 10, weight: .medium))
          .lineLimit(1)
        Spacer(minLength: 4)
        Text(metricText)
          .font(.system(size: 14, weight: .semibold))
          .monospacedDigit()
      }

      if let remainingFraction {
        GeometryReader { geometry in
          ZStack(alignment: .leading) {
            Capsule().fill(Color.primary.opacity(0.09))
            Capsule()
              .fill(routerAccent.opacity(0.84))
              .frame(width: geometry.size.width * remainingFraction)
          }
        }
        .frame(height: 4)
      }

      Text(resetText)
        .font(.system(size: 8.5))
        .foregroundStyle(routerMuted)
        .lineLimit(1)
    }
    .padding(10)
    .frame(maxWidth: .infinity, minHeight: 65, alignment: .leading)
    .background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
  }

  private var metricText: String {
    if let metric = card.metric { return formattedAccountMetric(metric) }
    guard let remaining = card.remainingPercent else { return "—" }
    return "\(Int(remaining.rounded()))% left"
  }

  private var resetText: String {
    guard let reset = card.resetDate else { return "No reset reported" }
    return usageResetCaption(reset)
  }

  private var remainingFraction: CGFloat? {
    guard let remaining = card.remainingPercent else { return nil }
    return CGFloat(max(0, min(100, remaining))) / 100
  }
}

private struct ModelUsageBreakdown: View {
  @ObservedObject var store: RouterStore

  private static let visibleRowLimit = 8

  private var rows: [ModelUsageRow] {
    Array(store.overallModelUsage.prefix(Self.visibleRowLimit))
  }

  private var hiddenCount: Int {
    max(0, store.overallModelUsage.count - rows.count)
  }

  private var heaviestTokens: Double {
    Double(rows.map(\.model.totalTokens).max() ?? 0)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      ForEach(rows) { row in
        VStack(alignment: .leading, spacing: 3) {
          HStack(spacing: 6) {
            Text(row.model.displayName)
              .font(.system(size: 10, weight: .medium))
              .lineLimit(1)
            Text(row.providerName)
              .font(.system(size: 8))
              .foregroundStyle(routerMuted)
              .lineLimit(1)
            Spacer(minLength: 6)
            Text(primaryLabel(for: row))
              .font(.system(size: 10, weight: .semibold))
              .monospacedDigit()
          }

          GeometryReader { geometry in
            ZStack(alignment: .leading) {
              Capsule().fill(Color.primary.opacity(0.09))
              Capsule()
                .fill(routerAccent.opacity(0.84))
                .frame(width: geometry.size.width * fraction(for: row))
            }
          }
          .frame(height: 4)

          Text(detailLabel(for: row))
            .font(.system(size: 8))
            .foregroundStyle(routerMuted)
            .lineLimit(1)
        }
      }

      if hiddenCount > 0 {
        Text("+\(hiddenCount) more model\(hiddenCount == 1 ? "" : "s")")
          .font(.system(size: 8.5))
          .foregroundStyle(routerMuted)
      }
    }
  }

  private func fraction(for row: ModelUsageRow) -> Double {
    guard heaviestTokens > 0 else { return 0 }
    return min(1, Double(row.model.totalTokens) / heaviestTokens)
  }

  private func primaryLabel(for row: ModelUsageRow) -> String {
    guard row.model.totalTokens > 0 else { return "\(row.model.requests) req" }
    return "\(compactTokenCount(Double(row.model.totalTokens))) tok"
  }

  private func detailLabel(for row: ModelUsageRow) -> String {
    // A model with traffic but no metered response carries no token counts;
    // say so rather than implying it burned nothing.
    guard row.model.totalTokens > 0 else {
      return "\(row.model.requests) req · not metered"
    }
    let input = compactTokenCount(Double(row.model.inputTokens))
    let output = compactTokenCount(Double(row.model.outputTokens))
    return "\(input) in · \(output) out · \(row.model.requests) req"
  }
}

private struct AllProviderUsageGrid: View {
  @ObservedObject var store: RouterStore

  private let columns = [
    GridItem(.flexible(), spacing: 8),
    GridItem(.flexible(), spacing: 8),
  ]

  var body: some View {
    LazyVGrid(columns: columns, spacing: 8) {
      ForEach(store.visibleUsageCards) { card in
        AllProviderUsageCard(store: store, card: card)
      }
    }
  }
}

private struct AllProviderUsageCard: View {
  @ObservedObject var store: RouterStore
  let card: UsageOverviewCard

  var body: some View {
    Button {
      store.selectUsageProvider(card.providerID)
    } label: {
      VStack(alignment: .leading, spacing: 7) {
        HStack(spacing: 6) {
          Circle()
            .fill(card.providerID == store.selectedUsageProviderID ? store.activityState.tint : statusTint)
            .frame(width: 6, height: 6)
          Text(card.title)
            .font(.system(size: 10, weight: .medium))
            .lineLimit(1)
          Spacer(minLength: 4)
        }

        Text(metricText)
          .font(.system(size: 16, weight: .semibold))
          .monospacedDigit()

        if let remainingFraction {
          GeometryReader { geometry in
            ZStack(alignment: .leading) {
              Capsule().fill(Color.primary.opacity(0.09))
              Capsule()
                .fill(routerAccent.opacity(0.84))
                .frame(width: geometry.size.width * remainingFraction)
            }
          }
          .frame(height: 4)
        }

        Text(detailText)
          .font(.system(size: 8.5))
          .foregroundStyle(routerMuted)
          .lineLimit(1)

        Text(footerText)
          .font(.system(size: 8))
          .foregroundStyle(routerMuted)
          .lineLimit(1)
      }
      .padding(10)
      .frame(maxWidth: .infinity, minHeight: 98, alignment: .leading)
      .background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .stroke(
            card.providerID == store.selectedUsageProviderID ? routerAccent.opacity(0.45) : Color.clear,
            lineWidth: 0.75
          )
      )
    }
    .buttonStyle(.plain)
    .help("Show \(card.provider.displayName) usage")
    .accessibilityLabel("Show \(card.provider.displayName) usage")
  }

  private var account: ProviderAccountUsage? {
    store.providerUsage(for: card.providerID)?.account
  }

  private var oauthNeedsReconnect: Bool {
    guard account?.status == "unavailable" else { return false }
    return account?.message?.localizedCaseInsensitiveContains("login") == true
  }

  private var localTotals: (tokens: Double, requests: Int) {
    store.localUsageTotals(for: card.providerID, days: 7)
  }

  private var metricText: String {
    if oauthNeedsReconnect { return "Reconnect" }
    if let metric = card.metric { return formattedAccountMetric(metric) }
    if let remaining = card.remainingPercent {
      return "\(Int(remaining.rounded()))% left"
    }
    if card.providerID == "openai" { return "—" }
    return store.localUsageSummary(for: card.providerID, days: 7)
  }

  private var detailText: String {
    if oauthNeedsReconnect { return "OAuth expired · reconnect below" }
    if let kindLabel = card.kindLabel {
      return kindLabel
    }
    if card.providerID == "openai" {
      return store.accountUsage?.primary?.durationLabel ?? "Weekly limit"
    }
    if localTotals.requests > 0 || localTotals.tokens > 0 {
      if localTotals.tokens > 0, localTotals.requests > 0 {
        return "7D local · \(localTotals.requests) requests"
      }
      if localTotals.requests > 0 {
        return "7D local · tokens not reported"
      }
      return "7D local traffic"
    }
    if card.provider.isEnabled { return "No router traffic yet" }
    return "Configured · currently hidden"
  }

  private var footerText: String {
    if oauthNeedsReconnect { return "Sign in again to restore quota" }
    if let reset = card.resetDate {
      return usageResetCaption(reset)
    }
    if card.metric != nil || card.providerID == "openai" {
      return "No reset reported"
    }
    return "Local router traffic"
  }

  private var remainingFraction: CGFloat? {
    guard let remaining = card.remainingPercent else { return nil }
    return CGFloat(max(0, min(100, remaining))) / 100
  }

  private var statusTint: Color {
    if card.providerID == "openai" || card.provider.isEnabled { return routerMint }
    return Color.secondary.opacity(0.42)
  }
}

struct UsageRangePicker: View {
  @Binding var selection: UsageRange

  var body: some View {
    HStack(spacing: 2) {
      ForEach(UsageRange.allCases) { range in
        Button(range.label) { selection = range }
          .buttonStyle(.plain)
          .font(.system(size: 9, weight: .medium))
          .foregroundStyle(selection == range ? Color.primary : routerMuted)
          .padding(.horizontal, 7)
          .padding(.vertical, 4)
          .background(
            selection == range ? Color.primary.opacity(0.10) : Color.clear,
            in: Capsule()
          )
      }
    }
    .padding(2)
    .background(Color.primary.opacity(0.045), in: Capsule())
  }
}

struct UsageBarChart: View {
  let points: [DailyUsagePoint]
  let tint: Color
  var showsAxis = true

  @State private var hoveredDate: Date?

  var body: some View {
    GeometryReader { geometry in
      let maximum = max(points.map(\.tokens).max() ?? 0, 1)
      let spacing: CGFloat = points.count > 45 ? 1 : points.count > 14 ? 2 : 4
      let width = max(
        1,
        (geometry.size.width - spacing * CGFloat(max(0, points.count - 1))) /
          CGFloat(max(points.count, 1))
      )
      let axisHeight: CGFloat = showsAxis ? 14 : 0
      let chartHeight = max(1, geometry.size.height - axisHeight)

      ZStack(alignment: .top) {
        VStack(spacing: 2) {
          HStack(alignment: .bottom, spacing: spacing) {
            ForEach(points) { point in
              VStack(spacing: 0) {
                Spacer(minLength: 0)
                RoundedRectangle(cornerRadius: min(2.5, width / 2), style: .continuous)
                  .fill(point.tokens == 0 ? Color.primary.opacity(0.07) : tint.opacity(0.86))
                  .frame(height: max(2, chartHeight * CGFloat(point.tokens / maximum)))
              }
              .frame(width: width, height: chartHeight)
              .contentShape(Rectangle())
              .onHover { hovering in
                if hovering {
                  hoveredDate = point.date
                } else if hoveredDate == point.date {
                  hoveredDate = nil
                }
              }
              .help(hoverText(for: point))
            }
          }

          if showsAxis {
            ZStack(alignment: .leading) {
              ForEach(Array(points.enumerated()), id: \.element.id) { index, point in
                if shouldLabel(index: index) {
                  Text(axisLabel(for: point))
                    .font(.system(size: 7.5, weight: .medium))
                    .foregroundStyle(.secondary)
                    .fixedSize()
                    .position(
                      x: min(
                        geometry.size.width - 8,
                        max(8, width / 2 + CGFloat(index) * (width + spacing))
                      ),
                      y: 5
                    )
                }
              }
            }
            .frame(height: 12)
          }
        }

        if let point = hoveredPoint {
          Text(hoverText(for: point))
            .font(.system(size: 9, weight: .medium, design: .monospaced))
            .foregroundStyle(.primary)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(.regularMaterial, in: Capsule())
            .overlay(Capsule().stroke(Color.primary.opacity(0.12), lineWidth: 0.5))
            .allowsHitTesting(false)
        }
      }
    }
    .accessibilityLabel("Daily token usage chart. Hover a day for its exact token count.")
  }

  private var hoveredPoint: DailyUsagePoint? {
    guard let hoveredDate else { return nil }
    return points.first(where: { $0.date == hoveredDate })
  }

  private func shouldLabel(index: Int) -> Bool {
    let stride = points.count <= 7 ? 1 : points.count <= 31 ? 5 : 15
    return index.isMultiple(of: stride) || index == points.count - 1
  }

  private func axisLabel(for point: DailyUsagePoint) -> String {
    if points.count <= 7 {
      return point.date.formatted(.dateTime.weekday(.abbreviated))
    }
    return point.date.formatted(.dateTime.month(.defaultDigits).day())
  }

  private func hoverText(for point: DailyUsagePoint) -> String {
    let date = point.date.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day())
    let tokens = Int64(point.tokens).formatted(.number.grouping(.automatic))
    return "\(date) · \(tokens) tokens"
  }
}

func standardizedLimitLabel(_ label: String) -> String {
  let lowered = label.lowercased()
  if lowered.contains("5-hour") || lowered.contains("5 hour") {
    return "5-hour limit"
  }
  if lowered.contains("7-day") || lowered.contains("7 day") {
    return "Weekly limit"
  }
  if lowered.contains("weekly") {
    return "Weekly limit"
  }
  if lowered.contains("monthly") {
    return "Monthly limit"
  }
  if lowered.contains("daily") {
    return "Daily limit"
  }
  if lowered.contains("hour") && lowered.contains("limit") {
    return label
  }
  if lowered.contains("quota") || lowered.contains("limit") {
    return label.replacingOccurrences(of: "quota", with: "limit", options: [.caseInsensitive])
  }
  return label
}

func formattedAccountMetric(_ metric: ProviderAccountMetric) -> String {
  if metric.kind == "quota", let remaining = metric.remainingPercent {
    return "\(Int(remaining.rounded()))% left"
  }
  if metric.kind == "balance", let value = metric.value {
    let formatter = NumberFormatter()
    formatter.numberStyle = .currency
    formatter.currencyCode = metric.currency ?? "USD"
    formatter.minimumFractionDigits = 2
    formatter.maximumFractionDigits = 2
    return formatter.string(from: NSNumber(value: value)) ?? String(format: "%.2f", value)
  }
  return "—"
}

func compactTokenCount(_ value: Double) -> String {
  if value >= 1_000_000_000 {
    return String(format: "%.1fB", value / 1_000_000_000)
  }
  if value >= 1_000_000 {
    return String(format: "%.1fM", value / 1_000_000)
  }
  if value >= 1_000 {
    return String(format: "%.1fK", value / 1_000)
  }
  return String(Int(value))
}

func usageResetCaption(_ date: Date) -> String {
  "Resets \(date.formatted(.dateTime.month(.abbreviated).day().hour().minute()))"
}

private struct StatusBeacon: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let state: RouterActivityState
  @State private var breathing = false

  var body: some View {
    HStack(spacing: 6) {
      ZStack {
        Circle()
          .fill(state.tint.opacity(0.18))
          .frame(width: 14, height: 14)
          .scaleEffect((state == .generating || state == .starting) && breathing ? 1.28 : 0.9)
        Circle()
          .fill(state.tint)
          .frame(width: 7, height: 7)
      }
      Text(state.label)
        .font(.system(size: 10, weight: .medium))
    }
    .foregroundStyle(state.tint)
    .onAppear { animate() }
    .onChange(of: state) { _ in animate() }
  }

  private func animate() {
    breathing = false
    guard state == .generating || state == .starting, !reduceMotion else { return }
    withAnimation(.easeInOut(duration: 0.72).repeatForever(autoreverses: true)) {
      breathing = true
    }
  }
}

private struct AccentButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 11, weight: .semibold))
      .foregroundStyle(.white)
      .padding(.horizontal, 12)
      .padding(.vertical, 7)
      .background(routerAccent.opacity(configuration.isPressed ? 0.74 : 1), in: Capsule())
      .scaleEffect(configuration.isPressed ? 0.98 : 1)
  }
}

private struct VisualEffectBlur: NSViewRepresentable {
  func makeNSView(context: Context) -> NSVisualEffectView {
    let view = NSVisualEffectView()
    view.material = .popover
    view.blendingMode = .behindWindow
    view.state = .active
    return view
  }

  func updateNSView(_ nsView: NSVisualEffectView, context: Context) {}
}

struct LocalVisionMeasurement: Decodable, Equatable {
  let percent: Int
  let textPercent: Int?
  let seconds: Double?
}
