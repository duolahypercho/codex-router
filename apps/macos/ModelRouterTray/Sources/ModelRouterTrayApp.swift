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
  case error

  var tint: Color {
    switch self {
    case .idle: return routerMint
    case .generating: return routerYellow
    case .error: return routerRed
    }
  }

  var label: String {
    switch self {
    case .idle: return "Idle"
    case .generating: return "Generating"
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
  @Published private(set) var pendingApply = false
  @Published private(set) var message: String?
  @Published private(set) var lastUpdated: Date?
  @Published private(set) var pinnedModelSlug: String?
  @Published private(set) var activityState: RouterActivityState = .idle
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

  init() {
    pinnedModelSlug = defaults.string(forKey: "ModelRouterTray.pinnedModel")
    islandVisible = defaults.object(forKey: islandVisibilityKey) == nil
      ? true
      : defaults.bool(forKey: islandVisibilityKey)
  }

  var codexActive: Bool {
    snapshot.targets["codex"]?.active == true
  }

  var pinnedModel: RouterModel? {
    guard let models = snapshot.targets["codex"]?.models.filter(\.enabled), !models.isEmpty else {
      return nil
    }
    return models.first(where: { $0.slug == pinnedModelSlug }) ?? preferredModel(in: models)
  }

  var pinnedShortName: String? {
    guard let model = pinnedModel else { return nil }
    for name in ["Sol", "Terra", "Luna", "Grok 4.5", "K3", "V4 Pro", "V4 Flash"]
    where model.displayName.localizedCaseInsensitiveContains(name) {
      return name
    }
    return model.displayName.split(separator: " ").first.map(String.init)
  }

  var pinnedUsageText: String? {
    if pinnedUsesChatGPTUsage {
      guard let primary = accountUsage?.primary else { return nil }
      return "\(primary.remainingPercent)% left"
    }
    guard providerUsage != nil else { return nil }
    if let metric = pinnedAccountMetric { return formattedAccountMetric(metric) }
    let total = localUsageTotals(days: 7).tokens
    return total > 0 ? "\(compactTokenCount(total)) tok" : "No use"
  }

  var pinnedUsesChatGPTUsage: Bool {
    pinnedModel?.provider == "openai"
  }

  var pinnedProviderUsage: RouterProviderUsage? {
    guard let provider = pinnedModel?.provider else { return nil }
    return providerUsage?.providers.first(where: { $0.id == provider })
  }

  var pinnedAccountMetric: ProviderAccountMetric? {
    pinnedProviderUsage?.account.metrics.first
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
      resolvePinnedModel()
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

  func pin(_ model: RouterModel) {
    pinnedModelSlug = model.slug
    defaults.set(model.slug, forKey: "ModelRouterTray.pinnedModel")
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
  }

  func refreshProviderUsage() async {
    do {
      let output = try await runControl(arguments: ["provider-usage", "--json"])
      providerUsage = try JSONDecoder().decode(ProviderUsageSnapshot.self, from: output)
      providerUsageError = nil
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
    } catch {
      message = error.localizedDescription
    }
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
    await performProviderOperation(
      provider,
      successMessage: "Provider connected. Apply Changes to add its models to Codex."
    ) {
      _ = try await runControl(arguments: ["login", provider])
      try await stageProvider(provider)
    }
  }

  func saveProviderKey(_ provider: String, key: String) async {
    let secret = Data(key.utf8)
    await performProviderOperation(
      provider,
      successMessage: "API key saved. Apply Changes to add its models to Codex."
    ) {
      _ = try await runControl(arguments: ["credential", provider], stdin: secret)
      try await stageProvider(provider)
    }
  }

  func dailyTokens(days: Int) -> [Double] {
    dailyUsage(days: days).map(\.tokens)
  }

  func dailyUsage(days: Int) -> [DailyUsagePoint] {
    let indexed: [String: Double]
    if pinnedUsesChatGPTUsage {
      guard let accountUsage else { return placeholderDailyUsage(days: days) }
      indexed = Dictionary(uniqueKeysWithValues: accountUsage.dailyUsageBuckets.map {
        ($0.startDate, Double($0.tokens))
      })
    } else {
      guard let usage = pinnedProviderUsage else { return placeholderDailyUsage(days: days) }
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
    guard !pinnedUsesChatGPTUsage, let usage = pinnedProviderUsage else { return (0, 0) }
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
    do {
      _ = try await runControl(arguments: ["set", provider, enabled ? "on" : "off", "--targets", "codex"])
      pendingApply = true
      await refresh()
    } catch {
      message = error.localizedDescription
    }
  }

  func apply() async {
    do {
      _ = try await runControl(arguments: ["apply", "--targets", "codex"])
      pendingApply = false
      await refresh()
    } catch {
      message = error.localizedDescription
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
      message = successMessage
    } catch {
      message = error.localizedDescription
      await refreshProviderSetup()
    }
  }

  private func stageProvider(_ provider: String) async throws {
    _ = try await runControl(arguments: ["set", provider, "on", "--targets", "codex"])
    pendingApply = true
  }

  private func refreshActivity() async {
    let configuredPort = ProcessInfo.processInfo.environment["MODEL_ROUTER_PORT"] ?? "4102"
    guard let url = URL(string: "http://127.0.0.1:\(configuredPort)/health") else {
      activityState = .error
      return
    }
    var request = URLRequest(url: url)
    request.cachePolicy = .reloadIgnoringLocalCacheData
    request.timeoutInterval = 2
    do {
      let (data, _) = try await URLSession.shared.data(for: request)
      let health = try JSONDecoder().decode(RouterHealth.self, from: data)
      activityState = health.activity.state
    } catch {
      activityState = .error
    }
  }

  private func resolvePinnedModel() {
    guard let models = snapshot.targets["codex"]?.models.filter(\.enabled), !models.isEmpty else { return }
    if let pinnedModelSlug, models.contains(where: { $0.slug == pinnedModelSlug }) { return }
    let model = preferredModel(in: models)
    pinnedModelSlug = model.slug
    defaults.set(model.slug, forKey: "ModelRouterTray.pinnedModel")
  }

  private func preferredModel(in models: [RouterModel]) -> RouterModel {
    if let selected = snapshot.targets["codex"]?.selectedModel,
       let model = models.first(where: { $0.slug == selected }) {
      return model
    }
    return models.first(where: { $0.slug == "gpt-5.6-terra" }) ?? models[0]
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
      if let stdin, let input {
        input.fileHandleForWriting.write(stdin)
        try? input.fileHandleForWriting.close()
      }
      task.waitUntilExit()
      let stdout = output.fileHandleForReading.readDataToEndOfFile()
      guard task.terminationStatus == 0 else {
        let stderr = errors.fileHandleForReading.readDataToEndOfFile()
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
      return days == 1 ? "Daily limit" : "\(days)-day limit"
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
}

struct RouterModel: Decodable, Identifiable {
  let slug: String
  let displayName: String
  let provider: String
  let enabled: Bool
  var id: String { slug }
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
      Text(store.pinnedShortName ?? "Codex")
        .font(.system(size: 11, weight: .medium, design: .rounded))
      if let usage = store.pinnedUsageText {
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
    if !store.pinnedUsesChatGPTUsage {
      guard let provider = store.pinnedProviderUsage else { return "Provider usage" }
      return "\(provider.displayName) · \(provider.credentialType.uppercased())"
    }
    guard let plan = store.accountUsage?.planType else { return "Codex account" }
    return "ChatGPT \(plan.capitalized)"
  }

  private func content(for target: RouterTarget) -> some View {
    ScrollView(showsIndicators: false) {
      VStack(alignment: .leading, spacing: 14) {
        ProviderUsageSection(store: store)
        settingRow(
          title: "Dynamic Island",
          detail: "Show live model, limit, and activity status",
          isOn: Binding(
            get: { store.islandVisible },
            set: { store.setIslandVisible($0) }
          )
        )
        sectionLabel(
          "Island model",
          detail: store.pinnedShortName.map { "Pinned: \($0)" } ?? "Uses Codex default"
        )
        VStack(spacing: 0) {
          ForEach(target.models.filter(\.enabled)) { model in
            SimpleModelRow(
              model: model,
              isPinned: store.pinnedModelSlug == model.slug,
              isDefault: target.selectedModel == model.slug
            ) {
              store.pin(model)
            }
            if model.id != target.models.filter(\.enabled).last?.id {
              Divider()
            }
          }
        }
        sectionLabel("Providers", detail: store.pendingApply ? "Apply required" : "Synced")
        VStack(spacing: 0) {
          ForEach(providers, id: \.id) { provider in
            ProviderSetupRow(
              provider: provider,
              setup: store.providerSetup[provider.id],
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
    .animation(.spring(response: 0.36, dampingFraction: 0.84), value: store.pendingApply)
  }

  private func sectionLabel(_ title: String, detail: String) -> some View {
    HStack {
      Text(title)
        .font(.system(size: 11, weight: .medium))
        .foregroundStyle(.secondary)
      Spacer()
      Text(detail)
        .font(.system(size: 9, weight: .regular))
        .foregroundStyle(store.pendingApply ? routerAccent : routerMuted)
    }
    .padding(.horizontal, 2)
    .padding(.top, 1)
  }

  private func settingRow(
    title: String,
    detail: String,
    isOn: Binding<Bool>
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
      if store.pendingApply {
        Button("Apply Changes") { Task { await store.apply() } }
          .buttonStyle(AccentButtonStyle())
          .transition(.move(edge: .leading).combined(with: .opacity))
      }
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
      Toggle("", isOn: Binding(get: { provider.enabled }, set: onToggle))
        .labelsHidden()
        .toggleStyle(.switch)
        .controlSize(.mini)
        .tint(routerMint)
        .disabled(controlsDisabled)
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

      if showsProgressBar {
        GeometryReader { geometry in
          ZStack(alignment: .leading) {
            Capsule().fill(Color.primary.opacity(0.10))
            Capsule()
              .fill(routerAccent)
              .frame(width: geometry.size.width * remainingFraction)
          }
        }
        .frame(height: 5)
      }

      if let secondaryAccountMetric {
        HStack(spacing: 8) {
          Text(secondaryAccountMetric.label)
            .font(.system(size: 9, weight: .medium))
            .foregroundStyle(routerMuted)
          GeometryReader { geometry in
            ZStack(alignment: .leading) {
              Capsule().fill(Color.primary.opacity(0.08))
              Capsule()
                .fill(routerAccent.opacity(0.72))
                .frame(width: geometry.size.width * metricRemainingFraction(secondaryAccountMetric))
            }
          }
          .frame(height: 4)
          Text(formattedAccountMetric(secondaryAccountMetric))
            .font(.system(size: 9, weight: .medium, design: .monospaced))
        }
      }

      HStack {
        Text(store.pinnedUsesChatGPTUsage ? "Daily token usage" : "Router traffic")
          .font(.system(size: 10, weight: .medium))
          .foregroundStyle(routerMuted)
        Spacer()
        UsageRangePicker(selection: $range)
      }

      UsageBarChart(points: store.dailyUsage(days: range.rawValue), tint: routerAccent)
        .frame(height: 88)

      HStack {
        Text(rangeCaption)
        Spacer()
        if store.pinnedUsesChatGPTUsage,
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
    if store.pinnedUsesChatGPTUsage { return "ChatGPT subscription" }
    return store.pinnedProviderUsage?.displayName ?? "Provider usage"
  }

  private var primaryMetric: String {
    if store.pinnedUsesChatGPTUsage {
      guard let value = store.accountUsage?.primary?.remainingPercent else { return "—" }
      return "\(value)% left"
    }
    guard store.providerUsage != nil else { return "—" }
    if let metric = store.pinnedAccountMetric { return formattedAccountMetric(metric) }
    return compactTokenCount(store.localUsageTotals(days: range.rawValue).tokens)
  }

  private var remainingFraction: CGFloat {
    if let metric = store.pinnedAccountMetric,
       let remaining = metric.remainingPercent {
      return CGFloat(max(0, min(100, remaining))) / 100
    }
    return CGFloat(store.accountUsage?.primary?.remainingPercent ?? 0) / 100
  }

  private var showsProgressBar: Bool {
    store.pinnedUsesChatGPTUsage || store.pinnedAccountMetric?.kind == "quota"
  }

  private var limitDetail: String {
    if !store.pinnedUsesChatGPTUsage {
      guard let usage = store.pinnedProviderUsage else { return "Loading provider usage…" }
      if let metric = usage.account.metrics.first {
        if let reset = metric.resetDate {
          return "\(metric.label) · resets \(reset.formatted(date: .abbreviated, time: .shortened))"
        }
        if let detail = metric.detail, !detail.isEmpty { return detail }
        return "Official provider account"
      }
      return "\(usage.credentialType.uppercased()) traffic · measured on this Mac"
    }
    guard let limit = store.accountUsage?.primary else { return "Loading native Codex usage…" }
    guard let reset = limit.resetDate else { return limit.durationLabel }
    return "\(limit.durationLabel) · resets \(reset.formatted(date: .abbreviated, time: .shortened))"
  }

  private var rangeCaption: String {
    let total = store.dailyTokens(days: range.rawValue).reduce(0, +)
    if !store.pinnedUsesChatGPTUsage {
      let requests = store.localUsageTotals(days: range.rawValue).requests
      return "\(compactTokenCount(total)) tokens · \(requests) requests over \(range.rawValue) days"
    }
    return "\(compactTokenCount(total)) tokens over \(range.rawValue) days"
  }

  private var usageError: String? {
    if store.pinnedUsesChatGPTUsage {
      return store.accountUsage == nil ? store.accountUsageError : nil
    }
    return store.providerUsage == nil ? store.providerUsageError : nil
  }

  private var secondaryAccountMetric: ProviderAccountMetric? {
    guard !store.pinnedUsesChatGPTUsage else { return nil }
    return store.pinnedProviderUsage?.account.metrics.dropFirst().first
  }

  private var accountMessage: String? {
    guard !store.pinnedUsesChatGPTUsage,
          store.pinnedProviderUsage?.account.metrics.isEmpty == true else { return nil }
    return store.pinnedProviderUsage?.account.message
  }

  private func metricRemainingFraction(_ metric: ProviderAccountMetric) -> CGFloat {
    CGFloat(max(0, min(100, metric.remainingPercent ?? 0))) / 100
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

private struct SimpleModelRow: View {
  let model: RouterModel
  let isPinned: Bool
  let isDefault: Bool
  let onPin: () -> Void

  var body: some View {
    HStack(spacing: 10) {
      VStack(alignment: .leading, spacing: 2) {
        Text(model.displayName)
          .font(.system(size: 12, weight: .medium))
          .lineLimit(1)
        Text(modelDetail)
          .font(.system(size: 9))
          .foregroundStyle(routerMuted)
      }
      Spacer()
      Button(isPinned ? "Pinned" : "Pin") { onPin() }
        .buttonStyle(.plain)
        .font(.system(size: 10, weight: .medium))
        .foregroundStyle(isPinned ? routerMint : routerAccent)
    }
    .padding(.vertical, 7)
  }

  private var modelDetail: String {
    if model.provider == "openai" {
      return isDefault ? "ChatGPT · Codex default" : "ChatGPT"
    }
    if model.provider == "grok-oauth" { return "xAI OAuth" }
    return model.provider
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
          .scaleEffect(state == .generating && breathing ? 1.28 : 0.9)
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
    guard state == .generating, !reduceMotion else { return }
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
