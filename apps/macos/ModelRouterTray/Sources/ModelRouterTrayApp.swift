import AppKit
import Combine
import Darwin
import Foundation
import ServiceManagement
import SwiftUI
import UniformTypeIdentifiers

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

struct RouterControlContract: Decodable, Equatable {
  let version: String
  let controlProtocol: Int
}

enum RouterControlAccess: Equatable {
  case read
  case recovery
  case mutation
}

/// The native host and embedded Electron window are one app, so they must
/// enforce the same mutation boundary when the installed router checkout is a
/// different build. Status reads remain available to explain the mismatch;
/// writes fail closed before a control process is launched.
enum RouterControlContractPolicy {
  static let packageLimit = 1_048_576

  static func access(for arguments: [String]) -> RouterControlAccess {
    if arguments == ["--json"]
      || arguments == ["account", "--json"]
      || arguments == ["provider-usage", "--json"]
      || arguments == ["providers", "--json"]
      || arguments == ["local-models", "list", "--json"]
      || arguments == ["vision-bridge", "pull-status"]
      || arguments == ["chatgpt-session", "status"]
      || arguments == ["health", "--json"]
    {
      return .read
    }
    // These are the escape hatch from a mismatched/broken install, or the
    // runtime-only service transition needed to leave follow mode safely.
    // Blocking them on the mismatch they repair would make recovery
    // impossible. They must stay exact; an unknown future argv is a mutation.
    if arguments == ["doctor", "--fix"]
      || arguments == ["maintenance"]
      || arguments == ["tray", "refresh"]
      || arguments == ["tray", "rebuild"]
      || arguments == ["service", "start"]
      || arguments == ["service", "stop"]
      || arguments == ["service", "restart"]
    {
      return .recovery
    }
    return .mutation
  }

  static func drainsBeforeTermination(_ arguments: [String]) -> Bool {
    // Repair is compatibility-exempt so it can fix skew, but it still writes
    // the installation and therefore must finish before an unrelated quit.
    // Maintenance and tray rebuild replace this very app and must not wait on
    // themselves; service transitions do not write router configuration.
    access(for: arguments) == .mutation || arguments == ["doctor", "--fix"]
  }

  static func outlivesApplication(_ arguments: [String]) -> Bool {
    arguments == ["maintenance"]
      || arguments == ["tray", "refresh"]
      || arguments == ["tray", "rebuild"]
  }

  static func requiresDetachedTrayRefresh(_ arguments: [String]) -> Bool {
    arguments == ["maintenance"] || arguments == ["doctor", "--fix"]
  }

  static func installedContract(
    sourceRoot: URL,
    currentUserID: UInt32 = getuid()
  ) -> RouterControlContract? {
    let package = sourceRoot
      .appendingPathComponent("apps", isDirectory: true)
      .appendingPathComponent("control-center", isDirectory: true)
      .appendingPathComponent("package.json")
    let required: [(URL, FileAttributeType)] = [
      (package, .typeRegular),
      (package.deletingLastPathComponent(), .typeDirectory),
      (package.deletingLastPathComponent().deletingLastPathComponent(), .typeDirectory),
    ]
    for (url, expectedType) in required {
      guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
        attributes[.type] as? FileAttributeType == expectedType,
        let owner = attributes[.ownerAccountID] as? NSNumber,
        owner.uint32Value == currentUserID || owner.uint32Value == 0,
        let permissions = attributes[.posixPermissions] as? NSNumber,
        (permissions.uint16Value & 0o022) == 0
      else { return nil }
    }
    guard let attributes = try? FileManager.default.attributesOfItem(atPath: package.path),
      let size = attributes[.size] as? NSNumber,
      size.intValue <= packageLimit,
      let data = try? Data(contentsOf: package),
      let contract = try? JSONDecoder().decode(RouterControlContract.self, from: data),
      !contract.version.isEmpty,
      contract.controlProtocol >= 1
    else { return nil }
    return contract
  }

  static func matches(
    installed: RouterControlContract?,
    expectedVersion: String?,
    expectedProtocol: Int?
  ) -> Bool {
    guard let installed,
      let expectedVersion,
      !expectedVersion.isEmpty,
      let expectedProtocol,
      expectedProtocol >= 1
    else { return false }
    return installed.version == expectedVersion
      && installed.controlProtocol == expectedProtocol
  }
}

enum RouterInstallManifestPolicy {
  static let manifestLimit = 1_048_576

  static func sourceRoot(
    stateDirectory: URL,
    currentUserID: UInt32 = getuid()
  ) -> URL? {
    let manifest = stateDirectory.appendingPathComponent("install-manifest.json")
    guard let directoryAttributes = try? FileManager.default.attributesOfItem(atPath: stateDirectory.path),
      let manifestAttributes = try? FileManager.default.attributesOfItem(atPath: manifest.path),
      directoryAttributes[.type] as? FileAttributeType == .typeDirectory,
      manifestAttributes[.type] as? FileAttributeType == .typeRegular,
      let directoryOwner = directoryAttributes[.ownerAccountID] as? NSNumber,
      let manifestOwner = manifestAttributes[.ownerAccountID] as? NSNumber,
      directoryOwner.uint32Value == currentUserID,
      manifestOwner.uint32Value == currentUserID,
      let directoryMode = directoryAttributes[.posixPermissions] as? NSNumber,
      let manifestMode = manifestAttributes[.posixPermissions] as? NSNumber,
      (directoryMode.uint16Value & 0o077) == 0,
      (manifestMode.uint16Value & 0o077) == 0,
      let size = manifestAttributes[.size] as? NSNumber,
      size.intValue <= manifestLimit,
      let data = try? Data(contentsOf: manifest),
      let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      payload["version"] as? Int == 1,
      let current = payload["current"] as? [String: Any],
      let sourceRoot = current["sourceRoot"] as? String,
      !sourceRoot.isEmpty
    else { return nil }
    return URL(fileURLWithPath: sourceRoot, isDirectory: true)
  }
}

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

enum RouterToggleKey: Hashable {
  case provider(String)
  case signedRouting
  case loginFree
  case toolResultAging
  case subagentMode
  case subagentModel(String)
  case pickerModel(String)
  case localModel(String)
  case visionBridge
}

// A refresh remains the source of truth, but a switch should not wait for the
// control process and publication lock before it moves. The ledger holds only
// the user's not-yet-reconciled intent. Revisions make a late result from an
// earlier click harmless when the same switch is changed again in flight.
struct OptimisticToggleLedger<Key: Hashable> {
  struct Intent: Equatable {
    let value: Bool
    let revision: Int
  }

  private var revisions: [Key: Int] = [:]
  private var intents: [Key: Intent] = [:]

  mutating func request(_ value: Bool, for key: Key) -> Intent {
    let revision = (revisions[key] ?? 0) + 1
    revisions[key] = revision
    let intent = Intent(value: value, revision: revision)
    intents[key] = intent
    return intent
  }

  func intent(for key: Key) -> Intent? { intents[key] }

  func value(for key: Key, authoritative: Bool) -> Bool {
    intents[key]?.value ?? authoritative
  }

  func isCurrent(_ intent: Intent, for key: Key) -> Bool {
    intents[key] == intent
  }

  @discardableResult
  mutating func reconcile(_ intent: Intent, for key: Key) -> Bool {
    guard isCurrent(intent, for: key) else { return false }
    intents.removeValue(forKey: key)
    return true
  }
}

// Provider discovery is not serialized with credential writes. Generations
// make the renderer last-request-wins and, more importantly, let a credential
// boundary invalidate every response that was authorized by the old account.
struct ProviderCatalogGenerationLedger: Equatable {
  private var generations: [String: Int] = [:]

  mutating func begin(_ sourceID: String) -> Int {
    let generation = (generations[sourceID] ?? 0) + 1
    generations[sourceID] = generation
    return generation
  }

  mutating func invalidate(_ sourceIDs: [String]) {
    for sourceID in sourceIDs { _ = begin(sourceID) }
  }

  func isCurrent(_ generation: Int, for sourceID: String) -> Bool {
    generation > 0 && generations[sourceID] == generation
  }
}

enum ProviderCatalogReloadOutcome: Equatable {
  case loaded
  case superseded
  case failed(String)
}

struct ProviderCatalogReloadBatch: Equatable {
  private(set) var loaded = 0
  private(set) var failures: [String] = []

  mutating func record(_ outcome: ProviderCatalogReloadOutcome, sourceID: String) {
    switch outcome {
    case .loaded:
      loaded += 1
    case .superseded:
      failures.append("\(sourceID): reload superseded by a credential change")
    case .failed(let detail):
      failures.append(detail)
    }
  }

  var message: String {
    if failures.isEmpty {
      return "Reloaded current models from \(loaded) catalog\(loaded == 1 ? "" : "s")."
    }
    if loaded == 0 {
      return "Catalog reload failed: \(failures.joined(separator: " · "))"
    }
    return "Reloaded \(loaded) catalog\(loaded == 1 ? "" : "s"); \(failures.count) failed: \(failures.joined(separator: " · "))"
  }
}

struct NativeMutationDrain: Equatable {
  private(set) var active = 0
  private(set) var terminationPending = false

  mutating func begin() {
    active += 1
  }

  /// Returns true when AppKit may complete a previously deferred quit.
  mutating func finish() -> Bool {
    precondition(active > 0, "native mutation drain underflow")
    active -= 1
    guard active == 0, terminationPending else { return false }
    terminationPending = false
    return true
  }

  /// Returns true for terminate-now, false for terminate-later.
  mutating func requestTermination() -> Bool {
    guard active > 0 else { return true }
    terminationPending = true
    return false
  }
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
        // Publishing from a refresh can happen while SwiftUI is evaluating the
        // MenuBarExtra tree. Defer AppKit window/layout work until that render
        // transaction has finished, otherwise relaunches can recurse through
        // layoutSubtreeIfNeeded.
        Task { @MainActor [weak self] in
          self?.islandController?.setVisible(visible && mode == .notch)
          self?.desktopPanelController?.setVisible(visible && mode == .desktop)
        }
      }
    store.retireLoginItem()
    store.startHostAppObservation()
    Task { await store.startPolling() }
    Task { await store.startActivityPolling() }
    Task { await store.startAccountUsagePolling() }
    Task { await store.startProviderPolling() }
    if Self.launchedByUser {
      store.revealForUserLaunch()
      ControlCenterLauncher.open()
    }
  }

  // Double-clicking an app that is already running sends this instead of a
  // fresh launch. An LSUIElement app has no window and no Dock icon, so without
  // handling it the second open is silently swallowed and the app reads as
  // broken.
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
    store.revealForUserLaunch()
    ControlCenterLauncher.open()
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
    ControlCenterLauncher.terminateEmbeddedApplication()
    store.restoreServiceOnQuit()
  }

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    store.applicationTerminationReply()
  }
}

@MainActor
enum ControlCenterLauncher {
  private static let bundleName = "Control Center.app"
  private static let bundleIdentifier = "io.github.codex-router.control-center"

  static var bundledApplicationURL: URL? {
    guard let resources = Bundle.main.resourceURL else { return nil }
    let candidate = resources.appendingPathComponent(bundleName, isDirectory: true)
    return FileManager.default.fileExists(atPath: candidate.path) ? candidate : nil
  }

  static func open() {
    guard let application = bundledApplicationURL else {
      RouterStore.shared.reportControlCenterLaunchFailure(
        "The embedded Control Center is missing. Rebuild Codex Router."
      )
      return
    }
    Task { @MainActor in
      do {
        try await retireSupersededControlCenters(except: application)
        openBundledApplication(application)
      } catch {
        RouterStore.shared.reportControlCenterLaunchFailure(error.localizedDescription)
      }
    }
  }

  nonisolated static func shouldRetireControlCenter(
    at candidate: URL?,
    embeddedApplication: URL
  ) -> Bool {
    guard let candidate else { return true }
    return candidate.standardizedFileURL.resolvingSymlinksInPath()
      != embeddedApplication.standardizedFileURL.resolvingSymlinksInPath()
  }

