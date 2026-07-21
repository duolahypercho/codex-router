import AppKit
import Combine
import Foundation
import SwiftUI

let routerAccent = Color(red: 0.36, green: 0.66, blue: 0.91)
let routerMint = Color(red: 0.38, green: 0.82, blue: 0.61)
let routerYellow = Color(red: 0.94, green: 0.68, blue: 0.25)
let routerRed = Color(red: 0.91, green: 0.35, blue: 0.32)
let routerInk = Color(red: 0.035, green: 0.043, blue: 0.055)
let routerMuted = Color.white.opacity(0.52)

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
        .frame(width: 404, height: 594)
        .preferredColorScheme(.dark)
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
  @Published private(set) var islandVisible: Bool

  private var polling = false
  private var activityPolling = false
  private var accountUsagePolling = false
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
    guard let primary = accountUsage?.primary else { return nil }
    return "\(primary.remainingPercent)%"
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

  func dailyTokens(days: Int) -> [Double] {
    guard let accountUsage else { return Array(repeating: 0, count: days) }
    let indexed = Dictionary(uniqueKeysWithValues: accountUsage.dailyUsageBuckets.map {
      ($0.startDate, Double($0.tokens))
    })
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.calendar = Calendar(identifier: .gregorian)
    formatter.dateFormat = "yyyy-MM-dd"
    let calendar = Calendar.current
    let today = calendar.startOfDay(for: .now)
    return (0..<days).map { offset in
      let date = calendar.date(byAdding: .day, value: offset - (days - 1), to: today) ?? today
      return indexed[formatter.string(from: date)] ?? 0
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
    models.first(where: { $0.slug == "grok-oauth/grok-4.5" }) ?? models[0]
  }

  private func runControl(arguments: [String]) async throws -> Data {
    let root = try sourceRoot()
    return try await Task.detached {
      let task = Process()
      task.executableURL = root.appendingPathComponent("bin/control")
      task.arguments = arguments
      task.currentDirectoryURL = root
      let output = Pipe()
      let errors = Pipe()
      task.standardOutput = output
      task.standardError = errors
      try task.run()
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

struct CodexUsageSummary: Decodable {
  let lifetimeTokens: Int64?
  let peakDailyTokens: Int64?
  let currentStreakDays: Int?
}

struct RouterTarget: Decodable {
  let target: String
  let configured: Bool
  let active: Bool
  let enabledProviders: [String]
  let models: [RouterModel]
}

struct RouterModel: Decodable, Identifiable {
  let slug: String
  let displayName: String
  let provider: String
  let enabled: Bool
  var id: String { slug }
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
    return Dictionary(grouping: target.models, by: \.provider)
      .map { (id: $0.key, enabled: $0.value.contains(where: \.enabled)) }
      .sorted { $0.id < $1.id }
  }

  var body: some View {
    ZStack {
      VisualEffectBlur()
      Color(red: 0.045, green: 0.052, blue: 0.064).opacity(0.88)
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
      .padding(16)
    }
    .foregroundStyle(.white)
    .task { await store.refresh() }
  }


  private var header: some View {
    HStack(alignment: .center, spacing: 12) {
      VStack(alignment: .leading, spacing: 3) {
        Text("Model Router")
          .font(.system(size: 18, weight: .semibold, design: .rounded))
        Text(accountLabel)
          .font(.system(size: 10, weight: .regular, design: .rounded))
          .foregroundStyle(routerMuted)
      }
      Spacer()
      StatusBeacon(state: store.activityState)
    }
    .padding(.bottom, 15)
  }

  private var accountLabel: String {
    guard let plan = store.accountUsage?.planType else { return "Codex account" }
    return "ChatGPT \(plan.capitalized)"
  }

  private func content(for target: RouterTarget) -> some View {
    ScrollView(showsIndicators: false) {
      VStack(alignment: .leading, spacing: 18) {
        AccountUsageSection(store: store)
        settingRow(
          title: "Dynamic Island",
          detail: "Show live model, limit, and activity status",
          isOn: Binding(
            get: { store.islandVisible },
            set: { store.setIslandVisible($0) }
          )
        )
        sectionLabel("Models", detail: store.pinnedShortName.map { "Pinned: \($0)" } ?? "None pinned")
        VStack(spacing: 0) {
          ForEach(target.models.filter(\.enabled)) { model in
            SimpleModelRow(model: model, isPinned: store.pinnedModelSlug == model.slug) {
              store.pin(model)
            }
            if model.id != target.models.filter(\.enabled).last?.id {
              Divider().overlay(Color.white.opacity(0.08))
            }
          }
        }
        sectionLabel("Providers", detail: store.pendingApply ? "Apply required" : "Synced")
        VStack(spacing: 0) {
          ForEach(providers, id: \.id) { provider in
            providerRow(provider)
            if provider.id != providers.last?.id {
              Divider().overlay(Color.white.opacity(0.08))
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
        .font(.system(size: 12, weight: .semibold, design: .rounded))
      Spacer()
      Text(detail)
        .font(.system(size: 10, weight: .medium, design: .rounded))
        .foregroundStyle(store.pendingApply ? routerAccent : routerMuted)
    }
    .padding(.horizontal, 2)
    .padding(.top, 1)
  }

  private func providerRow(_ provider: (id: String, enabled: Bool)) -> some View {
    HStack(spacing: 10) {
      VStack(alignment: .leading, spacing: 2) {
        Text(providerTitle(provider.id))
          .font(.system(size: 12, weight: .medium, design: .rounded))
        Text(provider.enabled ? "Available in Codex" : "Hidden from Codex")
          .font(.system(size: 9, weight: .regular, design: .rounded))
          .foregroundStyle(routerMuted)
      }
      Spacer()
      Toggle("", isOn: Binding(
        get: { provider.enabled },
        set: { enabled in Task { await store.setProvider(provider.id, enabled: enabled) } }
      ))
      .labelsHidden()
      .toggleStyle(.switch)
      .controlSize(.mini)
      .tint(routerMint)
    }
    .padding(.vertical, 9)
  }

  private func settingRow(
    title: String,
    detail: String,
    isOn: Binding<Bool>
  ) -> some View {
    HStack(spacing: 12) {
      VStack(alignment: .leading, spacing: 3) {
        Text(title)
          .font(.system(size: 13, weight: .medium, design: .rounded))
        Text(detail)
          .font(.system(size: 10, design: .rounded))
          .foregroundStyle(routerMuted)
      }
      Spacer()
      Toggle("", isOn: isOn)
        .labelsHidden()
        .toggleStyle(.switch)
        .controlSize(.small)
        .tint(routerMint)
    }
    .padding(.vertical, 2)
  }

  private var emptyState: some View {
    VStack(spacing: 10) {
      Text("Router unavailable")
        .font(.system(size: 14, weight: .semibold, design: .rounded))
      Text("Run setup, then refresh this panel.")
        .font(.system(size: 11, design: .rounded))
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
        }
      }
      .buttonStyle(.plain)
      .font(.system(size: 11, weight: .medium, design: .rounded))
      .foregroundStyle(routerAccent)
      .disabled(store.isRefreshing)

      if let message = store.message {
        Text(message)
          .lineLimit(1)
          .font(.system(size: 10, design: .rounded))
          .foregroundStyle(Color(red: 1, green: 0.61, blue: 0.52))
      } else {
        Spacer()
        Text(store.lastUpdated.map { "Updated \($0.formatted(date: .omitted, time: .shortened))" } ?? "Awaiting data")
          .font(.system(size: 10, weight: .medium, design: .rounded))
          .foregroundStyle(routerMuted)
      }

      Button("Quit") { NSApp.terminate(nil) }
        .buttonStyle(.plain)
        .font(.system(size: 11, weight: .medium, design: .rounded))
        .foregroundStyle(routerMuted)
    }
    .padding(.top, 13)
  }

  private func providerTitle(_ provider: String) -> String {
    [
      "grok-oauth": "xAI Grok OAuth",
      "kimi-oauth": "Kimi Code OAuth",
      "kimi-api": "Kimi Platform API",
      "deepseek": "DeepSeek API",
      "grok-api": "xAI Grok API",
    ][provider] ?? provider
  }

}

private struct AccountUsageSection: View {
  @ObservedObject var store: RouterStore
  @State private var range: UsageRange = .week

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .firstTextBaseline) {
        VStack(alignment: .leading, spacing: 3) {
          Text("ChatGPT limit")
            .font(.system(size: 13, weight: .medium, design: .rounded))
          Text(limitDetail)
            .font(.system(size: 10, design: .rounded))
            .foregroundStyle(routerMuted)
        }
        Spacer()
        Text(remainingText)
          .font(.system(size: 22, weight: .semibold, design: .rounded))
          .monospacedDigit()
      }

      GeometryReader { geometry in
        ZStack(alignment: .leading) {
          Capsule().fill(Color.white.opacity(0.09))
          Capsule()
            .fill(routerAccent)
            .frame(width: geometry.size.width * remainingFraction)
        }
      }
      .frame(height: 5)

      HStack {
        Text("Daily token usage")
          .font(.system(size: 10, weight: .medium, design: .rounded))
          .foregroundStyle(routerMuted)
        Spacer()
        UsageRangePicker(selection: $range)
      }

      UsageBarChart(values: store.dailyTokens(days: range.rawValue), tint: routerAccent)
        .frame(height: 74)

      HStack {
        Text(rangeCaption)
        Spacer()
        if let streak = store.accountUsage?.summary.currentStreakDays {
          Text("\(streak)-day streak")
        }
      }
      .font(.system(size: 9, design: .rounded))
      .foregroundStyle(routerMuted)

      if let error = store.accountUsageError, store.accountUsage == nil {
        Text(error)
          .font(.system(size: 10, design: .rounded))
          .foregroundStyle(routerRed)
          .lineLimit(2)
      }
    }
    .padding(.vertical, 2)
  }

  private var remainingText: String {
    guard let value = store.accountUsage?.primary?.remainingPercent else { return "—" }
    return "\(value)% left"
  }

  private var remainingFraction: CGFloat {
    CGFloat(store.accountUsage?.primary?.remainingPercent ?? 0) / 100
  }

  private var limitDetail: String {
    guard let limit = store.accountUsage?.primary else { return "Loading native Codex usage…" }
    guard let reset = limit.resetDate else { return limit.durationLabel }
    return "\(limit.durationLabel) · resets \(reset.formatted(date: .abbreviated, time: .shortened))"
  }

  private var rangeCaption: String {
    let total = store.dailyTokens(days: range.rawValue).reduce(0, +)
    return "\(compactTokenCount(total)) tokens over \(range.rawValue) days"
  }
}

struct UsageRangePicker: View {
  @Binding var selection: UsageRange

  var body: some View {
    HStack(spacing: 2) {
      ForEach(UsageRange.allCases) { range in
        Button(range.label) { selection = range }
          .buttonStyle(.plain)
          .font(.system(size: 9, weight: .medium, design: .rounded))
          .foregroundStyle(selection == range ? Color.white : routerMuted)
          .padding(.horizontal, 7)
          .padding(.vertical, 4)
          .background(
            selection == range ? Color.white.opacity(0.12) : Color.clear,
            in: Capsule()
          )
      }
    }
    .padding(2)
    .background(Color.white.opacity(0.045), in: Capsule())
  }
}

private struct SimpleModelRow: View {
  let model: RouterModel
  let isPinned: Bool
  let onPin: () -> Void

  var body: some View {
    HStack(spacing: 10) {
      VStack(alignment: .leading, spacing: 2) {
        Text(model.displayName)
          .font(.system(size: 12, weight: .medium, design: .rounded))
          .lineLimit(1)
        Text(model.provider == "grok-oauth" ? "xAI OAuth" : model.provider)
          .font(.system(size: 9, design: .rounded))
          .foregroundStyle(routerMuted)
      }
      Spacer()
      Button(isPinned ? "Pinned" : "Pin") { onPin() }
        .buttonStyle(.plain)
        .font(.system(size: 10, weight: .medium, design: .rounded))
        .foregroundStyle(isPinned ? routerMint : routerAccent)
    }
    .padding(.vertical, 9)
  }
}

struct UsageBarChart: View {
  let values: [Double]
  let tint: Color

  var body: some View {
    GeometryReader { geometry in
      let maximum = max(values.max() ?? 0, 1)
      let spacing: CGFloat = values.count > 45 ? 1 : values.count > 14 ? 2 : 4
      let width = max(1, (geometry.size.width - spacing * CGFloat(max(0, values.count - 1))) / CGFloat(max(values.count, 1)))
      HStack(alignment: .bottom, spacing: spacing) {
        ForEach(Array(values.enumerated()), id: \.offset) { _, value in
          RoundedRectangle(cornerRadius: min(2, width / 2), style: .continuous)
            .fill(value == 0 ? Color.white.opacity(0.055) : tint.opacity(0.82))
            .frame(width: width, height: max(2, geometry.size.height * CGFloat(value / maximum)))
        }
      }
      .frame(maxHeight: .infinity, alignment: .bottom)
    }
    .accessibilityLabel("Daily token usage chart")
  }
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
        .font(.system(size: 10, weight: .medium, design: .rounded))
    }
    .foregroundStyle(state.tint)
    .onAppear { animate() }
    .onChange(of: state) { _ in animate() }
  }

  private func animate() {
    breathing = false
    guard state == .generating else { return }
    withAnimation(.easeInOut(duration: 0.72).repeatForever(autoreverses: true)) {
      breathing = true
    }
  }
}

private struct AccentButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 11, weight: .semibold, design: .rounded))
      .foregroundStyle(routerInk)
      .padding(.horizontal, 13)
      .padding(.vertical, 8)
      .background(
        LinearGradient(
          colors: [Color.white.opacity(0.95), routerAccent],
          startPoint: .topLeading,
          endPoint: .bottomTrailing
        )
        .opacity(configuration.isPressed ? 0.76 : 1)
      )
      .clipShape(Capsule())
      .shadow(color: routerAccent.opacity(0.26), radius: 9, y: 4)
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
