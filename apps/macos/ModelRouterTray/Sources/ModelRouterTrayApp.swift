import AppKit
import Combine
import Foundation
import ServiceManagement
import SwiftUI

// Keep the existing material/background treatment, but use stronger text and
// semantic accents so the compact tray remains readable over it.
let routerAccent = Color(red: 0.12, green: 0.40, blue: 0.76)
let routerMint = Color(red: 0.04, green: 0.52, blue: 0.31)
let routerYellow = Color(red: 0.68, green: 0.40, blue: 0.03)
let routerRed = Color(red: 0.72, green: 0.16, blue: 0.12)
let routerInk = Color(red: 0.035, green: 0.043, blue: 0.055)
let routerText = Color.primary.opacity(0.92)
let routerMuted = Color.primary.opacity(0.76)
let routerMutedStrong = Color.primary.opacity(0.90)
let removalArmWindow: TimeInterval = 4

enum LocalModelOperationKind: Equatable {
  case uninstall

  var label: String {
    switch self {
    case .uninstall: return routerLocalized("Uninstalling")
    }
  }
}

struct LocalModelOperation: Equatable {
  let tag: String
  let kind: LocalModelOperationKind
}

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
    case .idle: return routerLocalized("Idle")
    case .generating: return routerLocalized("Thinking")
    case .starting: return routerLocalized("Starting")
    case .error: return routerLocalized("Error")
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
    if Self.launchedByUser { store.revealForUserLaunch() }
  }

  // Double-clicking an app that is already running sends this instead of a
  // fresh launch. An LSUIElement app has no window and no Dock icon, so without
  // handling it the second open is silently swallowed and the app reads as
  // broken.
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
    store.revealForUserLaunch()
    return true
  }

  // launchd passes --supervised (see src/tray-service-macos.mjs) so a login
  // start is distinguishable from a person opening the app. Without the
  // distinction every login would force the surfaces visible and quietly
  // defeat follow mode.
  private static var launchedByUser: Bool {
    !CommandLine.arguments.contains("--supervised")
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
  @Published private(set) var localDownload: VisionDownloadState?
  @Published private(set) var localModelOperation: LocalModelOperation?
  @Published private(set) var benchmarkingTag: String?
  @Published private(set) var maintenanceMessage: String?
  @Published private(set) var maintenanceSucceeded = false
  @Published private(set) var harnessMessage: String?
  @Published private(set) var harnessSucceeded = false
  @Published private(set) var islandMode: IslandMode
  // Publishing the language makes every view re-render on change, so the
  // panel switches in place instead of waiting for the next relaunch.
  @Published private(set) var language: TrayLanguage = RouterLanguage.selection
  @Published private(set) var presenceMode: TrayPresenceMode
  @Published private(set) var hostAppRunning = false
  @Published private(set) var surfacesVisible = true
  // A client the tray cannot watch -- the harness, or a terminal `codex` --
  // overrides follow mode. The router computes this; the tray does not
  // re-derive it. Sourced from the routine snapshot, so a client appearing
  // mid-session is picked up without a relaunch.
  @Published private(set) var routerPinsServiceOn = false
  // Bumped every time the user opens the app by hand. StatusItemLabel watches
  // it so a double-click gets a visible answer even when the tray was already
  // running and nothing about the router changed.
  @Published private(set) var attentionPulse = 0
  private var attentionRelease: Task<Void, Never>?
  private var userRevealUntil: Date?
  private static let userRevealWindow: TimeInterval = 20

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
  // p_comm truncates at 16 characters, so these must be the executable names as
  // the kernel stores them. The npm wrapper is a Node script that execs a native
  // binary called `codex`; the desktop app's helper is also `codex`, which is
  // harmless because that case is already covered by the bundle check.
  nonisolated static let hostProcessNames = ["codex"]
  private var workspaceObservers: [NSObjectProtocol] = []
  private var pendingServiceStop: Task<Void, Never>?
  // Bumped for every scheduled stop so a cancelled task can tell whether the
  // handle it would clear is still its own.
  private var serviceStopGeneration = 0
  private var hostAppRecheck: Task<Void, Never>?
  private var serviceWork: Task<Void, Never>?
  private var serviceIntent: ServiceIntent = .unknown
  // Codex relaunches itself to apply updates, so a momentary disappearance must
  // not bounce the router. Wait the absence out and re-check the process list
  // directly before stopping; workspace notifications are only hints.
  private let hostAppAbsenceGrace = Duration.seconds(30)
  private let hostAppRecheckInterval = Duration.seconds(5)
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

  // What the three stored signals mean, as one pure decision. Pulled out of
  // `init` so it can be tested: the mode this picks is the difference between
  // an overlay covering somebody's notch on every display and it never
  // appearing, and asserting on the source text of an initializer proves only
  // that the source says what it says.
  //
  // `storedMode` is the operator's own answer and is taken verbatim forever.
  // `legacyVisible` is the pre-desktop-mode boolean, migrated once. When
  // neither exists nobody has answered: the overlay is opt-in for a new
  // install, but an install that has launched before keeps it, because
  // silently retiring an overlay somebody has been using is its own surprise.
  nonisolated static func resolveIslandMode(
    storedMode: String?,
    legacyVisible: Bool?,
    hasLaunchedBefore: Bool
  ) -> IslandMode {
    if let storedMode, let mode = IslandMode(rawValue: storedMode) { return mode }
    if let legacyVisible { return legacyVisible ? .notch : .off }
    return hasLaunchedBefore ? .notch : .off
  }

  init() {
    selectedUsageProviderID = "openai"
    // retireLoginItem records the bundle path on every bundled launch and runs
    // after this initializer, so its absence here means nothing has ever
    // launched from a bundle.
    let resolvedIslandMode = Self.resolveIslandMode(
      storedMode: defaults.string(forKey: islandModeKey),
      legacyVisible: defaults.object(forKey: islandVisibilityKey) == nil
        ? nil
        : defaults.bool(forKey: islandVisibilityKey),
      hasLaunchedBefore: defaults.object(forKey: loginItemBundlePathKey) != nil
    )
    islandMode = resolvedIslandMode
    // Persist it, so "never configured" and "explicitly chose notch" stop being
    // the same state for every launch after this one.
    if defaults.string(forKey: islandModeKey) == nil {
      defaults.set(resolvedIslandMode.rawValue, forKey: islandModeKey)
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

  var signedRouting: Bool {
    snapshot.targets["codex"]?.signedRouting == true
  }

  var harnessRunning: Bool { providerOperation == "harness" }

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

  // In follow mode every tray surface and the endpoint track the Codex/ChatGPT
  // desktop apps. The process itself stays resident as the watcher — quitting
  // on app exit would leave nothing around to notice the next launch. Workspace
  // notifications are backed by polling because missing one must never strand
  // Codex without its endpoint.
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
    hostAppRecheck?.cancel()
    hostAppRecheck = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: self?.hostAppRecheckInterval ?? .seconds(5))
        guard !Task.isCancelled else { return }
        self?.refreshHostAppRunning()
      }
    }
  }

  // The mode the tray acts on. A harness turn or a TUI turn arrives over a
  // socket with no app behind it, so following the Codex apps would stop the
  // router under a user with nothing left to notice their next request.
  var effectivePresenceMode: TrayPresenceMode {
    routerPinsServiceOn ? .always : presenceMode
  }

  private func updateRouterPinsServiceOn(_ pinned: Bool) {
    guard routerPinsServiceOn != pinned else { return }
    routerPinsServiceOn = pinned
    refreshSurfacesVisible()
    reconcileService()
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
    let detected = hostAppRunningNow()
    if hostAppRunning != detected { hostAppRunning = detected }
    refreshSurfacesVisible()
    reconcileService()
  }

  // Codex ships two ways: the desktop app, which has a bundle identifier, and
  // the npm CLI, which is a plain terminal process and has none. Follow mode
  // checked only the bundle identifiers, so every CLI session read as "Codex is
  // not running" -- which hid the menu bar item immediately and then stopped the
  // router thirty seconds into the user's work, exactly when it was needed. Look
  // for the process too.
  private func hostAppRunningNow() -> Bool {
    let bundleMatch = hostAppBundleIDs.contains { identifier in
      NSRunningApplication.runningApplications(withBundleIdentifier: identifier)
        .contains { !$0.isTerminated }
    }
    if bundleMatch { return true }
    return Self.anyProcessRunning(named: Self.hostProcessNames)
  }

  // sysctl rather than spawning pgrep: this runs every five seconds for the
  // life of the session, and a fork/exec on that cadence is a real cost on a
  // laptop. NSRunningApplication cannot see processes that are not bundled apps,
  // so there is no AppKit answer here.
  // nonisolated: a process scan touches no actor state, and pinning it to the
  // main actor would make it unusable from anywhere but the UI.
  nonisolated static func anyProcessRunning(named names: [String]) -> Bool {
    var request: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0]
    var byteCount = 0
    guard sysctl(&request, UInt32(request.count), nil, &byteCount, nil, 0) == 0, byteCount > 0
    else { return false }

    let stride = MemoryLayout<kinfo_proc>.stride
    // Processes can appear between sizing and reading, so ask for headroom and
    // trust the byte count sysctl reports back rather than the one it predicted.
    var entries = [kinfo_proc](repeating: kinfo_proc(), count: byteCount / stride + 32)
    byteCount = entries.count * stride
    let read = entries.withUnsafeMutableBytes { buffer -> Int32 in
      sysctl(&request, UInt32(request.count), buffer.baseAddress, &byteCount, nil, 0)
    }
    guard read == 0 else { return false }

    // Our own Codex does not count as "Codex is running".
    //
    // The tray polls `control account` every 30 seconds, which starts
    // `codex app-server` to read usage -- a process whose `p_comm` is exactly
    // `codex`. Counting it latches follow mode on: the tray sees Codex as
    // permanently present and never releases the router again.
    //
    // The match is a *grandchild*, not a child: the tray spawns `control`, and
    // `control` spawns Codex. So collect the parent of every process first and
    // walk the chain, rather than comparing a single ppid.
    var parentOf: [pid_t: pid_t] = [:]
    var matches: [pid_t] = []
    for index in 0..<min(byteCount / stride, entries.count) {
      let process = entries[index].kp_proc
      let identifier = process.p_pid
      parentOf[identifier] = entries[index].kp_eproc.e_ppid
      let comm = withUnsafeBytes(of: process.p_comm) { raw -> String in
        // p_comm is a fixed 17-byte field, NUL-padded rather than NUL-terminated
        // when the name fills it, so measure before decoding.
        var length = 0
        while length < raw.count, raw[length] != 0 { length += 1 }
        return String(decoding: raw[0..<length], as: UTF8.self)
      }
      if names.contains(where: { $0.compare(comm, options: .caseInsensitive) == .orderedSame }) {
        matches.append(identifier)
      }
    }
    let own = getpid()
    return matches.contains { !isDescendant($0, of: own, parentOf: parentOf) }
  }

  // Walks a pid up to an ancestor. Bounded rather than `while true`: this reads
  // a table sampled from the kernel between two sysctl calls, and a torn read
  // must not be able to spin the scan that runs every five seconds.
  nonisolated static func isDescendant(
    _ pid: pid_t,
    of ancestor: pid_t,
    parentOf: [pid_t: pid_t],
  ) -> Bool {
    var current = pid
    for _ in 0..<64 {
      if current == ancestor { return true }
      guard let parent = parentOf[current], parent != 0, parent != current else { return false }
      current = parent
    }
    return false
  }

  private func refreshSurfacesVisible() {
    let pinnedByUser = userRevealUntil.map { $0 > Date() } ?? false
    // effectivePresenceMode, not presenceMode: the router pins follow mode to
    // always while a client it cannot watch is talking to it, and a user launch
    // must not undo that.
    surfacesVisible = pinnedByUser || effectivePresenceMode == .always || hostAppRunning
  }

  // Opening Model Router from Finder, Spotlight, Launchpad, or the Dock has to
  // produce a menu bar item and a live router even in follow mode with Codex
  // closed. Without this the app looked broken on exactly the launch that
  // motivates having an icon at all: double-click, nothing appears, because
  // follow mode had already decided the surfaces should stay hidden.
  //
  // Time-boxed rather than sticky, so follow mode takes over again on its own
  // and the user does not silently end up in always-on.
  func revealForUserLaunch() {
    userRevealUntil = Date().addingTimeInterval(Self.userRevealWindow)
    refreshSurfacesVisible()
    startService()
    attentionPulse &+= 1
    NSApp.activate(ignoringOtherApps: true)
    attentionRelease?.cancel()
    attentionRelease = Task { [weak self] in
      try? await Task.sleep(for: .seconds(Self.userRevealWindow))
      guard !Task.isCancelled, let self else { return }
      self.userRevealUntil = nil
      self.refreshSurfacesVisible()
      self.reconcileService()
    }
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
    guard effectivePresenceMode == .followCodex else {
      pendingServiceStop?.cancel()
      pendingServiceStop = nil
      // Leaving follow mode hands the router back to launchd's always-on
      // contract, so anything the tray stopped has to come back up.
      if serviceIntent == .stopped { startService() }
      serviceIntent = .unknown
      return
    }
    if hostAppRunning {
      pendingServiceStop?.cancel()
      pendingServiceStop = nil
      startService()
      return
    }
    // Periodic process rechecks must not restart this grace period forever.
    guard pendingServiceStop == nil else { return }
    serviceStopGeneration += 1
    let generation = serviceStopGeneration
    pendingServiceStop = Task { [weak self] in
      guard let self else { return }
      // The handle is released however this task ends, including the early
      // returns below and the ones inside `stopServiceWhenIdle`. Leaving it set
      // is what made a single spurious "Codex is running" permanent: the
      // `pendingServiceStop == nil` guard above would then refuse to schedule
      // another stop for the rest of the session. The generation check keeps a
      // cancelled task from clearing a handle a later reconcile installed.
      defer {
        if self.serviceStopGeneration == generation { self.pendingServiceStop = nil }
      }
      try? await Task.sleep(for: self.hostAppAbsenceGrace)
      guard !Task.isCancelled else { return }
      // Do not trust a possibly missed launch notification. Query the process
      // list again at the decision point before unloading the endpoint.
      self.refreshHostAppRunning()
      guard !Task.isCancelled, !self.hostAppRunning else { return }
      await self.stopServiceWhenIdle()
    }
  }

  private func stopServiceWhenIdle() async {
    while !Task.isCancelled {
      guard effectivePresenceMode == .followCodex, !hostAppRunning else { return }
      if activeRequestCount == 0 && activityState == .idle { break }
      try? await Task.sleep(for: activeRequestRecheck)
      refreshHostAppRunning()
    }
    guard !Task.isCancelled, effectivePresenceMode == .followCodex, !hostAppRunning else { return }
    guard serviceIntent != .stopped else { return }
    serviceIntent = .stopped
    enqueueServiceWork { [weak self] in
      guard let self, self.effectivePresenceMode == .followCodex, !self.hostAppRunning else { return }
      await self.runServiceCommand("stop")
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
  private func enqueueServiceWork(_ work: @escaping @MainActor @Sendable () async -> Void) {
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
      if action == "stop" { pendingServiceStop = nil }
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
    hostAppRecheck?.cancel()
    guard effectivePresenceMode == .followCodex, serviceIntent == .stopped else { return }
    guard let root = try? sourceRoot() else { return }
    let task = Process()
    task.executableURL = root.appendingPathComponent("bin/control")
    task.arguments = ["service", "start"]
    task.currentDirectoryURL = root
    try? task.run()
  }

  private static let providerShortNames: [String: String] = [
    "opencode-free": "OpenCode Free",
    "kilo-free": "Kilo Free",
    "grok-oauth": "Grok",
    "kimi-oauth": "Kimi",
    "deepseek": "DeepSeek",
    "grok-api": "Grok API",
    "kimi-api": "Kimi API",
    "kimi-api-cn": "Kimi CN",
    "anthropic-api": "Claude",
    "zai-coding": "GLM",
    "zai-api": "GLM API",
    "qwen-plan": "Qwen",
    "ollama-cloud": "Ollama",
    "commandcode": "Command Code",
    "github-copilot": "Copilot",
    "clinepass": "ClinePass",
    "chutes": "Chutes",
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
      return RouterLanguage.isSimplifiedChinese
        ? "剩余 \(primary.remainingPercent)%"
        : "\(primary.remainingPercent)% left"
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
      return RouterLanguage.isSimplifiedChinese
        ? "\(activeChatCount) 个会话"
        : "\(activeChatCount) chats"
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

  func observedTokensPerSecond(providerID: String?, model: String?) -> Double? {
    guard let model, !model.isEmpty else { return nil }
    let displayName = model.split(separator: "/").last.map(String.init) ?? model
    let matchingProviders: [RouterProviderUsage]
    if let providerID,
       let provider = providerUsage?.providers.first(where: { $0.id == providerID }) {
      matchingProviders = [provider]
    } else {
      matchingProviders = providerUsage?.providers ?? []
    }
    let match = matchingProviders
      .flatMap { $0.models ?? [] }
      .first { $0.slug == model || $0.displayName == displayName }
    if let speed = match?.observedTokensPerSecond { return speed }
    // Protocol variants are folded into their canonical provider in the usage
    // snapshot, so retry across providers before declaring the speed unknown.
    return providerUsage?.providers
      .flatMap { $0.models ?? [] }
      .first { $0.slug == model || $0.displayName == displayName }?
      .observedTokensPerSecond
  }

  var activeModelObservedTokensPerSecond: Double? {
    let latest = activeRequests.last
    return observedTokensPerSecond(
      providerID: latest?.provider,
      model: latest?.model ?? activeModel
    )
  }

  func sessionName(for request: RouterActiveRequest) -> String {
    guard let sessionName = request.sessionName?.trimmingCharacters(in: .whitespacesAndNewlines),
          !sessionName.isEmpty
    else { return routerLocalized("Active session") }
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

  // Issue #182. The headline card follows whatever is generating right now,
  // which answers "how fast is this" but never "how do my models compare".
  // `lastUsedAt` was already decoded and unread; this is what it was for.
  // Only measured models appear -- an unmeasured one would need a placeholder
  // row that says nothing, and the card above already covers "no samples yet".
  var recentModelSpeeds: [ModelUsageRow] {
    guard let snapshot = providerUsage else { return [] }
    return snapshot.providers
      .flatMap { provider in
        (provider.models ?? []).map { model in
          ModelUsageRow(providerID: provider.id, providerName: provider.displayName, model: model)
        }
      }
      .filter { $0.model.observedTokensPerSecond != nil }
      .sorted { ($0.model.lastUsedAt ?? "") > ($1.model.lastUsedAt ?? "") }
      .prefix(4)
      .map { $0 }
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
      updateRouterPinsServiceOn(snapshot.presence?.effectiveMode == "always")
      let reportedLocalModels = snapshot.targets["codex"]?.modelSettings?.localModels
      let installedLocalTags = Set(reportedLocalModels?.models.map(\.tag) ?? [])
      let rawReportedLocalDownload = reportedLocalModels?.download
      // The protected download record intentionally survives completion, but
      // it stops describing reality after that model is removed from Ollama.
      // Never render a stale "ready · 100%" result for an uninstalled tag.
      let reportedLocalDownload: VisionDownloadState?
      if let reported = rawReportedLocalDownload,
         reported.status == "done",
         let tag = reported.tag,
         !installedLocalTags.contains(tag) {
        reportedLocalDownload = nil
      } else {
        reportedLocalDownload = rawReportedLocalDownload
      }
      // A click publishes an optimistic state before the control process has
      // finished its registry/runtime preflight. Do not let a concurrent
      // refresh replace that state with an older snapshot (or nil), otherwise
      // the tray appears to do nothing for the first seconds of a pull.
      if let current = localDownload, current.isRunning {
        if let reported = reportedLocalDownload,
          reported.tag == current.tag,
          (reported.updatedAt ?? 0) >= (current.startedAt ?? .greatestFiniteMagnitude) {
          localDownload = reported
        }
      } else if let current = localDownload, current.status == "error" {
        // Keep a preflight failure visible until a newer record for that tag
        // arrives; a nil/stale probe should not erase the explanation.
        if let reported = reportedLocalDownload,
          reported.tag == current.tag,
          (reported.updatedAt ?? 0) >= (current.updatedAt ?? .greatestFiniteMagnitude) {
          localDownload = reported
        }
      } else {
        localDownload = reportedLocalDownload
      }
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

  func setLanguage(_ next: TrayLanguage) {
    guard next != language else { return }
    // RouterLanguage holds the value routerLocalized() reads, so it has to be
    // updated before the published change re-renders anything.
    RouterLanguage.setSelection(next)
    language = next
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
    let label = providerSetup[provider]?.credentialLabel ?? "API key"
    await performProviderOperation(
      provider,
      successMessage: "\(label) saved. Restart Codex to refresh its model picker."
    ) {
      _ = try await runControl(arguments: ["credential", provider], stdin: secret)
      try await updateProviderSelection(provider, enabled: true)
    }
  }

  // The control plane already drops the provider from the Codex selection when
  // the key file is deleted; this only makes that selection live.
  func removeProviderKey(_ provider: String) async {
    let label = providerSetup[provider]?.credentialLabel ?? "API key"
    await performProviderOperation(
      provider,
      successMessage: "\(label) removed. Restart Codex to refresh its model picker."
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
      return RouterLanguage.isSimplifiedChinese ? "\(totals.requests) 个请求" : "\(totals.requests) req"
    }
    return routerLocalized("No traffic")
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
      maintenanceMessage = "Update installed. Fully quit and reopen Codex to load updated models and agents."
    } catch {
      maintenanceMessage = error.localizedDescription
      await refresh()
    }
  }

  // Install the harness if it is absent, then publish the routed models into
  // its own documents. One button, because "install it" and "point it at this
  // router" are never wanted separately -- an installed harness that routes
  // nowhere is not a state anybody asked for.
  func setupHarness() async {
    guard providerOperation == nil else { return }
    providerOperation = "harness"
    harnessSucceeded = false
    harnessMessage = snapshot.harness?.installed == true
      ? routerLocalized("Publishing routed models…")
      : routerLocalized("Installing DeepSeek Harness…")
    defer { providerOperation = nil }
    do {
      let output = try await runControl(arguments: ["harness", "setup"])
      let result = try JSONDecoder().decode(HarnessSetupResult.self, from: output)
      await refresh()
      harnessSucceeded = true
      // The row now offers the play button; say so rather than leaving the
      // count sitting there as if nothing further were expected.
      harnessMessage = routerFormat(
        routerLocalized("%d models published. Press play to open the harness."),
        result.published.models
      )
    } catch {
      harnessMessage = error.localizedDescription
      await refresh()
    }
  }

  // Opening is not a router action -- there is nothing to run and nothing that
  // can fail slowly -- so it stays off the serialized operation queue that the
  // install and publish share.
  func openHarnessWeb() {
    guard let raw = snapshot.harness?.web?.url, let url = URL(string: raw) else { return }
    NSWorkspace.shared.open(url)
  }

  // Start without republishing. Offered when the models are already published
  // and only the browser UI is down, which is the state a machine lands in
  // after a reboot.
  func startHarnessWeb() async {
    guard providerOperation == nil else { return }
    providerOperation = "harness"
    harnessSucceeded = false
    harnessMessage = routerLocalized("Starting DeepSeek Harness…")
    defer { providerOperation = nil }
    do {
      _ = try await runControl(arguments: ["harness", "start"])
      await refresh()
      harnessSucceeded = true
      harnessMessage = nil
      openHarnessWeb()
    } catch {
      harnessMessage = error.localizedDescription
      await refresh()
    }
  }

  // Stop the running harness. This is the resource question -- a booted harness
  // holds a Node process and its plugin tree resident -- not the integration
  // question, so it leaves the published route alone and the row goes straight
  // back to offering play.
  func stopHarnessWeb() async {
    guard providerOperation == nil else { return }
    providerOperation = "harness"
    harnessSucceeded = false
    harnessMessage = routerLocalized("Stopping…")
    defer { providerOperation = nil }
    do {
      let output = try await runControl(arguments: ["harness", "stop"])
      let result = try JSONDecoder().decode(HarnessStopResult.self, from: output)
      await refresh()
      if result.stopped {
        harnessSucceeded = true
        harnessMessage = routerLocalized("Stopped. Memory and CPU released.")
      } else {
        // Never signal a process this router did not start. Say where it came
        // from instead of failing silently or killing somebody's terminal.
        harnessSucceeded = false
        harnessMessage = routerLocalized("This harness was started outside the router — stop it where you started it.")
      }
    } catch {
      harnessMessage = error.localizedDescription
      await refresh()
    }
  }

  // Remove the router's models from the harness. Distinct from stopping: this
  // is about the integration, not about what is resident.
  func disconnectHarness() async {
    guard providerOperation == nil else { return }
    providerOperation = "harness"
    harnessSucceeded = false
    harnessMessage = routerLocalized("Disconnecting…")
    defer { providerOperation = nil }
    do {
      _ = try await runControl(arguments: ["harness", "disconnect"])
      await refresh()
      harnessSucceeded = true
      harnessMessage = routerLocalized("Turned off. The harness and its own settings were kept.")
    } catch {
      harnessMessage = error.localizedDescription
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
      maintenanceMessage = "Repair verified. Fully quit and reopen Codex if models changed."
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

  func setSignedRouting(_ enabled: Bool) async {
    guard providerOperation == nil else { return }
    providerOperation = "signed-routing"
    defer { providerOperation = nil }
    do {
      _ = try await runControl(arguments: ["signed-routing", enabled ? "on" : "off"])
      await refresh()
      message = enabled
        ? "Router with ChatGPT enabled. Fully quit and reopen Codex when ready."
        : "Previous provider restored. Fully quit and reopen Codex when ready."
    } catch {
      await refresh()
      message = error.localizedDescription
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

  func setSubagentProvider(_ provider: String, enabled: Bool) async {
    await applyModelSettings(
      arguments: ["subagents", "provider", provider, enabled ? "on" : "off"]
    )
  }

  func setPickerModel(_ slug: String, visible: Bool) async {
    await applyModelSettings(
      arguments: ["picker", "set", slug, visible ? "show" : "hide"]
    )
  }

  func setPickerProvider(_ provider: String, visible: Bool) async {
    await applyModelSettings(
      arguments: ["picker", "provider", provider, visible ? "show" : "hide"]
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

  func setToolResultAgingEnabled(_ enabled: Bool) async {
    await applyModelSettings(
      arguments: ["tool-result-aging", enabled ? "on" : "off"],
      successMessage: enabled
        ? "Old tool-result compaction is on for the next external-model request."
        : "Exact tool results will be sent on the next external-model request."
    )
  }

  /// Picks a cloud engine ("auto" or a model slug) as the image reader, and
  /// optionally the reasoning effort it reads at. Passing "default" for the
  /// effort hands the level back to the model. One command, so the two never
  /// land out of step.
  func setVisionBridgeEngine(_ value: String, effort: String? = nil) async {
    var arguments = ["vision-bridge", "engine", value]
    if let effort { arguments.append(effort) }
    await applyModelSettings(arguments: arguments)
  }

  func setVisionBridgeEffort(_ effort: String) async {
    await applyModelSettings(arguments: ["vision-bridge", "effort", effort])
  }

  func setLocalModelEnabled(_ tag: String, enabled: Bool) async {
    await applyModelSettings(arguments: ["local-models", "set", tag, enabled ? "on" : "off"])
  }

  /// Deletes the model from disk. Irreversible short of downloading it again,
  /// so the tray arms the row before this is reachable.
  func uninstallLocalModel(_ tag: String) async {
    guard providerOperation == nil, localModelOperation == nil else { return }
    let startedAt = Date()
    localModelOperation = LocalModelOperation(tag: tag, kind: .uninstall)
    await applyModelSettings(arguments: ["local-models", "uninstall", tag, "--yes"])
    // A local delete can complete before SwiftUI presents the next frame, and
    // refresh removes the model row that used to own the only progress UI.
    // Keep the operation banner around long enough to be perceived.
    let remaining = 0.8 - Date().timeIntervalSince(startedAt)
    if remaining > 0 {
      try? await Task.sleep(nanoseconds: UInt64(remaining * 1_000_000_000))
    }
    localModelOperation = nil
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

  /// Measures Ollama's own eval counters, so the number is this machine's
  /// observed generation speed rather than a marketing estimate.
  func benchmarkLocalModelSpeed(_ tag: String) async {
    guard benchmarkingTag == nil else { return }
    benchmarkingTag = tag
    defer { benchmarkingTag = nil }
    do {
      _ = try await runControl(arguments: ["local-models", "benchmark", tag])
      await refresh()
      message = "\(tag) speed measured. Tokens per second is on its row."
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
    let startedAt = Date().timeIntervalSince1970 * 1_000
    visionDownload = VisionDownloadState(
      tag: tag,
      status: "downloading",
      detail: "starting",
      percent: 0,
      error: nil,
      startedAt: startedAt,
      updatedAt: startedAt
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

  /// Downloads a local chat model through Ollama, installs/starts Ollama when
  /// needed, and checks the model on for Codex after the pull completes. The
  /// control command returns immediately; the state file is polled so the
  /// tray remains responsive during multi-gigabyte downloads.
  /// `force` carries the operator's deliberate override for a model this
  /// machine is rated too small for. Every catalog entry is offered, so the
  /// only way to attempt an oversized one is to say so explicitly here.
  func downloadLocalModel(_ tag: String, force: Bool = false) async {
    guard localDownload?.isRunning != true else { return }
    let startedAt = Date().timeIntervalSince1970 * 1_000
    localDownload = VisionDownloadState(
      tag: tag,
      status: "downloading",
      detail: "starting",
      percent: 0,
      error: nil,
      startedAt: startedAt,
      updatedAt: startedAt
    )
    do {
      // `--yes` consents to installing and starting Ollama headlessly when it
      // is missing, so one click covers both the runtime and the model.
      var arguments = ["local-models", "install", tag, "--yes"]
      if force { arguments.append("--force") }
      _ = try await runControl(arguments: arguments)
    } catch {
      message = error.localizedDescription
      localDownload = VisionDownloadState(
        tag: tag,
        status: "error",
        detail: "failed",
        percent: 0,
        error: error.localizedDescription,
        startedAt: startedAt,
        updatedAt: Date().timeIntervalSince1970 * 1_000
      )
      return
    }
    await pollLocalDownload()
  }

  func updateLocalOllama() async {
    guard providerOperation == nil else { return }
    providerOperation = "models"
    defer { providerOperation = nil }
    do {
      _ = try await runControl(arguments: ["local-models", "runtime", "update", "--yes"])
      await refresh()
      message = "Ollama updated. Its headless server will be reused for local models."
    } catch {
      message = error.localizedDescription
    }
  }

  private func pollLocalDownload() async {
    while !Task.isCancelled {
      try? await Task.sleep(nanoseconds: 1_000_000_000)
      guard let data = try? await runControl(arguments: ["local-models", "list", "--json"]),
        let decoded = try? JSONDecoder().decode(LocalModelsSnapshot.self, from: data)
      else { continue }
      let state = decoded.download
      localDownload = state
      guard let state else { continue }
      if state.isRunning { continue }
      await refresh()
      message = state.status == "done"
        ? "\(state.tag ?? "Model") ready for Codex. Restart Codex to refresh its picker."
        : (state.error ?? "The local model download failed.")
      return
    }
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

  private func applyModelSettings(
    arguments: [String],
    successMessage: String = "Model settings applied. Restart Codex to refresh its picker."
  ) async {
    guard providerOperation == nil else { return }
    providerOperation = "models"
    defer { providerOperation = nil }
    do {
      _ = try await runControl(arguments: arguments)
      await refresh()
      message = successMessage
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
    let configuredPort = ProcessInfo.processInfo.environment["MODEL_ROUTER_PORT"] ?? "4202"
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
      if previousActivityState == .generating, health.activity.state != .generating {
        // Pull the just-finished request into the status speed without waiting
        // for the normal 30-second account polling interval.
        Task { await refreshProviderUsage() }
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
      return providerID.hasSuffix("-oauth")
        ? routerLocalized("OAuth · enabled")
        : routerLocalized("API · enabled")
    }
    if providerSetup[providerID]?.configured == true { return routerLocalized("Ready to enable") }
    return routerLocalized("Needs setup")
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
    guard let configured = Bundle.main.object(forInfoDictionaryKey: "ModelRouterSourceRoot") as? String,
      !configured.isEmpty
    else {
      throw RouterError("Cannot find this Model Router checkout. Rebuild the tray app from the router repository.")
    }
    return try validatedSourceRoot(URL(fileURLWithPath: configured, isDirectory: true))
  }

  private func validatedSourceRoot(_ root: URL) throws -> URL {
    let resolvedRoot = root.standardizedFileURL.resolvingSymlinksInPath()
    let control = resolvedRoot.appendingPathComponent("bin/control")
    guard FileManager.default.isExecutableFile(atPath: control.path) else {
      throw RouterError("Cannot find this Model Router checkout. Rebuild the tray app from the router repository.")
    }
    return resolvedRoot
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
  // Absent from an older router's output, so the tray keeps working against one
  // rather than failing the whole decode over a field it gained later.
  let presence: RouterPresence?
  let harness: RouterHarness?
  static let empty = RouterSnapshot(targets: [:], presence: nil, harness: nil)
}

struct HarnessStopResult: Decodable {
  let stopped: Bool
  let reason: String?
}

struct HarnessSetupResult: Decodable {
  struct Published: Decodable { let models: Int }
  let published: Published
  let launch: String
  let web: RouterHarnessWeb?
}

struct RouterHarness: Decodable {
  let package: String
  let installed: Bool
  let version: String?
  let published: Bool
  let nodeVersion: String
  let nodeSupported: Bool
  let minimumNode: String
  let web: RouterHarnessWeb?
}

struct RouterHarnessWeb: Decodable {
  let running: Bool
  let url: String?
  let port: Int?
}

struct RouterPresence: Decodable {
  let mode: String
  let effectiveMode: String
  let harnessPublished: Bool
  let terminalCodex: Bool
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

enum TokenDisplayUnit: String, CaseIterable, Identifiable {
  case full
  case millions

  var id: Self { self }

  var label: String {
    switch self {
    case .full: return routerLocalized("Full")
    case .millions: return "M"
    }
  }

  var accessibilityLabel: String {
    switch self {
    case .full: return routerLocalized("Full token numbers")
    case .millions: return routerLocalized("Millions of tokens")
    }
  }

  func format(_ value: Double) -> String {
    let normalized = value.isFinite ? max(0, value) : 0
    switch self {
    case .full:
      return Int64(normalized.rounded()).formatted(.number.grouping(.automatic))
    case .millions:
      return "\(String(format: "%.1f", normalized / 1_000_000))M"
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
    guard let minutes = windowDurationMins else { return routerLocalized("Current limit") }
    if minutes >= 1_440, minutes.isMultiple(of: 1_440) {
      let days = minutes / 1_440
      if days == 1 { return routerLocalized("Daily limit") }
      if days == 7 { return routerLocalized("Weekly limit") }
      return RouterLanguage.isSimplifiedChinese ? "\(days) 天限制" : "\(days)-day limit"
    }
    if minutes >= 60, minutes.isMultiple(of: 60) {
      return RouterLanguage.isSimplifiedChinese ? "\(minutes / 60) 小时限制" : "\(minutes / 60)-hour limit"
    }
    return RouterLanguage.isSimplifiedChinese ? "\(minutes) 分钟限制" : "\(minutes)-minute limit"
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
  let speedSampleCount: Int?
  let observedTokensPerSecond: Double?
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
  let signedRouting: Bool?
  let signedRoutingManaged: Bool?
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
    .init(id: "kimi-api-cn", displayName: "Kimi API (China)", kind: "openai-compatible"),
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
  let toolResultAging: ToolResultAgingSnapshot?
  let localModels: LocalModelsSnapshot?
  let visionBridge: VisionBridgeSnapshot?
}

struct ToolResultAgingSnapshot: Decodable {
  let enabled: Bool
  let environmentOverride: Bool?
  let stats: ToolResultAgingStats?
}

struct ToolResultAgingStats: Decodable {
  let requests: Int?
  let resultsAged: Int?
  let bytesSaved: Int?
  let estimatedTokensSaved: Int?
  let ranges: [String: ToolResultAgingRange]?

  var savingsSummary: String? {
    guard let requests, requests > 0, let estimatedTokensSaved, let bytesSaved else { return nil }
    let tokens = Self.compactCount(estimatedTokensSaved)
    let megabytes = String(format: "%.1f", Double(bytesSaved) / 1_048_576)
    return "Saved ~\(tokens) tokens (\(megabytes) MB) across \(requests) requests"
  }

  static func compactCount(_ value: Int) -> String {
    if value >= 1_000_000 { return String(format: "%.1fM", Double(value) / 1_000_000) }
    if value >= 1_000 { return String(format: "%.1fk", Double(value) / 1_000) }
    return String(value)
  }
}

struct ToolResultAgingRange: Decodable {
  let savedTokens: Int?
  let requests: Int?
  let buckets: [Int]?
  let cache: ToolResultAgingCache?
}

// Display order and labels for the savings card's range tabs. Keys must match
// the snapshot's `stats.ranges` keys from src/usage-events.mjs.
enum SavingsRange: String, CaseIterable {
  case day = "24h"
  case week = "7d"
  case month = "30d"

  var label: String {
    switch self {
    case .day: return "24H"
    case .week: return "7D"
    case .month: return "30D"
    }
  }

  var caption: String {
    switch self {
    case .day: return "tokens saved · last 24 hours"
    case .week: return "tokens saved · last 7 days"
    case .month: return "tokens saved · last 30 days"
    }
  }

  var bucketUnit: String {
    switch self {
    case .day: return "h"
    case .week, .month: return "d"
    }
  }
}

struct ToolResultAgingCache: Decodable {
  let agedRate: Double?
  let unagedRate: Double?
  let agedTurns: Int?
  let unagedTurns: Int?

  // One line of measured evidence, shown only when both sides have data:
  // "Cache 99.0% normal · 99.5% compacted" answers the break-the-cache worry
  // with the provider's own telemetry.
  var comparisonSummary: String? {
    guard let agedRate, let unagedRate, let agedTurns, agedTurns > 0 else { return nil }
    let normal = String(format: "%.1f%%", unagedRate * 100)
    let compacted = String(format: "%.1f%%", agedRate * 100)
    return "Cache \(normal) normal · \(compacted) compacted (n=\(agedTurns))"
  }
}

struct LocalModelsSnapshot: Decodable {
  let installed: Int
  let enabled: Int
  let usableAsChat: Int?
  let totalGb: Double
  let models: [InstalledLocalModel]
  // Optional so a tray built against this snapshot keeps decoding one from an
  // older router that has no suggestions to offer.
  let available: [AvailableLocalModel]?
  let availableVision: [AvailableVisionModel]?
  let availableExplore: [AvailableLocalModel]?
  let machine: String?
  let families: [LocalModelFamily]?
  let download: VisionDownloadState?
  let runtime: LocalRuntimeSnapshot?
  let catalog: LocalCatalogSnapshot?
}

struct LocalRuntimeSnapshot: Decodable {
  let installed: Bool?
  let version: String?
  let running: Bool?
  let managed: Bool?
  let modelsPath: String?
}

struct LocalCatalogSnapshot: Decodable {
  let mode: String?
  let note: String?
}

struct LocalModelFamily: Decodable, Identifiable {
  let family: String
  let displayName: String
  let variants: [String]
  var id: String { family }
}

/// A model/tag worth displaying, already rated against this machine's memory
/// by the router. Cloud aliases are intentionally visible but non-downloadable.
struct AvailableLocalModel: Decodable, Identifiable, Equatable {
  let tag: String
  let family: String?
  let variant: String?
  let displayName: String?
  let sizeGb: Double
  let tools: Bool
  let context: Int?
  /// What running the real Codex client against this model actually produced.
  /// A tool template predicts it in neither direction, so "untested" stays
  /// untested rather than reading as a recommendation.
  let codex: String?
  let note: String
  let fit: String
  let diskFit: String?
  let speedStatus: String?
  let downloadable: Bool?
  /// Research captured from the official Ollama family page. This is kept
  /// separate from `tools` and `codex`: upstream capability labels are not a
  /// substitute for a real post-install Codex check.
  let researchStatus: String?
  let researchCapabilities: [String]?
  let researchNote: String?
  var id: String { tag }

  var isVerified: Bool { codex == "verified" }
}

/// A model that can only read images. Ranked by what it actually scored
/// against a known image, never by size alone.
struct AvailableVisionModel: Decodable, Identifiable, Equatable {
  let tag: String
  let sizeGb: Double
  let accuracy: String
  let note: String
  let fit: String
  let diskFit: String?
  var id: String { tag }
}

struct InstalledLocalModel: Decodable, Identifiable, Equatable {
  let tag: String
  let family: String?
  let variant: String?
  let sizeGb: Double
  let modified: String?
  let enabled: Bool
  let running: Bool
  let vision: Bool
  let tools: Bool?
  let accuracy: String?
  let agent: String?
  let tokensPerSecond: Double?
  let speedStatus: String?
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
    if tools != true { return routerLocalized("no tools — can't chat") }
    switch agent {
    case "agent": return routerLocalized("works in Codex")
    case "flaky": return routerLocalized("unreliable in Codex")
    case "not-published": return routerLocalized("not offered yet")
    case .some: return routerLocalized("fails in Codex")
    default: return routerLocalized("chat — untested")
    }
  }

  var chatRoleGood: Bool { tools == true && agent == "agent" }
}

struct VisionEngineOption: Decodable, Identifiable, Equatable {
  let slug: String
  let displayName: String
  // The reasoning levels this model itself declares. Older routers do not send
  // them, and some models declare none, so an empty list means "no level to
  // choose" rather than "no levels allowed".
  let efforts: [String]?
  var id: String { slug }
}

struct VisionBridgeSnapshot: Decodable {
  let enabled: Bool
  let engine: String?
  let local: VisionLocalPin?
  let resolvedEngine: String?
  let resolvedEngineName: String?
  let hostMemGib: Double?
  let paidEngines: [VisionEngineOption]
  // Vision models from the signed-in ChatGPT session. Older routers do not send
  // this, so it defaults to empty rather than failing the whole decode.
  let nativeEngines: [VisionEngineOption]?
  /// Pinned reasoning effort, `nil` when the reader runs at its own default.
  let effort: String?
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
  // These timestamps let the tray reject an older terminal record when the
  // operator retries the same tag while a refresh is in flight.
  let startedAt: Double?
  let updatedAt: Double?

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
    case .always: return routerLocalized("Always")
    case .followCodex: return routerLocalized("With Codex")
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
    case .off: return routerLocalized("Off")
    case .notch: return routerLocalized("Notch")
    case .desktop: return routerLocalized("Desktop")
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
  let credentialLabel: String?
  // Set when connecting successfully still leaves the account unable to use
  // the API, because its plan does not include one. Shown before the buttons
  // rather than after a 403 lands in Codex.
  let planNote: String?
  let anonymousNote: String?
}

private struct StatusItemLabel: View {
  @ObservedObject var store: RouterStore
  @State private var pulsing = false
  private static let reservedWidth: CGFloat = 180

  var body: some View {
    HStack(spacing: 5) {
      Circle()
        .fill(store.activityState.tint)
        .frame(width: 6, height: 6)
        // Opening a menu bar app gives the user nothing to look at, so the
        // status dot answers instead. SwiftUI offers no supported way to open a
        // MenuBarExtra window programmatically -- the usual trick reaches into
        // the private NSStatusItem behind it -- and a dot that visibly reacts is
        // worth more than a private API that breaks on the next macOS release.
        .scaleEffect(pulsing ? 2.1 : 1)
        .opacity(pulsing ? 0.55 : 1)
        .animation(.easeOut(duration: 0.45), value: pulsing)
        .onChange(of: store.attentionPulse) { _ in
          pulsing = true
          Task {
            try? await Task.sleep(for: .milliseconds(450))
            pulsing = false
          }
        }
      Text(store.hasConcurrentActivity ? store.activitySummaryLabel : store.selectedUsageProvider.shortName)
        .font(.system(size: 11, weight: .medium, design: .rounded))
        .lineLimit(1)
        .truncationMode(.tail)
      if store.hasConcurrentActivity {
        Text(store.compactActivityProvidersLabel)
          .font(.system(size: 10, weight: .medium, design: .rounded))
          .foregroundStyle(routerMuted)
          .lineLimit(1)
          .truncationMode(.tail)
      } else if let usage = store.selectedUsageText {
        Text(usage)
          .font(.system(size: 10, weight: .medium, design: .monospaced))
          .foregroundStyle(routerMuted)
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
    case .usage: return routerLocalized("Usage")
    case .status: return routerLocalized("Status")
    case .settings: return routerLocalized("Settings")
    }
  }
}

private struct TrayView: View {
  @ObservedObject var store: RouterStore
  @AppStorage("trayTab") private var tab: TrayTab = .usage
  @State private var providersExpanded = true
  @State private var savingsRange: SavingsRange = .day

  private var target: RouterTarget? { store.snapshot.targets["codex"] }
  // Rows come from the registry snapshot, not from the models in the picker.
  // Deriving them from models hid every provider that ships none until its
  // models were curated — which is backwards, because the row is where the
  // operator sets a provider up. That left the ten catalog-only services and
  // the keyless local provider invisible in the one place built to configure
  // them. The model-derived list survives only for routers that predate the
  // snapshot's `providers` field.
  private var providers: [(id: String, enabled: Bool)] {
    guard let target else { return [] }
    if let registry = target.providers, !registry.isEmpty {
      let enabled = Set(target.enabledProviders)
      return registry
        .map { (id: $0.id, enabled: enabled.contains($0.id)) }
        .sorted { $0.id < $1.id }
    }
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
    .foregroundStyle(routerText)
    .task { await store.refresh() }
  }


  private var header: some View {
    HStack(alignment: .center, spacing: 12) {
      VStack(alignment: .leading, spacing: 3) {
        Text(routerLocalized("Model Router"))
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
    guard let plan = store.accountUsage?.planType else { return routerLocalized("Codex account") }
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
      emptyNotice(routerLocalized("No usage recorded yet"))
    }
    if !store.visibleUsageProviders.isEmpty {
      sectionLabel(routerLocalized("Current usage"), detail: store.selectedUsageProvider.displayName)
      ProviderUsageSection(store: store)
        .id(store.selectedUsageProviderID)
      sectionLabel(routerLocalized("All usage"), detail: routerLocalized("7-day snapshot"))
      AllProviderUsageGrid(store: store)
    }
    if !store.overallModelUsage.isEmpty {
      sectionLabel(
        routerLocalized("Tokens by model"),
        detail: "\(compactTokenCount(Double(store.overallTokenTotal))) tok · \(store.overallRequestTotal) req"
      )
      ModelUsageBreakdown(store: store)
    }
  }

  @ViewBuilder
  private var statusTab: some View {
    sectionLabel(routerLocalized("Router"), detail: store.activitySummaryLabel)
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

    sectionLabel(routerLocalized("Model speed"), detail: speedSampleDetail)
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      VStack(alignment: .leading, spacing: 2) {
        Text(activeModelLabel)
          .font(.system(size: 10, weight: .medium))
          .lineLimit(1)
          .truncationMode(.middle)
        Text(speedExplanation)
          .font(.system(size: 8))
          .foregroundStyle(routerMuted)
          .lineLimit(1)
      }
      Spacer(minLength: 8)
      Text(activeModelSpeedLabel)
        .font(.system(size: 15, weight: .semibold, design: .monospaced))
        .foregroundStyle(store.activeModelObservedTokensPerSecond == nil ? routerMuted : routerMint)
        .monospacedDigit()
    }
    .padding(9)
    .background(
      Color.primary.opacity(0.045),
      in: RoundedRectangle(cornerRadius: 9, style: .continuous)
    )
    // Issue #182: the card above tracks the active model only, so a second
    // model's speed was unknowable without switching to it and waiting.
    if store.recentModelSpeeds.count > 1 {
      VStack(spacing: 0) {
        ForEach(store.recentModelSpeeds) { row in
          HStack(spacing: 8) {
            Text(row.model.displayName ?? row.model.slug)
              .font(.system(size: 9))
              .lineLimit(1)
              .truncationMode(.middle)
            Spacer(minLength: 8)
            Text(row.providerName)
              .font(.system(size: 8))
              .foregroundStyle(routerMuted)
              .lineLimit(1)
            Text(row.model.observedTokensPerSecond.map { String(format: "%.1f", $0) } ?? "—")
              .font(.system(size: 9, weight: .medium, design: .monospaced))
              .foregroundStyle(routerMint)
              .monospacedDigit()
              .frame(width: 46, alignment: .trailing)
          }
          .padding(.vertical, 3)
          .padding(.horizontal, 9)
        }
      }
      .padding(.vertical, 2)
      .background(
        Color.primary.opacity(0.03),
        in: RoundedRectangle(cornerRadius: 9, style: .continuous)
      )
    }

    if let agingStats = target?.modelSettings?.toolResultAging?.stats,
       let agedRequests = agingStats.requests, agedRequests > 0 {
      let range = agingStats.ranges?[savingsRange.rawValue]
      sectionLabel("Context savings", detail: "\(agedRequests) requests compacted all-time")
      VStack(alignment: .leading, spacing: 8) {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          VStack(alignment: .leading, spacing: 2) {
            Text("Old tool results replaced with receipts")
              .font(.system(size: 10, weight: .medium))
              .lineLimit(1)
            Text("\(range?.requests ?? 0) compacted requests in this window")
              .font(.system(size: 8))
              .foregroundStyle(routerMuted)
              .lineLimit(1)
          }
          Spacer(minLength: 8)
          VStack(alignment: .trailing, spacing: 4) {
            HStack(spacing: 2) {
              ForEach(SavingsRange.allCases, id: \.rawValue) { candidate in
                Button {
                  savingsRange = candidate
                } label: {
                  Text(candidate.label)
                    .font(.system(size: 8, weight: savingsRange == candidate ? .bold : .regular))
                    .foregroundStyle(savingsRange == candidate ? routerMint : routerMuted)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 2)
                    .background(
                      savingsRange == candidate ? Color.primary.opacity(0.08) : Color.clear,
                      in: RoundedRectangle(cornerRadius: 4, style: .continuous)
                    )
                }
                .buttonStyle(.plain)
              }
            }
            Text("~\(compactTokenCount(Double(range?.savedTokens ?? 0))) tok")
              .font(.system(size: 15, weight: .semibold, design: .monospaced))
              .foregroundStyle(routerMint)
              .monospacedDigit()
          }
        }
        if let buckets = range?.buckets, buckets.contains(where: { $0 > 0 }) {
          SavingsSparkBars(
            buckets: buckets,
            caption: savingsRange.caption,
            bucketUnit: savingsRange.bucketUnit
          )
        } else {
          Text("Nothing compacted in this window")
            .font(.system(size: 8))
            .foregroundStyle(routerMuted)
        }
        if let cacheLine = range?.cache?.comparisonSummary {
          Text(cacheLine)
            .font(.system(size: 8))
            .foregroundStyle(routerMuted)
            .lineLimit(1)
        }
      }
      .padding(9)
      .background(
        Color.primary.opacity(0.045),
        in: RoundedRectangle(cornerRadius: 9, style: .continuous)
      )
    }

    sectionLabel(
      routerLocalized("Live requests"),
      detail: store.activeRequests.isEmpty ? routerLocalized("None") : "\(store.activeRequests.count)"
    )
    if store.activeRequests.isEmpty {
      emptyNotice(routerLocalized("Nothing in flight"))
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
      sectionLabel(routerLocalized("Quota resets"), detail: "\(quotaResets.count)")
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
    guard store.activeRequestCount > 0 else { return routerLocalized("No traffic right now") }
    let chats = store.activeChatCount
    let requests = store.activeRequestCount
    if RouterLanguage.isSimplifiedChinese {
      return "\(chats) 个会话 · \(requests) 个请求进行中"
    }
    return "\(chats) chat\(chats == 1 ? "" : "s") · \(requests) request\(requests == 1 ? "" : "s") in flight"
  }

  private var activeModelLabel: String {
    guard let model = store.activeRequests.last?.model ?? store.activeModel else {
      return routerLocalized("No model observed")
    }
    return model.split(separator: "/").last.map(String.init) ?? model
  }

  private var activeModelSpeedLabel: String {
    guard let speed = store.activeModelObservedTokensPerSecond else { return "— tok/s" }
    return "\(String(format: "%.1f", speed)) tok/s"
  }

  private var speedSampleDetail: String {
    guard let model = store.activeRequests.last?.model ?? store.activeModel else { return routerLocalized("Waiting") }
    let displayName = model.split(separator: "/").last.map(String.init) ?? model
    let sampleCount = store.providerUsage?.providers
      .flatMap { $0.models ?? [] }
      .first { $0.slug == model || $0.displayName == displayName }?
      .speedSampleCount ?? 0
    return sampleCount == 0
      ? routerLocalized("No samples")
      : RouterLanguage.isSimplifiedChinese
        ? "\(sampleCount) 条回复"
        : "\(sampleCount) reply\(sampleCount == 1 ? "" : "s")"
  }

  private var speedExplanation: String {
    store.activeModelObservedTokensPerSecond == nil
      ? routerLocalized("Appears after a metered reply")
      : routerLocalized("Observed output throughput")
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
        Text(routerLocalized("Show tray"))
          .font(.system(size: 12, weight: .medium))
        Text(store.presenceMode == .followCodex && store.routerPinsServiceOn
          ? routerLocalized("Kept on: a terminal session has no window to follow")
          : store.presenceMode == .followCodex
            ? routerLocalized("Appears with Codex or ChatGPT, hides when they quit")
            : routerLocalized("Menu bar icon stays visible"))
          .font(.system(size: 10))
          .foregroundStyle(routerMuted)
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
        Text(routerLocalized("Language"))
          .font(.system(size: 12, weight: .medium))
        Text(routerLocalized("Tray language. Reopen the panel to apply everywhere."))
          .font(.system(size: 10))
          .foregroundStyle(routerMuted)
      }
      Spacer()
      // A dropdown rather than the segmented style the neighbouring rows use:
      // the option labels are written in the language each one selects, so
      // they are different scripts and different widths, and a segmented
      // control would size every cell to the widest and leave the Latin ones
      // adrift. A dropdown also stays right when a third language lands.
      Picker("", selection: Binding(
        get: { store.language },
        set: { store.setLanguage($0) }
      )) {
        ForEach(TrayLanguage.allCases) { option in
          Text(option.label).tag(option)
        }
      }
      .pickerStyle(.menu)
      .labelsHidden()
      .frame(width: 168)
    }
    .padding(.vertical, 2)
    HStack(spacing: 12) {
      VStack(alignment: .leading, spacing: 3) {
        Text(routerLocalized("Dynamic Island"))
          .font(.system(size: 12, weight: .medium))
        Text(store.islandMode == .desktop
          ? routerLocalized("Quotas and live activity pinned to the desktop")
          : store.islandMode == .notch
            ? routerLocalized("Usage and activity over the notch on every display")
            : routerLocalized("Off by default. The menu-bar panel stays available either way."))
          .font(.system(size: 10))
          .foregroundStyle(routerMuted)
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
      title: routerLocalized("Use Router with ChatGPT"),
      detail: store.signedRouting
        ? routerLocalized("Native GPT + external models · task history preserved")
        : routerLocalized("Keep ChatGPT login and the current task history"),
      isOn: Binding(
        get: { store.signedRouting },
        set: { enabled in Task { await store.setSignedRouting(enabled) } }
      ),
      isDisabled: store.providerOperation != nil || store.loginFree
    )
    settingRow(
      title: routerLocalized("Use without OpenAI login"),
      detail: store.loginFree
        ? routerLocalized("External providers · Codex restarts automatically")
        : routerLocalized("Use connected models and restart Codex"),
      isOn: Binding(
        get: { store.loginFree },
        set: { enabled in Task { await store.setLoginFree(enabled) } }
      ),
      isDisabled: store.providerOperation != nil || store.signedRouting
    )
    settingRow(
      title: routerLocalized("Compact old tool results (experimental)"),
      detail: target.modelSettings?.toolResultAging?.environmentOverride == true
        ? routerLocalized("Forced off by CODEX_ROUTER_TOOL_RESULT_AGING=0")
        : (target.modelSettings?.toolResultAging?.stats?.savingsSummary
          ?? routerLocalized("Off by default · replaces consumed tool results on external models")),
      isOn: Binding(
        get: { target.modelSettings?.toolResultAging?.enabled ?? true },
        set: { enabled in Task { await store.setToolResultAgingEnabled(enabled) } }
      ),
      isDisabled: store.providerOperation != nil
        || target.modelSettings?.toolResultAging?.environmentOverride == true
    )
    harnessRow
    maintenanceRow
    AccordionPanel(
      title: routerLocalized("Providers"),
      summary: store.providerOperation == nil ? routerLocalized("Auto-saved") : routerLocalized("Applying…"),
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
    // Local models are a first-class install surface. Keep this section open
    // on launch so the catalog is not hidden behind the other settings cards.
    @State private var localLlmExpanded = true
    @State private var localDetailsExpanded = false
    @State private var expandedLocalFamilies = Set<String>()
    @State private var expandedLocalVariants = Set<String>()
    @State private var variantHelpExpanded = false
    @State private var localCatalogFilter = ""
    @State private var installTag = ""
    @State private var armedRemoval: String?
    // Set to the tag awaiting an "it will not fit here" confirmation. Held as
    // the tag rather than a Bool so the alert can name the model.
    @State private var pendingOversizedInstall: String?
    @State private var quickPicksExpanded = false
    @State private var collapsedProviders = Set<String>()

    private struct ProviderModels: Identifiable {
      let provider: String
      let models: [RouterModel]
      var id: String { provider }
    }

    private struct LocalCatalogFamily: Identifiable {
      let family: String
      let displayName: String
      let models: [AvailableLocalModel]
      let researchStatus: String?
      let researchCapabilities: [String]
      let researchNote: String?
      var id: String { family }
    }

    private var settings: ModelSettingsSnapshot? { target.modelSettings }
    private var busy: Bool { store.providerOperation == "models" }

    // Hidden models stay listed here. A model hidden from the picker cannot be
    // a subagent either, but dropping its row made it look deleted and left no
    // way back to it from this panel -- the tray must always show every model
    // it can still change.
    private var enabledExternalModels: [RouterModel] {
      target.models
        .filter {
          $0.enabled && $0.provider != "openai" && $0.multiAgentVersion == "v2"
        }
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

    // Keyed by section as well as provider: "Subagent models" and "Model
    // picker" list the same providers for different settings, so a shared key
    // made expanding one open the other and turned the two panels into
    // look-alikes -- which is how a subagent toggle gets mistaken for a picker
    // toggle.
    private func providerBinding(_ section: String, _ provider: String) -> Binding<Bool> {
      let key = "\(section):\(provider)"
      return Binding(
        get: { !collapsedProviders.contains(key) },
        set: { expanded in
          if expanded {
            collapsedProviders.remove(key)
          } else {
            collapsedProviders.insert(key)
          }
        }
      )
    }

    // Per-provider counts, so a click that lands on the wrong panel is visible
    // in the header it did not change instead of only in Codex's picker.
    private func subagentGroupSummary(_ group: ProviderModels) -> String {
      "\(group.models.filter { isSubagent($0) }.count) of \(group.models.count) on"
    }

    private func pickerGroupSummary(_ group: ProviderModels) -> String {
      "\(group.models.filter { !hiddenModels.contains($0.slug) }.count) of \(group.models.count) visible"
    }

    var body: some View {
      VStack(alignment: .leading, spacing: 10) {
        AccordionPanel(
          title: routerLocalized("Subagent models"),
          summary: subagentSummary,
          expanded: $subagentsExpanded
        ) {
          VStack(alignment: .leading, spacing: 8) {
            toggleRow(
              title: routerLocalized("All proven models"),
              detail: settings?.subagents.mode == "all"
                ? "Every proven v2 model can run as a subagent"
                : "Only selected proven v2 models can run as subagents",
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
            Text(routerLocalized("Subagent choices do not hide models from Codex's picker — use Model picker below for that."))
              .font(.system(size: 9))
              .foregroundStyle(routerMuted)
            toolbar(
              buttons: [
                ("Subagents on", { Task { await store.selectAllSubagents() } }),
                ("Subagents off", { Task { await store.unselectAllSubagents() } }),
              ]
            )
            ForEach(providerGroups(enabledExternalModels)) { group in
              AccordionPanel(
                title: providerName(group.provider),
                summary: subagentGroupSummary(group),
                expanded: providerBinding("subagents", group.provider)
              ) {
                VStack(alignment: .leading, spacing: 6) {
                  toolbar(
                    buttons: [
                      ("Subagents on", {
                        Task { await store.setSubagentProvider(group.provider, enabled: true) }
                      }),
                      ("Subagents off", {
                        Task { await store.setSubagentProvider(group.provider, enabled: false) }
                      }),
                    ]
                  )
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
                      disabled: busy || model.visible == false
                    )
                  }
                }
              }
            }
          }
        }

        AccordionPanel(
          title: routerLocalized("Model picker"),
          summary: pickerSummary,
          expanded: $pickerExpanded
        ) {
          VStack(alignment: .leading, spacing: 8) {
            Text(routerLocalized("Hidden models stay connected but are not offered by Codex."))
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
                summary: pickerGroupSummary(group),
                expanded: providerBinding("picker", group.provider)
              ) {
                VStack(alignment: .leading, spacing: 6) {
                  toolbar(
                    buttons: [
                      ("Show all", {
                        Task { await store.setPickerProvider(group.provider, visible: true) }
                      }),
                      ("Hide all", {
                        Task { await store.setPickerProvider(group.provider, visible: false) }
                      }),
                    ]
                  )
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
          title: routerLocalized("Local LLMs"),
          summary: localLlmSummary,
          expanded: $localLlmExpanded
        ) {
          localLlmPanel
        }

        // Header says "Vision" and nothing else; the state it used to summarise
        // is one line below, in the toggle's own detail.
        AccordionPanel(
          title: routerLocalized("Vision"),
          summary: "",
          expanded: $visionExpanded
        ) {
          visionPanel
        }
      }
      .alert(
        routerLocalized("Download anyway?"),
        isPresented: Binding(
          get: { pendingOversizedInstall != nil },
          set: { presented in if !presented { pendingOversizedInstall = nil } }
        ),
        presenting: pendingOversizedInstall
      ) { tag in
        Button("\(routerLocalized("Download")) \(tag)", role: .destructive) {
          pendingOversizedInstall = nil
          Task { await store.downloadLocalModel(tag, force: true) }
        }
        Button(routerLocalized("Cancel"), role: .cancel) { pendingOversizedInstall = nil }
      } message: { tag in
        Text(
          RouterLanguage.isSimplifiedChinese
            ? "\(tag) 对本机内存或可用磁盘空间来说过大。仍会下载，但可能无法加载或运行非常缓慢。"
            : "\(tag) is rated too large for this machine's memory or free disk. "
              + "It will download, but it may fail to load or run very slowly."
        )
      }
    }

    // Everything installed through Ollama, in one place: check the ones to
    // offer Codex, install more by tag, remove the ones eating disk. Checking a
    // model is not the same as downloading it and not the same as deleting it,
    // so the three actions stay visibly separate.
    //
    // The popover is 352pt wide, so identity stays on one compact line and
    // secondary actions live behind an overflow menu. Long tags and role
    // phrases truncate in place instead of making the panel wider or taller.
    @ViewBuilder private var localLlmPanel: some View {
      VStack(alignment: .leading, spacing: 10) {
        Text(routerLocalized("Run models locally through Ollama. Enable an installed model to make it available to Codex."))
          .font(.system(size: 9))
          .foregroundStyle(routerMuted)
        if let operation = store.localModelOperation {
          localModelOperationStatus(operation)
            .transition(.opacity.combined(with: .scale(scale: 0.98, anchor: .top)))
        }
        if let download = store.localDownload {
          localDownloadStatus(download)
        }
        localInstalledSection
        localQuickPicksSection
        if let explore = localModels?.availableExplore, !explore.isEmpty {
          localCatalogSection(explore)
        }
        localInstallSection
        Button(routerLocalized(localDetailsExpanded ? "Hide machine & runtime" : "Machine & runtime")) {
          withAnimation(.easeOut(duration: 0.15)) { localDetailsExpanded.toggle() }
        }
        .buttonStyle(.borderless)
        .font(.system(size: 9, weight: .medium))
        .foregroundStyle(routerMutedStrong)
        if localDetailsExpanded {
          localDetails
        }
      }
      .animation(.easeOut(duration: 0.2), value: store.localModelOperation)
    }

    @ViewBuilder private func localModelOperationStatus(_ operation: LocalModelOperation) -> some View {
      HStack(spacing: 9) {
        OperationPulse(tint: routerRed)
        VStack(alignment: .leading, spacing: 2) {
          Text("\(routerLocalized(operation.kind.label)) \(routerLocalized("local model"))")
            .font(.system(size: 9, weight: .semibold))
            .foregroundStyle(routerRed)
          Text(operation.tag)
            .font(.system(size: 9, weight: .medium, design: .monospaced))
            .foregroundStyle(routerMutedStrong)
            .lineLimit(1)
            .truncationMode(.middle)
        }
        Spacer(minLength: 4)
        ProgressView()
          .controlSize(.small)
          .tint(routerRed)
      }
      .padding(8)
      .background(
        routerRed.opacity(0.08),
        in: RoundedRectangle(cornerRadius: 8, style: .continuous)
      )
      .accessibilityElement(children: .combine)
      .accessibilityLabel("\(routerLocalized(operation.kind.label)) \(routerLocalized("local model")) \(operation.tag)")
    }

    @ViewBuilder private var localInstalledSection: some View {
      let installedCount = sortedLocalModels.count
      let detail = installedCount == 0
        ? routerLocalized("none installed")
        : "\(installedCount) \(routerLocalized("installed")) · \(String(format: "%.1f", localModels?.totalGb ?? 0)) GB"
      downloadHeader("ON THIS MAC", detail: detail)
      if sortedLocalModels.isEmpty {
        Text(routerLocalized("Nothing installed yet. Start with a quick pick or browse the Ollama catalog below."))
          .font(.system(size: 9))
          .foregroundStyle(routerMutedStrong)
      } else {
        HStack(spacing: 0) {
          Text(routerLocalized("CODEX"))
            .frame(width: Self.checkColumnWidth, alignment: .leading)
          Text(routerLocalized("MODEL"))
          Spacer()
          Text(routerLocalized("SIZE"))
        }
        .font(.system(size: 8, weight: .semibold))
        .foregroundStyle(routerMuted)
        .padding(.horizontal, 2)
        VStack(spacing: 7) {
          ForEach(sortedLocalModels) { model in
            installedLocalRow(model)
          }
        }
      }
    }

    @ViewBuilder private var localQuickPicksSection: some View {
      if !suggestedLocalModels.isEmpty || !suggestedVisionModels.isEmpty {
        downloadHeader("QUICK PICKS", detail: "shortlist for this Mac")
        if !visibleQuickCodingModels.isEmpty {
          Text(routerLocalized("CODING"))
            .font(.system(size: 8, weight: .semibold))
            .foregroundStyle(routerMuted)
          VStack(spacing: 3) {
            ForEach(visibleQuickCodingModels) { model in
              quickCodingRow(model)
            }
          }
        }
        if !visibleQuickVisionModels.isEmpty {
          Text(routerLocalized("IMAGE READING"))
            .font(.system(size: 8, weight: .semibold))
            .foregroundStyle(routerMuted)
            .padding(.top, 2)
          VStack(spacing: 3) {
            ForEach(visibleQuickVisionModels) { model in
              quickVisionRow(model)
            }
          }
        }
        if quickPickRemainingCount > 0 || quickPicksExpanded {
          Button(
            quickPicksExpanded
              ? routerLocalized("Show fewer quick picks")
              : (RouterLanguage.isSimplifiedChinese
                  ? "再显示 \(quickPickRemainingCount) 个快速选项"
                  : "Show \(quickPickRemainingCount) more quick picks")
          ) {
            withAnimation(.easeOut(duration: 0.15)) { quickPicksExpanded.toggle() }
          }
          .buttonStyle(.borderless)
          .font(.system(size: 8, weight: .medium))
          .foregroundStyle(routerMutedStrong)
        }
      }
    }

    @ViewBuilder private func localCatalogSection(_ explore: [AvailableLocalModel]) -> some View {
      let cloudCount = explore.filter { $0.downloadable == false }.count
      let visibleTagCount = localCatalogFamilies.reduce(0) { $0 + $1.models.count }
      let visibleCloudCount = localCatalogFamilies
        .flatMap(\.models)
        .filter { $0.downloadable == false }
        .count
      let showingAllCatalog = localCatalogFilter.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      let shownCloudCount = showingAllCatalog ? cloudCount : visibleCloudCount
      let catalogDetail = RouterLanguage.isSimplifiedChinese
        ? (showingAllCatalog
            ? "\(localCatalogFamilies.count) 个系列 · \(explore.count) 个标签"
            : "\(localCatalogFamilies.count) 个系列 · \(visibleTagCount) 个匹配")
        : (showingAllCatalog
            ? "\(localCatalogFamilies.count) families · \(explore.count) tags"
            : "\(localCatalogFamilies.count) families · \(visibleTagCount) matches")
      downloadHeader(
        "DISCOVER OLLAMA",
        detail: catalogDetail +
          (shownCloudCount > 0
            ? (RouterLanguage.isSimplifiedChinese ? " · \(shownCloudCount) 个仅云端" : " · \(shownCloudCount) cloud-only")
            : "")
      )
      Button(routerLocalized(variantHelpExpanded ? "Hide tag guide" : "What do these tags mean?")) {
        withAnimation(.easeOut(duration: 0.15)) { variantHelpExpanded.toggle() }
      }
      .buttonStyle(.borderless)
      .font(.system(size: 8, weight: .medium))
      .foregroundStyle(routerMutedStrong)
      if variantHelpExpanded {
        Text(routerLocalized("Size tags choose the model scale. Q4/Q8/BF16 are weight precision; MLX/NVFP4 are hardware-oriented builds; cloud tags run remotely. Codex compatibility is checked only after a pull."))
          .font(.system(size: 8))
          .foregroundStyle(routerMuted)
          .fixedSize(horizontal: false, vertical: true)
          .padding(.top, 2)
      }
      HStack(spacing: 6) {
        TextField(routerLocalized("Search family or tag"), text: $localCatalogFilter)
          .textFieldStyle(.roundedBorder)
          .font(.system(size: 10))
        if !localCatalogFilter.isEmpty {
          Button(routerLocalized("Clear")) { localCatalogFilter = "" }
            .buttonStyle(.borderless)
            .font(.system(size: 9, weight: .medium))
            .foregroundStyle(routerMutedStrong)
        }
      }
      if localCatalogFamilies.isEmpty {
        Text(
          RouterLanguage.isSimplifiedChinese
            ? "没有匹配“\(localCatalogFilter)”的 Ollama 标签。"
            : "No Ollama tags match \"\(localCatalogFilter)\"."
        )
          .font(.system(size: 9))
          .foregroundStyle(routerMutedStrong)
          .padding(.top, 2)
      } else {
        VStack(spacing: 0) {
          ForEach(localCatalogFamilies) { family in
            localFamilySection(family)
          }
        }
      }
    }

    @ViewBuilder private var localInstallSection: some View {
      downloadHeader("INSTALL A MODEL", detail: "Ollama tag or URL")
      Text(routerLocalized("Use a tag or model-page URL. Downloads stay headless."))
        .font(.system(size: 8))
        .foregroundStyle(routerMuted)
      HStack(spacing: 6) {
        TextField(routerLocalized("gemma4:12b or ollama.com/library/gemma4:12b"), text: $installTag)
          .textFieldStyle(.roundedBorder)
          .font(.system(size: 10))
          .disabled(busy || store.localDownload?.isRunning == true)
          .onSubmit { submitInstall() }
        Button(routerLocalized("Install")) { submitInstall() }
          .buttonStyle(.borderless)
          .font(.system(size: 9, weight: .medium))
          .foregroundStyle(canInstall ? routerMint : routerMutedStrong)
          .disabled(!canInstall)
      }
    }

    @ViewBuilder private func localFamilySection(_ family: LocalCatalogFamily) -> some View {
      Button(action: {
        withAnimation(.easeOut(duration: 0.15)) {
          if expandedLocalFamilies.contains(family.id) {
            expandedLocalFamilies.remove(family.id)
          } else {
            expandedLocalFamilies.insert(family.id)
          }
        }
      }) {
        HStack(spacing: 8) {
          VStack(alignment: .leading, spacing: 2) {
            Text(family.displayName)
              .font(.system(size: 10, weight: .medium))
              .lineLimit(1)
            Text(localFamilySummary(family))
              .font(.system(size: 8))
              .foregroundStyle(routerMutedStrong)
              .lineLimit(1)
          }
          Spacer(minLength: 4)
          Image(systemName: expandedLocalFamilies.contains(family.id) ? "chevron.down" : "chevron.right")
            .font(.system(size: 9, weight: .semibold))
            .foregroundStyle(routerMuted)
        }
        .padding(.vertical, 7)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      if expandedLocalFamilies.contains(family.id) {
        localFamilyPanel(family)
          .padding(.bottom, 7)
      }
      Divider()
    }

    @ViewBuilder private func localFamilyPanel(_ family: LocalCatalogFamily) -> some View {
      let recommended = recommendedLocalVariant(in: family.models)
      let expanded = expandedLocalVariants.contains(family.id)
      let visibleVariants = expanded
        ? family.models
        : localPreviewVariants(in: family.models, excluding: recommended)
      let rows = visibleVariants.filter { $0.tag != recommended?.tag }
      let shownCount = rows.count + (recommended == nil ? 0 : 1)
      let hiddenCount = max(0, family.models.count - shownCount)

      if let status = family.researchStatus {
        HStack(spacing: 4) {
          Text(status)
          if !family.researchCapabilities.isEmpty {
            Text("· " + family.researchCapabilities.joined(separator: " · "))
          }
        }
        .font(.system(size: 8, weight: .medium))
        .foregroundStyle(routerMutedStrong)
        .lineLimit(1)
        .truncationMode(.tail)
      }
      if let note = family.researchNote {
        Text(note)
          .font(.system(size: 8))
          .foregroundStyle(routerMuted)
          .fixedSize(horizontal: false, vertical: true)
          .padding(.bottom, 2)
      }
      if let recommended {
        Text(routerLocalized("BEST FIT FOR THIS MAC"))
          .font(.system(size: 8, weight: .semibold))
          .foregroundStyle(routerMint)
          .padding(.bottom, 1)
        exploreLocalRow(recommended, isRecommended: true)
      } else if family.models.allSatisfy({ $0.downloadable == false }) {
        Text(routerLocalized("CLOUD ONLY · NO LOCAL DOWNLOAD"))
          .font(.system(size: 8, weight: .semibold))
          .foregroundStyle(routerMutedStrong)
          .padding(.bottom, 1)
      } else {
        Text(routerLocalized("NO LOCAL VARIANT FITS THIS MAC"))
          .font(.system(size: 8, weight: .semibold))
          .foregroundStyle(routerRed)
          .padding(.bottom, 1)
      }

      if !rows.isEmpty {
        VStack(spacing: 6) {
          ForEach(rows) { model in
            exploreLocalRow(model)
          }
        }
        .padding(.top, 3)
      }
      if expanded || hiddenCount > 0 {
        Button(
          expanded
            ? routerLocalized("Show fewer tags")
            : (RouterLanguage.isSimplifiedChinese
                ? "查看全部 \(family.models.count) 个标签"
                : "View all \(family.models.count) tags")
        ) {
          withAnimation(.easeOut(duration: 0.15)) {
            if expandedLocalVariants.contains(family.id) {
              expandedLocalVariants.remove(family.id)
            } else {
              expandedLocalVariants.insert(family.id)
            }
          }
        }
        .buttonStyle(.borderless)
        .font(.system(size: 9, weight: .medium))
        .foregroundStyle(routerMutedStrong)
      }
    }

    @ViewBuilder private var localDetails: some View {
      VStack(alignment: .leading, spacing: 4) {
        if let machine = localModels?.machine {
          Text(machine)
            .font(.system(size: 8))
            .foregroundStyle(routerMuted)
        }
        if let runtime = localModels?.runtime {
          let runtimeLabel = runtime.installed == true
            ? "Ollama \(runtime.version ?? routerLocalized("installed"))"
            : (RouterLanguage.isSimplifiedChinese ? "Ollama 未安装" : "Ollama not installed")
          let serverState = runtime.running == true
            ? routerLocalized("managed")
            : routerLocalized("not started")
          Text(
            RouterLanguage.isSimplifiedChinese
              ? "\(runtimeLabel) · 后台服务器 \(serverState)"
              : "\(runtimeLabel) · headless server \(serverState)"
          )
            .font(.system(size: 8))
            .foregroundStyle(runtime.installed == true ? routerMint : routerYellow)
          if let modelsPath = runtime.modelsPath {
            Text("\(routerLocalized("Models:")) \(modelsPath)")
              .font(.system(size: 8))
              .foregroundStyle(routerMuted)
              .lineLimit(1)
              .truncationMode(.middle)
          }
          if runtime.installed == true {
            Button(routerLocalized("Update Ollama")) { Task { await store.updateLocalOllama() } }
              .buttonStyle(.borderless)
              .font(.system(size: 8, weight: .medium))
              .foregroundStyle(routerMutedStrong)
              .disabled(busy)
          }
        }
        if let families = localModels?.families, !families.isEmpty {
          Text(
            RouterLanguage.isSimplifiedChinese
              ? "上方已按系列归类 \(families.count) 个 Ollama 系列的具体标签。"
              : "\(families.count) Ollama families; exact tags are grouped above."
          )
            .font(.system(size: 8))
            .foregroundStyle(routerMuted)
        }
        Text(
          RouterLanguage.isSimplifiedChinese
            ? "安装后会使用 Ollama 的评测计数器测量速度；未测量的模型不会显示臆造的数字。"
            : "Speed is measured after install with Ollama's eval counters; unmeasured models show no invented number."
        )
          .font(.system(size: 8))
          .foregroundStyle(routerMuted)
      }
      .padding(.horizontal, 2)
    }

    @ViewBuilder private func exploreLocalRow(
      _ model: AvailableLocalModel,
      isRecommended: Bool = false
    ) -> some View {
      let downloadable = model.downloadable != false
      let tooLarge = model.fit == "too-large" || model.diskFit == "too-large"
      HStack(spacing: 5) {
        VStack(alignment: .leading, spacing: 1) {
          HStack(spacing: 4) {
            Text(localVariantTitle(model))
              .font(.system(size: 9, weight: isRecommended ? .semibold : .medium))
              .lineLimit(1)
              .truncationMode(.tail)
            if let badge = localVariantBadge(model, isRecommended: isRecommended) {
              Text(badge)
                .font(.system(size: 7, weight: .semibold))
                .foregroundStyle(localVariantBadgeColor(model, isRecommended: isRecommended))
            }
          }
          Text(model.tag)
            .font(.system(size: 8))
            .foregroundStyle(routerMuted)
            .lineLimit(1)
            .truncationMode(.tail)
        }
        Spacer(minLength: 3)
        Text(downloadable ? String(format: "%.1f GB", model.sizeGb) : routerLocalized("cloud"))
          .font(.system(size: 8))
          .foregroundStyle(routerMuted)
          .monospacedDigit()
        Text(downloadable ? (tooLarge ? routerLocalized("won't fit") : routerLocalized(model.fit)) : routerLocalized("cloud only"))
          .font(.system(size: 8))
          .foregroundStyle(!downloadable ? routerMuted : (tooLarge ? routerRed : routerMutedStrong))
        if downloadable {
          // A model rated too large is still offered, because refusing to show
          // the button left those tags with no install path at all. The label
          // changes to name the risk and the tap asks once before spending the
          // gigabytes; confirming sends --force.
          Button(tooLarge ? routerLocalized("Anyway") : routerLocalized("Download")) {
            if tooLarge {
              pendingOversizedInstall = model.tag
            } else {
              Task { await store.downloadLocalModel(model.tag) }
            }
          }
          .buttonStyle(.borderless)
          .font(.system(size: 8, weight: .medium))
          .foregroundStyle(
            !canDownloadLocalSuggestion ? routerMutedStrong : (tooLarge ? routerRed : routerMint)
          )
          .disabled(!canDownloadLocalSuggestion)
        } else {
          Text(routerLocalized("cloud only"))
            .font(.system(size: 8, weight: .medium))
            .foregroundStyle(routerMutedStrong)
        }
      }
    }

    private func localVariantTitle(_ model: AvailableLocalModel) -> String {
      guard let variant = model.variant, !variant.isEmpty else { return model.tag }
      switch variant.lowercased() {
      case "latest": return routerLocalized("Default")
      case "cloud": return routerLocalized("Cloud")
      default: break
      }
      if localVariantIsStandard(model) { return variant.uppercased() }
      let lower = variant.lowercased()
      if lower.contains("mlx") { return routerLocalized("Apple Silicon build") }
      if lower.contains("nvfp4") { return routerLocalized("NVFP4 build") }
      if lower.contains("q4") || lower.contains("int4") { return routerLocalized("4-bit build") }
      if lower.contains("q8") || lower.contains("int8") { return routerLocalized("8-bit build") }
      if lower.contains("bf16") { return routerLocalized("BF16 build") }
      if lower.contains("coding") { return routerLocalized("Coding build") }
      return routerLocalized("Specialized build")
    }

    private func localVariantBadge(
      _ model: AvailableLocalModel,
      isRecommended: Bool
    ) -> String? {
      if isRecommended { return routerLocalized("BEST FIT") }
      if model.downloadable == false { return routerLocalized("CLOUD") }
      if model.variant == "latest" { return routerLocalized("DEFAULT") }
      if model.fit == "tight" || model.diskFit == "tight" { return routerLocalized("TIGHT") }
      if !localModelFits(model) { return routerLocalized("WON'T FIT") }
      return nil
    }

    private func localVariantBadgeColor(
      _ model: AvailableLocalModel,
      isRecommended: Bool
    ) -> Color {
      if isRecommended || localModelFits(model) { return routerMint }
      if model.downloadable == false { return routerMutedStrong }
      if model.fit == "tight" || model.diskFit == "tight" { return routerYellow }
      return routerRed
    }

    @ViewBuilder private func quickCodingRow(_ model: AvailableLocalModel) -> some View {
      HStack(spacing: 6) {
        VStack(alignment: .leading, spacing: 1) {
          Text(model.tag)
            .font(.system(size: 9, weight: .medium))
            .lineLimit(1)
          Text(
            routerLocalized(
              model.fit == "tight" ? "memory tight" : (model.isVerified ? "verified" : "untested")
            )
          )
            .font(.system(size: 8))
            .foregroundStyle(model.fit == "tight" ? routerYellow : (model.isVerified ? routerMint : routerMuted))
            .lineLimit(1)
        }
        Spacer()
        Text(String(format: "%.1f GB", model.sizeGb))
          .font(.system(size: 8))
          .foregroundStyle(routerMuted)
          .monospacedDigit()
        Button(routerLocalized("Download")) {
          Task { await store.downloadLocalModel(model.tag) }
        }
        .buttonStyle(.borderless)
        .font(.system(size: 8, weight: .medium))
        .foregroundStyle(canDownloadLocalSuggestion ? routerMint : routerMutedStrong)
        .disabled(!canDownloadLocalSuggestion)
      }
      .padding(.vertical, 1)
    }

    @ViewBuilder private func quickVisionRow(_ model: AvailableVisionModel) -> some View {
      HStack(spacing: 6) {
        VStack(alignment: .leading, spacing: 1) {
          Text(model.tag)
            .font(.system(size: 9, weight: .medium))
            .lineLimit(1)
          Text(
            RouterLanguage.isSimplifiedChinese
              ? "\(routerLocalized(model.accuracy)) · \(routerLocalized(model.fit))"
              : "\(model.accuracy) · \(model.fit)"
          )
            .font(.system(size: 8))
            .foregroundStyle(model.accuracy == "accurate" ? routerMint : routerMuted)
            .lineLimit(1)
        }
        Spacer()
        Text(String(format: "%.1f GB", model.sizeGb))
          .font(.system(size: 8))
          .foregroundStyle(routerMuted)
          .monospacedDigit()
        Button(routerLocalized("Download")) {
          Task { await store.downloadLocalModel(model.tag) }
        }
        .buttonStyle(.borderless)
        .font(.system(size: 8, weight: .medium))
        .foregroundStyle(canDownloadLocalSuggestion ? routerMint : routerMutedStrong)
        .disabled(!canDownloadLocalSuggestion)
      }
      .padding(.vertical, 1)
    }

    @ViewBuilder private func downloadHeader(_ title: String, detail: String?) -> some View {
      Divider().padding(.vertical, 2)
      HStack(spacing: 4) {
        Text(routerLocalized(title))
        Spacer()
        if let detail {
          Text(routerLocalized(detail)).lineLimit(1).truncationMode(.tail)
        }
      }
      .font(.system(size: 8, weight: .semibold))
      .foregroundStyle(routerMuted)
      .padding(.horizontal, 2)
    }

    private var canDownloadLocalSuggestion: Bool {
      !busy && store.localDownload?.isRunning != true
    }

    private var suggestedLocalModels: [AvailableLocalModel] {
      localModels?.available ?? []
    }

    private var suggestedVisionModels: [AvailableVisionModel] {
      localModels?.availableVision ?? []
    }

    private var visibleQuickCodingModels: [AvailableLocalModel] {
      quickPicksExpanded ? suggestedLocalModels : Array(suggestedLocalModels.prefix(1))
    }

    private var visibleQuickVisionModels: [AvailableVisionModel] {
      quickPicksExpanded ? suggestedVisionModels : Array(suggestedVisionModels.prefix(1))
    }

    private var quickPickRemainingCount: Int {
      suggestedLocalModels.count + suggestedVisionModels.count
        - visibleQuickCodingModels.count - visibleQuickVisionModels.count
    }

    private static let checkColumnWidth: CGFloat = 38

    @ViewBuilder private func localDownloadStatus(_ download: VisionDownloadState) -> some View {
      let isDone = download.status == "done"
      let isError = download.status == "error"
      let tint = isError ? routerRed : (isDone ? routerMint : routerYellow)
      VStack(alignment: .leading, spacing: 4) {
        HStack(spacing: 6) {
          if download.isRunning {
            OperationPulse(tint: tint)
          } else {
            Circle()
              .fill(tint)
              .frame(width: 6, height: 6)
          }
          Text(
            isError
              ? routerLocalized("Local model install failed")
              : (isDone ? routerLocalized("Local model ready") : routerLocalized("Installing local model"))
          )
            .font(.system(size: 9, weight: .semibold))
            .foregroundStyle(tint)
          Spacer(minLength: 4)
          if let percent = download.percent, !isError {
            Text("\(percent)%")
              .font(.system(size: 9, weight: .medium))
              .foregroundStyle(routerMutedStrong)
              .monospacedDigit()
          }
        }
        if let tag = download.tag {
          Text(tag)
            .font(.system(size: 9, weight: .medium))
            .lineLimit(1)
            .truncationMode(.middle)
        }
        if let detail = download.error ?? download.detail, !detail.isEmpty {
          Text(detail)
            .font(.system(size: 8))
            .foregroundStyle(isError ? routerRed : routerMuted)
            .lineLimit(2)
        }
        if download.isRunning {
          ProgressView(value: Double(download.percent ?? 0), total: 100)
            .progressViewStyle(.linear)
            .tint(routerMint)
        }
      }
      .padding(7)
      .background(tint.opacity(0.08), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
    }

    @ViewBuilder private func downloadBar(tag: String?, percent: Int?) -> some View {
      let tagLabel = tag.map { " \($0)" } ?? ""
      HStack(spacing: 6) {
        OperationPulse(tint: routerMint)
        ProgressView(value: Double(percent ?? 0), total: 100)
          .progressViewStyle(.linear)
          .tint(routerMint)
        Text("\(routerLocalized("Installing"))\(tagLabel) · \(percent ?? 0)%")
          .font(.system(size: 9, weight: .medium))
          .foregroundStyle(routerMint)
          .lineLimit(1)
          .monospacedDigit()
      }
    }

    @ViewBuilder private func installedLocalRow(_ model: InstalledLocalModel) -> some View {
      let operation = store.localModelOperation?.tag == model.tag
        ? store.localModelOperation
        : nil
      HStack(alignment: .top, spacing: 0) {
        // Codex drives every turn through tool calls, so a model without them
        // can never be a chat model. The checkbox goes dead rather than
        // silently doing nothing, and the role line below says why.
        Toggle("", isOn: Binding(
          get: { model.enabled },
          set: { on in Task { await store.setLocalModelEnabled(model.tag, enabled: on) } }
        ))
        .labelsHidden()
        .toggleStyle(.checkbox)
        .controlSize(.mini)
        .disabled(busy || operation != nil || !model.canBeChatModel)
        .frame(width: Self.checkColumnWidth, alignment: .leading)
        VStack(alignment: .leading, spacing: 3) {
          HStack(spacing: 6) {
            Text(model.tag)
              .font(.system(size: 11, weight: .medium))
              .lineLimit(1)
              .truncationMode(.middle)
            if model.running {
              Text(routerLocalized("loaded"))
                .font(.system(size: 8, weight: .medium))
                .foregroundStyle(routerMint)
            }
            Spacer(minLength: 6)
            Text(String(format: "%.1f GB", model.sizeGb))
              .font(.system(size: 9))
              .foregroundStyle(routerMutedStrong)
              .layoutPriority(1)
            Menu {
              Button(routerLocalized("Measure speed")) {
                Task { await store.benchmarkLocalModelSpeed(model.tag) }
              }
              .disabled(busy || store.benchmarkingTag != nil)
              if model.vision {
                Button(routerLocalized("Test image reading")) {
                  Task { await store.benchmarkLocalVisionModel(model.tag) }
                }
                .disabled(busy || store.benchmarkingTag != nil)
                if isVisionEngine(model) {
                  Label(routerLocalized("Reading images"), systemImage: "checkmark")
                } else {
                  Button(routerLocalized("Use for image reading")) {
                    Task { await store.useLocalVisionModel(model.tag) }
                  }
                  .disabled(busy)
                }
              }
              Divider()
              Button(routerLocalized("Remove model"), role: .destructive) {
                armedRemoval = model.tag
              }
              .disabled(busy)
            } label: {
              Image(systemName: "ellipsis")
                .font(.system(size: 10, weight: .semibold))
                .frame(width: 16, height: 16)
                .contentShape(Rectangle())
            }
            .menuStyle(.borderlessButton)
            .buttonStyle(.borderless)
            .accessibilityLabel(
              RouterLanguage.isSimplifiedChinese
                ? "\(model.tag) 的操作"
                : "Actions for \(model.tag)"
            )
          }
          if let operation {
            HStack(spacing: 7) {
              OperationPulse(tint: routerRed)
              Text("\(operation.kind.label)…")
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(routerRed)
              ProgressView()
                .controlSize(.mini)
                .tint(routerRed)
            }
            .transition(.opacity.combined(with: .scale(scale: 0.97, anchor: .leading)))
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(operation.kind.label) \(model.tag)")
          } else if let download = store.localDownload,
            download.isRunning,
            download.tag == model.tag {
            downloadBar(tag: nil, percent: download.percent)
          } else {
            if store.benchmarkingTag == model.tag {
              Text(routerLocalized("testing…"))
                .font(.system(size: 9, weight: .medium))
                .foregroundStyle(routerYellow)
            } else {
              roleLine(model)
            }
          }
          if armedRemoval == model.tag {
            HStack(spacing: 6) {
              Text(routerLocalized("Confirm removal?"))
                .font(.system(size: 8, weight: .medium))
                .foregroundStyle(routerRed)
              Button(routerLocalized("Confirm")) {
                armedRemoval = nil
                Task { await store.uninstallLocalModel(model.tag) }
              }
              .buttonStyle(.borderless)
              .font(.system(size: 8, weight: .semibold))
              .foregroundStyle(routerRed)
              .disabled(busy)
              Button(routerLocalized("Cancel")) { armedRemoval = nil }
                .buttonStyle(.borderless)
                .font(.system(size: 8))
                .foregroundStyle(routerMutedStrong)
            }
          }
        }
      }
      .padding(.horizontal, 2)
      .animation(.easeOut(duration: 0.2), value: operation)
    }

    // What this model is for, in one truncating phrase rather than a row of
    // competing badges: its Codex role first, then how well it reads images if
    // that has been measured.
    @ViewBuilder private func roleLine(_ model: InstalledLocalModel) -> some View {
      HStack(spacing: 5) {
        Text(localRoleLabel(model))
          .foregroundStyle(localRoleColor(model))
        if let accuracy = model.accuracy, model.vision {
          Text("· \(RouterLanguage.isSimplifiedChinese ? routerLocalized(accuracy) : accuracy)")
            .foregroundStyle(accuracy == "accurate" ? routerMint : routerRed)
        }
        if let speed = model.tokensPerSecond {
          Text("· \(String(format: "%.1f", speed)) tok/s")
            .foregroundStyle(routerMutedStrong)
            .monospacedDigit()
        } else {
          Text("· \(routerLocalized("speed unmeasured"))")
            .foregroundStyle(routerMuted)
        }
      }
      .font(.system(size: 9))
      .lineLimit(1)
    }

    private func localRoleLabel(_ model: InstalledLocalModel) -> String {
      if model.canBeChatModel { return model.chatRoleLabel }
      return model.vision ? routerLocalized("vision only — no tools") : model.chatRoleLabel
    }

    private func localRoleColor(_ model: InstalledLocalModel) -> Color {
      if model.chatRoleGood { return routerMint }
      return model.canBeChatModel || model.vision ? routerYellow : routerMutedStrong
    }

    private var localModels: LocalModelsSnapshot? { settings?.localModels }

    private var localCatalogFamilies: [LocalCatalogFamily] {
      let allModels = localModels?.availableExplore ?? []
      let query = localCatalogFilter.trimmingCharacters(in: .whitespacesAndNewlines)
        .localizedLowercase
      let filtered = query.isEmpty
        ? allModels
        : allModels.filter { model in
          [model.tag, model.family ?? "", model.displayName ?? ""]
            .contains { $0.localizedLowercase.contains(query) }
        }
      let grouped = Dictionary(grouping: filtered, by: localCatalogFamilyID)
      return grouped
        .map { family, models in
          let sorted = models.sorted { localVariantSort($0, $1) }
          let research = sorted.first
          return LocalCatalogFamily(
            family: family,
            displayName: localCatalogFamilyName(family),
            models: sorted,
            researchStatus: research?.researchStatus,
            researchCapabilities: research?.researchCapabilities ?? [],
            researchNote: research?.researchNote
          )
        }
        .sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
    }

    private func localCatalogFamilyID(_ model: AvailableLocalModel) -> String {
      if let family = model.family, !family.isEmpty { return family }
      return model.tag.split(separator: ":", maxSplits: 1).first.map(String.init) ?? model.tag
    }

    private func localCatalogFamilyName(_ family: String) -> String {
      guard let label = localModels?.families?.first(where: { $0.family == family })?.displayName else {
        return family
      }
      return label.components(separatedBy: " · ").first ?? label
    }

    private func localVariantSort(_ left: AvailableLocalModel, _ right: AvailableLocalModel) -> Bool {
      let leftLatest = left.variant == "latest"
      let rightLatest = right.variant == "latest"
      if leftLatest != rightLatest { return leftLatest }
      let leftFits = localModelFits(left)
      let rightFits = localModelFits(right)
      if leftFits != rightFits { return leftFits }
      if left.sizeGb != right.sizeGb { return left.sizeGb < right.sizeGb }
      return left.tag.localizedCaseInsensitiveCompare(right.tag) == .orderedAscending
    }

    private func localPreviewVariants(
      in models: [AvailableLocalModel],
      excluding recommended: AvailableLocalModel?
    ) -> [AvailableLocalModel] {
      let candidates = models.filter { $0.tag != recommended?.tag }
      let previewLimit = recommended == nil ? 3 : 2
      var selected: [AvailableLocalModel] = []
      var sizes = Set<String>()

      func add(_ model: AvailableLocalModel?) {
        guard let model, selected.count < previewLimit else { return }
        // `latest` and a plain size tag often point to the same digest. Avoid
        // showing two rows for one download while leaving every exact tag in
        // the full list.
        let sizeKey = model.downloadable == false
          ? "cloud"
          : String(format: "%.1f", model.sizeGb)
        guard sizes.insert(sizeKey).inserted else { return }
        selected.append(model)
      }

      add(candidates.first(where: { $0.variant == "latest" }))

      let standard = candidates.filter { localVariantIsStandard($0) }
      add(standard.first(where: localModelFits))
      add(standard.last(where: localModelFits))
      add(candidates.first(where: { $0.downloadable == false }))
      add(standard.first)
      add(candidates.first)
      return selected
    }

    private func localVariantIsStandard(_ model: AvailableLocalModel) -> Bool {
      guard let variant = model.variant?.lowercased(), !variant.isEmpty else { return false }
      if variant == "latest" || variant == "cloud" { return true }
      // Plain size tags such as `9b`, `35b`, or `e4b` are the understandable
      // family choices. Everything with a suffix is a precision, runtime, or
      // task-specific build and belongs behind “View all tags”.
      return !variant.contains("-") && !variant.contains("_")
    }

    private func localModelFits(_ model: AvailableLocalModel) -> Bool {
      model.downloadable != false
        && model.fit != "too-large"
        && model.diskFit != "too-large"
    }

  private func localFamilySummary(_ family: LocalCatalogFamily) -> String {
    let fits = family.models.filter(localModelFits).count
    let cloud = family.models.filter { $0.downloadable == false }.count
    var parts = [RouterLanguage.isSimplifiedChinese ? "\(family.models.count) 个标签" : "\(family.models.count) tags"]
    if fits > 0 {
      parts.append(RouterLanguage.isSimplifiedChinese ? "\(fits) 个适配" : "\(fits) fit")
    } else if cloud == family.models.count {
      parts.append(routerLocalized("cloud only"))
    } else {
      parts.append(routerLocalized("none fit"))
    }
    if cloud > 0 && cloud < family.models.count {
      parts.append(RouterLanguage.isSimplifiedChinese ? "\(cloud) 个云端" : "\(cloud) cloud")
    }
      return parts.joined(separator: " · ")
    }

    private func recommendedLocalVariant(in models: [AvailableLocalModel]) -> AvailableLocalModel? {
      // A recommendation is useful only when it can actually run here. Do not
      // relabel the smallest impossible download as a "best fit" choice.
      return models.first(where: localModelFits)
    }

    // Useful first: models that actually drive Codex, then the rest that can
    // chat, then image readers, then the ones that can do neither. A flat list
    // in this order groups by role without spending rows on group headers,
    // which the popover width cannot afford.
    private var sortedLocalModels: [InstalledLocalModel] {
      (localModels?.models ?? []).sorted {
        if localRoleRank($0) != localRoleRank($1) {
          return localRoleRank($0) < localRoleRank($1)
        }
        return $0.tag < $1.tag
      }
    }

    private func localRoleRank(_ model: InstalledLocalModel) -> Int {
      if model.chatRoleGood { return 0 }
      if model.canBeChatModel { return 1 }
      return model.vision ? 2 : 3
    }

    private func isVisionEngine(_ model: InstalledLocalModel) -> Bool {
      vision?.engine == "local" && vision?.local?.model == model.tag
    }

    private var localLlmSummary: String {
      if let download = store.localDownload, download.isRunning {
        let tag = download.tag ?? routerLocalized("local model")
        let percent = download.percent.map { " · \($0)%" } ?? ""
        return "\(routerLocalized("Downloading")) \(tag)\(percent)"
      }
      if let download = store.localDownload, download.status == "error" {
        return routerLocalized("Last download failed")
      }
      guard let localModels, localModels.installed > 0 else {
        let available = localModels?.availableExplore?.count ?? 0
        return available > 0
          ? (RouterLanguage.isSimplifiedChinese ? "尚未安装 · 有 \(available) 个可用" : "none installed · \(available) available")
          : routerLocalized("none installed")
      }
      let chat = localModels.usableAsChat ?? 0
      let available = localModels.availableExplore?.count ?? 0
      let suffix = available > 0 ? " · \(available) available" : ""
      return RouterLanguage.isSimplifiedChinese
        ? "已安装 \(localModels.installed) 个 · \(chat) 个可用于 Codex · \(String(format: "%.1f", localModels.totalGb)) GB\(suffix.replacingOccurrences(of: " available", with: " 个可用"))"
        : "\(localModels.installed) installed · \(chat) for Codex · \(String(format: "%.1f", localModels.totalGb)) GB\(suffix)"
    }

    private var canInstall: Bool {
      !busy && store.localDownload?.isRunning != true
        && !installTag.trimmingCharacters(in: .whitespaces).isEmpty
    }

    private func submitInstall() {
      let tag = installTag.trimmingCharacters(in: .whitespaces)
      guard canInstall else { return }
      installTag = ""
      Task { await store.downloadLocalModel(tag) }
    }

    // Lets a text-only model (DeepSeek, GLM, ...) answer about a pasted image by
    // having a vision model read it. The engine defaults to an enabled paid
    // model; a local model becomes selectable here once it is installed in the
    // Local LLMs panel above, which is the one place local models are managed.
    // Everything maps to a `control vision-bridge` command, so the tray never
    // needs the agent.
    @ViewBuilder private var visionPanel: some View {
      VStack(alignment: .leading, spacing: 8) {
        Text(routerLocalized("Text-only models can't see images. When on, a vision model reads the paste and hands over the text."))
          .font(.system(size: 9))
          .foregroundStyle(routerMuted)
        toggleRow(
          title: routerLocalized("Read images for text-only models"),
          detail: vision?.enabled == true
            ? (RouterLanguage.isSimplifiedChinese ? "读取引擎：\(currentEngineLabel)" : "Reading via \(currentEngineLabel)")
            : routerLocalized("Off — text-only models refuse pasted images"),
          isOn: Binding(
            get: { vision?.enabled == true },
            set: { on in Task { await store.setVisionBridgeEnabled(on) } }
          ),
          disabled: busy
        )
        // The row stays put when the switch flips. Showing and hiding it
        // resized the whole panel on every toggle, and because the state only
        // settles after the control command returns, the jump happened twice.
        HStack(spacing: 8) {
          Text(routerLocalized("Engine"))
            .font(.system(size: 11, weight: .medium))
            // The one label that must never compress; it is four characters
            // and the menu beside it is what should give way.
            .fixedSize()
          Spacer(minLength: 8)
          engineMenu
        }
        .padding(.horizontal, 2)
        .opacity(vision?.enabled == true ? 1 : 0.45)
        .disabled(vision?.enabled != true)
      }
    }

    @ViewBuilder private var engineMenu: some View {
      Menu {
        // No "Auto" entry. It was labelled "cheapest paid model", but the
        // ranking behind it scored cost by testing slugs against
        // /flash|haiku|mini|lite|small|turbo/ -- which matches none of the
        // engines a typical install has, so they tied and the winner fell out
        // of alphabetical order. The menu now offers only models the operator
        // can actually evaluate, and a fresh install starts on a named default.
        if !(vision?.paidEngines ?? []).isEmpty {
          Section(routerLocalized("Paid (cloud)")) {
            ForEach(vision?.paidEngines ?? []) { option in
              engineEntry(option)
            }
          }
        }
        if !(vision?.nativeEngines ?? []).isEmpty {
          Section(routerLocalized("Your ChatGPT plan")) {
            ForEach(vision?.nativeEngines ?? []) { option in
              engineEntry(option)
            }
          }
        }
      } label: {
        HStack(spacing: 4) {
          Text(currentEngineLabel)
            .lineLimit(1)
            // A label reads "Auto · MiniMax M3 (opencode Go) · high": the ends
            // carry the meaning, so the middle is what goes.
            .truncationMode(.middle)
          Image(systemName: "chevron.up.chevron.down")
            .font(.system(size: 8))
            .fixedSize()
        }
        .font(.system(size: 10, weight: .medium))
        .foregroundStyle(routerMint)
      }
      .menuStyle(.borderlessButton)
      // Not fixedSize: that asks for the label's ideal width and ignores the
      // 352pt popover, so a long engine name pushed the row off the panel
      // instead of truncating. A ceiling lets it shrink and keeps the chevron
      // on screen.
      .frame(maxWidth: 230, alignment: .trailing)
      .help(currentEngineLabel)
      .disabled(busy)
    }

    // Hovering a model opens its own levels, so picking the reader and how hard
    // it reads is one gesture. A model that declares no levels stays a plain
    // button: there would be nothing behind the submenu.
    @ViewBuilder private func engineEntry(_ option: VisionEngineOption) -> some View {
      let efforts = option.efforts ?? []
      if efforts.isEmpty {
        Button(engineEntryLabel(option, selected: isSelectedEngine(option.slug))) {
          Task { await store.setVisionBridgeEngine(option.slug) }
        }
      } else {
        Menu(engineEntryLabel(option, selected: isSelectedEngine(option.slug))) {
          Button(effortEntryLabel(routerLocalized("Model default"), selected: isSelectedEngine(option.slug) && vision?.effort == nil)) {
            Task { await store.setVisionBridgeEngine(option.slug, effort: "default") }
          }
          ForEach(efforts, id: \.self) { effort in
            Button(
              effortEntryLabel(
                effort.capitalized,
                selected: isSelectedEngine(option.slug) && vision?.effort == effort
              )
            ) {
              Task { await store.setVisionBridgeEngine(option.slug, effort: effort) }
            }
          }
        }
      }
    }

    private func isSelectedEngine(_ slug: String) -> Bool { vision?.engine == slug }

    private func engineEntryLabel(_ option: VisionEngineOption, selected: Bool) -> String {
      selected ? "\u{2713} \(option.displayName)" : option.displayName
    }

    private func effortEntryLabel(_ title: String, selected: Bool) -> String {
      selected ? "\u{2713} \(title)" : title
    }

    private var vision: VisionBridgeSnapshot? { settings?.visionBridge }

    private var currentEngineLabel: String {
      guard let vision else { return routerLocalized("none") }
      if vision.engine == "local" {
        return "\(routerLocalized("Local")) · \(vision.local?.model ?? routerLocalized("MODEL"))"
      }
      let suffix = vision.effort.map { " · \($0)" } ?? ""
      if vision.engine == nil {
        // While a change is in flight the snapshot can arrive with the choice
        // recorded but nothing resolved yet. "Auto" alone is true throughout;
        // "Auto · none" was a claim that flashed and then contradicted itself.
        guard let resolved = vision.resolvedEngineName ?? vision.resolvedEngine else {
          return "\(routerLocalized("Auto"))\(suffix)"
        }
        return "\(routerLocalized("Auto")) · \(resolved)\(suffix)"
      }
      return "\(vision.resolvedEngineName ?? vision.resolvedEngine ?? vision.engine ?? routerLocalized("none"))\(suffix)"
    }

    private var hiddenModels: Set<String> {
      Set(settings?.picker.hidden ?? [])
    }

    private var disabledSubagentSet: Set<String> {
      Set(settings?.subagents.disabled ?? [])
    }

    // A local selection may withhold a proven model, but never promote an
    // unverified one to native v2 collaboration.
    private func isSubagent(_ model: RouterModel) -> Bool {
      if model.visible == false { return false }
      if model.multiAgentVersion != "v2" { return false }
      if disabledSubagentSet.contains(model.slug) { return false }
      return true
    }

    private func subagentDetail(for model: RouterModel) -> String {
      if model.visible == false { return routerLocalized("Hidden from picker — show it below to use it here") }
      if isSubagent(model) { return routerLocalized("Proven v2") }
      return routerLocalized("Not selected")
    }

  private var subagentSummary: String {
      let count = enabledExternalModels.filter { isSubagent($0) }.count
      return RouterLanguage.isSimplifiedChinese
        ? "\(count) 个已启用 · \(settings?.subagents.mode ?? "proven")"
        : "\(count) enabled · \(settings?.subagents.mode ?? "proven")"
    }

    private var pickerSummary: String {
      let visible = enabledModels.filter { !hiddenModels.contains($0.slug) }.count
      return RouterLanguage.isSimplifiedChinese
        ? "\(visible) 个显示 · \(hiddenModels.count) 个隐藏"
        : "\(visible) visible · \(hiddenModels.count) hidden"
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
            // "Reading via <engine>" carries a model name of unbounded length,
            // and the switch to the right must not be pushed off the panel.
            .truncationMode(.tail)
            .help(detail)
        }
        Spacer(minLength: 8)
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
        .foregroundStyle(routerMutedStrong)
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

  // Offered whether or not the harness is installed: the same button installs
  // it, publishes into it, or republishes after the routable set changed. The
  // detail line says which of the three the click will do, so it is never a
  // surprise that it reached for the network.
  private var harnessRow: some View {
    let harness = store.snapshot.harness
    let installed = harness?.installed == true
    let published = harness?.published == true
    let running = harness?.web?.running == true
    let blocked = harness?.nodeSupported == false
    return VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 12) {
        VStack(alignment: .leading, spacing: 3) {
          Text(routerLocalized("DeepSeek Harness"))
            .font(.system(size: 12, weight: .medium))
          Text(harnessDetail(harness: harness, installed: installed, published: published))
            .font(.system(size: 9))
            .foregroundStyle(routerMuted)
            .lineLimit(2)
        }
        Spacer(minLength: 8)
        if store.harnessRunning {
          ProgressView()
            .controlSize(.small)
            .tint(routerAccent)
            .frame(width: 94)
            .accessibilityLabel(routerLocalized("Setting up DeepSeek Harness"))
        } else if running {
          // Everything is in place, so the only thing left to want is the page.
          Button {
            store.openHarnessWeb()
          } label: {
            Label(routerLocalized("Open site"), systemImage: "arrow.up.forward.app")
          }
          .buttonStyle(AccentButtonStyle())
          .help(routerLocalized("Open the DeepSeek Harness browser UI"))
        } else if installed && published {
          // Published but nothing serving: the state a machine reboots into.
          // Starting is not republishing, so it does not rewrite the harness's
          // documents to put a window back on screen.
          Button {
            Task { await store.startHarnessWeb() }
          } label: {
            Label(routerLocalized("Start"), systemImage: "play.circle")
          }
          .buttonStyle(AccentButtonStyle())
          .disabled(store.providerOperation != nil || blocked)
          .opacity(store.providerOperation == nil && !blocked ? 1 : 0.5)
          .help(routerLocalized("Start the DeepSeek Harness browser UI"))
        } else {
          Button {
            Task { await store.setupHarness() }
          } label: {
            Label(
              installed ? routerLocalized("Connect") : routerLocalized("Install"),
              systemImage: installed ? "link" : "arrow.down.circle"
            )
          }
          .buttonStyle(AccentButtonStyle())
          .disabled(store.providerOperation != nil || blocked)
          .opacity(store.providerOperation == nil && !blocked ? 1 : 0.5)
          .help(routerLocalized("Install DeepSeek Harness and publish this router's models into it"))
        }
        // The secondary action follows what is actually costing something.
        // While the harness is resident that is memory and CPU, so the offer is
        // to stop it; once it is stopped the only thing left to undo is the
        // integration.
        if !store.harnessRunning {
          if running {
            Button {
              Task { await store.stopHarnessWeb() }
            } label: {
              Label(routerLocalized("Turn off"), systemImage: "stop.circle")
            }
            .buttonStyle(.borderless)
            .font(.system(size: 10))
            .foregroundStyle(routerMuted)
            .disabled(store.providerOperation != nil)
            .help(routerLocalized("Stop the harness process and free its memory and CPU"))
          } else if published {
            Button {
              Task { await store.disconnectHarness() }
            } label: {
              Label(routerLocalized("Disconnect"), systemImage: "power")
            }
            .buttonStyle(.borderless)
            .font(.system(size: 10))
            .foregroundStyle(routerMuted)
            .disabled(store.providerOperation != nil)
            .help(routerLocalized("Remove this router's models from the harness, keeping the harness itself"))
          }
        }
      }
      if let message = store.harnessMessage {
        Text(message)
          .font(.system(size: 9))
          .foregroundStyle(store.harnessSucceeded ? routerMint : routerRed.opacity(0.9))
          .lineLimit(3)
      }
    }
    .padding(10)
    .background(
      Color.primary.opacity(0.045),
      in: RoundedRectangle(cornerRadius: 10, style: .continuous)
    )
  }

  private func harnessDetail(
    harness: RouterHarness?,
    installed: Bool,
    published: Bool
  ) -> String {
    guard let harness else { return routerLocalized("Checking…") }
    if !harness.nodeSupported {
      return routerFormat(
        routerLocalized("Needs Node %@ or newer; this router runs Node %@"),
        harness.minimumNode,
        harness.nodeVersion
      )
    }
    if !installed {
      return routerLocalized("Not installed · installs the CLI, then publishes this router's models")
    }
    let version = harness.version.map { "v\($0)" } ?? routerLocalized("installed")
    if let web = harness.web, web.running, let url = web.url {
      return routerFormat(routerLocalized("%@ · running at %@"), version, url)
    }
    return published
      ? routerFormat(routerLocalized("%@ · routed models published · not running"), version)
      : routerFormat(routerLocalized("%@ · installed but not routed here yet"), version)
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
            .accessibilityLabel(routerLocalized("Running Codex Router maintenance"))
        } else {
          Button {
            Task { await store.updateAndVerify() }
          } label: {
            Label(routerLocalized("Update"), systemImage: "arrow.triangle.2.circlepath")
          }
          .buttonStyle(AccentButtonStyle())
          .disabled(store.providerOperation != nil)
          .opacity(store.providerOperation == nil ? 1 : 0.5)
          .help(routerLocalized("Apply the checked-out router revision, then run the Codex doctor"))
          .accessibilityLabel(routerLocalized("Update and verify Codex Router"))
          Button {
            Task { await store.fixAndVerify() }
          } label: {
            Label(routerLocalized("Fix"), systemImage: "wrench.and.screwdriver")
          }
          .buttonStyle(AccentButtonStyle())
          .disabled(store.providerOperation != nil)
          .opacity(store.providerOperation == nil ? 1 : 0.5)
          .help(routerLocalized("Run the Codex doctor and repair managed router files"))
          .accessibilityLabel(routerLocalized("Fix Codex Router installation"))
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
      return routerLocalized("Working…")
    }
    if store.maintenanceSucceeded {
      return store.maintenanceMessage ?? routerLocalized("All good")
    }
    if maintenanceFailed {
      return routerLocalized("Update or fix failed")
    }
    return store.maintenanceMessage ?? routerLocalized("Router ready")
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
      Text(routerLocalized("Router unavailable"))
        .font(.system(size: 13, weight: .semibold))
      Text(routerLocalized("Run setup, then refresh this panel."))
        .font(.system(size: 11))
        .foregroundStyle(routerMuted)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private var footer: some View {
    HStack(spacing: 9) {
      Button(store.isRefreshing ? routerLocalized("Refreshing…") : routerLocalized("Refresh")) {
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
        Text(store.lastUpdated.map { "\(routerLocalized("Updated")) \($0.formatted(date: .omitted, time: .shortened))" } ?? routerLocalized("Awaiting data"))
          .font(.system(size: 10, weight: .regular))
          .foregroundStyle(routerMuted)
      }

      Button(routerLocalized("Quit")) { NSApp.terminate(nil) }
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

  private var credentialLabel: String { setup?.credentialLabel ?? routerLocalized("API key") }

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

      if let anonymousNote = setup?.anonymousNote {
        HStack(alignment: .top, spacing: 5) {
          Image(systemName: "info.circle")
            .font(.system(size: 9, weight: .semibold))
          Text(anonymousNote)
            .font(.system(size: 9))
            .fixedSize(horizontal: false, vertical: true)
        }
        .foregroundStyle(routerMuted)
      }

      if showingKeyField, setup?.kind == "api" {
        VStack(alignment: .leading, spacing: 5) {
          Text(
            setup?.configured == true
              ? (RouterLanguage.isSimplifiedChinese ? "替换\(credentialLabel)" : "Replacement \(credentialLabel)")
              : credentialLabel
          )
            .font(.system(size: 9, weight: .medium))
            .foregroundStyle(routerMuted)
          HStack(spacing: 7) {
            SecureField(
              RouterLanguage.isSimplifiedChinese
                ? "粘贴\(credentialLabel)"
                : "Paste \(credentialLabel.lowercased())",
              text: $apiKey
            )
              .textFieldStyle(.plain)
              .font(.system(size: 11, design: .monospaced))
              .padding(.horizontal, 9)
              .padding(.vertical, 7)
              .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 6))
            Button(routerLocalized("Save")) {
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
    if removalArmed { return routerLocalized("Click the check again to delete this credential") }
    guard let setup else { return routerLocalized("Checking setup…") }
    if oauthNeedsReconnect {
      return routerLocalized("Session expired · reconnect for account usage")
    }
    if setup.configured {
      let visibility = provider.enabled ? routerLocalized("Available in Codex") : routerLocalized("Hidden from Codex")
      return setup.signedIn == true
        ? (RouterLanguage.isSimplifiedChinese ? "已登录 · \(visibility)" : "Signed in · \(visibility)")
        : (RouterLanguage.isSimplifiedChinese ? "就绪 · \(visibility)" : "Ready · \(visibility)")
    }
    switch setup.action {
    case "install": return routerLocalized("Official CLI required")
    case "login": return routerLocalized("Sign in with the official CLI")
    case "add-key":
      return offersSignIn ? routerLocalized("Sign in or paste an API key") : "\(credentialLabel) \(routerLocalized("required"))"
    default: return routerLocalized("Setup required")
    }
  }

  private var offersSignIn: Bool { setup?.signIn == true }

  // Names both halves when both will run, so one click never does more than
  // the label promised.
  private var signInTitle: String {
    setup?.signInAction == "install" ? routerLocalized("Install & Sign In") : routerLocalized("Sign In")
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
            Button(routerLocalized("Reconnect"), action: onLogin)
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
            .help(routerLocalized("Reconnect OAuth"))
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
          .help(routerLocalized(setup?.signInAction == "install"
            ? "Install the official CLI and sign in"
            : "Sign in again with the official CLI"))
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
          .help(
            showingKeyField
              ? routerLocalized("Cancel credential replacement")
              : (RouterLanguage.isSimplifiedChinese ? "替换\(credentialLabel)" : "Replace \(credentialLabel)")
          )
          .disabled(controlsDisabled)

          Button(action: { tapRemove() }) {
            Image(systemName: removalArmed ? "checkmark.circle.fill" : "trash")
              .font(.system(size: removalArmed ? 12 : 10, weight: .semibold))
              .frame(width: 20, height: 20)
          }
          .buttonStyle(.plain)
          .foregroundStyle(removalArmed ? routerRed : routerYellow)
          .help(
            removalArmed
              ? routerLocalized("Click again to delete the stored credential")
              : (RouterLanguage.isSimplifiedChinese ? "移除已保存的\(credentialLabel)" : "Remove stored \(credentialLabel)")
          )
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
    case "install": return routerLocalized("Install & Sign In")
    case "login": return routerLocalized("Sign In")
    case "add-key":
      guard !showingKeyField else { return routerLocalized("Cancel") }
      return credentialLabel == routerLocalized("API key")
        ? routerLocalized("Add Key")
        : (RouterLanguage.isSimplifiedChinese ? "添加\(credentialLabel)" : "Add \(credentialLabel)")
    default: return routerLocalized("Checking…")
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
  @AppStorage("ModelRouterTray.tokenDisplayUnit") private var tokenDisplayUnitRawValue =
    TokenDisplayUnit.full.rawValue

  private var tokenDisplayUnit: TokenDisplayUnit {
    TokenDisplayUnit(rawValue: self.tokenDisplayUnitRawValue) ?? .full
  }

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
        Text(routerLocalized(store.selectedUsageUsesChatGPT ? "Daily token usage" : "Router traffic"))
          .font(.system(size: 10, weight: .medium))
          .foregroundStyle(routerMuted)
        Spacer()
        HStack(spacing: 5) {
          UsageRangePicker(selection: $range)
          TokenDisplayUnitPicker(selection: Binding(
            get: { self.tokenDisplayUnit },
            set: { self.tokenDisplayUnitRawValue = $0.rawValue }
          ))
        }
      }

      UsageBarChart(
        points: store.dailyUsage(days: range.rawValue),
        tint: routerAccent,
        tokenDisplayUnit: self.tokenDisplayUnit)
        .id("\(store.selectedUsageProviderID)-\(range.rawValue)-\(self.tokenDisplayUnit.rawValue)")
        .frame(height: 88)

      HStack {
        Text(rangeCaption)
        Spacer()
        if store.selectedUsageUsesChatGPT,
           let streak = store.accountUsage?.summary.currentStreakDays {
          Text(RouterLanguage.isSimplifiedChinese ? "连续 \(streak) 天" : "\(streak)-day streak")
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
        Button(routerLocalized("Open usage dashboard")) {
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
    if store.selectedUsageUsesChatGPT { return routerLocalized("ChatGPT subscription") }
    return store.selectedProviderUsage?.displayName ?? store.selectedUsageProvider.displayName
  }

  private var primaryMetric: String {
    if store.selectedUsageUsesChatGPT {
      guard let value = store.accountUsage?.primary?.remainingPercent else { return "—" }
      return RouterLanguage.isSimplifiedChinese ? "剩余 \(value)%" : "\(value)% left"
    }
    guard store.providerUsage != nil else { return "—" }
    if let metric = store.selectedAccountMetric { return formattedAccountMetric(metric) }
    return self.tokenDisplayUnit.format(store.localUsageTotals(days: range.rawValue).tokens)
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
      guard let usage = store.selectedProviderUsage else { return routerLocalized("Loading provider usage…") }
      if let metric = usage.account.metrics.first {
        if let detail = metric.detail, !detail.isEmpty { return detail }
        return standardizedLimitLabel(metric.label)
      }
      return RouterLanguage.isSimplifiedChinese
        ? "\(usage.credentialType.uppercased()) 流量 · \(routerLocalized("measured on this Mac"))"
        : "\(usage.credentialType.uppercased()) traffic · measured on this Mac"
    }
    return routerLocalized("Loading native Codex usage…")
  }

  private var rangeCaption: String {
    let total = store.dailyTokens(days: range.rawValue).reduce(0, +)
    let formattedTotal = self.tokenDisplayUnit.format(total)
    if !store.selectedUsageUsesChatGPT {
      let requests = store.localUsageTotals(days: range.rawValue).requests
      return RouterLanguage.isSimplifiedChinese
        ? "\(formattedTotal) token · \(requests) 个请求 · 近 \(range.rawValue) 天"
        : "\(formattedTotal) tokens · \(requests) requests over \(range.rawValue) days"
    }
    return RouterLanguage.isSimplifiedChinese
      ? "\(formattedTotal) token · 近 \(range.rawValue) 天"
      : "\(formattedTotal) tokens over \(range.rawValue) days"
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
      return routerLocalized("Set up this provider below to fetch its account usage.")
    }
    guard store.selectedProviderUsage?.account.metrics.isEmpty == true else { return nil }
    return store.selectedProviderUsage?.account.message
  }
}

// Saved-token bars for the status tab's Context savings card: fixed slots
// (oldest left, hourly or daily depending on the selected range), so a quiet
// stretch reads as a gap rather than reflowing the chart. Values come
// precomputed from the router snapshot.
private struct SavingsSparkBars: View {
  let buckets: [Int]
  let caption: String
  let bucketUnit: String

  var body: some View {
    let peak = max(buckets.max() ?? 0, 1)
    VStack(alignment: .leading, spacing: 3) {
      HStack(alignment: .bottom, spacing: 2) {
        ForEach(Array(buckets.enumerated()), id: \.offset) { _, value in
          RoundedRectangle(cornerRadius: 1.5, style: .continuous)
            .fill(value > 0 ? routerMint : Color.primary.opacity(0.12))
            .frame(maxWidth: .infinity)
            .frame(height: value > 0 ? max(4, CGFloat(value) / CGFloat(peak) * 26) : 2)
        }
      }
      .frame(height: 26, alignment: .bottom)
      HStack {
        Text(caption)
          .font(.system(size: 7.5))
          .foregroundStyle(routerMuted)
        Spacer()
        Text("peak \(ToolResultAgingStats.compactCount(peak))/\(bucketUnit)")
          .font(.system(size: 7.5))
          .foregroundStyle(routerMuted)
          .monospacedDigit()
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(caption), peak \(peak) per \(bucketUnit == "h" ? "hour" : "day")")
  }
}

private struct CurrentUsageLimitCard: View {
  let card: UsageOverviewCard

  var body: some View {
    VStack(alignment: .leading, spacing: 7) {
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Text(card.kindLabel ?? routerLocalized("Usage limit"))
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
    return RouterLanguage.isSimplifiedChinese
      ? "剩余 \(Int(remaining.rounded()))%"
      : "\(Int(remaining.rounded()))% left"
  }

  private var resetText: String {
    guard let reset = card.resetDate else { return routerLocalized("No reset reported") }
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
        Text(
          RouterLanguage.isSimplifiedChinese
            ? "还有 \(hiddenCount) 个模型"
            : "+\(hiddenCount) more model\(hiddenCount == 1 ? "" : "s")"
        )
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
    guard row.model.totalTokens > 0 else {
      return RouterLanguage.isSimplifiedChinese ? "\(row.model.requests) 个请求" : "\(row.model.requests) req"
    }
    return RouterLanguage.isSimplifiedChinese
      ? "\(compactTokenCount(Double(row.model.totalTokens))) token"
      : "\(compactTokenCount(Double(row.model.totalTokens))) tok"
  }

  private func detailLabel(for row: ModelUsageRow) -> String {
    // A model with traffic but no metered response carries no token counts;
    // say so rather than implying it burned nothing.
    guard row.model.totalTokens > 0 else {
      return RouterLanguage.isSimplifiedChinese
        ? "\(row.model.requests) 个请求 · 未计量"
        : "\(row.model.requests) req · not metered"
    }
    let input = compactTokenCount(Double(row.model.inputTokens))
    let output = compactTokenCount(Double(row.model.outputTokens))
    return RouterLanguage.isSimplifiedChinese
      ? "输入 \(input) · 输出 \(output) · \(row.model.requests) 个请求"
      : "\(input) in · \(output) out · \(row.model.requests) req"
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
    .help(
      RouterLanguage.isSimplifiedChinese
        ? "显示 \(card.provider.displayName) 用量"
        : "Show \(card.provider.displayName) usage"
    )
    .accessibilityLabel(
      RouterLanguage.isSimplifiedChinese
        ? "显示 \(card.provider.displayName) 用量"
        : "Show \(card.provider.displayName) usage"
    )
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
    if oauthNeedsReconnect { return routerLocalized("Reconnect") }
    if let metric = card.metric { return formattedAccountMetric(metric) }
    if let remaining = card.remainingPercent {
      return RouterLanguage.isSimplifiedChinese
        ? "剩余 \(Int(remaining.rounded()))%"
        : "\(Int(remaining.rounded()))% left"
    }
    if card.providerID == "openai" { return "—" }
    return store.localUsageSummary(for: card.providerID, days: 7)
  }

  private var detailText: String {
    if oauthNeedsReconnect { return routerLocalized("OAuth expired · reconnect below") }
    if let kindLabel = card.kindLabel {
      return kindLabel
    }
    if card.providerID == "openai" {
      return store.accountUsage?.primary?.durationLabel ?? "Weekly limit"
    }
    if localTotals.requests > 0 || localTotals.tokens > 0 {
      if localTotals.tokens > 0, localTotals.requests > 0 {
        return RouterLanguage.isSimplifiedChinese
          ? "近 7 天本地 · \(localTotals.requests) 个请求"
          : "7D local · \(localTotals.requests) requests"
      }
      if localTotals.requests > 0 {
        return RouterLanguage.isSimplifiedChinese ? "近 7 天本地 · 未报告 token" : "7D local · tokens not reported"
      }
      return RouterLanguage.isSimplifiedChinese ? "近 7 天本地流量" : "7D local traffic"
    }
    if card.provider.isEnabled { return routerLocalized("No router traffic yet") }
    return routerLocalized("Configured · currently hidden")
  }

  private var footerText: String {
    if oauthNeedsReconnect { return routerLocalized("Sign in again to restore quota") }
    if let reset = card.resetDate {
      return usageResetCaption(reset)
    }
    if card.metric != nil || card.providerID == "openai" {
      return routerLocalized("No reset reported")
    }
    return routerLocalized("Local router traffic")
  }

  private var remainingFraction: CGFloat? {
    guard let remaining = card.remainingPercent else { return nil }
    return CGFloat(max(0, min(100, remaining))) / 100
  }

  private var statusTint: Color {
    if card.providerID == "openai" || card.provider.isEnabled { return routerMint }
    return routerMuted
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
          .foregroundStyle(selection == range ? routerText : routerMuted)
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

struct TokenDisplayUnitPicker: View {
  @Binding var selection: TokenDisplayUnit

  var body: some View {
    HStack(spacing: 2) {
      ForEach(TokenDisplayUnit.allCases) { unit in
        Button(unit.label) { self.selection = unit }
          .buttonStyle(.plain)
          .font(.system(size: 9, weight: .medium))
          .foregroundStyle(self.selection == unit ? routerText : routerMuted)
          .padding(.horizontal, 6)
          .padding(.vertical, 4)
          .background(
            self.selection == unit ? Color.primary.opacity(0.10) : Color.clear,
            in: Capsule()
          )
          .accessibilityLabel(unit.accessibilityLabel)
          .accessibilityAddTraits(self.selection == unit ? .isSelected : [])
      }
    }
    .padding(2)
    .background(Color.primary.opacity(0.045), in: Capsule())
    .accessibilityLabel(routerLocalized("Token unit"))
  }
}

struct UsageBarChart: View {
  let points: [DailyUsagePoint]
  let tint: Color
  var tokenDisplayUnit: TokenDisplayUnit = .full
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
                    .foregroundStyle(routerMuted)
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
            .foregroundStyle(routerText)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(.regularMaterial, in: Capsule())
            .overlay(Capsule().stroke(Color.primary.opacity(0.12), lineWidth: 0.5))
            .allowsHitTesting(false)
        }
      }
    }
    .accessibilityLabel(routerLocalized("Daily token usage chart. Hover a day for its displayed token count."))
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
    let tokens = self.tokenDisplayUnit.format(point.tokens)
    return RouterLanguage.isSimplifiedChinese ? "\(date) · \(tokens) token" : "\(date) · \(tokens) tokens"
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

private struct OperationPulse: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let tint: Color
  @State private var pulsing = false

  var body: some View {
    ZStack {
      Circle()
        .stroke(tint.opacity(0.34), lineWidth: 1)
        .frame(width: 12, height: 12)
        .scaleEffect(pulsing ? 1.35 : 0.65)
        .opacity(pulsing ? 0 : 0.9)
      Circle()
        .fill(tint)
        .frame(width: 6, height: 6)
    }
    .frame(width: 14, height: 14)
    .onAppear {
      guard !reduceMotion else { return }
      withAnimation(.easeOut(duration: 0.9).repeatForever(autoreverses: false)) {
        pulsing = true
      }
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
