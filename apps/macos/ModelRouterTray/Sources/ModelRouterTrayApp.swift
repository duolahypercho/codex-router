import AppKit
import Foundation
import SwiftUI

let routerAccent = Color(red: 0.38, green: 0.74, blue: 1.00)
let routerMint = Color(red: 0.38, green: 0.96, blue: 0.80)
let routerYellow = Color(red: 1.00, green: 0.78, blue: 0.22)
let routerRed = Color(red: 1.00, green: 0.32, blue: 0.29)
let routerInk = Color(red: 0.025, green: 0.045, blue: 0.075)
let routerMuted = Color.white.opacity(0.56)

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
    case .idle: return "IDLE"
    case .generating: return "WORKING"
    case .error: return "ERROR"
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

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)
    islandController = IslandWindowController(store: store)
    islandController?.show()
    Task { await store.startPolling() }
    Task { await store.startActivityPolling() }
  }
}

@MainActor
final class RouterStore: ObservableObject {
  @Published private(set) var snapshot = RouterSnapshot.empty
  @Published private(set) var isRefreshing = false
  @Published private(set) var pendingApply = false
  @Published private(set) var message: String?
  @Published private(set) var lastUpdated: Date?
  @Published private(set) var quota = CodexQuota.empty
  @Published private(set) var quotaHistory: [QuotaSample]
  @Published private(set) var pinnedModelSlug: String?
  @Published private(set) var activityState: RouterActivityState = .idle

  private var polling = false
  private var activityPolling = false
  private let defaults = UserDefaults.standard

  init() {
    pinnedModelSlug = defaults.string(forKey: "ModelRouterTray.pinnedModel")
    if let data = defaults.data(forKey: "ModelRouterTray.quotaHistory"),
       let history = try? JSONDecoder().decode([QuotaSample].self, from: data) {
      quotaHistory = history
    } else {
      quotaHistory = []
    }
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
    guard let model = pinnedModel else { return nil }
    if model.provider == "chatgpt-oauth", let used = quota.primary?.usedFraction {
      return "\(Int((used * 100).rounded()))%"
    }
    let cutoff = Date().addingTimeInterval(-60 * 60)
    let count = usageEvents(for: model).filter { $0.at >= cutoff }.count
    return count > 0 ? "\(count)×" : nil
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
      let output = try runControl(arguments: ["--json"])
      snapshot = try JSONDecoder().decode(RouterSnapshot.self, from: output)
      resolvePinnedModel()
      lastUpdated = .now
      message = nil
    } catch {
      message = error.localizedDescription
    }
    await refreshQuota()
  }

  func startActivityPolling() async {
    guard !activityPolling else { return }
    activityPolling = true
    defer { activityPolling = false }
    while !Task.isCancelled {
      await refreshActivity()
      do {
        try await Task.sleep(nanoseconds: 750_000_000)
      } catch {
        return
      }
    }
  }

  func pin(_ model: RouterModel) {
    pinnedModelSlug = model.slug
    defaults.set(model.slug, forKey: "ModelRouterTray.pinnedModel")
  }

  func usageEvents(for model: RouterModel) -> [RouterUsageEvent] {
    (snapshot.targets["codex"]?.usageEvents ?? []).filter { $0.model == model.slug }
  }

  func setProvider(_ provider: String, enabled: Bool) async {
    do {
      _ = try runControl(arguments: ["set", provider, enabled ? "on" : "off", "--targets", "codex"])
      pendingApply = true
      await refresh()
    } catch {
      message = error.localizedDescription
    }
  }

  func apply() async {
    do {
      _ = try runControl(arguments: ["apply", "--targets", "codex"])
      pendingApply = false
      await refresh()
    } catch {
      message = error.localizedDescription
    }
  }

  private func refreshQuota() async {
    let fetched = await CodexQuotaFetcher.fetch()
    quota = fetched
    guard let used = fetched.primary?.usedFraction, fetched.error == nil else { return }
    let now = Date()
    if quotaHistory.last.map({ now.timeIntervalSince($0.at) >= 60 }) != false {
      quotaHistory.append(QuotaSample(at: now, usedFraction: used))
      let cutoff = now.addingTimeInterval(-7 * 24 * 60 * 60)
      quotaHistory = Array(quotaHistory.filter { $0.at >= cutoff }.suffix(1_000))
      if let data = try? JSONEncoder().encode(quotaHistory) {
        defaults.set(data, forKey: "ModelRouterTray.quotaHistory")
      }
    }
  }

  private func refreshActivity() async {
    let configuredPort = ProcessInfo.processInfo.environment["MODEL_ROUTER_PORT"] ?? "4102"
    guard let url = URL(string: "http://127.0.0.1:\(configuredPort)/health") else {
      activityState = .error
      return
    }
    var request = URLRequest(url: url)
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
    models.first(where: { $0.slug.contains("gpt-5.6-sol") }) ?? models[0]
  }

  private func runControl(arguments: [String]) throws -> Data {
    let root = try sourceRoot()
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

struct RouterTarget: Decodable {
  let target: String
  let configured: Bool
  let active: Bool
  let enabledProviders: [String]
  let models: [RouterModel]
  let usageEvents: [RouterUsageEvent]?
}

struct RouterModel: Decodable, Identifiable {
  let slug: String
  let displayName: String
  let provider: String
  let enabled: Bool
  var id: String { slug }
}

struct RouterUsageEvent: Decodable, Identifiable {
  let at: Date
  let model: String
  let provider: String
  let status: Int
  let durationMs: Int
  var id: String { "\(at.timeIntervalSince1970)-\(model)-\(durationMs)" }

  private enum CodingKeys: String, CodingKey {
    case at, model, provider, status, durationMs
  }

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    let rawDate = try values.decode(String.self, forKey: .at)
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    guard let parsedDate = fractional.date(from: rawDate) ?? ISO8601DateFormatter().date(from: rawDate) else {
      throw DecodingError.dataCorruptedError(forKey: .at, in: values, debugDescription: "Invalid usage event date")
    }
    at = parsedDate
    model = try values.decode(String.self, forKey: .model)
    provider = try values.decode(String.self, forKey: .provider)
    status = try values.decode(Int.self, forKey: .status)
    durationMs = try values.decode(Int.self, forKey: .durationMs)
  }
}

