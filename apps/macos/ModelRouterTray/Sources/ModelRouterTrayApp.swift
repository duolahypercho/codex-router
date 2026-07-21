import AppKit
import Foundation
import SwiftUI

private let routerAccent = Color(red: 0.39, green: 0.93, blue: 0.72)
private let routerInk = Color(red: 0.055, green: 0.071, blue: 0.094)
private let routerPanel = Color(red: 0.09, green: 0.115, blue: 0.145)
private let routerMuted = Color(red: 0.57, green: 0.63, blue: 0.70)

@main
struct ModelRouterTrayApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
  @StateObject private var store = RouterStore()

  var body: some Scene {
    MenuBarExtra {
      TrayView(store: store)
        .frame(width: 410, height: 580)
    } label: {
      Image(systemName: store.anyTargetActive ? "point.3.connected.trianglepath.dotted" : "point.3.filled.connected.trianglepath")
    }
    .menuBarExtraStyle(.window)
  }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)
  }
}

@MainActor
private final class RouterStore: ObservableObject {
  @Published private(set) var snapshot = RouterSnapshot.empty
  @Published private(set) var isRefreshing = false
  @Published private(set) var pendingApply = false
  @Published private(set) var message: String?
  @Published private(set) var lastUpdated: Date?

  var anyTargetActive: Bool {
    snapshot.targets.values.contains(where: \.active)
  }

  func refresh() async {
    isRefreshing = true
    defer { isRefreshing = false }
    do {
      let output = try runControl(arguments: ["--json"])
      snapshot = try JSONDecoder().decode(RouterSnapshot.self, from: output)
      lastUpdated = .now
      message = nil
    } catch {
      message = error.localizedDescription
    }
  }

  func setProvider(_ provider: String, enabled: Bool, target: String) async {
    do {
      _ = try runControl(arguments: ["set", provider, enabled ? "on" : "off", "--targets", target])
      pendingApply = true
      await refresh()
    } catch {
      message = error.localizedDescription
    }
  }