  private static func retireSupersededControlCenters(except embedded: URL) async throws {
    let superseded = NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier)
      .filter { shouldRetireControlCenter(at: $0.bundleURL, embeddedApplication: embedded) }
    guard !superseded.isEmpty else { return }
    for application in superseded where !application.isTerminated {
      _ = application.terminate()
    }
    for _ in 0..<50 {
      if superseded.allSatisfy(\.isTerminated) { return }
      try await Task.sleep(for: .milliseconds(100))
    }
    throw RouterError(
      "A superseded Codex Router Control Center is still running. Quit it, then reopen Codex Router."
    )
  }

  private static func openBundledApplication(_ application: URL) {
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = true
    configuration.environment = embeddedEnvironment(
      processEnvironment: ProcessInfo.processInfo.environment
    )
    NSWorkspace.shared.openApplication(at: application, configuration: configuration) { _, error in
      guard let error else { return }
      Task { @MainActor in
        RouterStore.shared.reportControlCenterLaunchFailure(
          "Control Center could not open: \(error.localizedDescription)"
        )
      }
    }
  }

  nonisolated static func embeddedEnvironment(
    processEnvironment: [String: String],
    userVisible: Bool = true
  ) -> [String: String] {
    var environment = [
      "CODEX_ROUTER_EMBEDDED_CONTROL_CENTER": "1",
      "CODEX_ROUTER_USER_VISIBLE_CONTROL_CENTER": userVisible ? "1" : "0",
    ]
    // Keep source ownership identical across the native host and embedded
    // Electron process. These are the complete aliases both sides accept for
    // the checkout, shared state plane, and Codex client home. Forward only
    // these named paths; arbitrary environment values may contain secrets.
    for key in [
      "CODEX_ROUTER_SOURCE_ROOT", "MODEL_ROUTER_SOURCE_ROOT",
      "MODEL_ROUTER_STATE_DIR", "CODEX_ROUTER_STATE_DIR", "KIMI_CODEX_STATE_DIR",
      "CODEX_HOME",
    ] {
      if let value = processEnvironment[key], !value.isEmpty {
        environment[key] = value
      }
    }
    return environment
  }

  static func terminateEmbeddedApplication() {
    guard let embedded = bundledApplicationURL?.standardizedFileURL else { return }
    for application in NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier) {
      guard let runningURL = application.bundleURL?.standardizedFileURL,
        runningURL == embedded
      else { continue }
      application.terminate()
    }
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
  @Published fileprivate var routerHealth: RouterHealth?
  @Published private(set) var activeRequests: [RouterActiveRequest] = []
  @Published private(set) var activeRequestCount: Int = 0
  @Published private(set) var activeModel: String?
  @Published private(set) var activitySessionName: String?
  @Published private(set) var accountUsage: CodexAccountUsage?
  @Published private(set) var accountUsageError: String?
  @Published private(set) var providerUsage: ProviderUsageSnapshot?
  @Published private(set) var providerUsageError: String?
  @Published private(set) var providerSetup: [String: ProviderSetupState] = [:]
  // Provider discovery is deliberately on-demand. Unlike router status, this
  // may make a network request to a provider, so the tray only does it after
  // the user presses Load/Reload models for that provider.
  @Published private(set) var providerCatalogs: [String: ProviderModelCatalog] = [:]
  @Published private(set) var providerCatalogLoading = Set<String>()
  private var providerCatalogGenerations = ProviderCatalogGenerationLedger()
  @Published private(set) var providerOperation: String?
  @Published private(set) var visionDownload: VisionDownloadState?
  @Published private(set) var localDownload: VisionDownloadState?
  @Published private(set) var localMlx: LocalMlxSnapshot?
  @Published private(set) var localModelOperation: LocalModelOperation?
  @Published private(set) var benchmarkingTag: String?
  @Published private(set) var maintenanceMessage: String?
  @Published private(set) var maintenanceSucceeded = false
  @Published private(set) var harnessMessage: String?
  @Published private(set) var harnessSucceeded = false
  @Published private(set) var islandMode: IslandMode
  @Published private(set) var menuBarDisplayMode: TrayMenuBarDisplayMode
  @Published private(set) var menuBarShowModelName: Bool
  @Published private(set) var menuBarIconStyle: TrayMenuBarIconStyle
  @Published private(set) var menuBarPresetIcon: String
  @Published private(set) var menuBarCustomIconPath: String?
  @Published private(set) var menuBarCustomIconImage: NSImage?
  @Published private(set) var menuBarCustomIconMissing = false
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
  @Published private var optimisticToggles = OptimisticToggleLedger<RouterToggleKey>()
  private var nativeMutationDrain = NativeMutationDrain()
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
  private let menuBarDisplayModeKey = "ModelRouterTray.menuBarDisplayMode"
  private let menuBarShowModelNameKey = "ModelRouterTray.menuBarShowModelName"
  private let menuBarIconStyleKey = "ModelRouterTray.menuBarIconStyle"
  private let menuBarPresetIconKey = "ModelRouterTray.menuBarPresetIcon"
  private let menuBarCustomIconPathKey = "ModelRouterTray.menuBarCustomIconPath"
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
  private var profileReconcileNeeded = true
  private var serviceWork: Task<Void, Never>?
  private var serviceIntent: ServiceIntent = .unknown
  private struct PendingToggleOperation {
    let label: String
    let run: @MainActor (Bool) async throws -> Void
    let success: @MainActor (Bool) async -> String
  }
  private var pendingToggleOperations: [RouterToggleKey: PendingToggleOperation] = [:]
  private var toggleQueue: [RouterToggleKey] = []
  private var activeToggleKey: RouterToggleKey?
  private var toggleWorker: Task<Void, Never>?
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

  // Missing keys keep the look that shipped before custom icons: standard
  // width, model name on, activity dot. An explicit Settings choice always
  // wins; garbage raw values fall through the same way island mode does.
  nonisolated static func resolveMenuBarSettings(
    storedDisplayMode: String?,
    storedShowModelName: Bool?,
    storedIconStyle: String?,
    storedPresetIcon: String?,
    storedCustomIconPath: String?
  ) -> MenuBarSettings {
    let custom = storedCustomIconPath.flatMap { $0.isEmpty ? nil : $0 }
    let preset = storedPresetIcon.flatMap { $0.isEmpty ? nil : $0 } ?? "cpu"
    return MenuBarSettings(
      displayMode: storedDisplayMode.flatMap(TrayMenuBarDisplayMode.init(rawValue:)) ?? .standard,
      showModelName: storedShowModelName ?? true,
      iconStyle: storedIconStyle.flatMap(TrayMenuBarIconStyle.init(rawValue:)) ?? .indicator,
      presetIcon: preset,
      customIconPath: custom
    )
  }

  nonisolated static let customMenuBarIconMaxBytes = 5 * 1024 * 1024

  nonisolated static func persistCustomMenuBarIcon(
    from source: URL,
    into applicationSupportDirectory: URL,
    fileManager: FileManager = .default,
    maxBytes: Int = RouterStore.customMenuBarIconMaxBytes
  ) throws -> URL {
    let size = (try fileManager.attributesOfItem(atPath: source.path)[.size] as? NSNumber)?.intValue ?? 0
    if size > maxBytes {
      throw MenuBarCustomIconError.tooLarge
    }
    let dir = applicationSupportDirectory.appendingPathComponent("ModelRouterTray", isDirectory: true)
    try fileManager.createDirectory(at: dir, withIntermediateDirectories: true)
    let ext = source.pathExtension.isEmpty ? "png" : source.pathExtension.lowercased()
    let dest = dir.appendingPathComponent("menu-bar-icon.\(ext)")
    let staging = dir.appendingPathComponent("menu-bar-icon.\(UUID().uuidString).tmp")
    do {
      try fileManager.copyItem(at: source, to: staging)
      if fileManager.fileExists(atPath: dest.path) {
        _ = try fileManager.replaceItemAt(dest, withItemAt: staging)
      } else {
        try fileManager.moveItem(at: staging, to: dest)
      }
    } catch {
      try? fileManager.removeItem(at: staging)
      throw error
    }
    if let leftovers = try? fileManager.contentsOfDirectory(
      at: dir,
      includingPropertiesForKeys: nil
    ) {
      for leftover in leftovers
      where leftover.lastPathComponent.hasPrefix("menu-bar-icon.")
        && leftover.lastPathComponent != dest.lastPathComponent
      {
        try? fileManager.removeItem(at: leftover)
      }
    }
    return dest
  }

  nonisolated static func loadCustomMenuBarIcon(path: String?) -> (image: NSImage?, missing: Bool) {
    guard let path, !path.isEmpty else { return (nil, false) }
    if let image = NSImage(contentsOfFile: path) {
      return (image, false)
    }
    return (nil, true)
  }

  nonisolated static func menuBarTooltip(provider: String, state: String, usage: String?) -> String {
    if let usage {
      return routerFormat("Codex Router · %@ (%@) · %@", provider, state, usage)
    }
    return routerFormat("Codex Router · %@ (%@)", provider, state)
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

    let resolvedMenuBar = Self.resolveMenuBarSettings(
      storedDisplayMode: defaults.string(forKey: menuBarDisplayModeKey),
      storedShowModelName: defaults.object(forKey: menuBarShowModelNameKey) == nil
        ? nil
        : defaults.bool(forKey: menuBarShowModelNameKey),
      storedIconStyle: defaults.string(forKey: menuBarIconStyleKey),
      storedPresetIcon: defaults.string(forKey: menuBarPresetIconKey),
      storedCustomIconPath: defaults.string(forKey: menuBarCustomIconPathKey)
    )
    menuBarDisplayMode = resolvedMenuBar.displayMode
    menuBarShowModelName = resolvedMenuBar.showModelName
    menuBarIconStyle = resolvedMenuBar.iconStyle
    menuBarPresetIcon = resolvedMenuBar.presetIcon
    menuBarCustomIconPath = resolvedMenuBar.customIconPath
    reloadCustomMenuBarIcon()
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

  func setMenuBarDisplayMode(_ mode: TrayMenuBarDisplayMode) {
    menuBarDisplayMode = mode
    defaults.set(mode.rawValue, forKey: menuBarDisplayModeKey)
  }

  func setMenuBarShowModelName(_ show: Bool) {
    menuBarShowModelName = show
    defaults.set(show, forKey: menuBarShowModelNameKey)
  }

  func setMenuBarIconStyle(_ style: TrayMenuBarIconStyle) {
    menuBarIconStyle = style
    defaults.set(style.rawValue, forKey: menuBarIconStyleKey)
  }

  func setMenuBarPresetIcon(_ icon: String) {
    menuBarPresetIcon = icon
    defaults.set(icon, forKey: menuBarPresetIconKey)
  }

  func setMenuBarCustomIconPath(_ path: String?) {
    menuBarCustomIconPath = path
    if let path {
      defaults.set(path, forKey: menuBarCustomIconPathKey)
    } else {
      defaults.removeObject(forKey: menuBarCustomIconPathKey)
    }
    reloadCustomMenuBarIcon()
  }

  private func reloadCustomMenuBarIcon() {
    let loaded = Self.loadCustomMenuBarIcon(path: menuBarCustomIconPath)
    menuBarCustomIconImage = loaded.image
    menuBarCustomIconMissing = loaded.missing
  }

  private func refreshHostAppRunning() {
    let detected = hostAppRunningNow()
    if detected {
      profileReconcileNeeded = true
    } else if profileReconcileNeeded {
      profileReconcileNeeded = false
      enqueueServiceWork { [weak self] in
        guard let self else { return }
        _ = try? await self.runControl(arguments: ["chatgpt-account-pool", "profile", "reconcile"])
        await self.refresh()
      }
    }
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
    let next = pinnedByUser || effectivePresenceMode == .always || hostAppRunning
    guard surfacesVisible != next else { return }
    surfacesVisible = next
  }

  // Opening Codex Router from Finder, Spotlight, Launchpad, or the Dock has to
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

  func reportControlCenterLaunchFailure(_ detail: String) {
    message = detail
    attentionPulse &+= 1
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
    "custom": "Custom",
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
    "orca": "OrcaRouter",
    "venice": "Venice",
    "nousresearch": "Nous",
    "openrouter": "OpenRouter",
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
      let reportedLocalMlx = reportedLocalModels?.mlx
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
      // Keep the click's optimistic state until the detached worker publishes
      // a record at least as new. Otherwise a routine refresh can briefly turn
      // the install card back into an idle button during runtime preflight.
      if let current = localMlx, current.operation.isRunning {
        if let reported = reportedLocalMlx,
          (reported.operation.updatedAt ?? 0) >= (current.operation.startedAt ?? .greatestFiniteMagnitude) {
          localMlx = reported
        }
      } else {
        localMlx = reportedLocalMlx
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
        // Activity is status UI, not a frame clock. A 350ms loop kept waking
        // SwiftUI and AppKit while the tray was idle; one second is responsive
        // for a status indicator without turning it into a display link.
        try await Task.sleep(nanoseconds: 1_000_000_000)
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
          remainingPercent: Double(window.remainingPercent),
          resetAt: window.resetsAt))
      }
    }
    for provider in usageProviderChoices where provider.id != "openai" && provider.isEnabled {
      guard let usage = providerUsage(for: provider.id) else { continue }
      for (index, metric) in usage.account.metrics.enumerated() where metric.kind == "quota" {
        guard let remaining = remainingQuotaPercent(metric) else { continue }
        rows.append(DesktopQuotaRow(
          id: "\(provider.id)-\(index)",
          providerID: provider.id,
          providerName: provider.shortName,
          label: metric.label,
          remainingPercent: remaining,
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

  /// `refresh` re-asks the provider; without it the router answers from its
  /// stored list, so opening a provider costs no round trip and still works
  /// offline. That is the same split `discoverProviderModels` makes in
  /// apps/control-center/electron/ipc.mjs, and the reason the decoded
  /// `cached`/`stale` fields exist at all.
  @discardableResult
  func reloadProviderCatalog(
    _ provider: String,
    refresh: Bool = false,
    reportsOutcome: Bool = true
  ) async -> ProviderCatalogReloadOutcome {
    let providerID: String
    do {
      providerID = try ProviderCatalogInput.validatedProviderID(provider)
    } catch {
      let detail = "\(provider): \(error.localizedDescription)"
      if reportsOutcome { message = detail }
      return .failed(detail)
    }
    guard !providerCatalogLoading.contains(providerID) else { return .superseded }
    let generation = providerCatalogGenerations.begin(providerID)
    providerCatalogLoading.insert(providerID)
    defer {
      if providerCatalogGenerations.isCurrent(generation, for: providerID) {
        providerCatalogLoading.remove(providerID)
      }
    }
    do {
      let output = try await runRouterScript(
        "model-discovery.mjs",
        arguments: [providerID, "--json"] + (refresh ? ["--refresh"] : []),
        timeout: RouterScriptWatchdog.discoveryTimeout
      )
      let catalog = try JSONDecoder().decode(ProviderModelCatalog.self, from: output)
      guard providerCatalogGenerations.isCurrent(generation, for: providerID) else {
        return .superseded
      }
      providerCatalogs[providerID] = catalog
      let origin = catalog.cached == true ? "saved" : "current"
      if reportsOutcome {
        message = "\(catalog.discovered.count) \(origin) \(providerID) models loaded. Select the ones to add below."
      }
      return .loaded
    } catch {
      guard providerCatalogGenerations.isCurrent(generation, for: providerID) else {
        return .superseded
      }
      let detail = "\(providerID): \(error.localizedDescription)"
      if reportsOutcome { message = detail }
      return .failed(detail)
    }
  }

  func reloadAvailableProviderCatalogs() async {
    let sources = providerSetup.values
      .filter(\.configured)
      .flatMap { $0.catalogSources ?? [] }
      .sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
    guard !sources.isEmpty, providerCatalogLoading.isEmpty else { return }
    var batch = ProviderCatalogReloadBatch()
    for source in sources {
      // The button says "Reload", so this one is the explicit re-ask. Every
      // other entry point is cache-first.
      let outcome = await reloadProviderCatalog(
        source.id,
        refresh: true,
        reportsOutcome: false
      )
      batch.record(outcome, sourceID: source.id)
    }
    message = batch.message
  }

  func addProviderCatalogModels(_ provider: String, modelIDs: [String]) async {
    // Model ids arrive from the provider's own HTTP response and end up in a
    // single comma-separated `--models` argument, so they are validated to the
    // same shape Electron's `addProviderModels` enforces before any of them is
    // allowed to reach curation.
    let providerID: String
    let unique: [String]
    do {
      providerID = try ProviderCatalogInput.validatedProviderID(provider)
      unique = try ProviderCatalogInput.validatedModelIDs(modelIDs)
    } catch {
      message = "\(provider): \(error.localizedDescription)"
      return
    }
    if let catalog = providerCatalogs[providerID],
       let blockedID = unique.first(where: { !catalog.addableModelIDs.contains($0) })
    {
      message = catalog.blocked?[blockedID]
        ?? "\(blockedID) is not an addable \(providerID) catalog candidate."
      return
    }
    guard !providerCatalogLoading.contains(providerID) else { return }
    providerCatalogLoading.insert(providerID)
    do {
      // Curation repeats a live discovery before committing, then atomically
      // republishes every installed client. Never turn a cached list directly
      // into routes that may already have been withdrawn upstream.
      _ = try await runRouterScript(
        "curate-models.mjs",
        arguments: [providerID, "--models", unique.joined(separator: ","), "--refresh", "--apply"],
        timeout: RouterScriptWatchdog.catalogMutationTimeout
      )
      await refresh()
      providerCatalogLoading.remove(providerID)
      // Curation just re-asked upstream and rewrote the stored list, so the
      // cache-first read here is the fresh answer without a second round trip.
      await reloadProviderCatalog(providerID)
      message = "\(unique.count) \(providerID) model\(unique.count == 1 ? "" : "s") added. Restart Codex to refresh its picker."
    } catch {
      providerCatalogLoading.remove(providerID)
      message = "\(providerID): \(error.localizedDescription)"
    }
  }

  func selectUsageProvider(_ providerID: String) {
    manuallySelectedUsageProvider = true
    focusUsageProvider(providerID)
  }

  // One click covers the whole route into an OAuth provider: install the
  // official CLI when it is missing, then run its sign-in flow. Stopping after
  // the install left a row that looked finished but still had no credential.
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
    }
  }

  // The credential command removes the key, disables the provider, and publishes
  // the resulting selection under one model-overlay lock.
  func removeProviderKey(_ provider: String) async {
    let label = providerSetup[provider]?.credentialLabel ?? "API key"
    await performProviderOperation(
      provider,
      successMessage: "\(label) removed. Restart Codex to refresh its model picker."
    ) {
      _ = try await runControl(arguments: ["credential", provider, "--remove"])
    }
  }

  func setProviderPoolStrategy(_ provider: String, strategy: String) async {
    providerOperation = "pool:\(provider)"
    defer { providerOperation = nil }
    do {
      _ = try await runControl(arguments: ["provider-pools", "policy", provider, strategy])
      await refresh()
      message = routerLocalized("Provider pool policy saved.")
    } catch {
      message = error.localizedDescription
    }
  }

  func setProviderPoolCredentialPaused(
    provider: String,
    credential: String,
    paused: Bool
  ) async {
    providerOperation = "pool:\(provider)"
    defer { providerOperation = nil }
    do {
      _ = try await runControl(arguments: [
        "provider-pools", paused ? "pause" : "resume", provider, credential
      ])
      await refresh()
      message = paused
        ? routerLocalized("Pool credential paused.")
        : routerLocalized("Pool credential resumed.")
    } catch {
      message = error.localizedDescription
    }
  }

  func setChatGPTAccountPoolEnabled(_ enabled: Bool) async {
    providerOperation = "chatgpt-account-pool"
    defer { providerOperation = nil }
    do {
      _ = try await runControl(arguments: [
        "chatgpt-account-pool", enabled ? "enable" : "disable"
      ])
      await refresh()
      message = enabled
        ? routerLocalized("ChatGPT account pool enabled.")
        : routerLocalized("ChatGPT account pool disabled.")
    } catch {
      message = error.localizedDescription
    }
  }

  func setChatGPTAccountPoolMode(_ mode: String) async {
    guard mode == "switch" || mode == "pool" else { return }
    providerOperation = "chatgpt-account-pool"
    defer { providerOperation = nil }
    do {
      _ = try await runControl(arguments: ["chatgpt-account-pool", "mode", mode])
      await refresh()
      message = mode == "pool"
        ? routerLocalized("ChatGPT account pool mode enabled.")
        : routerLocalized("ChatGPT account switch mode enabled.")
    } catch {
      message = error.localizedDescription
    }
  }

  func setChatGPTAccountSelection(_ selection: String) async {
    providerOperation = "chatgpt-account-pool"
    defer { providerOperation = nil }
    do {
      _ = try await runControl(arguments: ["chatgpt-account-pool", "select", selection])
      await refresh()
      message = routerLocalized("ChatGPT account selection saved.")
    } catch {
      message = error.localizedDescription
    }
  }

  func setSearchSidecarEnabled(_ enabled: Bool) async {
    providerOperation = "routing-policy"
    defer { providerOperation = nil }
    do {
      _ = try await runControl(arguments: ["routing-policy", "sidecar", enabled ? "on" : "off"])
      await refresh()
      message = enabled
        ? routerLocalized("Search sidecar enabled.")
        : routerLocalized("Search sidecar disabled.")
    } catch {
      message = error.localizedDescription
    }
  }

  func setSubagentAllowUnverified(_ enabled: Bool) async {
    providerOperation = "routing-policy"
    defer { providerOperation = nil }
    do {
      _ = try await runControl(arguments: [
        "routing-policy", "subagents", "allow-unverified", enabled ? "on" : "off"
      ])
      await refresh()
      message = routerLocalized("Subagent routing policy saved.")
    } catch {
      message = error.localizedDescription
    }
  }

  func setComboEnabled(_ combo: String, enabled: Bool) async {
    providerOperation = "routing-policy"
    defer { providerOperation = nil }
    do {
      _ = try await runControl(arguments: [
        "routing-policy", "combo", enabled ? "enable" : "disable", combo
      ])
      await refresh()
      message = routerLocalized("Routing policy saved.")
    } catch {
      message = error.localizedDescription
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

  func providerEnabled(_ provider: String, authoritative: Bool) -> Bool {
    optimisticToggles.value(for: .provider(provider), authoritative: authoritative)
  }

  func signedRoutingEnabled(authoritative: Bool) -> Bool {
    optimisticToggles.value(for: .signedRouting, authoritative: authoritative)
  }

  func loginFreeEnabled(authoritative: Bool) -> Bool {
    optimisticToggles.value(for: .loginFree, authoritative: authoritative)
  }

  func toolResultAgingEnabled(authoritative: Bool) -> Bool {
    optimisticToggles.value(for: .toolResultAging, authoritative: authoritative)
  }

  func subagentModeAll(authoritative: Bool) -> Bool {
    optimisticToggles.value(for: .subagentMode, authoritative: authoritative)
  }

  func subagentModelEnabled(_ slug: String, authoritative: Bool) -> Bool {
    optimisticToggles.value(for: .subagentModel(slug), authoritative: authoritative)
  }

  func pickerModelVisible(_ slug: String, authoritative: Bool) -> Bool {
    optimisticToggles.value(for: .pickerModel(slug), authoritative: authoritative)
  }

  func localModelEnabled(_ tag: String, authoritative: Bool) -> Bool {
    optimisticToggles.value(for: .localModel(tag), authoritative: authoritative)
  }

  func visionBridgeEnabled(authoritative: Bool) -> Bool {
    optimisticToggles.value(for: .visionBridge, authoritative: authoritative)
  }

  func providerToggleIsActive(_ provider: String) -> Bool {
    activeToggleKey == .provider(provider)
  }

  private func queueOptimisticToggle(
    _ key: RouterToggleKey,
    value: Bool,
    label: String,
    run: @escaping @MainActor (Bool) async throws -> Void,
    success: @escaping @MainActor (Bool) async -> String
  ) {
    _ = optimisticToggles.request(value, for: key)
    pendingToggleOperations[key] = PendingToggleOperation(
      label: label,
      run: run,
      success: success
    )
    if !toggleQueue.contains(key) { toggleQueue.append(key) }
    guard toggleWorker == nil else { return }
    toggleWorker = Task { @MainActor [weak self] in
      await self?.drainOptimisticToggles()
    }
  }

  private func drainOptimisticToggles() async {
    while !toggleQueue.isEmpty {
      // Non-toggle work keeps its existing exclusive operation contract. A
      // switch clicked during it still moves now; persistence starts as soon
      // as that operation releases the store.
      while providerOperation != nil {
        try? await Task.sleep(for: .milliseconds(50))
        if Task.isCancelled { toggleWorker = nil; return }
      }

      let key = toggleQueue.removeFirst()
      guard let intent = optimisticToggles.intent(for: key),
        let operation = pendingToggleOperations.removeValue(forKey: key)
      else { continue }

      activeToggleKey = key
      providerOperation = operation.label
      do {
        try await operation.run(intent.value)
        await refresh()
        // A newer click remains painted over the authoritative result from
        // this older command and already has one queue entry waiting.
        if optimisticToggles.isCurrent(intent, for: key) {
          let successMessage = await operation.success(intent.value)
          if optimisticToggles.reconcile(intent, for: key) {
            message = successMessage
          }
        }
      } catch {
        let errorMessage = error.localizedDescription
        await refresh()
        // Roll back only the intent that actually failed. If another click
        // arrived in flight, keeping its overlay is what makes last intent win.
        _ = optimisticToggles.reconcile(intent, for: key)
        message = errorMessage
      }
      providerOperation = nil
      activeToggleKey = nil
    }
    toggleWorker = nil
  }


  func setProvider(_ provider: String, enabled: Bool) {
    queueOptimisticToggle(
      .provider(provider),
      value: enabled,
      label: provider,
      run: { [weak self] enabled in
        guard let self else { return }
        try await self.updateProviderSelection(provider, enabled: enabled)
      },
      success: { [weak self] enabled in
        await self?.refreshProviderUsage()
        return enabled
          ? "Provider added. Restart Codex to refresh its model picker."
          : "Provider hidden. Restart Codex to refresh its model picker."
      }
    )
  }

  func updateAndVerify() async {
    guard providerOperation == nil else { return }
    // Keep a pending AppKit quit deferred through both maintenance and the
    // spawn-only refresh handoff. Releasing the drain after maintenance but
    // before the helper starts can leave a successful update with the old app.
    let maintenanceArguments = ["maintenance"]
    var refreshLaunched = false
    beginNativeMutation()
    defer {
      // A failed final check can follow a partially applied repair. Refresh is
      // plan-driven and becomes a no-op when nothing changed, so attempt the
      // same safe handoff before releasing a pending quit on every exit path.
      if !refreshLaunched {
        try? launchDetachedTrayRefresh(after: maintenanceArguments)
      }
      finishNativeMutation()
    }
    providerOperation = "maintenance"
    maintenanceMessage = "Running update and doctor…"
    maintenanceSucceeded = false
    defer { providerOperation = nil }
    do {
      _ = try await runControl(arguments: maintenanceArguments)
      try launchDetachedTrayRefresh(after: maintenanceArguments)
      refreshLaunched = true
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
    // doctor --fix has its own mutation classification, but this outer claim is
    // intentionally one level wider: it stays active until the detached tray
    // refresh is launched, so a quit already waiting on doctor cannot win the
    // handoff race.
    let repairArguments = ["doctor", "--fix"]
    var refreshLaunched = false
    beginNativeMutation()
    defer {
      if !refreshLaunched {
        try? launchDetachedTrayRefresh(after: repairArguments)
      }
      finishNativeMutation()
    }
    providerOperation = "doctor"
    maintenanceMessage = "Running doctor --fix…"
    maintenanceSucceeded = false
    defer { providerOperation = nil }
    do {
      _ = try await runControl(arguments: repairArguments)
      try launchDetachedTrayRefresh(after: repairArguments)
      refreshLaunched = true
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

  func setLoginFree(_ enabled: Bool) {
    queueOptimisticToggle(
      .loginFree,
      value: enabled,
      label: "auth-mode",
      run: { [weak self] enabled in
        guard let self else { return }
        _ = try await self.runControl(arguments: ["auth-mode", enabled ? "on" : "off"])
      },
      success: { [weak self] enabled in
        guard let self else { return "Mode changed." }
        do {
          try await self.restartCodexApp()
          return enabled
            ? "Codex restarted with external-provider mode."
            : "Codex restarted with OpenAI login restored."
        } catch {
          return "Mode changed, but Codex could not restart: \(error.localizedDescription)"
        }
      }
    )
  }

  func setSignedRouting(_ enabled: Bool) {
    queueOptimisticToggle(
      .signedRouting,
      value: enabled,
      label: "signed-routing",
      run: { [weak self] enabled in
        guard let self else { return }
        _ = try await self.runControl(arguments: ["signed-routing", enabled ? "on" : "off"])
      },
      success: { enabled in
        enabled
        ? "Router with ChatGPT enabled. Fully quit and reopen Codex when ready."
        : "Previous provider restored. Fully quit and reopen Codex when ready."
      }
    )
  }

  func setChatGptSessionSharing(_ enabled: Bool) async {
    guard providerOperation == nil else { return }
    guard ChatGptSessionControlPolicy.allowsChange(
      to: enabled,
      status: snapshot.chatgptSession
    ) else {
      message = enabled
        ? routerLocalized("A usable ChatGPT login is required before sharing can be enabled. Run codex login first.")
        : routerLocalized("ChatGPT session-sharing status is unavailable. Refresh before changing it.")
      return
    }
    providerOperation = "chatgpt-session"
    defer { providerOperation = nil }
    do {
      _ = try await runControl(arguments: ChatGptSessionControlPolicy.arguments(enabled: enabled))
      await refresh()
      message = enabled
        ? routerLocalized("ChatGPT session sharing enabled for local router clients.")
        : routerLocalized("ChatGPT session sharing disabled. Installed client catalogs were refreshed.")
    } catch {
      message = error.localizedDescription
      await refresh()
    }
  }

  func setSubagentMode(_ mode: String) {
    queueOptimisticToggle(
      .subagentMode,
      value: mode == "all",
      label: "models",
      run: { [weak self] _ in
        guard let self else { return }
        _ = try await self.runControl(arguments: ["subagents", "mode", mode])
      },
      success: { _ in "Model settings applied. Restart Codex to refresh its picker." }
    )
  }

  func setSubagentModel(_ slug: String, enabled: Bool) {
    queueOptimisticToggle(
      .subagentModel(slug),
      value: enabled,
      label: "models",
      run: { [weak self] enabled in
        guard let self else { return }
        _ = try await self.runControl(
          arguments: ["subagents", "set", slug, enabled ? "on" : "off"]
        )
      },
      success: { _ in "Model settings applied. Restart Codex to refresh its picker." }
    )
  }

  // An empty level clears the override, which the control command spells
  // "default" -- the model goes back to deciding its own depth.
  func setSubagentEffort(_ slug: String, effort: String?) async {
    await applyModelSettings(
      arguments: ["subagents", "effort", slug, effort ?? "default"]
    )
  }

  func setSubagentProvider(_ provider: String, enabled: Bool) async {
    await applyModelSettings(
      arguments: ["subagents", "provider", provider, enabled ? "on" : "off"]
    )
  }

  func setPickerModel(_ slug: String, visible: Bool) {
    queueOptimisticToggle(
      .pickerModel(slug),
      value: visible,
      label: "models",
      run: { [weak self] visible in
        guard let self else { return }
        _ = try await self.runControl(
          arguments: ["picker", "set", slug, visible ? "show" : "hide"]
        )
      },
      success: { _ in "Model settings applied. Restart Codex to refresh its picker." }
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

  func setVisionBridgeEnabled(_ enabled: Bool) {
    queueOptimisticToggle(
      .visionBridge,
      value: enabled,
      label: "models",
      run: { [weak self] enabled in
        guard let self else { return }
        _ = try await self.runControl(arguments: ["vision-bridge", enabled ? "on" : "off"])
      },
      success: { _ in "Model settings applied. Restart Codex to refresh its picker." }
    )
  }

  func setToolResultAgingEnabled(_ enabled: Bool) {
    queueOptimisticToggle(
      .toolResultAging,
      value: enabled,
      label: "models",
      run: { [weak self] enabled in
        guard let self else { return }
        _ = try await self.runControl(
          arguments: ["tool-result-aging", enabled ? "on" : "off"]
        )
      },
      success: { enabled in
        enabled
        ? "Old tool-result compaction is on for the next external-model request."
        : "Exact tool results will be sent on the next external-model request."
      }
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

  func setLocalModelEnabled(_ tag: String, enabled: Bool) {
    queueOptimisticToggle(
      .localModel(tag),
      value: enabled,
      label: "models",
      run: { [weak self] enabled in
        guard let self else { return }
        _ = try await self.runControl(
          arguments: ["local-models", "set", tag, enabled ? "on" : "off"]
        )
      },
      success: { _ in "Model settings applied. Restart Codex to refresh its picker." }
    )
  }

  /// Deletes the model from disk. Irreversible short of downloading it again,
  /// so the tray arms the row before this is reachable.
  func uninstallLocalModel(_ tag: String) async {
    guard providerOperation == nil,
      localModelOperation == nil,
      localDownload?.isRunning != true,
      localMlx?.operation.isRunning != true
    else { return }
    let startedAt = Date()
    localModelOperation = LocalModelOperation(tag: tag, kind: .uninstall)
    do {
      // The native tray uses the same detached worker as Windows/Linux, so the
      // panel stays responsive and can cancel a removal while Ollama deletes.
      _ = try await runControl(arguments: ["local-models", "uninstall", tag, "--yes", "--async"])
      await pollLocalDownload()
    } catch {
      message = error.localizedDescription
      localModelOperation = nil
    }
    // A local delete can complete before SwiftUI presents the next frame, and
    // refresh removes the model row that used to own the only progress UI.
    // Keep the terminal status around long enough to be perceived.
    let remaining = 0.8 - Date().timeIntervalSince(startedAt)
    if remaining > 0, localModelOperation != nil {
      try? await Task.sleep(nanoseconds: UInt64(remaining * 1_000_000_000))
    }
    localModelOperation = nil
  }

  /// Cancels the active local pull or removal and leaves the terminal state in
  /// the status card. The router kills the exact detached worker, including
  /// its Ollama child process on Windows.
  func cancelLocalModel(_ tag: String) async {
    guard localDownload?.isRunning == true || localModelOperation?.tag == tag else { return }
    do {
      _ = try await runControl(arguments: ["local-models", "cancel", tag])
      await pollLocalDownload()
    } catch {
      message = error.localizedDescription
      localModelOperation = nil
    }
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
    guard localModelOperation == nil,
      localDownload?.isRunning != true,
      localMlx?.operation.isRunning != true
    else { return }
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

  /// Installs the curated four-bit MLX build plus its official local runtime,
  /// then publishes the stable LM Studio slug through the router. The button
  /// is the operator's consent for both prerequisites and the ~15 GB download;
  /// no token or credential ever passes through the tray.
  func installLocalMlx() async {
    guard localMlx?.operation.isRunning != true,
      localModelOperation == nil,
      localDownload?.isRunning != true,
      localMlx?.host?.supported != false
    else { return }
    let now = Date().timeIntervalSince1970 * 1_000
    let starting = LocalMlxOperation(
      status: "preparing",
      detail: "Checking the local runtime and downloader",
      percent: 0,
      progressMode: "determinate",
      startedAt: now,
      updatedAt: now,
      workerPid: nil,
      error: nil
    )
    localMlx = localMlx?.replacing(operation: starting)
      ?? LocalMlxSnapshot(
        model: nil,
        host: nil,
        prerequisites: nil,
        operation: starting,
        runtime: nil
      )
    do {
      _ = try await runControl(arguments: ["local-models", "mlx-install", "--yes"])
    } catch {
      localMlx = localMlx?.replacing(operation: LocalMlxOperation(
        status: "error",
        detail: "The MLX install could not start",
        percent: 0,
        progressMode: "determinate",
        startedAt: now,
        updatedAt: Date().timeIntervalSince1970 * 1_000,
        workerPid: nil,
        error: error.localizedDescription
      ))
      message = error.localizedDescription
      return
    }
    await pollLocalMlx()
  }

  func cancelLocalMlx() async {
    guard localMlx?.operation.isRunning == true else { return }
    do {
      _ = try await runControl(arguments: ["local-models", "mlx-cancel"])
      await pollLocalMlx()
    } catch {
      message = error.localizedDescription
    }
  }

  private func pollLocalMlx() async {
    while !Task.isCancelled {
      try? await Task.sleep(nanoseconds: 1_000_000_000)
      guard let data = try? await runControl(arguments: ["local-models", "list", "--json"]),
        let decoded = try? JSONDecoder().decode(LocalModelsSnapshot.self, from: data),
        let mlx = decoded.mlx
      else { continue }
      localMlx = mlx
      if mlx.operation.isRunning { continue }
      await refresh()
      switch mlx.operation.status {
      case "done":
        message = "Qwen3.8 27B MLX is ready for Codex. Fully quit and reopen Codex to refresh its picker."
      case "cancelled":
        message = "Qwen3.8 27B MLX installation cancelled."
      case "error":
        message = mlx.operation.error ?? mlx.operation.detail ?? "The MLX installation failed."
      default:
        break
      }
      return
    }
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
      guard let state else {
        localModelOperation = nil
        message = "No local model operation is running."
        return
      }
      if state.isRunning { continue }
      await refresh()
      let isUninstall = state.isUninstalling || localModelOperation?.tag == state.tag
      switch state.status {
      case "done":
        message = isUninstall
          ? "\(state.tag ?? "Model") was removed."
          : "\(state.tag ?? "Model") ready for Codex. Restart Codex to refresh its picker."
      case "cancelled":
        message = isUninstall
          ? "\(state.tag ?? "Model") removal cancelled."
          : "\(state.tag ?? "Model") download cancelled."
      default:
        message = state.error ?? (isUninstall
          ? "The local model removal failed."
          : "The local model download failed.")
      }
      localModelOperation = nil
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
    let catalogSourceIDs = providerSetup[provider]?.catalogSources?.map(\.id) ?? []
    // Invalidate before the command begins and again after it ends. A command
    // can store/remove the credential successfully and then fail while
    // republishing clients, so its thrown result is not proof the old account
    // is still authoritative.
    invalidateProviderCatalogs(catalogSourceIDs)
    providerOperation = provider
    defer { providerOperation = nil }
    do {
      try await operation()
      invalidateProviderCatalogs(catalogSourceIDs)
      await refreshProviderSetup()
      await refresh()
      await refreshProviderUsage()
      message = successMessage
    } catch {
      invalidateProviderCatalogs(catalogSourceIDs)
      message = error.localizedDescription
      await refreshProviderSetup()
    }
  }

  private func invalidateProviderCatalogs(_ sourceIDs: [String]) {
    providerCatalogGenerations.invalidate(sourceIDs)
    for sourceID in sourceIDs {
      providerCatalogs.removeValue(forKey: sourceID)
      providerCatalogLoading.remove(sourceID)
    }
  }

  private func updateProviderSelection(_ provider: String, enabled: Bool) async throws {
    _ = try await runControl(
      arguments: [
        "set-apply", provider, enabled ? "on" : "off",
        "--targets", "codex", "--activate",
      ]
    )
  }

  private func refreshActivity() async {
    do {
      // `control health` uses the protected health leaf and projects away the
      // forwarders' credential metadata. The public `/health` endpoint is
      // intentionally too small for the service rows below.
      let data = try await runControl(arguments: ["health", "--json"])
      let health = try JSONDecoder().decode(RouterHealth.self, from: data)
      let previousActivityState = activityState
      let nextActiveRequests = health.activity.active ?? []
      let nextActiveRequestCount = health.activity.activeCount ?? nextActiveRequests.count
      activityHealthFailureStartedAt = nil
      routerHealth = health
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
        // A completed request writes its usage event before the health activity
        // clears. Pull both the provider aggregate and the snapshot now, so
        // speed, cache reuse, and tool-result savings update with this turn
        // instead of waiting for their normal background polling intervals.
        Task {
          await refreshProviderUsage()
          await refresh()
        }
      }
    } catch {
      recordActivityHealthFailure()
    }
  }

  private func recordActivityHealthFailure() {
    if routerHealth != nil { routerHealth = nil }
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

  // Restart rebuilds both halves and brings them back up: maintenance pulls
  // the managed install to origin/main and verifies it (reinstalling the
  // service when anything landed), the explicit service restart covers the
  // nothing-to-update case, and the tray rebuild goes last because it replaces
  // and relaunches the process that is asking. A failed update must not turn
  // Restart into a no-op -- an offline machine still deserves a restart -- so
  // its error is carried into the message but the restart steps still run.
  // Maintenance defers its companion rebuild while this app owns the mutation
  // drain. The detached rebuild launcher then outlives this process and quits
  // the tray only after its staged bundle passes verification, with launchd's
  // `SuccessfulExit: false` covering any abnormal exit. Only the failure path
  // can be reported, because a success takes the window that would show it.
  func restartRouter() async {
    // This flow used to await the self-replacing rebuild while AppKit was free
    // to terminate between maintenance and that last command. Hold one outer
    // claim, then launch the rebuild without waiting before releasing it.
    beginNativeMutation()
    defer { finishNativeMutation() }
    message = routerLocalized("Restarting…")
    var updateFailure: String?
    do {
      _ = try await runControl(arguments: ["maintenance"])
    } catch {
      updateFailure = error.localizedDescription
    }
    do {
      _ = try await runControl(arguments: ["service", "restart"])
      try launchDetachedTrayCommand("rebuild")
      if let updateFailure {
        message = routerFormat("Restarted without updating: %@", updateFailure)
      }
    } catch {
      message = routerFormat("Restart failed: %@", error.localizedDescription)
    }
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

  func applicationTerminationReply() -> NSApplication.TerminateReply {
    nativeMutationDrain.requestTermination() ? .terminateNow : .terminateLater
  }

  private func beginNativeMutation() {
    nativeMutationDrain.begin()
  }

  private func finishNativeMutation() {
    if nativeMutationDrain.finish() {
      NSApp.reply(toApplicationShouldTerminate: true)
    }
  }

  private func launchDetachedTrayRefresh(after arguments: [String]) throws {
    guard RouterControlContractPolicy.requiresDetachedTrayRefresh(arguments) else {
      throw RouterError("This maintenance command does not schedule a desktop refresh.")
    }
    try launchDetachedTrayCommand("refresh")
  }

  private func launchDetachedTrayCommand(_ action: String) throws {
    guard action == "refresh" || action == "rebuild" else {
      throw RouterError("Unsupported detached tray command.")
    }
    let root = try sourceRoot()
    let task = Process()
    task.executableURL = root.appendingPathComponent("bin/control")
    task.arguments = ["tray", action]
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
    environment["MODEL_ROUTER_SOURCE_ROOT"] = root.path
    environment["MODEL_ROUTER_TARGET"] = "codex"
    environment.removeValue(forKey: "CODEX_ROUTER_DEFER_TRAY_REBUILD")
    environment.removeValue(forKey: "ELECTRON_RUN_AS_NODE")
    task.environment = environment
    task.standardInput = FileHandle.nullDevice
    task.standardOutput = FileHandle.nullDevice
    task.standardError = FileHandle.nullDevice
    // Process.run() only waits for exec. The child owns no pipe back into this
    // app and remains alive when the staged replacement asks AppKit to quit.
    try task.run()
  }

  private func runControl(arguments: [String], stdin: Data? = nil) async throws -> Data {
    let root = try sourceRoot()
    if RouterControlContractPolicy.access(for: arguments) == .mutation {
      try assertMutationCompatibility(sourceRoot: root)
    }
    let drainsBeforeTermination = RouterControlContractPolicy.drainsBeforeTermination(arguments)
    if drainsBeforeTermination { beginNativeMutation() }
    defer {
      if drainsBeforeTermination { finishNativeMutation() }
    }
    let outlivesApplication = RouterControlContractPolicy.outlivesApplication(arguments)
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
      if arguments == ["maintenance"] || arguments == ["doctor", "--fix"] {
        // The installer must return before it replaces the app that is waiting
        // for this mutation. A detached tray refresh below performs the
        // self-replace after the mutation drain is clear.
        environment["CODEX_ROUTER_DEFER_TRAY_REBUILD"] = "1"
      }
      task.environment = environment
      let output = outlivesApplication ? nil : Pipe()
      let errors = outlivesApplication ? nil : Pipe()
      let input = stdin.map { _ in Pipe() }
      var durableErrorURL: URL?
      var durableErrorHandle: FileHandle?
      if outlivesApplication {
        let url = FileManager.default.temporaryDirectory
          .appendingPathComponent("model-router-self-replace-\(UUID().uuidString).log")
        guard FileManager.default.createFile(
          atPath: url.path,
          contents: nil,
          attributes: [.posixPermissions: 0o600]
        ) else {
          throw RouterError("Could not create the private maintenance error log.")
        }
        durableErrorURL = url
        durableErrorHandle = try FileHandle(forUpdating: url)
      }
      defer {
        try? durableErrorHandle?.close()
        if let durableErrorURL { try? FileManager.default.removeItem(at: durableErrorURL) }
      }
      // Self-replacing maintenance/rebuild commands deliberately terminate
      // this app while their child tree is still completing the atomic swap.
      // A pipe owned by the dying app becomes EPIPE and can kill that updater;
      // /dev/null plus a private on-disk stderr handle remain valid after the
      // parent exits, so the child safely outlives the UI. If replacement does
      // not happen and the command fails, a bounded tail still carries the
      // actionable refusal back into the live app.
      if let output { task.standardOutput = output }
      else { task.standardOutput = FileHandle.nullDevice }
      if let errors { task.standardError = errors }
      else { task.standardError = durableErrorHandle ?? FileHandle.nullDevice }
      task.standardInput = input
      try task.run()
      // A successful self-replace can end this process before Swift executes
      // its defer. Remove the private name as soon as the child inherits the
      // descriptor; the inode remains usable until both processes close it,
      // and the kernel then reclaims it without leaving a temp-file orphan.
      if let errorURL = durableErrorURL, unlink(errorURL.path) == 0 {
        durableErrorURL = nil
      }
      let stdoutReader = output.map { pipe in
        Task.detached { pipe.fileHandleForReading.readDataToEndOfFile() }
      }
      let stderrReader = errors.map { pipe in
        Task.detached { pipe.fileHandleForReading.readDataToEndOfFile() }
      }
      if let stdin, let input {
        input.fileHandleForWriting.write(stdin)
        try? input.fileHandleForWriting.close()
      }
      task.waitUntilExit()
      let stdout = await stdoutReader?.value ?? Data()
      let stderr: Data
      if let durableErrorHandle {
        try? durableErrorHandle.synchronize()
        let end = (try? durableErrorHandle.seekToEnd()) ?? 0
        try? durableErrorHandle.seek(toOffset: end > 65_536 ? end - 65_536 : 0)
        stderr = (try? durableErrorHandle.read(upToCount: 65_536)) ?? Data()
      } else {
        stderr = await stderrReader?.value ?? Data()
      }
      guard task.terminationStatus == 0 else {
        let detail = String(data: stderr, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
        throw RouterError(detail?.isEmpty == false ? detail! : "Codex Router control command failed.")
      }
      return stdout
    }.value
  }

  // These are two UI-owned entry points that the generic control plane does
  // not expose. Keep the allow-list here: provider ids and model ids are data,
  // never a command path, and the tray must not become an arbitrary script
  // launcher just to mirror Electron's catalog controls.
  private func runRouterScript(
    _ script: String,
    arguments: [String],
    timeout: TimeInterval
  ) async throws -> Data {
    guard ["model-discovery.mjs", "curate-models.mjs"].contains(script) else {
      throw RouterError("Unsupported Codex Router script.")
    }
    let root = try sourceRoot()
    if script == "curate-models.mjs" {
      try assertMutationCompatibility(sourceRoot: root)
      beginNativeMutation()
    }
    defer {
      if script == "curate-models.mjs" { finishNativeMutation() }
    }
    let scriptURL = root.appendingPathComponent("src").appendingPathComponent(script)
    return try await Task.detached {
      let task = Process()
      task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
      task.arguments = ["node", scriptURL.path] + arguments
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
      task.standardOutput = output
      task.standardError = errors
      try task.run()
      // Drain both pipes before waiting. A provider list easily exceeds the
      // 64KB pipe buffer, and a child blocked on a full pipe never exits, so
      // waiting first would deadlock even without a hostile endpoint.
      let stdoutReader = Task.detached { output.fileHandleForReading.readDataToEndOfFile() }
      let stderrReader = Task.detached { errors.fileHandleForReading.readDataToEndOfFile() }
      // A provider that accepts the connection and then never answers would
      // otherwise park `waitUntilExit` forever, and with it the caller's
      // `defer` that clears the loading flag -- which permanently disables
      // both catalog buttons for the rest of the app's life. Terminating the
      // child closes the pipes, so the readers finish and the wait returns.
      let watchdog = RouterScriptWatchdog(task: task)
      watchdog.arm(after: timeout)
      task.waitUntilExit()
      watchdog.disarm()
      let stdout = await stdoutReader.value
      let stderr = await stderrReader.value
      if watchdog.didTimeOut {
        throw RouterError(
          "\(script) did not answer within \(Int(timeout.rounded())) seconds and was stopped. "
            + "The provider may be unreachable; try again."
        )
      }
      guard task.terminationStatus == 0 else {
        let detail = String(data: stderr, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
        throw RouterError(detail?.isEmpty == false ? detail! : "Codex Router command failed.")
      }
      return stdout
    }.value
  }

  private func sourceRoot() throws -> URL {
    var candidates: [URL] = []
    let environment = ProcessInfo.processInfo.environment
    for key in ["CODEX_ROUTER_SOURCE_ROOT", "MODEL_ROUTER_SOURCE_ROOT"] {
      if let explicit = environment[key], !explicit.isEmpty {
        candidates.append(URL(fileURLWithPath: explicit, isDirectory: true))
      }
    }
    // The service owner's private manifest wins over the app's build checkout,
    // matching the embedded Control Center after any explicit operator
    // override. Otherwise the two halves of this one app can mutate different
    // registries after a developer build opens an installed service.
    if let recorded = recordedInstallSourceRoot() { candidates.append(recorded) }
    if let configured = Bundle.main.object(forInfoDictionaryKey: "ModelRouterSourceRoot") as? String,
      !configured.isEmpty
    {
      candidates.append(URL(fileURLWithPath: configured, isDirectory: true))
    }

    if let dataHome = environment["XDG_DATA_HOME"], !dataHome.isEmpty {
      candidates.append(
        URL(fileURLWithPath: dataHome, isDirectory: true)
          .appendingPathComponent("codex-router", isDirectory: true)
      )
    }
    let home = FileManager.default.homeDirectoryForCurrentUser
    candidates.append(
      home.appendingPathComponent(".local/share/codex-router", isDirectory: true)
    )
    candidates.append(home.appendingPathComponent(".codex-router", isDirectory: true))

    for candidate in candidates {
      if let root = try? validatedSourceRoot(candidate) { return root }
    }
    throw RouterError(
      "Cannot find the installed Codex Router checkout. Install the router or rebuild this app from its checkout."
    )
  }

  private func assertMutationCompatibility(sourceRoot: URL) throws {
    let expectedVersion = Bundle.main.object(
      forInfoDictionaryKey: "ModelRouterControlVersion"
    ) as? String
    let expectedProtocol = (
      Bundle.main.object(forInfoDictionaryKey: "ModelRouterControlProtocol") as? NSNumber
    )?.intValue
    let installed = RouterControlContractPolicy.installedContract(sourceRoot: sourceRoot)
    guard RouterControlContractPolicy.matches(
      installed: installed,
      expectedVersion: expectedVersion,
      expectedProtocol: expectedProtocol
    ) else {
      throw RouterError(
        "This Codex Router app does not match the installed router control protocol. "
          + "Install or update the router and desktop app from the same build, then reopen the app."
      )
    }
  }

  private func validatedSourceRoot(_ root: URL) throws -> URL {
    let resolvedRoot = root.standardizedFileURL.resolvingSymlinksInPath()
    let required: [(URL, FileAttributeType, Bool)] = [
      (resolvedRoot, .typeDirectory, false),
      (resolvedRoot.appendingPathComponent("src", isDirectory: true), .typeDirectory, false),
      (resolvedRoot.appendingPathComponent("bin", isDirectory: true), .typeDirectory, false),
      (resolvedRoot.appendingPathComponent("src/control.mjs"), .typeRegular, false),
      (resolvedRoot.appendingPathComponent("bin/control"), .typeRegular, true),
    ]
    for (url, expectedType, executable) in required {
      let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
      guard attributes[.type] as? FileAttributeType == expectedType,
        trustedOwnerAndMode(attributes),
        !executable || FileManager.default.isExecutableFile(atPath: url.path)
      else {
        throw RouterError("The Codex Router checkout is missing or has unsafe ownership or permissions.")
      }
    }
    return resolvedRoot
  }

  private func trustedOwnerAndMode(_ attributes: [FileAttributeKey: Any]) -> Bool {
    guard let owner = attributes[.ownerAccountID] as? NSNumber,
      let permissions = attributes[.posixPermissions] as? NSNumber
    else { return false }
    let ownerID = owner.uint32Value
    return (ownerID == getuid() || ownerID == 0) && (permissions.uint16Value & 0o022) == 0
  }

  private func recordedInstallSourceRoot() -> URL? {
    let environment = ProcessInfo.processInfo.environment
    let home = FileManager.default.homeDirectoryForCurrentUser
    let stateDirectory: URL
    if let configured = environment["MODEL_ROUTER_STATE_DIR"]
      ?? environment["CODEX_ROUTER_STATE_DIR"]
      ?? environment["KIMI_CODEX_STATE_DIR"],
      !configured.isEmpty
    {
      stateDirectory = URL(fileURLWithPath: configured, isDirectory: true)
    } else {
      let codexHome = environment["CODEX_HOME"].flatMap { $0.isEmpty ? nil : $0 }
        .map { URL(fileURLWithPath: $0, isDirectory: true) }
        ?? home.appendingPathComponent(".codex", isDirectory: true)
      stateDirectory = codexHome.appendingPathComponent("codex-router", isDirectory: true)
    }
    return RouterInstallManifestPolicy.sourceRoot(stateDirectory: stateDirectory)
  }
}

private struct RouterHealth: Decodable {
  let ok: Bool?
  let error: String?
  let degraded: [String]?
  let gateway: RouterServiceHealth?
  let oauth: RouterServiceHealth?
  let api: RouterServiceHealth?
  let activity: RouterActivity

}

private struct RouterServiceHealth: Decodable, Equatable {
  let reachable: Bool?
  let enabled: Bool?
}

private enum TrayServiceHealthState: Equatable {
  case ready
  case degraded
  case offline
  case standby
  case unknown

  var tint: Color {
    switch self {
    case .ready: return routerMint
    case .degraded: return routerYellow
    case .offline: return routerRed
    case .standby, .unknown: return routerMutedStrong
    }
  }
}

private struct TrayServiceHealthRow: Identifiable {
  let id: String
  let label: String
  let state: TrayServiceHealthState
  let status: String
  let detail: String
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

/// Bounds a child `Process` so a wedged provider cannot hold the tray's
/// catalog UI hostage. `arm` schedules a SIGTERM, escalating to SIGKILL if the
/// child ignores it, and `disarm` cancels the timer once the process is gone.
/// The `finished` flag is what makes `disarm` safe: it is set under the same
/// lock the watchdog takes, so a timer firing during teardown cannot signal a
/// process the caller has already reaped.
final class RouterScriptWatchdog: @unchecked Sendable {
  /// Electron's discovery budget (`{ timeoutMs: 45_000 }` in
  /// apps/control-center/electron/ipc.mjs). One provider HTTP round trip.
  static let discoveryTimeout: TimeInterval = 45
  /// Electron's `CATALOG_MUTATION_TIMEOUT_MS` (330_000). Curation waits on a
  /// cross-process publish lock and rebuilds every installed client, so it
  /// gets the same long budget rather than a discovery-sized one.
  static let catalogMutationTimeout: TimeInterval = 330
  /// Grace period between SIGTERM and SIGKILL, for a child that traps TERM.
  static let terminationGrace: TimeInterval = 5

  private let task: Process
  private let lock = NSLock()
  private var finished = false
  private var timedOut = false
  // Signalled by `disarm` so a deadline that is no longer needed stops waiting
  // immediately instead of sleeping out a 330s curation budget.
  private let gate = DispatchSemaphore(value: 0)

  init(task: Process) { self.task = task }

  var didTimeOut: Bool {
    lock.lock()
    defer { lock.unlock() }
    return timedOut
  }

  /// The deadline runs on a thread of its own, deliberately.
  ///
  /// The first version scheduled it with `DispatchQueue.global().asyncAfter`.
  /// That deadlocks against the very condition this class exists to break:
  /// the caller blocks a thread in `waitUntilExit()`, the pipe readers hold
  /// two more, and on a small machine libdispatch had no thread left to run
  /// the work item -- so a wedged child ran to completion and the watchdog
  /// never fired. CI caught it on a 3-core macOS runner, where a `sleep 60`
  /// armed at 0.4s exited normally after 60s. A dedicated thread cannot be
  /// starved by the blocked callers it is supposed to rescue.
  func arm(after timeout: TimeInterval) {
    let thread = Thread { [weak self] in
      guard let self else { return }
      if self.gate.wait(timeout: .now() + timeout) == .timedOut { self.fire() }
    }
    thread.name = "codex-router.script-watchdog"
    thread.stackSize = 64 << 10
    thread.start()
  }

  func disarm() {
    lock.lock()
    finished = true
    lock.unlock()
    gate.signal()
  }

  private func fire() {
    lock.lock()
    guard !finished, task.isRunning else {
      lock.unlock()
      return
    }
    timedOut = true
    let pid = task.processIdentifier
    task.terminate()
    lock.unlock()
    guard pid > 0 else { return }
    // Escalation sleeps on the watchdog's own thread rather than queueing:
    // this runs after `terminate()` on a wedged child, which is exactly when
    // libdispatch's pool may have nothing free to hand a work item.
    Thread.sleep(forTimeInterval: Self.terminationGrace)
    lock.lock()
    defer { lock.unlock() }
    guard !finished, task.isRunning else { return }
    kill(pid, SIGKILL)
  }
}

private struct RouterError: LocalizedError {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}

enum ChatGptSessionSharingState: String, Decodable, Equatable {
  case enabled
  case disabled
}

enum ChatGptSessionUsability: String, Decodable, Equatable {
  case usable
  case expired
  case unavailable
}

struct ChatGptSessionStatus: Decodable, Equatable {
  let sharing: ChatGptSessionSharingState
  let session: ChatGptSessionUsability
  let present: Bool
  let expiresInHours: Double?

  private enum CodingKeys: String, CodingKey {
    case sharing
    case session
    case present
    case expiresInHours
  }

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    sharing = try values.decode(ChatGptSessionSharingState.self, forKey: .sharing)
    session = try values.decode(ChatGptSessionUsability.self, forKey: .session)
    present = try values.decode(Bool.self, forKey: .present)
    let expiry = try values.decodeIfPresent(Double.self, forKey: .expiresInHours)
    guard expiry?.isFinite != false else {
      throw DecodingError.dataCorruptedError(
        forKey: .expiresInHours,
        in: values,
        debugDescription: "ChatGPT session expiry must be finite"
      )
    }
    expiresInHours = expiry
  }
}

enum ChatGptSessionControlPolicy {
  static func allowsChange(to enabled: Bool, status: ChatGptSessionStatus?) -> Bool {
    guard let status else { return false }
    return !enabled || status.session == .usable
  }

  static func arguments(enabled: Bool) -> [String] {
    ["chatgpt-session", enabled ? "enable" : "disable"]
  }
}

struct RouterSnapshot: Decodable {
  let targets: [String: RouterTarget]
  let catalog: RouterDashboardSnapshot?
  // Absent from an older router's output, so the tray keeps working against one
  // rather than failing the whole decode over a field it gained later.
  let presence: RouterPresence?
  let harness: RouterHarness?
  // Malformed or future consent states fail closed without taking the rest of
  // the tray offline. The settings row becomes unavailable and cannot enable
  // sharing until this app understands the control contract again.
  let chatgptSession: ChatGptSessionStatus?

  private enum CodingKeys: String, CodingKey {
    case targets
    case presence
    case harness
    case chatgptSession
    case catalog
  }

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    targets = try values.decode([String: RouterTarget].self, forKey: .targets)
    presence = try values.decodeIfPresent(RouterPresence.self, forKey: .presence)
    harness = try values.decodeIfPresent(RouterHarness.self, forKey: .harness)
    do {
      chatgptSession = try values.decodeIfPresent(
        ChatGptSessionStatus.self,
        forKey: .chatgptSession
      )
    } catch {
      chatgptSession = nil
    }
    catalog = try values.decodeIfPresent(RouterDashboardSnapshot.self, forKey: .catalog)
  }

  init(
    targets: [String: RouterTarget],
    presence: RouterPresence?,
    harness: RouterHarness?,
    chatgptSession: ChatGptSessionStatus?,
    catalog: RouterDashboardSnapshot? = nil
  ) {
    self.targets = targets
    self.presence = presence
    self.harness = harness
    self.chatgptSession = chatgptSession
    self.catalog = catalog
  }

  static let empty = RouterSnapshot(
    targets: [:],
    presence: nil,
    harness: nil,
    chatgptSession: nil,
    catalog: nil
  )
}

struct RouterDashboardSnapshot: Decodable {
  let pools: [RouterApiKeyPool]
  let accountPool: RouterAccountPoolSnapshot?
  let routingPolicies: RouterRoutingPolicies?

  private enum CodingKeys: String, CodingKey {
    case pools
    case accountPool
    case routingPolicies
  }

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    pools = try values.decodeIfPresent([RouterApiKeyPool].self, forKey: .pools) ?? []
    accountPool = try values.decodeIfPresent(RouterAccountPoolSnapshot.self, forKey: .accountPool)
    routingPolicies = try values.decodeIfPresent(RouterRoutingPolicies.self, forKey: .routingPolicies)
  }
}

struct RouterApiKeyPool: Decodable, Identifiable {
  let providerId: String
  let policy: RouterPoolPolicy
  let credentials: [RouterApiKeyPoolCredential]
  var id: String { providerId }
}

struct RouterPoolPolicy: Decodable {
  let strategy: String
}

struct RouterApiKeyPoolCredential: Decodable, Identifiable {
  let id: String
  let paused: Bool
  let health: RouterPoolHealth?
}

struct RouterPoolHealth: Decodable {
  let state: String
  let lastStatus: Int?
}

struct RouterAccountPoolSnapshot: Decodable {
  let policy: RouterAccountPoolPolicy
  let accounts: [String: RouterAccountPoolEntry]
  let sessions: RouterPoolSessionCount?
  let profile: RouterProfileSwitchSnapshot?
}

struct RouterAccountPoolPolicy: Decodable {
  let enabled: Bool
  let mode: String?
  let strategy: String
  let selectedAccountId: String?
}

struct RouterAccountPoolEntry: Decodable {
  let label: String?
  let subscription: RouterAccountPoolSubscription?
  let paused: Bool
  let health: RouterPoolHealth?
}

struct RouterAccountPoolSubscription: Decodable {
  let usable: Bool?
  let email: String?
}

struct RouterPoolSessionCount: Decodable {
  let count: Int
}

struct RouterProfileSwitchSnapshot: Decodable {
  let desired: String?
  let active: String?
  let pending: Bool
  let running: Bool?
}

struct RouterRoutingPolicies: Decodable {
  let combos: [RouterComboPolicy]
  let searchSidecar: RouterSearchSidecar
  let subagent: RouterSubagentRoutingPolicy

  private enum CodingKeys: String, CodingKey {
    case combos
    case searchSidecar
    case subagent
  }

  init(
    combos: [RouterComboPolicy] = [],
    searchSidecar: RouterSearchSidecar = RouterSearchSidecar(),
    subagent: RouterSubagentRoutingPolicy = RouterSubagentRoutingPolicy()
  ) {
    self.combos = combos
    self.searchSidecar = searchSidecar
    self.subagent = subagent
  }

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    combos = try values.decodeIfPresent([RouterComboPolicy].self, forKey: .combos) ?? []
    searchSidecar = try values.decodeIfPresent(RouterSearchSidecar.self, forKey: .searchSidecar)
      ?? RouterSearchSidecar()
    subagent = try values.decodeIfPresent(RouterSubagentRoutingPolicy.self, forKey: .subagent)
      ?? RouterSubagentRoutingPolicy()
  }
}

struct RouterComboPolicy: Decodable, Identifiable {
  let id: String
  let displayName: String
  let strategy: String
  let sticky: Bool
  let stickyLimit: Int
  let enabled: Bool?
}

struct RouterSearchSidecar: Decodable {
  let enabled: Bool
  let providerId: String?
  let credentialRef: String?

  init(enabled: Bool = false, providerId: String? = nil, credentialRef: String? = nil) {
    self.enabled = enabled
    self.providerId = providerId
    self.credentialRef = credentialRef
  }
}

struct RouterSubagentRoutingPolicy: Decodable {
  let allowUnverifiedModels: Bool
  let requiredCapabilities: [String]

  init(allowUnverifiedModels: Bool = false, requiredCapabilities: [String] = []) {
    self.allowUnverifiedModels = allowUnverifiedModels
    self.requiredCapabilities = requiredCapabilities
  }
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
  let accountSelection: String?
  let accountEmail: String?
  let profilePending: Bool?
  let planType: String?
  let limitId: String?
  let primary: CodexRateLimitWindow?
  let secondary: CodexRateLimitWindow?
  let dailyUsageBuckets: [CodexDailyUsageBucket]
  let summary: CodexUsageSummary

  static func == (lhs: CodexAccountUsage, rhs: CodexAccountUsage) -> Bool {
    lhs.planType == rhs.planType
      && lhs.accountSelection == rhs.accountSelection
      && lhs.accountEmail == rhs.accountEmail
      && lhs.profilePending == rhs.profilePending
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
  // Optional because a router older than the field still answers without it;
  // those rows simply stay ungrouped rather than failing to decode.
  let ownedBy: String?
  // Optional for the same reason. "anonymous" keeps a keyless gateway out of
  // a vendor's "N accounts" group; a missing value reads as credentialed.
  let authMode: String?

  static let legacyFallback: [RouterProviderInfo] = [
    .init(id: "grok-oauth", displayName: "Grok OAuth", kind: "oauth", ownedBy: "xai", authMode: nil),
    .init(id: "kimi-oauth", displayName: "Kimi OAuth", kind: "oauth", ownedBy: "kimi", authMode: nil),
    .init(id: "deepseek", displayName: "DeepSeek API", kind: "openai-compatible", ownedBy: "deepseek", authMode: nil),
    .init(id: "grok-api", displayName: "Grok API", kind: "openai-compatible", ownedBy: "xai", authMode: nil),
    .init(id: "kimi-api", displayName: "Kimi API", kind: "openai-compatible", ownedBy: "kimi", authMode: nil),
    .init(id: "kimi-api-cn", displayName: "Kimi API (China)", kind: "openai-compatible", ownedBy: "kimi", authMode: nil),
    .init(id: "anthropic-api", displayName: "Anthropic API", kind: "openai-compatible", ownedBy: "anthropic", authMode: nil),
  ]
}

struct RouterModel: Decodable, Identifiable {
  let slug: String
  let displayName: String
  let provider: String
  let enabled: Bool
  let multiAgentVersion: String?
  let subagentCertification: String?
  let visible: Bool?
  let reasoningLevels: [String]?
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
  let evaluatedRequests: Int?
  let largestResultBytes: Int?
  let resultsAged: Int?
  let resultsShaped: Int?
  let bytesSaved: Int?
  let estimatedTokensSaved: Int?
  let ranges: [String: ToolResultAgingRange]?

  var savingsSummary: String? {
    guard let requests, requests > 0, let estimatedTokensSaved, let bytesSaved else {
      // Enabled and running, but nothing qualified. Saying nothing here reads
      // as "the toggle did nothing" -- the exact ambiguity that sent an
      // operator hunting for a hook that was loaded the whole time. Report the
      // largest result seen so the gap to the floor is visible.
      guard let evaluatedRequests, evaluatedRequests > 0 else { return nil }
      let largestBytes = largestResultBytes ?? 0
      let largest = Self.compactBytes(largestBytes)
      // Size is only one of the two reasons nothing ages. A result the model
      // has not acted on yet is skipped whatever its size, so a result over
      // the floor can still be counted here -- and saying "no result over
      // 32 KB (largest 40 KB)" would contradict itself in the same sentence.
      if largestBytes > Self.agingMinBytes {
        return "Nothing aged yet in \(evaluatedRequests) requests (largest \(largest))"
      }
      return "No result over 32 KB in \(evaluatedRequests) requests (largest \(largest))"
    }
    let tokens = Self.compactCount(estimatedTokensSaved)
    let megabytes = String(format: "%.1f", Double(bytesSaved) / 1_048_576)
    return "Saved ~\(tokens) tokens (\(megabytes) MB) across \(requests) requests"
  }

  // Mirrors TOOL_RESULT_AGING_MIN_BYTES in src/tool-result-aging.mjs. Only the
  // wording above depends on it, so a drifted copy misworks a label rather
  // than the pass itself.
  static let agingMinBytes = 32 * 1024

  static func compactBytes(_ value: Int) -> String {
    if value >= 1_048_576 { return String(format: "%.1f MB", Double(value) / 1_048_576) }
    if value >= 1_024 { return String(format: "%.0f KB", Double(value) / 1_024) }
    return "\(value) B"
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
  // Optional so a newer tray remains compatible with a router installed
  // before the curated MLX workflow existed.
  let mlx: LocalMlxSnapshot?
}

struct LocalMlxSnapshot: Decodable, Equatable {
  let model: LocalMlxModel?
  let host: LocalMlxHost?
  let prerequisites: LocalMlxPrerequisites?
  let operation: LocalMlxOperation
  let runtime: LocalMlxRuntime?

  func replacing(operation: LocalMlxOperation) -> LocalMlxSnapshot {
    LocalMlxSnapshot(
      model: model,
      host: host,
      prerequisites: prerequisites,
      operation: operation,
      runtime: runtime
    )
  }
}

struct LocalMlxHost: Decodable, Equatable {
  let supported: Bool
  let platform: String
  let arch: String
  let reason: String?
}

struct LocalMlxModel: Decodable, Equatable {
  let id: String
  let slug: String
  let source: String
  let precision: String
  let contextLength: Int
}

struct LocalMlxPrerequisites: Decodable, Equatable {
  let lms: LocalMlxPrerequisite
  let uvx: LocalMlxPrerequisite
}

struct LocalMlxPrerequisite: Decodable, Equatable {
  let available: Bool
  let automaticWithYes: Bool?
  let source: String?
  let installHint: String?
}

struct LocalMlxOperation: Decodable, Equatable {
  let status: String
  let detail: String?
  let percent: Int?
  let progressMode: String?
  let startedAt: Double?
  let updatedAt: Double?
  let workerPid: Int?
  let error: String?

  var isRunning: Bool {
    switch status {
    case "preparing", "downloading", "loading", "starting-server", "verifying", "publishing":
      return true
    default:
      return false
    }
  }

  var showsDeterminateProgress: Bool { progressMode != "indeterminate" }

  var stageLabel: String {
    switch status {
    case "preparing": return "Preparing runtime"
    case "downloading": return "Downloading model"
    case "loading": return "Loading model"
    case "starting-server": return "Starting local server"
    case "verifying": return "Verifying model"
    case "publishing": return "Wiring Codex"
    case "done": return "Ready for Codex"
    case "cancelled": return "Installation cancelled"
    case "error": return "Installation failed"
    default: return "Not installed"
    }
  }
}

struct LocalMlxRuntime: Decodable, Equatable {
  let loopbackReachable: Bool
  let served: Bool
  let published: Bool

  var ready: Bool { loopbackReachable && served && published }
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

  var isRunning: Bool { status == "downloading" || status == "uninstalling" }
  var isUninstalling: Bool { status == "uninstalling" }
}

struct SubagentSettingsSnapshot: Decodable {
  let mode: String
  let enabled: [String]
  let disabled: [String]
  let all: Bool
  let proofs: [String: SubagentProofSnapshot]?
  // Per-model depth applied only to child turns. Absent for every model the
  // operator has not set, which is the common case.
  let efforts: [String: String]?
}

struct SubagentProofSnapshot: Decodable {
  let status: String
  let reason: String?
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

enum TrayMenuBarDisplayMode: String, CaseIterable, Identifiable, Equatable {
  case standard
  case iconOnly

  var id: String { rawValue }
  var label: String {
    switch self {
    case .standard: return routerLocalized("Standard")
    case .iconOnly: return routerLocalized("Icon only")
    }
  }
}

enum TrayMenuBarIconStyle: String, CaseIterable, Identifiable, Equatable {
  case provider
  case indicator
  case preset
  case custom

  var id: String { rawValue }
  var label: String {
    switch self {
    case .provider: return routerLocalized("Provider icon")
    case .indicator: return routerLocalized("Activity dot")
    case .preset: return routerLocalized("Preset icon")
    case .custom: return routerLocalized("Custom image")
    }
  }
}

enum MenuBarCustomIconError: Error, Equatable {
  case tooLarge
}

struct MenuBarSettings: Equatable {
  var displayMode: TrayMenuBarDisplayMode
  var showModelName: Bool
  var iconStyle: TrayMenuBarIconStyle
  var presetIcon: String
  var customIconPath: String?
}

enum MenuBarLayoutMetrics {
  static let standardReservedWidth: CGFloat = 180
  static let iconOnlyWidth: CGFloat = 28

  nonisolated static func statusItemWidth(displayMode: TrayMenuBarDisplayMode) -> CGFloat {
    displayMode == .iconOnly ? iconOnlyWidth : standardReservedWidth
  }

  nonisolated static func showsActivityBadge(iconStyle: TrayMenuBarIconStyle, isIdle: Bool) -> Bool {
    iconStyle != .indicator && !isIdle
  }
}

struct DesktopQuotaRow: Identifiable {
  let id: String
  let providerID: String
  let providerName: String
  let label: String
  let remainingPercent: Double
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
  let credentialLabel: String?
  // Set when connecting successfully still leaves the account unable to use
  // the API, because its plan does not include one. Shown before the buttons
  // rather than after a 403 lands in Codex.
  let planNote: String?
  let anonymousNote: String?
  let catalogSources: [ProviderCatalogSource]?

  var supportsLiveModelCatalog: Bool {
    !(catalogSources ?? []).isEmpty
  }
}

struct ProviderCatalogSource: Decodable, Identifiable, Equatable {
  let id: String
  let displayName: String
  let kind: String
}

struct ProviderCatalogChoice: Identifiable {
  let id: String
  let displayName: String
}

/// The Swift half of the catalog input contract that
/// `apps/control-center/electron/ipc.mjs` enforces for the same two scripts.
/// Both surfaces hand provider-supplied ids straight to `curate-models.mjs`,
/// so both have to agree on what an id may contain.
///
/// There is no shell here -- `Process` runs `/usr/bin/env` with an argv array
/// -- so this is not about command injection. It is about the wire format:
/// `--models` takes one comma-separated list, so a single id containing a
/// comma silently becomes two ids the user never selected, and a leading `-`
/// would be read as another flag.
enum ProviderCatalogInput {
  /// Mirrors `MODEL_SLUG` in ipc.mjs: `^[A-Za-z0-9][A-Za-z0-9._/:+-]{0,200}$`.
  static let maxModelIDLength = 201
  /// Mirrors `PROVIDER_ID` in ipc.mjs: `^[a-z0-9][a-z0-9-]{0,80}$`.
  static let maxProviderIDLength = 81
  /// Mirrors the 1...200 array bound ipc.mjs puts on `addProviderModels`.
  static let maxModelIDCount = 200

  private static let asciiAlphanumerics = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")
  private static let modelIDBody = asciiAlphanumerics.union("._/:+-")
  private static let providerIDBody = Set("abcdefghijklmnopqrstuvwxyz0123456789-")
  private static let providerIDHead = Set("abcdefghijklmnopqrstuvwxyz0123456789")

  static func isValidModelID(_ value: String) -> Bool {
    matches(value, head: asciiAlphanumerics, body: modelIDBody, maxLength: maxModelIDLength)
  }

  static func isValidProviderID(_ value: String) -> Bool {
    matches(value, head: providerIDHead, body: providerIDBody, maxLength: maxProviderIDLength)
  }

  private static func matches(
    _ value: String,
    head: Set<Character>,
    body: Set<Character>,
    maxLength: Int
  ) -> Bool {
    guard let first = value.first, head.contains(first) else { return false }
    guard value.count <= maxLength else { return false }
    return value.dropFirst().allSatisfy { body.contains($0) }
  }

  enum Failure: LocalizedError, Equatable {
    case emptySelection
    case tooManyModels(Int)
    case invalidModelID(String)
    case duplicateModelID
    case invalidProviderID(String)

    var errorDescription: String? {
      switch self {
      case .emptySelection, .tooManyModels:
        return "Choose between 1 and \(ProviderCatalogInput.maxModelIDCount) provider models."
      case .invalidModelID(let id):
        return "Model id is invalid: \(id)"
      case .duplicateModelID:
        return "Provider model ids must be unique."
      case .invalidProviderID(let id):
        return "Provider is invalid: \(id)"
      }
    }
  }

  /// Rejects, rather than silently repairs, a selection Electron would refuse.
  /// Deduplicating here would hide a catalog that served the same id twice.
  static func validatedModelIDs(_ modelIDs: [String]) throws -> [String] {
    guard !modelIDs.isEmpty else { throw Failure.emptySelection }
    guard modelIDs.count <= maxModelIDCount else { throw Failure.tooManyModels(modelIDs.count) }
    var seen = Set<String>()
    for id in modelIDs {
      let trimmed = id.trimmingCharacters(in: .whitespacesAndNewlines)
      guard isValidModelID(trimmed) else { throw Failure.invalidModelID(id) }
      guard seen.insert(trimmed).inserted else { throw Failure.duplicateModelID }
    }
    return modelIDs
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .sorted()
  }

  static func validatedProviderID(_ provider: String) throws -> String {
    let trimmed = provider.trimmingCharacters(in: .whitespacesAndNewlines)
    guard isValidProviderID(trimmed) else { throw Failure.invalidProviderID(provider) }
    return trimmed
  }
}

struct ProviderModelCatalog: Decodable, Equatable {
  let provider: String
  let discovered: [String]
  let registered: [String]
  let unregistered: [String]
  let addable: [String]?
  let blocked: [String: String]?
  let unavailable: [String]
  let cached: Bool?
  let stale: Bool?
  let fetchedAt: String?

  // Older routers did not distinguish protocol-verified candidates. Keep the
  // tray compatible with them while honoring the explicit fail-closed set as
  // soon as the backend supplies it.
  var addableModelIDs: Set<String> {
    Set(addable ?? unregistered)
  }
}

private struct ActivityDotView: View {
  let state: RouterActivityState
  let diameter: CGFloat
  let slot: CGFloat?

  init(state: RouterActivityState, diameter: CGFloat = 6, slot: CGFloat? = nil) {
    self.state = state
    self.diameter = diameter
    self.slot = slot
  }

  var body: some View {
    // MenuBarExtra status-item labels are rasterized by AppKit. A SwiftUI
    // Shape can disappear during that conversion even though it renders in
    // the panel; use the system symbol path that status items handle reliably.
    Image(systemName: "circle.fill")
      .font(.system(size: diameter, weight: .regular))
      .symbolRenderingMode(.monochrome)
      .foregroundStyle(state.tint)
      .frame(width: slot ?? diameter, height: slot ?? diameter)
      .accessibilityLabel(state.label)
  }
}

private struct MenuBarIconView: View {
  @ObservedObject var store: RouterStore
  var size: CGFloat = 13

  var body: some View {
    switch store.menuBarIconStyle {
    case .provider:
      ProviderIcon(providerID: providerID, size: size, showsHelp: false)
    case .indicator:
      ActivityDotView(state: store.activityState, diameter: 7, slot: size)
    case .preset:
      Image(systemName: store.menuBarPresetIcon)
        .font(.system(size: size, weight: .medium))
        .foregroundStyle(store.activityState == .idle ? Color.primary : store.activityState.tint)
        .frame(width: size, height: size)
    case .custom:
      if let customImage = store.menuBarCustomIconImage {
        Image(nsImage: customImage)
          .resizable()
          .interpolation(.high)
          .scaledToFit()
          .frame(width: size, height: size)
      } else {
        Image(systemName: "cpu")
          .font(.system(size: size, weight: .medium))
          .foregroundStyle(routerMuted)
          .frame(width: size, height: size)
      }
    }
  }

  private var providerID: String {
    store.hasConcurrentActivity
      ? (store.activeRequests.first?.provider ?? store.selectedUsageProviderID)
      : store.selectedUsageProviderID
  }
}

private struct StatusItemLabel: View {
  @ObservedObject var store: RouterStore
  @State private var pulsing = false

  var body: some View {
    if store.menuBarDisplayMode == .iconOnly {
      HStack(spacing: 4) {
        MenuBarIconView(store: store, size: 17)
        if MenuBarLayoutMetrics.showsActivityBadge(
          iconStyle: store.menuBarIconStyle,
          isIdle: store.activityState == .idle
        ) {
          Circle()
            .fill(store.activityState.tint)
            .frame(width: 5, height: 5)
            .scaleEffect(pulsing ? 1.6 : 1)
            .animation(.easeOut(duration: 0.45), value: pulsing)
        }
      }
      .frame(width: MenuBarLayoutMetrics.statusItemWidth(displayMode: store.menuBarDisplayMode), height: 22)
      .clipped()
      .contentShape(Rectangle())
      .help(tooltipText)
      .onChange(of: store.attentionPulse) { _ in
        pulsing = true
        Task {
          try? await Task.sleep(for: .milliseconds(450))
          pulsing = false
        }
      }
    } else {
      HStack(spacing: 5) {
        if store.menuBarIconStyle == .indicator {
          ActivityDotView(state: store.activityState)
            .scaleEffect(pulsing ? 1.6 : 1)
            .opacity(pulsing ? 0.55 : 1)
            .animation(.easeOut(duration: 0.45), value: pulsing)
        } else {
          MenuBarIconView(store: store, size: 15)
        }
        if store.menuBarShowModelName {
          Text(store.hasConcurrentActivity ? store.activitySummaryLabel : store.selectedUsageProvider.shortName)
            .font(.system(size: 11, weight: .medium, design: .rounded))
            .lineLimit(1)
            .truncationMode(.tail)
        }
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
      .frame(width: MenuBarLayoutMetrics.statusItemWidth(displayMode: store.menuBarDisplayMode), alignment: .leading)
      .clipped()
      .help(tooltipText)
      .onChange(of: store.attentionPulse) { _ in
        pulsing = true
        Task {
          try? await Task.sleep(for: .milliseconds(450))
          pulsing = false
        }
      }
    }
  }

  private var tooltipText: String {
    let provider = store.activeRequests.isEmpty ? store.selectedUsageProvider.displayName : store.compactActivityProvidersLabel
    return RouterStore.menuBarTooltip(
      provider: provider,
      state: store.activityState.label,
      usage: store.selectedUsageText
    )
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
  @State private var savingsRangeSelectedByUser = false
  @State private var confirmSessionSharing = false

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
        .map {
          (id: $0.id, enabled: store.providerEnabled(
            $0.id,
            authoritative: enabled.contains($0.id)
          ))
        }
        .sorted { $0.id < $1.id }
    }
    return Dictionary(grouping: target.models.filter { $0.provider != "openai" }, by: \.provider)
      .map {
        (id: $0.key, enabled: store.providerEnabled(
          $0.key,
          authoritative: $0.value.contains(where: \.enabled)
        ))
      }
      .sorted { $0.id < $1.id }
  }

  // Vendors that publish more than one provider read as unrelated services in a
  // flat list -- "Z.ai GLM Coding Plan" and "Z.ai API" sit apart under Z, and
  // Kimi's three sit under K with nothing saying they are one account family.
  // `variantOf` already collapses the rows that share a credential; these do not
  // share one, so they stay separately connectable and are only drawn together.
  private var providerVendorGroups: [ProviderGroup] {
    guard let target, let registry = target.providers, !registry.isEmpty else {
      return providers.map {
        ProviderGroup(
          id: $0.id,
          vendorLabel: nil,
          members: [ProviderGroup.Member(id: $0.id, enabled: $0.enabled, shortName: nil)]
        )
      }
    }
    let enabled = Set(target.enabledProviders)
    let names = Dictionary(uniqueKeysWithValues: registry.map { ($0.id, $0.displayName) })
    func lone(_ entry: RouterProviderInfo) -> ProviderGroup {
      ProviderGroup(id: entry.id, vendorLabel: nil, members: [
        ProviderGroup.Member(
          id: entry.id,
          enabled: store.providerEnabled(entry.id, authoritative: enabled.contains(entry.id)),
          shortName: nil
        )
      ])
    }
    return Dictionary(grouping: registry) { $0.ownedBy ?? $0.id }
      .flatMap { vendor, entries -> [ProviderGroup] in
        let sorted = entries.sorted { $0.id < $1.id }
        // An anonymous gateway is not an account of the vendor's paid product;
        // drawing it under an "N accounts" heading beside a credentialed
        // sibling claims a relationship that does not exist (opencode-free
        // would read as a second opencode account). It always stands alone.
        let accounts = sorted.filter { $0.authMode != "anonymous" }
        let standalone = sorted.filter { $0.authMode == "anonymous" }
        // A lone provider keeps its own name and no header: a vendor heading
        // above a single row is noise, not structure.
        guard accounts.count > 1 else { return sorted.map(lone) }
        let prefix = commonWordPrefix(accounts.map { names[$0.id] ?? $0.id })
        // No shared leading words means the display names cannot supply a
        // heading, and a raw registry id is not one either -- those rows stay
        // flat rather than shipping a lowercase internal id as a brand.
        guard !prefix.isEmpty else { return sorted.map(lone) }
        let group = ProviderGroup(
          id: vendor,
          vendorLabel: prefix,
          members: accounts.map { entry in
            let full = names[entry.id] ?? entry.id
            let short = String(full.dropFirst(prefix.count)).trimmingCharacters(in: .whitespaces)
            // "Z.ai API" minus "Z.ai" leaves "API"; a name that is nothing but
            // its vendor leaves nothing, so keep the full name there.
            return ProviderGroup.Member(
              id: entry.id,
              enabled: store.providerEnabled(entry.id, authoritative: enabled.contains(entry.id)),
              shortName: short.isEmpty ? full : short
            )
          }
        )
        return [group] + standalone.map(lone)
      }
      .sorted { ($0.vendorLabel ?? $0.members[0].id) < ($1.vendorLabel ?? $1.members[0].id) }
  }

  // The vendor name is the leading words every display name in the group
  // shares: "Z.ai GLM Coding Plan" + "Z.ai API" -> "Z.ai", and "xAI Grok OAuth"
  // + "xAI Grok API" -> "xAI Grok". Whole words only, so a group that happens to
  // share a few letters cannot produce a heading that is half a word.
  private func commonWordPrefix(_ values: [String]) -> String {
    guard let first = values.first else { return "" }
    var prefix = first.split(separator: " ").map(String.init)
    for value in values.dropFirst() {
      let words = value.split(separator: " ").map(String.init)
      var shared: [String] = []
      for (a, b) in zip(prefix, words) where a == b { shared.append(a) }
      prefix = shared
      if prefix.isEmpty { break }
    }
    // Identical names share every word, which says nothing about a vendor.
    if values.allSatisfy({ $0 == first }) { return "" }
    return prefix.joined(separator: " ")
  }

  private var chatGptSessionDetail: String {
    guard let status = store.snapshot.chatgptSession else {
      return routerLocalized("Sharing status unavailable")
    }
    let sharing = status.sharing == .enabled
      ? routerLocalized("Sharing enabled")
      : routerLocalized("Sharing disabled")
    let login: String
    switch status.session {
    case .usable:
      if let hours = status.expiresInHours {
        login = routerFormat(
          "login usable · about %@h left",
          hours.formatted(.number.precision(.fractionLength(0...1)))
        )
      } else {
        login = routerLocalized("login usable")
      }
    case .expired:
      login = routerLocalized("login expired")
    case .unavailable:
      login = status.present
        ? routerLocalized("login unavailable · sign-in data detected")
        : routerLocalized("login unavailable · run codex login")
    }
    return "\(sharing) · \(login)"
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
    .task {
      await store.refresh()
      selectInitialSavingsRange()
    }
    .onChange(of: savingsRangeDataFingerprint) { _ in
      selectInitialSavingsRange()
    }
  }

  // A quiet most-recent day should not hide the savings that are already in a
  // longer window. Keep 24H as the default when it has data, but start on the
  // first populated range otherwise; a manual range choice always wins.
  private func selectInitialSavingsRange() {
    guard !savingsRangeSelectedByUser,
          let ranges = target?.modelSettings?.toolResultAging?.stats?.ranges,
          (ranges[savingsRange.rawValue]?.requests ?? 0) == 0,
          let firstPopulated = SavingsRange.allCases.first(where: {
            (ranges[$0.rawValue]?.requests ?? 0) > 0
          }) else { return }
    savingsRange = firstPopulated
  }

  private var savingsRangeDataFingerprint: String {
    guard let ranges = target?.modelSettings?.toolResultAging?.stats?.ranges else { return "" }
    return SavingsRange.allCases.map { range in
      let value = ranges[range.rawValue]
      return "\(range.rawValue):\(value?.requests ?? 0):\(value?.savedTokens ?? 0)"
    }.joined(separator: "|")
  }


  private var header: some View {
    HStack(alignment: .center, spacing: 12) {
      VStack(alignment: .leading, spacing: 3) {
        Text(routerLocalized("Codex Router"))
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
      // AppKit's segmented control keeps the titles it was created with, so a
      // language change must recreate it rather than relabel it in place.
      .id(store.language)

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

    sectionLabel(routerLocalized("Service health"), detail: serviceHealthSummary)
    VStack(spacing: 0) {
      ForEach(serviceHealthRows) { row in
        HStack(spacing: 8) {
          Circle()
            .fill(row.state.tint)
            .frame(width: 6, height: 6)
          VStack(alignment: .leading, spacing: 1) {
            Text(row.label)
              .font(.system(size: 10, weight: .medium))
            Text(row.detail)
              .font(.system(size: 8))
              .foregroundStyle(routerMuted)
              .lineLimit(1)
          }
          Spacer(minLength: 6)
          Text(row.status)
            .font(.system(size: 8.5, weight: .semibold))
            .foregroundStyle(row.state.tint)
        }
        .padding(.vertical, 6)
        if row.id != serviceHealthRows.last?.id {
          Divider().opacity(0.45)
        }
      }
    }
    .padding(.horizontal, 9)
    .background(
      Color.primary.opacity(0.045),
      in: RoundedRectangle(cornerRadius: 9, style: .continuous)
    )

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
            Text(row.model.displayName)
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
      let rangeRequests = range?.requests ?? 0
      let allTimeTokens = agingStats.estimatedTokensSaved ?? 0
      sectionLabel("Context savings", detail: "\(agedRequests) requests compacted all-time")
      VStack(alignment: .leading, spacing: 8) {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          VStack(alignment: .leading, spacing: 2) {
            Text("Tool results compressed into recoverable receipts")
              .font(.system(size: 10, weight: .medium))
              .lineLimit(1)
            Text(rangeRequests > 0
              ? "\(rangeRequests) compacted requests in this window"
              : "No compactions in this window")
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
                  savingsRangeSelectedByUser = true
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
            Text("~\(compactTokenCount(Double(allTimeTokens))) tok")
              .font(.system(size: 15, weight: .semibold, design: .monospaced))
              .foregroundStyle(routerMint)
              .monospacedDigit()
            Text("saved all-time")
              .font(.system(size: 7.5))
              .foregroundStyle(routerMuted)
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
      VStack(spacing: 6) {
        ForEach(quotaResets, id: \.id) { entry in
          HStack(spacing: 8) {
            ProviderIcon(providerID: entry.providerID, size: 14)
            VStack(alignment: .leading, spacing: 1) {
              // The window label leads: the provider name alone leaves
              // ChatGPT's 5-hour and weekly rows indistinguishable.
              Text(entry.window ?? entry.provider)
                .font(.system(size: 10, weight: .medium))
                .lineLimit(1)
              if entry.window != nil {
                Text(entry.provider)
                  .font(.system(size: 8.5))
                  .foregroundStyle(routerMuted)
                  .lineLimit(1)
              }
            }
            Spacer(minLength: 6)
            VStack(alignment: .trailing, spacing: 1) {
              Text(resetCountdownLabel(entry.date))
                .font(.system(size: 10, weight: .semibold))
                .monospacedDigit()
              Text(resetClockLabel(entry.date))
                .font(.system(size: 8.5))
                .foregroundStyle(routerMuted)
            }
          }
        }
      }
    }
  }

  private var quotaResets: [(id: String, providerID: String, provider: String, window: String?, date: Date)] {
    store.visibleUsageCards.compactMap { card in
      guard let date = card.resetDate else { return nil }
      return (
        id: card.id,
        providerID: card.providerID,
        provider: card.title,
        window: card.kindLabel,
        date: date
      )
    }
  }

  private var serviceHealthSummary: String {
    guard store.routerHealth != nil else { return routerLocalized("Checking") }
    let attention = serviceHealthRows.filter { $0.state == .offline || $0.state == .degraded }.count
    if attention > 0 {
      return "\(attention) \(routerLocalized(attention == 1 ? "dependency needs attention" : "dependencies need attention"))"
    }
    return routerLocalized("All clear")
  }

  private var serviceHealthRows: [TrayServiceHealthRow] {
    let health = store.routerHealth
    let degraded = Set(health?.degraded ?? [])
    let routerState: TrayServiceHealthState
    let routerStatus: String
    let routerDetail: String
    if let health {
      if health.ok == true {
        routerState = .ready
        routerStatus = routerLocalized("Ready")
        routerDetail = routerLocalized("Serving locally")
      } else if !degraded.isEmpty {
        routerState = .degraded
        routerStatus = routerLocalized("Degraded")
        routerDetail = "\(degraded.count) \(routerLocalized(degraded.count == 1 ? "dependency needs attention" : "dependencies need attention"))"
      } else {
        routerState = .offline
        routerStatus = routerLocalized("Offline")
        routerDetail = health.error ?? routerLocalized("Health endpoint unavailable")
      }
    } else {
      routerState = .unknown
      routerStatus = routerLocalized("Unknown")
      routerDetail = routerLocalized("Waiting for health report")
    }

    var rows = [TrayServiceHealthRow(
      id: "router",
      label: routerLocalized("Router"),
      state: routerState,
      status: routerStatus,
      detail: routerDetail
    )]

    func dependencyRow(
      id: String,
      label: String,
      service: RouterServiceHealth?
    ) -> TrayServiceHealthRow {
      if service == nil {
        let offline = degraded.contains(id)
        return TrayServiceHealthRow(
          id: id,
          label: routerLocalized(label),
          state: offline ? .offline : .unknown,
          status: routerLocalized(offline ? "Offline" : "Unknown"),
          detail: routerLocalized(offline ? "Unreachable" : "Waiting for health report")
        )
      }
      if service?.enabled == false && !degraded.contains(id) {
        return TrayServiceHealthRow(
          id: id,
          label: routerLocalized(label),
          state: .standby,
          status: routerLocalized("Standby"),
          detail: routerLocalized("Not enabled")
        )
      }
      if service?.reachable == false || degraded.contains(id) {
        return TrayServiceHealthRow(
          id: id,
          label: routerLocalized(label),
          state: .offline,
          status: routerLocalized("Offline"),
          detail: routerLocalized("Unreachable")
        )
      }
      if service?.reachable == true {
        return TrayServiceHealthRow(
          id: id,
          label: routerLocalized(label),
          state: .ready,
          status: routerLocalized("Ready"),
          detail: routerLocalized("Reachable")
        )
      }
      return TrayServiceHealthRow(
        id: id,
        label: routerLocalized(label),
        state: .unknown,
        status: routerLocalized("Unknown"),
        detail: routerLocalized("Waiting for health report")
      )
    }

    rows.append(dependencyRow(id: "gateway", label: "Gateway", service: health?.gateway))
    let forwarders = [("oauth", "OAuth forwarder", health?.oauth), ("api", "API forwarder", health?.api)]
      .filter { health != nil && $0.2 != nil || degraded.contains($0.0) }
    if forwarders.isEmpty {
      rows.append(TrayServiceHealthRow(
        id: "forwarders",
        label: routerLocalized("External forwarders"),
        state: health == nil ? .unknown : .standby,
        status: routerLocalized(health == nil ? "Unknown" : "Standby"),
        detail: routerLocalized(health == nil ? "Waiting for health report" : "No external forwarders enabled")
      ))
    } else {
      for (id, label, service) in forwarders {
        rows.append(dependencyRow(id: id, label: label, service: service))
      }
    }
    return rows
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
      // AppKit's segmented control keeps the titles it was created with, so a
      // language change must recreate it rather than relabel it in place.
      .id(store.language)
    }
    .padding(.vertical, 2)
    HStack(spacing: 12) {
      VStack(alignment: .leading, spacing: 3) {
        Text(routerLocalized("Menu bar mode"))
          .font(.system(size: 12, weight: .medium))
        Text(store.menuBarDisplayMode == .iconOnly
          ? routerLocalized("Compact icon only, no model name text")
          : routerLocalized("Show icon, model name, and usage"))
          .font(.system(size: 10))
          .foregroundStyle(routerMuted)
      }
      Spacer()
      Picker("", selection: Binding(
        get: { store.menuBarDisplayMode },
        set: { store.setMenuBarDisplayMode($0) }
      )) {
        ForEach(TrayMenuBarDisplayMode.allCases) { mode in
          Text(mode.label).tag(mode)
        }
      }
      .pickerStyle(.segmented)
      .labelsHidden()
      .frame(width: 168)
      .id(store.language)
    }
    .padding(.vertical, 2)

    if store.menuBarDisplayMode == .standard {
      settingRow(
        title: routerLocalized("Show model name"),
        detail: store.menuBarShowModelName
          ? routerLocalized("Current model or provider is visible in menu bar")
          : routerLocalized("Hide model name text in menu bar"),
        isOn: Binding(
          get: { store.menuBarShowModelName },
          set: { store.setMenuBarShowModelName($0) }
        )
      )
    }

    HStack(spacing: 12) {
      VStack(alignment: .leading, spacing: 3) {
        Text(routerLocalized("Menu bar icon"))
          .font(.system(size: 12, weight: .medium))
        Text(routerLocalized("Choose the icon displayed in the menu bar"))
          .font(.system(size: 10))
          .foregroundStyle(routerMuted)
      }
      Spacer()
      Picker("", selection: Binding(
        get: { store.menuBarIconStyle },
        set: { store.setMenuBarIconStyle($0) }
      )) {
        ForEach(TrayMenuBarIconStyle.allCases) { style in
          Text(style.label).tag(style)
        }
      }
      .pickerStyle(.menu)
      .labelsHidden()
      .frame(width: 168)
      .id(store.language)
    }
    .padding(.vertical, 2)

    if store.menuBarIconStyle == .preset {
      HStack(spacing: 8) {
        Text(routerLocalized("Preset icon"))
          .font(.system(size: 11, weight: .medium))
          .foregroundStyle(routerMuted)
        Spacer()
        ForEach(["cpu", "brain", "sparkles", "terminal", "bolt.horizontal.circle", "network"], id: \.self) { symbol in
          Button {
            store.setMenuBarPresetIcon(symbol)
          } label: {
            Image(systemName: symbol)
              .font(.system(size: 12, weight: .medium))
              .frame(width: 24, height: 24)
              .background(
                store.menuBarPresetIcon == symbol ? routerAccent.opacity(0.18) : Color.primary.opacity(0.04),
                in: RoundedRectangle(cornerRadius: 6, style: .continuous)
              )
              .overlay(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                  .stroke(store.menuBarPresetIcon == symbol ? routerAccent : Color.clear, lineWidth: 1)
              )
          }
          .buttonStyle(.plain)
        }
      }
      .padding(.vertical, 2)
    }

    if store.menuBarIconStyle == .custom {
      HStack(spacing: 10) {
        if store.menuBarCustomIconMissing {
          Text(routerLocalized("Custom image missing"))
            .font(.system(size: 10))
            .foregroundStyle(routerMuted)
            .lineLimit(1)
          Spacer()
          Button(routerLocalized("Clear")) {
            store.setMenuBarCustomIconPath(nil)
          }
          .buttonStyle(.borderless)
          .font(.system(size: 10))
        } else if let path = store.menuBarCustomIconPath, !path.isEmpty {
          Text(URL(fileURLWithPath: path).lastPathComponent)
            .font(.system(size: 10, design: .monospaced))
            .foregroundStyle(routerMuted)
            .lineLimit(1)
            .truncationMode(.middle)
          Spacer()
          Button(routerLocalized("Clear")) {
            store.setMenuBarCustomIconPath(nil)
          }
          .buttonStyle(.borderless)
          .font(.system(size: 10))
        } else {
          Text(routerLocalized("No custom image selected"))
            .font(.system(size: 10))
            .foregroundStyle(routerMuted)
          Spacer()
        }
        Button(routerLocalized("Choose Image…")) {
          chooseCustomIconImage()
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
      }
      .padding(.vertical, 2)
    }

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
      // The "System · <resolved>" option is itself translated, so the menu
      // must also be recreated when the language changes.
      .id(store.language)
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
      // AppKit's segmented control keeps the titles it was created with, so a
      // language change must recreate it rather than relabel it in place.
      .id(store.language)
    }
    .padding(.vertical, 2)
    settingRow(
      title: routerLocalized("Use Router with ChatGPT"),
      detail: store.signedRoutingEnabled(authoritative: store.signedRouting)
        ? routerLocalized("Native GPT + external models · task history preserved")
        : routerLocalized("Keep ChatGPT login and the current task history"),
      isOn: Binding(
        get: { store.signedRoutingEnabled(authoritative: store.signedRouting) },
        set: { enabled in store.setSignedRouting(enabled) }
      ),
      isDisabled: store.loginFreeEnabled(authoritative: store.loginFree)
    )
    settingRow(
      title: routerLocalized("Share ChatGPT subscription"),
      detail: chatGptSessionDetail,
      isOn: Binding(
        get: { store.snapshot.chatgptSession?.sharing == .enabled },
        set: { enabled in
          if enabled {
            confirmSessionSharing = true
          } else {
            Task { await store.setChatGptSessionSharing(false) }
          }
        }
      ),
      isDisabled: store.providerOperation != nil
        || !ChatGptSessionControlPolicy.allowsChange(
          to: store.snapshot.chatgptSession?.sharing != .enabled,
          status: store.snapshot.chatgptSession
        )
    )
    if confirmSessionSharing {
      VStack(alignment: .leading, spacing: 7) {
        Text(routerLocalized("Enable ChatGPT session sharing?"))
          .font(.system(size: 10, weight: .semibold))
          .foregroundStyle(routerYellow)
        Text(routerLocalized("Enabling lets other local Codex Router clients spend this user's ChatGPT subscription. Only continue for clients you trust on this Mac."))
          .font(.system(size: 9))
          .foregroundStyle(routerMutedStrong)
          .fixedSize(horizontal: false, vertical: true)
        HStack(spacing: 8) {
          Button(routerLocalized("Cancel")) { confirmSessionSharing = false }
            .buttonStyle(.borderless)
          Button(routerLocalized("Enable sharing")) {
            confirmSessionSharing = false
            Task { await store.setChatGptSessionSharing(true) }
          }
          .buttonStyle(.borderedProminent)
          .controlSize(.small)
          .tint(routerYellow)
        }
      }
      .padding(8)
      .background(
        routerYellow.opacity(0.10),
        in: RoundedRectangle(cornerRadius: 8, style: .continuous)
      )
    }
    settingRow(
      title: routerLocalized("Use without OpenAI login"),
      detail: store.loginFreeEnabled(authoritative: store.loginFree)
        ? routerLocalized("External providers · Codex restarts automatically")
        : routerLocalized("Use connected models and restart Codex"),
      isOn: Binding(
        get: { store.loginFreeEnabled(authoritative: store.loginFree) },
        set: { enabled in store.setLoginFree(enabled) }
      ),
      isDisabled: store.signedRoutingEnabled(authoritative: store.signedRouting)
    )
    settingRow(
      title: routerLocalized("Compact old tool results"),
      detail: target.modelSettings?.toolResultAging?.environmentOverride == true
        ? routerLocalized("Forced off by CODEX_ROUTER_TOOL_RESULT_AGING=0")
        : (target.modelSettings?.toolResultAging?.stats?.savingsSummary
          ?? routerLocalized("Off by default · token maxxing starts at 70% on external models")),
      isOn: Binding(
        // Off when the snapshot has not arrived, because that is what the
        // router does with no state file (tool-result-aging-state.mjs). The row
        // says "Off by default" a line above; showing the switch on while
        // nothing is being aged contradicted it on every fresh install.
        get: {
          store.toolResultAgingEnabled(
            authoritative: target.modelSettings?.toolResultAging?.enabled ?? false
          )
        },
        set: { enabled in store.setToolResultAgingEnabled(enabled) }
      ),
      isDisabled: target.modelSettings?.toolResultAging?.environmentOverride == true
    )
    harnessRow
    maintenanceRow
    AccordionPanel(
      title: routerLocalized("Providers"),
      summary: store.providerOperation == nil ? routerLocalized("Auto-saved") : routerLocalized("Applying…"),
      expanded: $providersExpanded
    ) {
      // Bound once per body pass. Reading the property inside the loop instead
      // would regroup and re-sort the whole registry for every row, and `body`
      // re-runs on each store publish, so the cost would be paid continuously
      // rather than once: measured at 89us a pass, that is 2.4ms of a render
      // spent on nothing.
      let groups = providerVendorGroups
      VStack(spacing: 0) {
        ForEach(groups) { group in
          if let vendorLabel = group.vendorLabel {
            HStack(spacing: 6) {
              Text(vendorLabel)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(routerMuted)
              Text(routerFormat("%d accounts", group.members.count))
                .font(.system(size: 9))
                .foregroundStyle(routerMuted.opacity(0.7))
              Spacer()
            }
            .padding(.top, 8)
            .padding(.bottom, 2)
          }
          ForEach(group.members) { member in
            ProviderSetupRow(
              provider: (id: member.id, enabled: member.enabled),
              titleOverride: member.shortName,
              setup: store.providerSetup[member.id],
              account: store.providerUsage(for: member.id)?.account,
              // A provider connection/login still replaces the controls with
              // progress. A provider visibility write does not: the switch
              // must remain clickable so a second click can supersede it.
              isBusy: store.providerOperation == member.id
                && !store.providerToggleIsActive(member.id),
              controlsDisabled: store.providerOperation != nil,
              onToggle: { enabled in
                store.setProvider(member.id, enabled: enabled)
              },
              onConnect: { Task { await store.connectProvider(member.id) } },
              onLogin: { Task { await store.loginProvider(member.id) } },
              onSaveKey: { key in Task { await store.saveProviderKey(member.id, key: key) } },
              onRemoveKey: { Task { await store.removeProviderKey(member.id) } }
            )
            // Indent only the grouped rows, so a vendor's accounts read as
            // belonging to the heading above them.
            .padding(.leading, group.vendorLabel == nil ? 0 : 10)
            if member.id != group.members.last?.id {
              Divider().padding(.leading, group.vendorLabel == nil ? 0 : 10)
            }
          }
          if group.id != groups.last?.id {
            Divider()
          }
        }
      }
    }
    ProviderPoolsPanel(store: store)
    RoutingPoliciesPanel(store: store)
    ModelSettingsAccordion(store: store, target: target)
  }

  private struct ProviderPoolsPanel: View {
    @ObservedObject var store: RouterStore
    @State private var expanded = false

    private var pools: [RouterApiKeyPool] { store.snapshot.catalog?.pools ?? [] }
    private var accountPool: RouterAccountPoolSnapshot? { store.snapshot.catalog?.accountPool }

    var body: some View {
      AccordionPanel(
        title: routerLocalized("Provider pools"),
        summary: pools.isEmpty
          ? routerLocalized("No API-key pool configured")
          : routerFormat("%d provider pools", pools.count),
        expanded: $expanded
      ) {
        VStack(alignment: .leading, spacing: 8) {
          Text(routerLocalized("Pool controls change routing metadata only. API keys and account tokens stay in their secure stores."))
            .font(.system(size: 9))
            .foregroundStyle(routerMuted)
            .fixedSize(horizontal: false, vertical: true)
          if let accountPool {
            HStack(spacing: 10) {
              VStack(alignment: .leading, spacing: 2) {
                Text(routerLocalized("ChatGPT account pool"))
                  .font(.system(size: 11, weight: .medium))
                Text(accountPool.accounts.isEmpty
                  ? routerLocalized("No pooled accounts registered")
                  : routerFormat("%d accounts · %@", accountPool.accounts.count, accountPool.policy.strategy))
                  .font(.system(size: 9))
                  .foregroundStyle(routerMuted)
              }
              Spacer()
              Picker("", selection: Binding(
                get: { accountPool.policy.mode == "pool" ? "pool" : "switch" },
                set: { mode in Task { await store.setChatGPTAccountPoolMode(mode) } }
              )) {
                Text(routerLocalized("Switch")).tag("switch")
                Text(routerLocalized("Pool")).tag("pool")
              }
              .pickerStyle(.menu)
              .labelsHidden()
              .frame(width: 86)
              .disabled(store.providerOperation != nil)
              Picker("", selection: Binding(
                get: {
                  accountPool.policy.enabled
                    ? accountPool.policy.selectedAccountId ?? "auto"
                    : accountPool.profile?.active ?? accountPool.accounts.keys.sorted().first ?? "auto"
                },
                set: { selection in Task { await store.setChatGPTAccountSelection(selection) } }
              )) {
                Text(routerLocalized("Automatic")).tag("auto")
                ForEach(accountPool.accounts.keys.sorted(), id: \.self) { accountId in
                  if let account = accountPool.accounts[accountId], account.subscription?.usable == true {
                    Text(account.subscription?.email ?? account.label ?? accountId).tag(accountId)
                  }
                }
              }
              .pickerStyle(.menu)
              .labelsHidden()
              .frame(width: 170)
              .disabled(store.providerOperation != nil)
            }
          }
          if pools.isEmpty {
            Text(routerLocalized("Add a second provider credential to use health-aware rotation."))
              .font(.system(size: 9))
              .foregroundStyle(routerMutedStrong)
          } else {
            ForEach(pools) { pool in
              VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 7) {
                  ProviderIcon(providerID: pool.providerId, size: 14)
                  Text(pool.providerId)
                    .font(.system(size: 10, weight: .semibold))
                  Spacer()
                  Picker("", selection: Binding(
                    get: { pool.policy.strategy },
                    set: { strategy in Task { await store.setProviderPoolStrategy(pool.providerId, strategy: strategy) } }
                  )) {
                    Text("Quota").tag("quota")
                    Text("Round robin").tag("round-robin")
                    Text("Fill first").tag("fill-first")
                  }
                  .pickerStyle(.menu)
                  .labelsHidden()
                  .frame(width: 112)
                  .disabled(store.providerOperation != nil)
                }
                ForEach(pool.credentials) { credential in
                  HStack(spacing: 6) {
                    Circle()
                      .fill(credential.paused ? routerMuted : routerMint)
                      .frame(width: 5, height: 5)
                    Text(credential.id)
                      .font(.system(size: 8, design: .monospaced))
                      .lineLimit(1)
                      .truncationMode(.middle)
                    Spacer()
                    Toggle(
                      "",
                      isOn: Binding(
                        get: { !credential.paused },
                        set: { enabled in
                          Task {
                            await store.setProviderPoolCredentialPaused(
                              provider: pool.providerId,
                              credential: credential.id,
                              paused: !enabled
                            )
                          }
                        }
                      )
                    )
                    .toggleStyle(.switch)
                    .controlSize(.mini)
                    .labelsHidden()
                    .disabled(store.providerOperation != nil)
                  }
                }
              }
              .padding(8)
              .background(
                Color.primary.opacity(0.045),
                in: RoundedRectangle(cornerRadius: 8, style: .continuous)
              )
            }
          }
        }
      }
    }
  }

  private struct RoutingPoliciesPanel: View {
    @ObservedObject var store: RouterStore
    @State private var expanded = false

    private var policies: RouterRoutingPolicies? { store.snapshot.catalog?.routingPolicies }

    var body: some View {
      AccordionPanel(
        title: routerLocalized("Routing policies"),
        summary: policies == nil ? routerLocalized("Optional") : routerLocalized("Capability aware"),
        expanded: $expanded
      ) {
        if let policies {
          VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
              VStack(alignment: .leading, spacing: 2) {
                Text(routerLocalized("Search sidecar"))
                  .font(.system(size: 11, weight: .medium))
                Text(policies.searchSidecar.enabled
                  ? routerLocalized("Used only for models without native search")
                  : routerLocalized("Disabled · native search is unchanged"))
                  .font(.system(size: 9))
                  .foregroundStyle(routerMuted)
              }
              Spacer()
              Toggle(
                "",
                isOn: Binding(
                  get: { policies.searchSidecar.enabled },
                  set: { enabled in Task { await store.setSearchSidecarEnabled(enabled) } }
                )
              )
              .toggleStyle(.switch)
              .controlSize(.mini)
              .labelsHidden()
              .disabled(store.providerOperation != nil
                || (policies.searchSidecar.providerId == nil && !policies.searchSidecar.enabled)
                || (policies.searchSidecar.credentialRef == nil && !policies.searchSidecar.enabled))
            }
            HStack(spacing: 10) {
              VStack(alignment: .leading, spacing: 2) {
                Text(routerLocalized("Allow unverified subagents"))
                  .font(.system(size: 11, weight: .medium))
                Text(policies.subagent.allowUnverifiedModels
                  ? routerLocalized("Explicit opt-in · capability checks still apply")
                  : routerLocalized("Verified models only"))
                  .font(.system(size: 9))
                  .foregroundStyle(routerMuted)
              }
              Spacer()
              Toggle(
                "",
                isOn: Binding(
                  get: { policies.subagent.allowUnverifiedModels },
                  set: { enabled in Task { await store.setSubagentAllowUnverified(enabled) } }
                )
              )
              .toggleStyle(.switch)
              .controlSize(.mini)
              .labelsHidden()
              .disabled(store.providerOperation != nil)
            }
            if !policies.combos.isEmpty {
              Divider().opacity(0.5)
              Text(routerLocalized("Model combos"))
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(routerMuted)
              ForEach(policies.combos) { combo in
                HStack(spacing: 8) {
                  VStack(alignment: .leading, spacing: 2) {
                    Text(combo.displayName)
                      .font(.system(size: 10, weight: .medium))
                      .lineLimit(1)
                    Text("\(combo.strategy) · \(combo.id)")
                      .font(.system(size: 8, design: .monospaced))
                      .foregroundStyle(routerMuted)
                      .lineLimit(1)
                  }
                  Spacer()
                  Toggle(
                    "",
                    isOn: Binding(
                      get: { combo.enabled ?? true },
                      set: { enabled in Task { await store.setComboEnabled(combo.id, enabled: enabled) } }
                    )
                  )
                  .toggleStyle(.switch)
                  .controlSize(.mini)
                  .labelsHidden()
                  .disabled(store.providerOperation != nil)
                }
              }
            } else {
              Text(routerLocalized("No model combos configured."))
                .font(.system(size: 9))
                .foregroundStyle(routerMutedStrong)
            }
          }
        } else {
          Text(routerLocalized("Routing policy status is unavailable until the router is updated."))
            .font(.system(size: 9))
            .foregroundStyle(routerMuted)
        }
      }
    }
  }

  private struct ModelSettingsAccordion: View {
    @ObservedObject var store: RouterStore
    let target: RouterTarget
    @State private var subagentsExpanded = true
    @State private var pickerExpanded = true
    @State private var providerCatalogsExpanded = true
    @State private var visionExpanded = true
    // Local models are a first-class install surface. Keep this section open
    // on launch so the catalog is not hidden behind the other settings cards.
    @State private var localLlmExpanded = true
    @State private var localDetailsExpanded = false
    @State private var expandedLocalFamilies = Set<String>()
    @State private var expandedLocalVariants = Set<String>()
    @State private var variantHelpExpanded = false
    @State private var localCatalogFilter = ""
    @State private var pickerModelFilter = ""
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
    private var subagentModels: [RouterModel] {
      target.models
        .filter(\.enabled)
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

    private var filteredPickerModels: [RouterModel] {
      let query = pickerModelFilter.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
      guard !query.isEmpty else { return enabledModels }
      return enabledModels.filter { model in
        [model.displayName, model.slug, model.provider, providerName(model.provider)]
          .joined(separator: " ")
          .lowercased()
          .contains(query)
      }
    }

    private var canReloadProviderCatalogs: Bool {
      store.providerSetup.values.contains { $0.configured && $0.supportsLiveModelCatalog }
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
      "\(group.models.filter { isPickerVisible($0) }.count) of \(group.models.count) visible"
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
              detail: store.subagentModeAll(authoritative: settings?.subagents.mode == "all")
                ? "Every proven v2 model can run as a subagent"
                : "Only selected proven v2 models can run as subagents",
              isOn: Binding(
                get: {
                  store.subagentModeAll(authoritative: settings?.subagents.mode == "all")
                },
                set: { enabled in
                  let current = settings?.subagents
                  let mode = enabled
                    ? "all"
                    : current?.enabled.isEmpty == false ? "selected" : "proven"
                  store.setSubagentMode(mode)
                }
              ),
              disabled: false
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
            ForEach(providerGroups(subagentModels)) { group in
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
                    VStack(alignment: .leading, spacing: 3) {
                      toggleRow(
                        title: model.displayName,
                        detail: subagentDetail(for: model),
                        isOn: Binding(
                          get: { subagentToggleOn(model) },
                          set: { enabled in
                            store.setSubagentModel(model.slug, enabled: enabled)
                          }
                        ),
                        disabled: subagentToggleDisabled(model)
                      )
                      if isSubagent(model) {
                        subagentStatusTags(for: model)
                      }
                      // Only for models actually acting as subagents, and only
                      // when the model offers a choice: a one-level ladder has
                      // nothing to pick, and an off model has no child turns to
                      // apply a depth to.
                      if isSubagent(model), (model.reasoningLevels?.count ?? 0) > 1 {
                        subagentEffortRow(for: model)
                      }
                    }
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
            HStack(alignment: .top, spacing: 8) {
              Text(routerLocalized("Hidden models stay connected but are not offered by Codex."))
                .font(.system(size: 9))
                .foregroundStyle(routerMuted)
              Spacer(minLength: 0)
              Button(
                store.providerCatalogLoading.isEmpty
                  ? routerLocalized("Reload provider models")
                  : routerLocalized("Reloading provider models…")
              ) {
                Task { await store.reloadAvailableProviderCatalogs() }
              }
              .buttonStyle(.borderless)
              .font(.system(size: 9, weight: .medium))
              .foregroundStyle(routerMint)
              .disabled(!canReloadProviderCatalogs || !store.providerCatalogLoading.isEmpty)
              .help(routerLocalized("Fetch the current catalog from every connected provider that supports live model discovery."))
            }
            toolbar(
              buttons: [
                ("Show all", { Task { await store.showAllPickerModels() } }),
                ("Hide all", { Task { await store.hideAllPickerModels() } }),
              ]
            )
            TextField(routerLocalized("Search available models"), text: $pickerModelFilter)
              .textFieldStyle(.roundedBorder)
              .font(.system(size: 10))
            if filteredPickerModels.isEmpty && !pickerModelFilter.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
              Text(routerLocalized("No provider models match this search."))
                .font(.system(size: 9))
                .foregroundStyle(routerMuted)
            }
            ForEach(providerGroups(filteredPickerModels)) { group in
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
                        get: { isPickerVisible(model) },
                        set: { visible in
                          store.setPickerModel(model.slug, visible: visible)
                        }
                      ),
                      disabled: false
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

        AccordionPanel(
          title: routerLocalized("Provider catalogs"),
          summary: routerLocalized("Load the latest provider models"),
          expanded: $providerCatalogsExpanded
        ) {
          providerCatalogPanel
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
        HStack(alignment: .top, spacing: 8) {
          Text(routerLocalized("Run local models through Ollama or the curated MLX runtime. Installed models are wired into the same Codex proxy."))
            .font(.system(size: 9))
            .foregroundStyle(routerMuted)
          Spacer(minLength: 0)
          Button(store.isRefreshing ? routerLocalized("Refreshing…") : routerLocalized("Refresh models")) {
            Task { await store.refresh() }
          }
          .buttonStyle(.borderless)
          .font(.system(size: 9, weight: .medium))
          .foregroundStyle(routerMint)
          .disabled(store.isRefreshing)
          .help(routerLocalized("Reload installed and available local models from the router."))
        }
        localMlxSection
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

    private var catalogProviders: [ProviderCatalogChoice] {
      store.providerSetup.values
        .filter(\.configured)
        .flatMap { provider -> [ProviderCatalogChoice] in
          let sources = provider.catalogSources ?? []
          return sources.map { source in
            ProviderCatalogChoice(
              id: source.id,
              displayName: sources.count > 1
                ? "\(provider.displayName) — \(source.displayName)"
                : provider.displayName
            )
          }
        }
        .sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
    }

    @ViewBuilder private var providerCatalogPanel: some View {
      VStack(alignment: .leading, spacing: 8) {
        if catalogProviders.isEmpty {
          Text(routerLocalized("Connect a supported provider to load its latest models."))
            .font(.system(size: 9))
            .foregroundStyle(routerMuted)
        } else {
          Text(routerLocalized("Load models asks that provider for its current list. Choosing models adds them to the router and republishes every installed client."))
            .font(.system(size: 9))
            .foregroundStyle(routerMuted)
          ForEach(catalogProviders) { provider in
            ProviderCatalogRow(
              title: provider.displayName,
              catalog: store.providerCatalogs[provider.id],
              isLoading: store.providerCatalogLoading.contains(provider.id),
              // Any catalog run in flight -- including a bulk reload started
              // from the picker panel -- freezes every row. Otherwise a user
              // can stack concurrent `Process` runs and starve the pipe
              // readers draining them.
              isBusy: !store.providerCatalogLoading.isEmpty,
              onReload: { refresh in
                Task { await store.reloadProviderCatalog(provider.id, refresh: refresh) }
              },
              onAdd: { models in Task { await store.addProviderCatalogModels(provider.id, modelIDs: models) } }
            )
          }
        }
      }
    }

    /// The curated MLX install is deliberately separate from Ollama: it has a
    /// different runtime, download source, and lifecycle. Its stable slug is
    /// still published through the same proxy once the local server verifies.
    @ViewBuilder private var localMlxSection: some View {
      let mlx = store.localMlx
      let operation = mlx?.operation
      let ready = mlx?.runtime?.ready == true
      let unsupported = mlx?.host?.supported == false
      // Runtime verification is authoritative. A terminal record can outlive
      // the retry that made the model healthy, so do not paint a ready route
      // red merely because an older attempt ended badly.
      let failed = !ready && operation?.status == "error"
      let cancelled = !ready && operation?.status == "cancelled"
      let active = operation?.isRunning == true
      let tint = failed || cancelled || unsupported ? routerRed : (ready ? routerMint : routerYellow)

      downloadHeader("QWEN MLX", detail: "LM Studio · 4-bit · ~15 GB")
      VStack(alignment: .leading, spacing: 7) {
        HStack(alignment: .top, spacing: 8) {
          VStack(alignment: .leading, spacing: 2) {
            Text("Qwen3.8 27B Uncensored")
              .font(.system(size: 11, weight: .semibold))
            Text(mlx?.model.map { "\($0.precision) MLX · \($0.contextLength / 1024)K context" }
              ?? "4-bit MLX · 32K context · Apple silicon")
              .font(.system(size: 8))
              .foregroundStyle(routerMutedStrong)
          }
          Spacer(minLength: 6)
          if ready {
            Label("Ready", systemImage: "checkmark.circle.fill")
              .font(.system(size: 8, weight: .semibold))
              .foregroundStyle(routerMint)
          }
        }

        if active, let operation {
          HStack(spacing: 6) {
            OperationPulse(tint: tint)
            Text(operation.stageLabel)
              .font(.system(size: 9, weight: .semibold))
              .foregroundStyle(tint)
            Spacer(minLength: 4)
            Button("Cancel", role: .cancel) {
              Task { await store.cancelLocalMlx() }
            }
            .buttonStyle(.borderless)
            .font(.system(size: 8, weight: .semibold))
            .foregroundStyle(routerRed)
            if operation.showsDeterminateProgress, let percent = operation.percent {
              Text("\(percent)%")
                .font(.system(size: 8, weight: .medium))
                .foregroundStyle(routerMutedStrong)
                .monospacedDigit()
            }
          }
          if let detail = operation.detail, !detail.isEmpty {
            Text(detail)
              .font(.system(size: 8))
              .foregroundStyle(routerMuted)
              .lineLimit(2)
          }
          if operation.showsDeterminateProgress {
            ProgressView(value: Double(operation.percent ?? 0), total: 100)
              .progressViewStyle(.linear)
              .tint(routerMint)
          } else {
            ProgressView()
              .controlSize(.small)
              .tint(routerMint)
              .accessibilityLabel(operation.stageLabel)
          }
        } else if failed || cancelled, let operation {
          Label(operation.stageLabel, systemImage: "exclamationmark.triangle.fill")
            .font(.system(size: 9, weight: .semibold))
            .foregroundStyle(routerRed)
          Text(operation.error ?? operation.detail ?? "The local MLX setup did not complete.")
            .font(.system(size: 8))
            .foregroundStyle(routerRed)
            .lineLimit(3)
        } else if ready {
          Text(mlx?.model?.slug ?? "lmstudio/qwen38-27b-uncensored-mlx")
            .font(.system(size: 8, design: .monospaced))
            .foregroundStyle(routerMutedStrong)
            .lineLimit(1)
            .truncationMode(.middle)
          Text("Served only on this Mac and published to the Codex model picker.")
            .font(.system(size: 8))
            .foregroundStyle(routerMuted)
        } else if unsupported {
          Label("Apple silicon required", systemImage: "cpu")
            .font(.system(size: 9, weight: .semibold))
            .foregroundStyle(routerRed)
          Text(mlx?.host?.reason ?? "This MLX model is available only on Apple silicon Macs.")
            .font(.system(size: 8))
            .foregroundStyle(routerRed)
            .lineLimit(3)
          if let host = mlx?.host {
            Text("Detected: \(host.platform) · \(host.arch)")
              .font(.system(size: 8, design: .monospaced))
              .foregroundStyle(routerMuted)
          }
        } else {
          localMlxPrerequisiteLine("LM Studio runtime", state: mlx?.prerequisites?.lms)
          localMlxPrerequisiteLine("Model downloader", state: mlx?.prerequisites?.uvx)
        }

        Text("Reduced safety guardrails. Treat outputs as untrusted and keep the server local.")
          .font(.system(size: 8))
          .foregroundStyle(routerYellow)
          .lineLimit(2)

        if !active && !ready {
          Button("Install runtime + ~15 GB model and wire Codex") {
            Task { await store.installLocalMlx() }
          }
          .buttonStyle(.borderedProminent)
          .controlSize(.small)
          .tint(routerMint)
          .disabled(unsupported || busy || store.localDownload?.isRunning == true || store.localModelOperation != nil)
          .help(unsupported
            ? (mlx?.host?.reason ?? "This MLX model requires an Apple silicon Mac.")
            : "Installs official local prerequisites when missing, downloads the curated 4-bit model, and publishes it through Codex Router.")
        }
      }
      .padding(8)
      .background(tint.opacity(0.07), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
      .animation(.easeOut(duration: 0.2), value: operation)
    }

    @ViewBuilder private func localMlxPrerequisiteLine(
      _ label: String,
      state: LocalMlxPrerequisite?
    ) -> some View {
      HStack(spacing: 5) {
        Image(systemName: state?.available == true ? "checkmark.circle.fill" : "arrow.down.circle")
          .foregroundStyle(state?.available == true ? routerMint : routerMutedStrong)
        Text(label)
        Spacer()
        Text(state?.available == true
          ? "ready"
          : (state?.automaticWithYes == true ? "official installer on click" : "required"))
          .foregroundStyle(routerMuted)
      }
      .font(.system(size: 8))
      if state?.available != true, let hint = state?.installHint, !hint.isEmpty {
        Text(hint)
          .font(.system(size: 8))
          .foregroundStyle(routerMuted)
          .lineLimit(2)
      } else if state?.available != true,
        let source = state?.source,
        let host = URL(string: source)?.host {
        Text("Source: \(host)")
          .font(.system(size: 8))
          .foregroundStyle(routerMuted)
      }
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
        Button("Cancel", role: .cancel) {
          Task { await store.cancelLocalModel(operation.tag) }
        }
        .buttonStyle(.borderless)
        .font(.system(size: 8, weight: .semibold))
        .foregroundStyle(routerRed)
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
          .disabled(busy || store.localModelOperation != nil || store.localDownload?.isRunning == true)
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
      !busy && store.localModelOperation == nil && store.localDownload?.isRunning != true
        && store.localMlx?.operation.isRunning != true
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
      let isCancelled = download.status == "cancelled"
      let isUninstalling = download.isUninstalling
        || (store.localModelOperation?.tag == download.tag)
      let tint = isError || isCancelled ? routerRed : (isDone ? routerMint : routerYellow)
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
              ? (isUninstalling ? "Local model removal failed" : routerLocalized("Local model install failed"))
              : (isCancelled
                ? (isUninstalling ? "Local model removal cancelled" : "Local model download cancelled")
                : (isDone ? (isUninstalling ? "Local model removed" : routerLocalized("Local model ready"))
                  : (isUninstalling ? "Uninstalling local model" : routerLocalized("Installing local model"))))
          )
            .font(.system(size: 9, weight: .semibold))
            .foregroundStyle(tint)
          Spacer(minLength: 4)
          if download.isRunning, let tag = download.tag {
            Button("Cancel", role: .cancel) {
              Task { await store.cancelLocalModel(tag) }
            }
            .buttonStyle(.borderless)
            .font(.system(size: 8, weight: .semibold))
            .foregroundStyle(routerRed)
          }
          if let percent = download.percent, !isError && !isCancelled && !isUninstalling {
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
            .foregroundStyle(isError || isCancelled ? routerRed : routerMuted)
            .lineLimit(2)
        }
        if download.isRunning && !isUninstalling {
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
          get: { store.localModelEnabled(model.tag, authoritative: model.enabled) },
          set: { on in store.setLocalModelEnabled(model.tag, enabled: on) }
        ))
        .labelsHidden()
        .toggleStyle(.checkbox)
        .controlSize(.mini)
        .disabled(operation != nil || !model.canBeChatModel)
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
      if let operation = store.localMlx?.operation, operation.isRunning {
        let percent = operation.showsDeterminateProgress
          ? operation.percent.map { " · \($0)%" } ?? ""
          : ""
        return "\(operation.stageLabel)\(percent)"
      }
      if store.localMlx?.host?.supported == false {
        return "MLX requires Apple silicon"
      }
      if store.localMlx?.runtime?.ready == true,
        (localModels?.installed ?? 0) == 0 {
        return "Qwen MLX ready for Codex"
      }
      if store.localMlx?.operation.status == "error" {
        return "MLX install failed"
      }
      if let download = store.localDownload, download.isRunning {
        let tag = download.tag ?? routerLocalized("local model")
        let percent = download.percent.map { " · \($0)%" } ?? ""
        return "\(routerLocalized(download.isUninstalling ? "Removing" : "Downloading")) \(tag)\(percent)"
      }
      if let download = store.localDownload, download.status == "error" {
        return download.isUninstalling ? "Last removal failed" : "Last download failed"
      }
      if let download = store.localDownload, download.status == "cancelled" {
        return download.isUninstalling ? "Removal cancelled" : "Download cancelled"
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
      !busy && store.localModelOperation == nil && store.localDownload?.isRunning != true
        && store.localMlx?.operation.isRunning != true
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
      let visionEnabled = store.visionBridgeEnabled(authoritative: vision?.enabled == true)
      VStack(alignment: .leading, spacing: 8) {
        Text(routerLocalized("Text-only models can't see images. When on, a vision model reads the paste and hands over the text."))
          .font(.system(size: 9))
          .foregroundStyle(routerMuted)
        toggleRow(
          title: routerLocalized("Read images for text-only models"),
          detail: visionEnabled
            ? (RouterLanguage.isSimplifiedChinese ? "读取引擎：\(currentEngineLabel)" : "Reading via \(currentEngineLabel)")
            : routerLocalized("Off — text-only models refuse pasted images"),
          isOn: Binding(
            get: { store.visionBridgeEnabled(authoritative: vision?.enabled == true) },
            set: { on in store.setVisionBridgeEnabled(on) }
          ),
          disabled: false
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
        .opacity(visionEnabled ? 1 : 0.45)
        .disabled(!visionEnabled)
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

    private func isPickerVisible(_ model: RouterModel) -> Bool {
      store.pickerModelVisible(
        model.slug,
        authoritative: !hiddenModels.contains(model.slug)
      )
    }

    private var disabledSubagentSet: Set<String> {
      Set(settings?.subagents.disabled ?? [])
    }

    private var selectedSubagentSet: Set<String> {
      Set(settings?.subagents.enabled ?? [])
    }

    private func subagentCertification(for model: RouterModel) -> String {
      if let certification = model.subagentCertification { return certification }
      if model.multiAgentVersion == "v2" { return "v2" }
      if model.multiAgentVersion == "v1" { return "v1" }
      return "unknown"
    }

    private func isKnownV1(_ model: RouterModel) -> Bool {
      subagentCertification(for: model) == "v1"
    }

    private func isCertifiedV2(_ model: RouterModel) -> Bool {
      subagentCertification(for: model) == "v2"
    }

    private func isCertificationCandidate(_ model: RouterModel) -> Bool {
      guard subagentCertification(for: model) == "unknown" else { return false }
      guard let status = settings?.subagents.proofs?[model.slug]?.status else { return false }
      return ["candidate", "experimental", "proven"].contains(status)
    }

    // Status tags, effort controls, and enabled counts must reflect only the
    // capability Codex receives. A selected compatibility-test candidate is
    // not a usable subagent until the exact registry route is certified v2.
    private func isSubagent(_ model: RouterModel) -> Bool {
      if !isPickerVisible(model) { return false }
      let authoritative = !disabledSubagentSet.contains(model.slug)
        && isCertifiedV2(model)
      return store.subagentModelEnabled(model.slug, authoritative: authoritative)
    }

    // Unknown routes use the same row to request their one-time compatibility
    // test. Keep that request checked while it runs (and after a failure so it
    // can be switched off before retrying), but never feed it to isSubagent.
    private func subagentToggleOn(_ model: RouterModel) -> Bool {
      if isCertifiedV2(model) { return isSubagent(model) }
      if !isPickerVisible(model) || isKnownV1(model) || isCertificationCandidate(model) {
        return false
      }
      let authoritative = selectedSubagentSet.contains(model.slug)
      return store.subagentModelEnabled(model.slug, authoritative: authoritative)
    }

    private func subagentToggleDisabled(_ model: RouterModel) -> Bool {
      if !isPickerVisible(model) { return true }
      if isCertifiedV2(model) { return false }
      return isKnownV1(model) || isCertificationCandidate(model)
    }

    // Codex chooses which model a child runs on; this chooses how hard it
    // thinks once it gets there. Indented under its model so it reads as a
    // property of that row rather than another model in the list.
    private func subagentStatusTags(for model: RouterModel) -> some View {
      let effort = settings?.subagents.efforts?[model.slug]
      return HStack(spacing: 5) {
        Text(routerLocalized("Subagent"))
          .font(.system(size: 8, weight: .semibold))
          .foregroundStyle(routerAccent)
          .padding(.horizontal, 6)
          .padding(.vertical, 2)
          .background(Capsule().fill(routerAccent.opacity(0.13)))
        Text("\((effort ?? routerLocalized("Default")).capitalized) \(routerLocalized("thinking"))")
          .font(.system(size: 8, weight: .medium))
          .foregroundStyle(routerMutedStrong)
          .padding(.horizontal, 6)
          .padding(.vertical, 2)
          .background(Capsule().fill(Color.primary.opacity(0.055)))
      }
      .padding(.leading, 14)
    }

    private func subagentEffortRow(for model: RouterModel) -> some View {
      let levels = model.reasoningLevels ?? []
      let current = settings?.subagents.efforts?[model.slug]
      return HStack(spacing: 6) {
        Text(routerLocalized("Effort as subagent"))
          .font(.system(size: 9))
          .foregroundStyle(routerMuted)
        Spacer(minLength: 6)
        Menu {
          Button(routerLocalized("Model default")) {
            Task { await store.setSubagentEffort(model.slug, effort: nil) }
          }
          ForEach(levels, id: \.self) { level in
            Button(level) {
              Task { await store.setSubagentEffort(model.slug, effort: level) }
            }
          }
        } label: {
          Text(current ?? routerLocalized("Model default"))
            .font(.system(size: 9, weight: .medium))
            .lineLimit(1)
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .disabled(busy)
      }
      .padding(.leading, 14)
      .padding(.trailing, 2)
    }

    private func subagentDetail(for model: RouterModel) -> String {
      if !isPickerVisible(model) { return routerLocalized("Hidden from picker — show it below to use it here") }
      if isKnownV1(model) { return routerLocalized("v1 only") }
      if !isCertifiedV2(model), let proof = settings?.subagents.proofs?[model.slug] {
        if proof.status == "checking" { return routerLocalized("Checking…") }
        if isCertificationCandidate(model) {
          return routerLocalized("Certification candidate")
        }
        if proof.status == "failed" {
          return proof.reason ?? routerLocalized("Error")
        }
      }
      if isCertifiedV2(model) && isSubagent(model) {
        let effort = settings?.subagents.efforts?[model.slug] ?? routerLocalized("Default")
        return "\(routerLocalized("Proven v2")) · \(effort.capitalized) \(routerLocalized("thinking"))"
      }
      if isCertifiedV2(model) { return routerLocalized("Proven v2") }
      return routerLocalized("Not selected")
    }

  private var subagentSummary: String {
      let count = subagentModels.filter { isSubagent($0) }.count
      let mode = store.subagentModeAll(authoritative: settings?.subagents.mode == "all")
        ? "all"
        : (settings?.subagents.mode ?? "proven")
      return RouterLanguage.isSimplifiedChinese
        ? "\(count) 个已启用 · \(mode)"
        : "\(count) enabled · \(mode)"
    }

    private var pickerSummary: String {
      let visible = enabledModels.filter { isPickerVisible($0) }.count
      let hidden = enabledModels.count - visible
      return RouterLanguage.isSimplifiedChinese
        ? "\(visible) 个显示 · \(hidden) 个隐藏"
        : "\(visible) visible · \(hidden) hidden"
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

  private struct ProviderCatalogRow: View {
    let title: String
    let catalog: ProviderModelCatalog?
    let isLoading: Bool
    let isBusy: Bool
    /// `true` re-asks the provider. The first load is cache-first; only an
    /// explicit Reload spends a round trip.
    let onReload: (Bool) -> Void
    let onAdd: ([String]) -> Void

    @State private var query = ""
    @State private var selected = Set<String>()

    private var matchingModels: [String] {
      guard let catalog else { return [] }
      let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
      return catalog.discovered.filter { needle.isEmpty || $0.lowercased().contains(needle) }
    }

    var body: some View {
      VStack(alignment: .leading, spacing: 7) {
        HStack(spacing: 8) {
          VStack(alignment: .leading, spacing: 2) {
            Text(title)
              .font(.system(size: 10, weight: .medium))
            Text(catalogDetail)
              .font(.system(size: 8))
              .foregroundStyle(routerMutedStrong)
          }
          Spacer()
          Button(
            isLoading
              ? routerLocalized("Loading models")
              : routerLocalized(catalog == nil ? "Load models" : "Reload models")
          ) {
            onReload(catalog != nil)
          }
          .buttonStyle(.borderless)
          .font(.system(size: 9, weight: .medium))
          .foregroundStyle(routerMint)
          .disabled(isLoading || isBusy)
        }

        if let catalog {
          let registered = Set(catalog.registered)
          let addable = catalog.addableModelIDs
          TextField(routerLocalized("Search available models"), text: $query)
            .textFieldStyle(.roundedBorder)
            .font(.system(size: 9))

          if matchingModels.isEmpty {
            Text(routerLocalized("No provider models match this search."))
              .font(.system(size: 8))
              .foregroundStyle(routerMutedStrong)
              .padding(.vertical, 2)
          } else {
            VStack(spacing: 0) {
              ForEach(Array(matchingModels.prefix(80)), id: \.self) { model in
                HStack(spacing: 7) {
                  if registered.contains(model) {
                    Image(systemName: "checkmark.circle.fill")
                      .font(.system(size: 10))
                      .foregroundStyle(routerMint)
                      .frame(width: 14)
                  } else {
                    Toggle("", isOn: Binding(
                      get: { selected.contains(model) },
                      set: { checked in
                        if checked { selected.insert(model) } else { selected.remove(model) }
                      }
                    ))
                    .labelsHidden()
                    .toggleStyle(.checkbox)
                    .controlSize(.mini)
                    .frame(width: 14)
                    .disabled(isLoading || isBusy || !addable.contains(model))
                  }
                  VStack(alignment: .leading, spacing: 2) {
                    Text(model)
                      .font(.system(size: 8, design: .monospaced))
                      .lineLimit(1)
                      .truncationMode(.middle)
                    if let reason = catalog.blocked?[model] {
                      Text(reason)
                        .font(.system(size: 8))
                        .foregroundStyle(routerYellow)
                        .lineLimit(2)
                    }
                  }
                  Spacer(minLength: 0)
                  if registered.contains(model) {
                    Text(routerLocalized("Added"))
                      .font(.system(size: 8, weight: .medium))
                      .foregroundStyle(routerMutedStrong)
                  }
                }
                .padding(.vertical, 3)
                if model != matchingModels.prefix(80).last {
                  Divider()
                }
              }
            }
            .padding(.horizontal, 3)
            .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            if matchingModels.count > 80 {
              Text(routerLocalized("Showing the first 80 matches. Search to narrow the list."))
                .font(.system(size: 8))
                .foregroundStyle(routerMutedStrong)
            }
          }

          if !selected.isEmpty {
            HStack(spacing: 8) {
              Text(routerFormat("%d selected", selected.count))
                .font(.system(size: 8))
                .foregroundStyle(routerMutedStrong)
              Spacer()
              Button(routerLocalized("Add selected")) {
                onAdd(selected.sorted())
              }
              .buttonStyle(.borderless)
              .font(.system(size: 9, weight: .medium))
              .foregroundStyle(routerMint)
              .disabled(isLoading || isBusy)
            }
          }
        }
      }
      .padding(8)
      .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
      .onChange(of: catalog?.addableModelIDs) { _ in
        selected.formIntersection(catalog?.addableModelIDs ?? [])
      }
    }

    // One format string rather than number + noun fragments glued together:
    // a translator can move the nouns around the numbers, which concatenation
    // makes impossible and which reads wrong in Arabic.
    private var catalogDetail: String {
      guard let catalog else { return routerLocalized("Load the current list from this provider.") }
      let freshness = catalog.cached == true ? routerLocalized("saved list") : routerLocalized("live list")
      return routerFormat(
        "%d models · %d added · %@",
        catalog.discovered.count,
        catalog.registered.count,
        freshness
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

  private func chooseCustomIconImage() {
    let panel = NSOpenPanel()
    panel.allowedContentTypes = [.png, .jpeg, .svg, .icns, .tiff]
    panel.allowsMultipleSelection = false
    panel.canChooseDirectories = false
    panel.canChooseFiles = true
    panel.prompt = routerLocalized("Select")
    if panel.runModal() == .OK, let url = panel.url {
      guard
        let support = FileManager.default.urls(
          for: .applicationSupportDirectory,
          in: .userDomainMask
        ).first
      else { return }
      do {
        let dest = try RouterStore.persistCustomMenuBarIcon(from: url, into: support)
        let loaded = RouterStore.loadCustomMenuBarIcon(path: dest.path)
        guard loaded.image != nil else {
          try? FileManager.default.removeItem(at: dest)
          return
        }
        store.setMenuBarCustomIconPath(dest.path)
      } catch {
        return
      }
    }
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
      Button(routerLocalized("Control Center")) {
        ControlCenterLauncher.open()
      }
      .buttonStyle(.plain)
      .font(.system(size: 11, weight: .semibold))
      .foregroundStyle(routerAccent)

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

      // One control for "pick up the current code": update and reinstall the
      // backend, restart the service, then rebuild and relaunch this tray.
      Button(routerLocalized("Restart")) {
        Task { await store.restartRouter() }
      }
      .buttonStyle(.plain)
      .font(.system(size: 11, weight: .medium))
      .foregroundStyle(routerMuted)

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

// One vendor's providers. `vendorLabel` is nil when the vendor publishes a
// single provider, which renders exactly as it always did.
private struct ProviderGroup: Identifiable {
  struct Member: Identifiable {
    let id: String
    let enabled: Bool
    /// The display name with the vendor prefix removed, or nil when ungrouped.
    let shortName: String?
  }

  let id: String
  let vendorLabel: String?
  let members: [Member]
}

private struct ProviderSetupRow: View {
  let provider: (id: String, enabled: Bool)
  /// Set for a grouped row, whose vendor already appears in the heading above.
  var titleOverride: String? = nil
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
          Text(titleOverride ?? setup?.displayName ?? provider.id)
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
      return RouterLanguage.isSimplifiedChinese ? "就绪 · \(visibility)" : "Ready · \(visibility)"
    }
    switch setup.action {
    case "install": return routerLocalized("Official CLI required")
    case "login": return routerLocalized("Sign in with the official CLI")
    case "add-key":
      return "\(credentialLabel) \(routerLocalized("required"))"
    default: return routerLocalized("Setup required")
    }
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
      }
    } else {
      HStack(spacing: 10) {
        Button(actionTitle) { performAction() }
          .buttonStyle(.plain)
          .font(.system(size: 10, weight: .medium))
          .foregroundStyle(routerAccent)
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
  if let remaining = remainingQuotaPercent(metric) {
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

func remainingQuotaPercent(_ metric: ProviderAccountMetric) -> Double? {
  guard metric.kind == "quota" else { return nil }
  if let remaining = metric.remainingPercent {
    return max(0, min(100, remaining))
  }
  if let used = metric.usedPercent {
    return 100 - max(0, min(100, used))
  }
  if let used = metric.used, let limit = metric.limit, limit > 0 {
    return max(0, min(100, (1 - used / limit) * 100))
  }
  return nil
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

// How long until a quota window reopens -- the number people actually scan
// the reset list for. The absolute clock time is resetClockLabel's job.
// `chinese` is a parameter (not read inline) so tests stay deterministic while
// the Tray language suite mutates the process-wide selection in parallel.
func resetCountdownLabel(
  _ date: Date,
  now: Date = Date(),
  chinese: Bool = RouterLanguage.isSimplifiedChinese
) -> String {
  let seconds = date.timeIntervalSince(now)
  if seconds <= 0 { return chinese ? "即将重置" : "resets soon" }
  let minutes = Int(seconds / 60)
  if minutes < 60 {
    return chinese ? "\(minutes) 分钟后" : "in \(minutes)m"
  }
  let hours = minutes / 60
  if hours < 24 {
    return chinese
      ? "\(hours) 小时 \(minutes % 60) 分后"
      : "in \(hours)h \(minutes % 60)m"
  }
  return chinese
    ? "\(hours / 24) 天 \(hours % 24) 小时后"
    : "in \(hours / 24)d \(hours % 24)h"
}

// Just enough calendar context for the countdown: time today, weekday inside
// the coming week (a weekly window's whole range), month and day beyond it
// (monthly windows).
func resetClockLabel(_ date: Date, now: Date = Date()) -> String {
  if Calendar.current.isDate(date, inSameDayAs: now) {
    return date.formatted(.dateTime.hour().minute())
  }
  if date.timeIntervalSince(now) < 7 * 24 * 3600 {
    return date.formatted(.dateTime.weekday(.abbreviated).hour().minute())
  }
  return date.formatted(.dateTime.month(.abbreviated).day().hour().minute())
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
    // A finite, task-backed transition avoids an always-running animation
    // timeline in an otherwise idle menu-bar process.
    .task(id: "\(state.rawValue)-\(reduceMotion)") { animate() }
  }

  private func animate() {
    breathing = false
    guard state == .generating || state == .starting, !reduceMotion else { return }
    withAnimation(.easeInOut(duration: 0.72)) {
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
    // Pulse once when the operation view appears. The old repeatForever kept a
    // display-list animation alive for every open tray, even when no layout or
    // data was changing.
    .task(id: reduceMotion) {
      guard !reduceMotion else { return }
      withAnimation(.easeOut(duration: 0.9)) {
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