struct QuotaSample: Codable, Identifiable {
  let at: Date
  let usedFraction: Double
  var id: Date { at }
}

struct QuotaWindow {
  let usedFraction: Double
  let resetAt: Date?
}

struct CodexQuota {
  let primary: QuotaWindow?
  let weekly: QuotaWindow?
  let plan: String?
  let error: String?

  static let empty = CodexQuota(primary: nil, weekly: nil, plan: nil, error: nil)
}

private enum CodexQuotaFetcher {
  static func fetch() async -> CodexQuota {
    guard let token = accessToken() else {
      return CodexQuota(primary: nil, weekly: nil, plan: nil, error: "Codex sign-in required")
    }
    var request = URLRequest(url: URL(string: "https://chatgpt.com/backend-api/wham/usage")!)
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    do {
      let (data, response) = try await URLSession.shared.data(for: request)
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0
      guard status == 200 else {
        return CodexQuota(
          primary: nil,
          weekly: nil,
          plan: nil,
          error: status == 401 ? "Run codex login to refresh usage" : "Usage service returned \(status)"
        )
      }
      guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            let rateLimit = object["rate_limit"] as? [String: Any] else {
        return CodexQuota(primary: nil, weekly: nil, plan: nil, error: "Usage response was not recognized")
      }
      return CodexQuota(
        primary: parseWindow(rateLimit["primary_window"]),
        weekly: parseWindow(rateLimit["secondary_window"]),
        plan: object["plan_type"] as? String,
        error: nil
      )
    } catch {
      return CodexQuota(primary: nil, weekly: nil, plan: nil, error: "Usage is temporarily unavailable")
    }
  }