  func apply(target: String) async {
    do {
      _ = try runControl(arguments: ["apply", "--targets", target])
      pendingApply = false
      await refresh()
    } catch {
      message = error.localizedDescription
    }
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

private struct RouterError: LocalizedError {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}

private struct RouterSnapshot: Decodable {
  let targets: [String: RouterTarget]
  static let empty = RouterSnapshot(targets: [:])
}

private struct RouterTarget: Decodable {
  let target: String
  let configured: Bool
  let active: Bool
  let enabledProviders: [String]
  let models: [RouterModel]
}

private struct RouterModel: Decodable, Identifiable {
  let slug: String
  let displayName: String
  let provider: String
  let enabled: Bool
  let claudeRole: String?
  var id: String { slug }
}

private struct TrayView: View {
  @ObservedObject var store: RouterStore
  @State private var selectedTarget = "codex"

  private var target: RouterTarget? { store.snapshot.targets[selectedTarget] }
  private var providers: [(id: String, enabled: Bool)] {
    guard let target else { return [] }
    return Dictionary(grouping: target.models, by: \.provider)
      .map { (id: $0.key, enabled: $0.value.contains(where: \.enabled)) }
      .sorted { $0.id < $1.id }
  }

  var body: some View {
    ZStack {
      routerInk
      LinearGradient(
        colors: [Color(red: 0.04, green: 0.12, blue: 0.13), .clear],
        startPoint: .topLeading,
        endPoint: .center
      )
      VStack(spacing: 0) {
        header
        targetPicker
        if let target {
          content(for: target)
        } else if store.isRefreshing {
          ProgressView().tint(routerAccent).frame(maxHeight: .infinity)
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
    HStack(alignment: .top) {
      VStack(alignment: .leading, spacing: 5) {
        Text("MODEL ROUTER")
          .font(.system(size: 11, weight: .bold, design: .monospaced))
          .tracking(2.1)
          .foregroundStyle(routerAccent)
        Text("Local inference control plane")
          .font(.system(size: 17, weight: .semibold, design: .rounded))
      }
      Spacer()
      statusPill(active: store.anyTargetActive)
    }
    .padding(.bottom, 15)
  }

  private var targetPicker: some View {
    HStack(spacing: 5) {
      ForEach(["codex", "claude", "cursor"], id: \.self) { item in
        Button {
          selectedTarget = item
        } label: {
          Text(item.uppercased())
            .font(.system(size: 10, weight: .bold, design: .monospaced))
            .tracking(0.7)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
            .foregroundStyle(selectedTarget == item ? routerInk : routerMuted)
            .background(selectedTarget == item ? routerAccent : Color.white.opacity(0.07))
            .clipShape(Capsule())
        }
        .buttonStyle(.plain)
      }
    }
    .padding(4)
    .background(Color.white.opacity(0.045))
    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    .padding(.bottom, 14)
    .animation(.snappy(duration: 0.32), value: selectedTarget)
  }

  private func content(for target: RouterTarget) -> some View {
    ScrollView(showsIndicators: false) {
      VStack(alignment: .leading, spacing: 13) {
        targetStatus(target)
        sectionLabel("EXPOSED MODELS", detail: "\(target.models.filter(\.enabled).count) routes")
        VStack(spacing: 7) {
          ForEach(target.models.filter(\.enabled)) { model in
            ModelRow(model: model)
          }
        }
        sectionLabel("PROVIDERS", detail: store.pendingApply ? "changes pending" : "live state")
        VStack(spacing: 6) {
          ForEach(providers, id: \.id) { provider in
            providerRow(provider, target: target)
          }
        }
      }
    }
    .animation(.snappy(duration: 0.32), value: store.pendingApply)
  }

  private func targetStatus(_ target: RouterTarget) -> some View {
    HStack(spacing: 12) {
      Image(systemName: target.active ? "bolt.horizontal.circle.fill" : "bolt.slash.circle")
        .font(.system(size: 27))
        .foregroundStyle(target.active ? routerAccent : routerMuted)
      VStack(alignment: .leading, spacing: 2) {
        Text(target.active ? "ROUTER ONLINE" : "ROUTER STANDBY")
          .font(.system(size: 12, weight: .bold, design: .monospaced))
          .tracking(0.6)
        Text(target.configured ? "Configuration found on this Mac" : "No local target configuration")
          .font(.system(size: 11, weight: .medium, design: .rounded))
          .foregroundStyle(routerMuted)
      }
      Spacer()
    }
    .padding(14)
    .background(routerPanel.opacity(0.95))
    .overlay(alignment: .leading) { Rectangle().fill(target.active ? routerAccent : routerMuted).frame(width: 3) }
    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
  }

  private func sectionLabel(_ title: String, detail: String) -> some View {
    HStack {
      Text(title).font(.system(size: 10, weight: .bold, design: .monospaced)).tracking(1.2)
      Spacer()
      Text(detail).font(.system(size: 10, weight: .medium, design: .monospaced)).foregroundStyle(routerMuted)
    }
    .padding(.top, 2)
  }

  private func providerRow(_ provider: (id: String, enabled: Bool), target: RouterTarget) -> some View {
    HStack {
      VStack(alignment: .leading, spacing: 2) {
        Text(providerTitle(provider.id)).font(.system(size: 13, weight: .semibold, design: .rounded))
        Text(provider.id).font(.system(size: 10, weight: .regular, design: .monospaced)).foregroundStyle(routerMuted)
      }
      Spacer()
      Toggle("", isOn: Binding(
        get: { provider.enabled },
        set: { enabled in Task { await store.setProvider(provider.id, enabled: enabled, target: target.target) } }
      ))
      .labelsHidden()
      .tint(routerAccent)
    }
    .padding(.horizontal, 13)
    .padding(.vertical, 10)
    .background(Color.white.opacity(0.055))
    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
  }

  private var emptyState: some View {
    VStack(spacing: 9) {
      Image(systemName: "rectangle.dashed")
        .font(.system(size: 28))
        .foregroundStyle(routerMuted)
      Text("No router data yet")
        .font(.system(size: 14, weight: .semibold, design: .rounded))
      Text("Run the router setup, then refresh this panel.")
        .font(.system(size: 11, design: .rounded))
        .foregroundStyle(routerMuted)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private var footer: some View {
    HStack(spacing: 9) {
      if store.pendingApply {
        Button("Apply changes") { Task { await store.apply(target: selectedTarget) } }
          .buttonStyle(AccentButtonStyle())
          .transition(.move(edge: .leading).combined(with: .opacity))
      }
      Button {
        Task { await store.refresh() }
      } label: {
        Image(systemName: store.isRefreshing ? "arrow.triangle.2.circlepath.circle.fill" : "arrow.clockwise")
          .rotationEffect(.degrees(store.isRefreshing ? 360 : 0))
          .animation(
            store.isRefreshing
              ? .linear(duration: 0.9).repeatForever(autoreverses: false)
              : .default,
            value: store.isRefreshing
          )
      }
      .buttonStyle(IconButtonStyle())
      .disabled(store.isRefreshing)
      if let message = store.message {
        Text(message)
          .lineLimit(1)
          .font(.system(size: 10, design: .rounded))
          .foregroundStyle(Color(red: 1, green: 0.61, blue: 0.52))
      } else {
        Spacer()
        Text(store.lastUpdated.map { "UPDATED \($0.formatted(date: .omitted, time: .shortened))" } ?? "AWAITING DATA")
          .font(.system(size: 9, weight: .medium, design: .monospaced))
          .foregroundStyle(routerMuted)
      }
      Button("Quit") { NSApp.terminate(nil) }
        .buttonStyle(.plain)
        .font(.system(size: 11, weight: .medium, design: .rounded))
        .foregroundStyle(routerMuted)
    }
    .padding(.top, 13)
  }

  private func statusPill(active: Bool) -> some View {
    StatusBeacon(active: active)
  }

  private func providerTitle(_ provider: String) -> String {
    [
      "chatgpt-oauth": "ChatGPT Codex OAuth",
      "kimi-oauth": "Kimi Code OAuth",
      "kimi-api": "Kimi Platform API",
      "deepseek": "DeepSeek API",
    ][provider] ?? provider
  }
}

private struct ModelRow: View {
  let model: RouterModel
  @State private var arrived = false

  var body: some View {
    HStack(spacing: 10) {
      Circle().fill(routerAccent).frame(width: 6, height: 6)
      VStack(alignment: .leading, spacing: 2) {
        Text(model.displayName)
          .font(.system(size: 12, weight: .semibold, design: .rounded))
        Text(model.claudeRole ?? model.slug)
          .font(.system(size: 9, weight: .regular, design: .monospaced))
          .foregroundStyle(routerMuted)
      }
      Spacer()
      Text("READY")
        .font(.system(size: 9, weight: .bold, design: .monospaced))
        .foregroundStyle(routerAccent)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 9)
    .background(Color.white.opacity(0.055))
    .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
    .opacity(arrived ? 1 : 0)
    .offset(y: arrived ? 0 : 7)
    .onAppear {
      withAnimation(.spring(response: 0.38, dampingFraction: 0.78)) {
        arrived = true
      }
    }
  }
}

private struct StatusBeacon: View {
  let active: Bool
  @State private var breathing = false

  var body: some View {
    HStack(spacing: 5) {
      ZStack {
        Circle()
          .fill(active ? routerAccent.opacity(0.22) : routerMuted.opacity(0.18))
          .frame(width: 17, height: 17)
          .scaleEffect(active && breathing ? 1.32 : 0.86)
        Circle()
          .fill(active ? routerAccent : routerMuted)
          .frame(width: 6, height: 6)
      }
      Text(active ? "LIVE" : "IDLE")
        .font(.system(size: 9, weight: .bold, design: .monospaced))
        .tracking(1.1)
    }
    .foregroundStyle(active ? routerAccent : routerMuted)
    .padding(.leading, 5)
    .padding(.trailing, 8)
    .padding(.vertical, 5)
    .background((active ? routerAccent : routerMuted).opacity(0.13))
    .clipShape(Capsule())
    .onAppear { animate() }
    .onChange(of: active) { _ in animate() }
  }

  private func animate() {
    breathing = false
    guard active else { return }
    withAnimation(.easeInOut(duration: 1.35).repeatForever(autoreverses: true)) {
      breathing = true
    }
  }
}

private struct AccentButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 11, weight: .bold, design: .rounded))
      .foregroundStyle(routerInk)
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      .background(routerAccent.opacity(configuration.isPressed ? 0.72 : 1))
      .clipShape(Capsule())
  }
}

private struct IconButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 13, weight: .bold))
      .foregroundStyle(routerAccent)
      .frame(width: 29, height: 29)
      .background(Color.white.opacity(configuration.isPressed ? 0.13 : 0.07))
      .clipShape(Circle())
  }
}
