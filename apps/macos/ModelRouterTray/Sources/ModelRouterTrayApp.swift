import AppKit
import Combine
import Foundation
import SwiftUI

let routerAccent = Color(red: 0.36, green: 0.66, blue: 0.91)
let routerMint = Color(red: 0.38, green: 0.82, blue: 0.61)
let routerYellow = Color(red: 0.94, green: 0.68, blue: 0.25)
let routerRed = Color(red: 0.91, green: 0.35, blue: 0.32)
let routerInk = Color(red: 0.035, green: 0.043, blue: 0.055)
let routerMuted = Color.secondary.opacity(0.72)

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
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

  var body: some Scene {
    MenuBarExtra {
      TrayView(store: appDelegate.store)
        .frame(width: 352, height: 560)
    } label: {
      StatusItemLabel(store: appDelegate.store)
    }
    .menuBarExtraStyle(.window)
  }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  let store = RouterStore()
  private var islandController: IslandWindowController?
  private var islandVisibility: AnyCancellable?

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)
    islandController = IslandWindowController(store: store)
    islandVisibility = store.$islandVisible
      .removeDuplicates()
      .sink { [weak self] visible in self?.islandController?.setVisible(visible) }
    Task { await store.startPolling() }
    Task { await store.startActivityPolling() }
    Task { await store.startAccountUsagePolling() }
    Task { await store.startProviderPolling() }
  }
}

@MainActor
final class RouterStore: ObservableObject {
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
  @Published private(set) var islandVisible: Bool

  private var polling = false
  private var activityPolling = false
  private var accountUsagePolling = false
  private var providerPolling = false
  private let defaults = UserDefaults.standard
  private let islandVisibilityKey = "ModelRouterTray.islandVisible"
  private var accountUsageResolved = false
  private var hasResolvedInitialUsageProvider = false
  private var hasObservedActiveProvider = false
  private var manuallySelectedUsageProvider = false
  private var activityHealthFailureStartedAt: Date?

  init() {
    selectedUsageProviderID = "openai"
    islandVisible = defaults.object(forKey: islandVisibilityKey) == nil
      ? true
      : defaults.bool(forKey: islandVisibilityKey)
  }

  var codexActive: Bool {
    snapshot.targets["codex"]?.active == true
  }

  var loginFree: Bool {
    snapshot.targets["codex"]?.loginFree == true
  }