  private static func accessToken() -> String? {
    let environment = ProcessInfo.processInfo.environment
    let codexHome = environment["CODEX_HOME"].map { URL(fileURLWithPath: $0, isDirectory: true) }
      ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".codex", isDirectory: true)
    let authURL = codexHome.appendingPathComponent("auth.json")
    guard let data = try? Data(contentsOf: authURL),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let tokens = object["tokens"] as? [String: Any],
          let token = tokens["access_token"] as? String,
          !token.isEmpty else {
      return nil
    }
    return token
  }

  private static func parseWindow(_ value: Any?) -> QuotaWindow? {
    guard let object = value as? [String: Any],
          let usedPercent = object["used_percent"] as? NSNumber else {
      return nil
    }
    let resetAt = (object["reset_at"] as? NSNumber).map {
      Date(timeIntervalSince1970: $0.doubleValue)
    }
    return QuotaWindow(
      usedFraction: min(1, max(0, usedPercent.doubleValue / 100)),
      resetAt: resetAt
    )
  }
}

private struct StatusItemLabel: View {
  @ObservedObject var store: RouterStore

  var body: some View {
    HStack(spacing: 4) {
      Image(systemName: store.codexActive ? "point.3.connected.trianglepath.dotted" : "point.3.filled.connected.trianglepath")
      if let model = store.pinnedShortName {
        Text(model)
          .font(.system(size: 11, weight: .semibold, design: .rounded))
        if let usage = store.pinnedUsageText {
          Text(usage)
            .font(.system(size: 10, weight: .medium, design: .monospaced))
        }
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
      ambientLight
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

  private var ambientLight: some View {
    ZStack {
      Circle()
        .fill(routerAccent.opacity(0.22))
        .frame(width: 250, height: 250)
        .blur(radius: 70)
        .offset(x: -150, y: -260)
      Circle()
        .fill(routerMint.opacity(0.13))
        .frame(width: 220, height: 220)
        .blur(radius: 76)
        .offset(x: 175, y: 235)
      LinearGradient(
        colors: [Color.white.opacity(0.07), routerInk.opacity(0.78)],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
      )
    }
    .allowsHitTesting(false)
  }

  private var header: some View {
    HStack(spacing: 12) {
      ZStack {
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .fill(.ultraThinMaterial)
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .stroke(Color.white.opacity(0.16), lineWidth: 0.7)
        Image(systemName: "point.3.connected.trianglepath.dotted")
          .font(.system(size: 18, weight: .medium))
          .foregroundStyle(
            LinearGradient(colors: [Color.white, routerAccent], startPoint: .top, endPoint: .bottom)
          )
      }
      .frame(width: 42, height: 42)
      .shadow(color: routerAccent.opacity(0.2), radius: 10, y: 5)

      VStack(alignment: .leading, spacing: 3) {
        Text("Codex Router")
          .font(.system(size: 18, weight: .semibold, design: .rounded))
        Text("LOCAL MODEL BRIDGE")
          .font(.system(size: 9, weight: .semibold, design: .monospaced))
          .tracking(1.5)
          .foregroundStyle(routerMuted)
      }
      Spacer()
      StatusBeacon(state: store.activityState)
    }
    .padding(.bottom, 15)
  }

  private func content(for target: RouterTarget) -> some View {
    ScrollView(showsIndicators: false) {
      VStack(alignment: .leading, spacing: 14) {
        PinnedModelIsland(store: store, target: target)
        sectionLabel("Exposed models", detail: "\(target.models.filter(\.enabled).count) available")
        VStack(spacing: 7) {
          ForEach(target.models.filter(\.enabled)) { model in
            ModelRow(
              model: model,
              isPinned: store.pinnedModelSlug == model.slug,
              onPin: { store.pin(model) }
            )
          }
        }
        sectionLabel("Providers", detail: store.pendingApply ? "Changes ready" : "Synced")
        VStack(spacing: 7) {
          ForEach(providers, id: \.id) { provider in
            providerRow(provider)
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
    HStack(spacing: 12) {
      Image(systemName: provider.enabled ? "network.badge.shield.half.filled" : "network.slash")
        .font(.system(size: 14, weight: .medium))
        .foregroundStyle(provider.enabled ? routerMint : routerMuted)
        .frame(width: 24)
      VStack(alignment: .leading, spacing: 2) {
        Text(providerTitle(provider.id))
          .font(.system(size: 12, weight: .semibold, design: .rounded))
        Text(provider.id)
          .font(.system(size: 9, weight: .regular, design: .monospaced))
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
      .tint(routerAccent)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 9)
    .glassCard(cornerRadius: 14)
  }

  private var emptyState: some View {
    VStack(spacing: 10) {
      Image(systemName: "sparkles.rectangle.stack")
        .font(.system(size: 28, weight: .light))
        .foregroundStyle(routerAccent)
      Text("Codex router is waiting")
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
      Button {
        Task { await store.refresh() }
      } label: {
        Image(systemName: "arrow.clockwise")
          .rotationEffect(.degrees(store.isRefreshing ? 360 : 0))
          .animation(
            store.isRefreshing
              ? .linear(duration: 0.9).repeatForever(autoreverses: false)
              : .default,
            value: store.isRefreshing
          )
      }
      .buttonStyle(GlassIconButtonStyle())
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
      "chatgpt-oauth": "ChatGPT Codex OAuth",
      "kimi-oauth": "Kimi Code OAuth",
      "kimi-api": "Kimi Platform API",
      "deepseek": "DeepSeek API",
      "grok-api": "xAI Grok API",
    ][provider] ?? provider
  }

}

private struct PinnedModelIsland: View {
  @ObservedObject var store: RouterStore
  let target: RouterTarget
  @State private var hovering = false

  private var model: RouterModel? { store.pinnedModel }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if let model {
        HStack(spacing: 12) {
          ZStack {
            Circle()
              .fill(routerAccent.opacity(0.15))
              .frame(width: 44, height: 44)
            Image(systemName: "pin.fill")
              .font(.system(size: 15, weight: .semibold))
              .foregroundStyle(routerAccent)
          }
          VStack(alignment: .leading, spacing: 4) {
            Text(model.displayName)
              .font(.system(size: 15, weight: .semibold, design: .rounded))
              .lineLimit(1)
            HStack(spacing: 5) {
              Circle()
                .fill(store.activityState.tint)
                .frame(width: 5, height: 5)
              Text(sourceLabel(for: model))
                .font(.system(size: 8, weight: .bold, design: .monospaced))
                .tracking(0.8)
                .foregroundStyle(routerMuted)
            }
          }
          Spacer(minLength: 8)
          VStack(alignment: .trailing, spacing: 3) {
            Text(metricText(for: model))
              .font(.system(size: 22, weight: .semibold, design: .rounded))
              .monospacedDigit()
            Text(metricCaption(for: model))
              .font(.system(size: 8, weight: .bold, design: .monospaced))
              .tracking(0.7)
              .foregroundStyle(routerMuted)
          }
        }

        if hovering {
          VStack(spacing: 8) {
            Divider().overlay(Color.white.opacity(0.09))
              .padding(.top, 12)
            HStack {
              VStack(alignment: .leading, spacing: 2) {
                Text(graphTitle(for: model))
                  .font(.system(size: 10, weight: .semibold, design: .rounded))
                Text(graphDetail(for: model))
                  .font(.system(size: 9, design: .rounded))
                  .foregroundStyle(routerMuted)
              }
              Spacer()
              Text("LIVE")
                .font(.system(size: 8, weight: .bold, design: .monospaced))
                .tracking(1)
                .foregroundStyle(routerMint)
            }
            UsageSparkline(values: graphValues(for: model), tint: graphTint(for: model))
              .frame(height: 54)
          }
          .transition(.opacity.combined(with: .move(edge: .top)))
        } else {
          HStack(spacing: 5) {
            Image(systemName: "waveform.path.ecg")
            Text("Hover for live usage")
          }
          .font(.system(size: 9, weight: .medium, design: .rounded))
          .foregroundStyle(routerMuted)
          .padding(.top, 10)
        }
      }
    }
    .padding(14)
    .glassCard(cornerRadius: 20, accent: routerAccent)
    .contentShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
    .onHover { isHovering in
      withAnimation(.spring(response: 0.34, dampingFraction: 0.86)) {
        hovering = isHovering
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Pinned model live usage")
  }

  private func sourceLabel(for model: RouterModel) -> String {
    if model.provider == "chatgpt-oauth" {
      let plan = store.quota.plan?.uppercased() ?? "SUBSCRIPTION"
      return "CODEX \(plan)"
    }
    if model.provider.hasSuffix("-api") || model.provider == "deepseek" {
      return "METERED API"
    }
    return "OAUTH ROUTE"
  }

  private func metricText(for model: RouterModel) -> String {
    if model.provider == "chatgpt-oauth" {
      guard let used = store.quota.primary?.usedFraction else { return "—" }
      return "\(Int((used * 100).rounded()))%"
    }
    let cutoff = Date().addingTimeInterval(-60 * 60)
    return "\(store.usageEvents(for: model).filter { $0.at >= cutoff }.count)"
  }

  private func metricCaption(for model: RouterModel) -> String {
    model.provider == "chatgpt-oauth" ? "5H USED" : "REQUESTS / H"
  }

  private func graphTitle(for model: RouterModel) -> String {
    model.provider == "chatgpt-oauth" ? "Subscription usage" : "Local route activity"
  }

  private func graphDetail(for model: RouterModel) -> String {
    if model.provider == "chatgpt-oauth" {
      if let error = store.quota.error { return error }
      let weekly = store.quota.weekly.map { "Weekly \(Int(($0.usedFraction * 100).rounded()))%" }
      let reset = store.quota.primary?.resetAt.map { "resets \(relativeTime(to: $0))" }
      return [weekly, reset].compactMap { $0 }.joined(separator: " • ")
    }
    return "Five-hour request history • no prompts recorded"
  }

  private func graphValues(for model: RouterModel) -> [Double] {
    if model.provider == "chatgpt-oauth" {
      let history = store.quotaHistory.suffix(30).map(\.usedFraction)
      let current = store.quota.primary.map { [$0.usedFraction] } ?? []
      let values = Array(history) + current
      return values.count > 1 ? values : [0, values.first ?? 0]
    }
    let bucketCount = 20
    let bucketDuration: TimeInterval = 15 * 60
    let start = Date().addingTimeInterval(-Double(bucketCount) * bucketDuration)
    var buckets = Array(repeating: 0.0, count: bucketCount)
    for event in store.usageEvents(for: model) where event.at >= start {
      let index = Int(event.at.timeIntervalSince(start) / bucketDuration)
      if buckets.indices.contains(index) { buckets[index] += 1 }
    }
    return buckets
  }

  private func graphTint(for model: RouterModel) -> Color {
    model.provider == "chatgpt-oauth" ? routerAccent : routerMint
  }

  private func relativeTime(to date: Date) -> String {
    let seconds = max(0, date.timeIntervalSinceNow)
    if seconds < 60 * 60 { return "in \(max(1, Int(seconds / 60)))m" }
    if seconds < 24 * 60 * 60 { return "in \(Int(seconds / 3600))h" }
    return "in \(Int(seconds / 86_400))d"
  }
}

struct UsageSparkline: View {
  let values: [Double]
  let tint: Color

  var body: some View {
    GeometryReader { geometry in
      let points = normalizedPoints(in: geometry.size)
      ZStack {
        Path { path in
          guard let first = points.first, let last = points.last else { return }
          path.move(to: CGPoint(x: first.x, y: geometry.size.height))
          points.forEach { path.addLine(to: $0) }
          path.addLine(to: CGPoint(x: last.x, y: geometry.size.height))
          path.closeSubpath()
        }
        .fill(
          LinearGradient(
            colors: [tint.opacity(0.26), tint.opacity(0.01)],
            startPoint: .top,
            endPoint: .bottom
          )
        )

        Path { path in
          guard let first = points.first else { return }
          path.move(to: first)
          points.dropFirst().forEach { path.addLine(to: $0) }
        }
        .stroke(tint, style: StrokeStyle(lineWidth: 1.8, lineCap: .round, lineJoin: .round))

        if let last = points.last {
          Circle()
            .fill(tint)
            .frame(width: 6, height: 6)
            .shadow(color: tint, radius: 5)
            .position(last)
        }
      }
      .overlay(alignment: .bottom) {
        Rectangle().fill(Color.white.opacity(0.08)).frame(height: 0.5)
      }
    }
    .accessibilityHidden(true)
  }

  private func normalizedPoints(in size: CGSize) -> [CGPoint] {
    guard !values.isEmpty else { return [] }
    let minimum = values.min() ?? 0
    let maximum = values.max() ?? 1
    let span = max(0.08, maximum - minimum)
    let step = values.count > 1 ? size.width / CGFloat(values.count - 1) : 0
    return values.enumerated().map { index, value in
      let normalized = (value - minimum) / span
      return CGPoint(
        x: CGFloat(index) * step,
        y: size.height - (CGFloat(normalized) * (size.height - 8) + 4)
      )
    }
  }
}

private struct ModelRow: View {
  let model: RouterModel
  let isPinned: Bool
  let onPin: () -> Void
  @State private var arrived = false

  var body: some View {
    HStack(spacing: 11) {
      ZStack {
        Circle().fill(routerAccent.opacity(0.14)).frame(width: 27, height: 27)
        Circle().fill(routerAccent).frame(width: 6, height: 6)
      }
      VStack(alignment: .leading, spacing: 2) {
        Text(model.displayName)
          .font(.system(size: 12, weight: .semibold, design: .rounded))
        Text(model.slug)
          .font(.system(size: 9, weight: .regular, design: .monospaced))
          .foregroundStyle(routerMuted)
      }
      Spacer()
      Text("READY")
        .font(.system(size: 8, weight: .bold, design: .monospaced))
        .tracking(0.8)
        .foregroundStyle(routerMint)
        .padding(.horizontal, 7)
        .padding(.vertical, 4)
        .background(routerMint.opacity(0.09))
        .clipShape(Capsule())
      Button(action: onPin) {
        Image(systemName: isPinned ? "pin.fill" : "pin")
          .font(.system(size: 10, weight: .semibold))
          .foregroundStyle(isPinned ? routerAccent : routerMuted)
          .frame(width: 24, height: 24)
          .background(Color.white.opacity(isPinned ? 0.09 : 0.04), in: Circle())
      }
      .buttonStyle(.plain)
      .help(isPinned ? "Pinned to the menu bar" : "Pin this model to the menu bar")
    }
    .padding(.horizontal, 11)
    .padding(.vertical, 8)
    .glassCard(cornerRadius: 14)
    .opacity(arrived ? 1 : 0)
    .offset(y: arrived ? 0 : 6)
    .onAppear {
      withAnimation(.spring(response: 0.4, dampingFraction: 0.82)) {
        arrived = true
      }
    }
  }
}

private struct StatusBeacon: View {
  let state: RouterActivityState
  @State private var breathing = false

  var body: some View {
    HStack(spacing: 6) {
      ZStack {
        Circle()
          .fill(state.tint.opacity(0.2))
          .frame(width: 16, height: 16)
          .scaleEffect(state == .generating && breathing ? 1.3 : 0.88)
        Circle()
          .fill(state.tint)
          .frame(width: 6, height: 6)
      }
      Text(state.label)
        .font(.system(size: 9, weight: .bold, design: .monospaced))
        .tracking(1)
    }
    .foregroundStyle(state.tint)
    .padding(.horizontal, 9)
    .padding(.vertical, 6)
    .background(.ultraThinMaterial, in: Capsule())
    .overlay(Capsule().stroke(Color.white.opacity(0.12), lineWidth: 0.7))
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

private struct GlassCardModifier: ViewModifier {
  let cornerRadius: CGFloat
  let accent: Color

  func body(content: Content) -> some View {
    content
      .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
      .background(
        LinearGradient(
          colors: [Color.white.opacity(0.07), Color.white.opacity(0.015)],
          startPoint: .topLeading,
          endPoint: .bottomTrailing
        ),
        in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
      )
      .overlay(
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
          .stroke(
            LinearGradient(
              colors: [Color.white.opacity(0.22), accent.opacity(0.17), Color.white.opacity(0.04)],
              startPoint: .topLeading,
              endPoint: .bottomTrailing
            ),
            lineWidth: 0.7
          )
      )
      .shadow(color: Color.black.opacity(0.19), radius: 14, y: 8)
  }
}

private extension View {
  func glassCard(cornerRadius: CGFloat, accent: Color = routerAccent) -> some View {
    modifier(GlassCardModifier(cornerRadius: cornerRadius, accent: accent))
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

private struct GlassIconButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 12, weight: .semibold))
      .foregroundStyle(routerAccent)
      .frame(width: 30, height: 30)
      .background(.ultraThinMaterial, in: Circle())
      .overlay(Circle().stroke(Color.white.opacity(0.14), lineWidth: 0.7))
      .scaleEffect(configuration.isPressed ? 0.92 : 1)
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
