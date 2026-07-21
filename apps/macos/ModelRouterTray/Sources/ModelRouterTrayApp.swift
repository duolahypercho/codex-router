import AppKit
import Foundation
import SwiftUI

private let routerAccent = Color(red: 0.38, green: 0.74, blue: 1.00)
private let routerMint = Color(red: 0.38, green: 0.96, blue: 0.80)
private let routerInk = Color(red: 0.025, green: 0.045, blue: 0.075)
private let routerMuted = Color.white.opacity(0.56)

@main
struct ModelRouterTrayApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
  @StateObject private var store = RouterStore()

  var body: some Scene {
    MenuBarExtra {
      TrayView(store: store)
        .frame(width: 404, height: 594)
        .preferredColorScheme(.dark)
    } label: {
      Image(systemName: store.codexActive ? "point.3.connected.trianglepath.dotted" : "point.3.filled.connected.trianglepath")
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

  var codexActive: Bool {
    snapshot.targets["codex"]?.active == true
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
  var id: String { slug }
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
      StatusBeacon(active: store.codexActive)
    }
    .padding(.bottom, 15)
  }

  private func content(for target: RouterTarget) -> some View {
    ScrollView(showsIndicators: false) {
      VStack(alignment: .leading, spacing: 14) {
        routerStatus(target)
        sectionLabel("Exposed models", detail: "\(target.models.filter(\.enabled).count) available")
        VStack(spacing: 7) {
          ForEach(target.models.filter(\.enabled)) { model in
            ModelRow(model: model)
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

  private func routerStatus(_ target: RouterTarget) -> some View {
    HStack(spacing: 13) {
      ZStack {
        Circle()
          .fill((target.active ? routerAccent : Color.white).opacity(0.12))
          .frame(width: 47, height: 47)
        Image(systemName: target.active ? "bolt.fill" : "bolt.slash.fill")
          .font(.system(size: 17, weight: .semibold))
          .foregroundStyle(target.active ? routerAccent : routerMuted)
      }
      VStack(alignment: .leading, spacing: 4) {
        Text(target.active ? "Codex is connected" : "Codex is on standby")
          .font(.system(size: 15, weight: .semibold, design: .rounded))
        Text(target.configured ? "Routing is configured on this Mac" : "Complete setup to enable routing")
          .font(.system(size: 11, weight: .regular, design: .rounded))
          .foregroundStyle(routerMuted)
      }
      Spacer(minLength: 0)
    }
    .padding(14)
    .glassCard(cornerRadius: 18, accent: target.active ? routerAccent : Color.white.opacity(0.3))
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
    ][provider] ?? provider
  }
}

private struct ModelRow: View {
  let model: RouterModel
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
  let active: Bool
  @State private var breathing = false

  var body: some View {
    HStack(spacing: 6) {
      ZStack {
        Circle()
          .fill(active ? routerMint.opacity(0.2) : Color.white.opacity(0.08))
          .frame(width: 16, height: 16)
          .scaleEffect(active && breathing ? 1.3 : 0.88)
        Circle()
          .fill(active ? routerMint : routerMuted)
          .frame(width: 6, height: 6)
      }
      Text(active ? "LIVE" : "IDLE")
        .font(.system(size: 9, weight: .bold, design: .monospaced))
        .tracking(1)
    }
    .foregroundStyle(active ? routerMint : routerMuted)
    .padding(.horizontal, 9)
    .padding(.vertical, 6)
    .background(.ultraThinMaterial, in: Capsule())
    .overlay(Capsule().stroke(Color.white.opacity(0.12), lineWidth: 0.7))
    .onAppear { animate() }
    .onChange(of: active) { _ in animate() }
  }

  private func animate() {
    breathing = false
    guard active else { return }
    withAnimation(.easeInOut(duration: 1.45).repeatForever(autoreverses: true)) {
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