  var usageProviderChoices: [UsageProviderChoice] {
    let enabled = Set(snapshot.targets["codex"]?.enabledProviders ?? [])
    return [
      UsageProviderChoice(id: "openai", displayName: "ChatGPT", shortName: "ChatGPT", detail: "Codex subscription", isEnabled: true),
      UsageProviderChoice(id: "grok-oauth", displayName: "Grok OAuth", shortName: "Grok", detail: providerDetail("grok-oauth", enabled: enabled), isEnabled: enabled.contains("grok-oauth")),
      UsageProviderChoice(id: "kimi-oauth", displayName: "Kimi OAuth", shortName: "Kimi", detail: providerDetail("kimi-oauth", enabled: enabled), isEnabled: enabled.contains("kimi-oauth")),
      UsageProviderChoice(id: "deepseek", displayName: "DeepSeek API", shortName: "DeepSeek", detail: providerDetail("deepseek", enabled: enabled), isEnabled: enabled.contains("deepseek")),
      UsageProviderChoice(id: "grok-api", displayName: "Grok API", shortName: "Grok API", detail: providerDetail("grok-api", enabled: enabled), isEnabled: enabled.contains("grok-api")),
      UsageProviderChoice(id: "kimi-api", displayName: "Kimi API", shortName: "Kimi API", detail: providerDetail("kimi-api", enabled: enabled), isEnabled: enabled.contains("kimi-api")),
      UsageProviderChoice(id: "anthropic-api", displayName: "Anthropic API", shortName: "Claude", detail: providerDetail("anthropic-api", enabled: enabled), isEnabled: enabled.contains("anthropic-api")),
    ]
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

  var hasConcurrentActivity: Bool {
    activeRequestCount > 1
  }

  var activitySummaryLabel: String {
    if activityState == .generating, activeRequestCount > 1 {
      return "\(activeRequestCount) active"
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
    let previousProvider = selectedUsageProviderID
    selectedUsageProviderID = providerID
    guard previousProvider != providerID else { return }
    Task {
      if providerID == "openai" {
        await refreshAccountUsage()
      } else {
        await refreshProviderUsage()
      }
    }
  }

  func setIslandVisible(_ visible: Bool) {
    islandVisible = visible
    defaults.set(visible, forKey: islandVisibilityKey)
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
      accountUsage = try JSONDecoder().decode(CodexAccountUsage.self, from: output)
      accountUsageError = nil
    } catch {
      accountUsageError = error.localizedDescription
    }
    accountUsageResolved = true
    resolveInitialUsageProvider()
  }

  func refreshProviderUsage() async {
    do {
      let output = try await runControl(arguments: ["provider-usage", "--json"])
      providerUsage = try JSONDecoder().decode(ProviderUsageSnapshot.self, from: output)
      providerUsageError = nil
      resolveInitialUsageProvider()
    } catch {
      providerUsageError = error.localizedDescription
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
      providerSetup = Dictionary(uniqueKeysWithValues: snapshot.providers.map { ($0.id, $0) })
      resolveInitialUsageProvider()
    } catch {
      message = error.localizedDescription
    }
  }

  func selectUsageProvider(_ providerID: String) {
    manuallySelectedUsageProvider = true
    focusUsageProvider(providerID)
  }

  func installProviderCLI(_ provider: String) async {
    await performProviderOperation(
      provider,
      successMessage: "Official provider CLI installed. Sign in to continue."
    ) {
      _ = try await runControl(arguments: ["install-cli", provider])
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

  func dailyTokens(days: Int) -> [Double] {
    dailyUsage(days: days).map(\.tokens)
  }

  func dailyUsage(days: Int) -> [DailyUsagePoint] {
    let indexed: [String: Double]
    if selectedUsageUsesChatGPT {
      guard let accountUsage else { return placeholderDailyUsage(days: days) }
      indexed = Dictionary(uniqueKeysWithValues: accountUsage.dailyUsageBuckets.map {
        ($0.startDate, Double($0.tokens))
      })
    } else {
      guard let usage = selectedProviderUsage else { return placeholderDailyUsage(days: days) }
      indexed = Dictionary(uniqueKeysWithValues: usage.dailyUsageBuckets.map {
        ($0.startDate, Double($0.tokens))
      })
    }
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.calendar = Calendar(identifier: .gregorian)
    formatter.dateFormat = "yyyy-MM-dd"
    let calendar = Calendar.current
    let today = calendar.startOfDay(for: .now)
    return (0..<days).map { offset in
      let date = calendar.date(byAdding: .day, value: offset - (days - 1), to: today) ?? today
      return DailyUsagePoint(date: date, tokens: indexed[formatter.string(from: date)] ?? 0)
    }
  }

  func localUsageTotals(days: Int) -> (tokens: Double, requests: Int) {
    localUsageTotals(for: selectedUsageProviderID, days: days)
  }

  func localUsageTotals(for providerID: String, days: Int) -> (tokens: Double, requests: Int) {
    guard providerID != "openai", let usage = providerUsage(for: providerID) else { return (0, 0) }
    let calendar = Calendar.current
    let today = calendar.startOfDay(for: .now)
    let firstDay = calendar.date(byAdding: .day, value: -(days - 1), to: today) ?? today
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.calendar = Calendar(identifier: .gregorian)
    formatter.dateFormat = "yyyy-MM-dd"
    return usage.dailyUsageBuckets.reduce(into: (tokens: 0.0, requests: 0)) { totals, bucket in
      guard let date = formatter.date(from: bucket.startDate), date >= firstDay, date <= today else { return }
      totals.tokens += Double(bucket.tokens)
      totals.requests += bucket.requests
    }
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


  private func placeholderDailyUsage(days: Int) -> [DailyUsagePoint] {
    let calendar = Calendar.current
    let today = calendar.startOfDay(for: .now)
    return (0..<days).map { offset in
      DailyUsagePoint(
        date: calendar.date(byAdding: .day, value: offset - (days - 1), to: today) ?? today,
        tokens: 0
      )
    }
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
      activityHealthFailureStartedAt = nil
      activityState = health.activity.state
      activeRequests = health.activity.active ?? []
      activeRequestCount = health.activity.activeCount ?? activeRequests.count
      activeModel = health.activity.model
      if let sessionName = health.activity.sessionName, !sessionName.isEmpty {
        activitySessionName = sessionName
      }
      if health.activity.state == .generating,
         let provider = health.activity.provider {
        hasObservedActiveProvider = true
        manuallySelectedUsageProvider = false
        focusUsageProvider(provider)
      }
    } catch {
      recordActivityHealthFailure()
    }
  }

  private func recordActivityHealthFailure() {
    activeRequests = []
    activeRequestCount = 0
    activeModel = nil
    let now = Date()
    if let startedAt = activityHealthFailureStartedAt {
      activityState = now.timeIntervalSince(startedAt) < 30 ? .starting : .error
    } else {
      activityHealthFailureStartedAt = now
      activityState = .starting
    }
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

struct CodexAccountUsage: Decodable {
  let fetchedAt: String
  let planType: String?
  let limitId: String?
  let primary: CodexRateLimitWindow?
  let secondary: CodexRateLimitWindow?
  let dailyUsageBuckets: [CodexDailyUsageBucket]
  let summary: CodexUsageSummary
}

struct CodexRateLimitWindow: Decodable {
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

struct CodexDailyUsageBucket: Decodable {
  let startDate: String
  let tokens: Int64
}

struct DailyUsagePoint: Identifiable {
  let date: Date
  let tokens: Double
  var id: Date { date }
}

struct CodexUsageSummary: Decodable {
  let lifetimeTokens: Int64?
  let peakDailyTokens: Int64?
  let currentStreakDays: Int?
}

struct ProviderUsageSnapshot: Decodable {
  let fetchedAt: String
  let scope: String
  let providers: [RouterProviderUsage]
}

struct RouterProviderUsage: Decodable, Identifiable {
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
}

struct ProviderAccountUsage: Decodable {
  let status: String
  let source: String
  let metrics: [ProviderAccountMetric]
  let message: String?
}

struct ProviderAccountMetric: Decodable {
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

struct ProviderDailyUsageBucket: Decodable {
  let startDate: String
  let tokens: Int64
  let requests: Int
}

struct RouterTarget: Decodable {
  let target: String
  let configured: Bool
  let active: Bool
  let enabledProviders: [String]
  let models: [RouterModel]
  let selectedModel: String?
  let loginFree: Bool?
  let loginFreeManaged: Bool?
  let nativeAliases: [String: String]?
}

struct RouterModel: Decodable, Identifiable {
  let slug: String
  let displayName: String
  let provider: String
  let enabled: Bool
  var id: String { slug }
}

struct UsageProviderChoice: Identifiable {
  let id: String
  let displayName: String
  let shortName: String
  let detail: String
  let isEnabled: Bool
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

struct ProviderSetupState: Decodable, Identifiable {
  let id: String
  let displayName: String
  let kind: String
  let configured: Bool
  let cliInstalled: Bool?
  let action: String
}

private struct StatusItemLabel: View {
  @ObservedObject var store: RouterStore

  var body: some View {
    HStack(spacing: 5) {
      Circle()
        .fill(store.activityState.tint)
        .frame(width: 6, height: 6)
      Text(store.hasConcurrentActivity ? store.activitySummaryLabel : store.selectedUsageProvider.shortName)
        .font(.system(size: 11, weight: .medium, design: .rounded))
      if store.hasConcurrentActivity {
        Text(store.compactActivityProvidersLabel)
          .font(.system(size: 10, weight: .medium, design: .rounded))
          .foregroundStyle(.secondary)
      } else if let usage = store.selectedUsageText {
        Text(usage)
          .font(.system(size: 10, weight: .medium, design: .monospaced))
          .foregroundStyle(.secondary)
      }
    }
  }
}

private struct TrayView: View {
  @ObservedObject var store: RouterStore

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
    ScrollView(showsIndicators: false) {
      VStack(alignment: .leading, spacing: 14) {
        if !store.visibleUsageProviders.isEmpty {
          sectionLabel("Current usage", detail: store.selectedUsageProvider.displayName)
          ProviderUsageSection(store: store)
            .id(store.selectedUsageProviderID)
          sectionLabel("All usage", detail: "7-day snapshot")
          AllProviderUsageGrid(store: store)
        }
        settingRow(
          title: "Dynamic Island",
          detail: "Show provider usage and activity status",
          isOn: Binding(
            get: { store.islandVisible },
            set: { store.setIslandVisible($0) }
          )
        )
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
        sectionLabel("Providers", detail: store.providerOperation == nil ? "Auto-saved" : "Applying…")
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
              onInstall: { Task { await store.installProviderCLI(provider.id) } },
              onLogin: { Task { await store.loginProvider(provider.id) } },
              onSaveKey: { key in Task { await store.saveProviderKey(provider.id, key: key) } }
            )
            if provider.id != providers.last?.id {
              Divider()
            }
          }
        }
      }
      .padding(.vertical, 1)
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
  let onInstall: () -> Void
  let onLogin: () -> Void
  let onSaveKey: (String) -> Void

  @State private var showingKeyField = false
  @State private var apiKey = ""

  var body: some View {
    VStack(alignment: .leading, spacing: 9) {
      HStack(spacing: 10) {
        VStack(alignment: .leading, spacing: 2) {
          Text(setup?.displayName ?? provider.id)
            .font(.system(size: 12, weight: .medium))
          Text(detail)
            .font(.system(size: 9, weight: .regular))
            .foregroundStyle(setup?.configured == true ? routerMuted : routerYellow.opacity(0.9))
        }
        Spacer()
        actionControl
      }

      if showingKeyField, setup?.action == "add-key" {
        VStack(alignment: .leading, spacing: 5) {
          Text("API key")
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
    .onChange(of: setup?.configured) { configured in
      if configured == true {
        apiKey = ""
        showingKeyField = false
      }
    }
  }

  private var detail: String {
    guard let setup else { return "Checking setup…" }
    if oauthNeedsReconnect {
      return "Session expired · reconnect for account usage"
    }
    if setup.configured {
      return provider.enabled ? "Ready · Available in Codex" : "Ready · Hidden from Codex"
    }
    switch setup.action {
    case "install": return "Official CLI required"
    case "login": return "Sign in with the official CLI"
    case "add-key": return "API key required"
    default: return "Setup required"
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
        Toggle("", isOn: Binding(get: { provider.enabled }, set: onToggle))
          .labelsHidden()
          .toggleStyle(.switch)
          .controlSize(.mini)
          .tint(routerMint)
          .disabled(controlsDisabled)
      }
    } else {
      Button(actionTitle) { performAction() }
        .buttonStyle(.plain)
        .font(.system(size: 10, weight: .medium))
        .foregroundStyle(routerAccent)
        .disabled(controlsDisabled || setup == nil)
    }
  }

  private var actionTitle: String {
    switch setup?.action {
    case "install": return "Install"
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
    case "install": onInstall()
    case "login": onLogin()
    case "add-key":
      apiKey = ""
      showingKeyField.toggle()
    default: break
    }
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
    }
    .padding(.vertical, 2)
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
