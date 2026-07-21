import AppKit
import SwiftUI

@MainActor
final class IslandDisplayModel: ObservableObject {
  enum State: Equatable {
    case compact
    case peek
    case expanded
  }

  @Published private(set) var state: State = .compact

  var size: CGSize {
    switch state {
    case .compact: return CGSize(width: 244, height: 38)
    case .peek: return CGSize(width: 350, height: 88)
    case .expanded: return CGSize(width: 500, height: 272)
    }
  }

  func setState(_ next: State) {
    guard state != next else { return }
    withAnimation(.spring(response: 0.42, dampingFraction: 0.82)) {
      state = next
    }
  }
}

@MainActor
final class IslandWindowController {
  static let windowSize = CGSize(width: 700, height: 360)

  private let window: NSPanel
  private let display = IslandDisplayModel()
  private var globalMouseMonitor: Any?
  private var localMouseMonitor: Any?
  private var initialTrackingTimer: Timer?
  private var screenObserver: NSObjectProtocol?

  init(store: RouterStore) {
    window = NSPanel(
      contentRect: NSRect(origin: .zero, size: Self.windowSize),
      styleMask: [.borderless, .nonactivatingPanel, .fullSizeContentView],
      backing: .buffered,
      defer: false
    )
    window.isOpaque = false
    window.backgroundColor = .clear
    window.hasShadow = false
    window.level = .popUpMenu
    window.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
    window.isMovable = false
    window.hidesOnDeactivate = false
    window.contentView = NSHostingView(
      rootView: IslandOverlayView(store: store, display: display)
        .frame(width: Self.windowSize.width, height: Self.windowSize.height, alignment: .top)
        .preferredColorScheme(.dark)
    )
  }

  func show() {
    reposition()
    window.orderFrontRegardless()
    installMouseTracking()
    screenObserver = NotificationCenter.default.addObserver(
      forName: NSApplication.didChangeScreenParametersNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      Task { @MainActor in self?.reposition() }
    }
  }

  deinit {
    if let globalMouseMonitor { NSEvent.removeMonitor(globalMouseMonitor) }
    if let localMouseMonitor { NSEvent.removeMonitor(localMouseMonitor) }
    if let screenObserver { NotificationCenter.default.removeObserver(screenObserver) }
    initialTrackingTimer?.invalidate()
  }

  private func reposition() {
    guard let screen = screenUnderPointer() ?? NSScreen.main else { return }
    let frame = screen.frame
    window.setFrame(
      NSRect(
        x: frame.midX - Self.windowSize.width / 2,
        y: frame.maxY - Self.windowSize.height,
        width: Self.windowSize.width,
        height: Self.windowSize.height
      ),
      display: true
    )
  }

  private func installMouseTracking() {
    window.ignoresMouseEvents = true
    let handler: (NSEvent) -> Void = { [weak self] _ in
      Task { @MainActor in
        self?.initialTrackingTimer?.invalidate()
        self?.initialTrackingTimer = nil
        self?.updateMouseState()
      }
    }
    globalMouseMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved], handler: handler)
    localMouseMonitor = NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved]) { event in
      handler(event)
      return event
    }
    initialTrackingTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.updateMouseState() }
    }
  }

  private func updateMouseState() {
    let cursor = NSEvent.mouseLocation
    let frame = window.frame
    let visible = display.size
    let islandRect = NSRect(
      x: frame.midX - visible.width / 2,
      y: frame.maxY - visible.height,
      width: visible.width,
      height: visible.height
    )
    let inside = islandRect.contains(cursor)
    window.ignoresMouseEvents = !inside
    if inside, display.state == .compact {
      display.setState(.peek)
    } else if !inside, display.state != .compact {
      display.setState(.compact)
    }
  }

  private func screenUnderPointer() -> NSScreen? {
    let pointer = NSEvent.mouseLocation
    return NSScreen.screens.first(where: { $0.frame.contains(pointer) })
  }
}

private struct IslandOverlayView: View {
  @ObservedObject var store: RouterStore
  @ObservedObject var display: IslandDisplayModel

  private var model: RouterModel? { store.pinnedModel }

  var body: some View {
    VStack(spacing: 0) {
      ZStack {
        glow
        IslandSilhouette()
          .fill(Color.black.opacity(0.97))
          .overlay {
            IslandSilhouette()
              .strokeBorder(
                LinearGradient(
                  colors: [Color.white.opacity(0.18), routerAccent.opacity(0.18), .clear],
                  startPoint: .topLeading,
                  endPoint: .bottomTrailing
                ),
                lineWidth: 0.7
              )
          }
        content
      }
      .frame(width: display.size.width, height: display.size.height)
      .contentShape(IslandSilhouette())
      .onTapGesture {
        if display.state != .expanded { display.setState(.expanded) }
      }
      .animation(.spring(response: 0.42, dampingFraction: 0.82), value: display.state)
      Spacer(minLength: 0)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .foregroundStyle(.white)
  }

  @ViewBuilder
  private var content: some View {
    switch display.state {
    case .compact:
      compactContent
        .transition(.opacity)
    case .peek:
      peekContent
        .transition(.opacity.combined(with: .scale(scale: 0.96, anchor: .top)))
    case .expanded:
      expandedContent
        .transition(.opacity.combined(with: .move(edge: .top)))
    }
  }

  private var compactContent: some View {
    HStack(spacing: 8) {
      LiveOrb(active: store.codexActive)
      Text(store.pinnedShortName ?? "Codex")
        .font(.system(size: 12, weight: .semibold, design: .rounded))
        .lineLimit(1)
      Spacer(minLength: 6)
      Text(store.pinnedUsageText ?? "LIVE")
        .font(.system(size: 10, weight: .bold, design: .monospaced))
        .foregroundStyle(store.pinnedUsageText == nil ? routerMint : routerAccent)
    }
    .padding(.horizontal, 14)
  }

  private var peekContent: some View {
    VStack(spacing: 7) {
      HStack(spacing: 9) {
        LiveOrb(active: store.codexActive)
        VStack(alignment: .leading, spacing: 1) {
          Text(islandModelName)
            .font(.system(size: 12, weight: .semibold, design: .rounded))
            .lineLimit(1)
          Text(sourceLabel)
            .font(.system(size: 8, weight: .bold, design: .monospaced))
            .tracking(0.7)
            .foregroundStyle(routerMuted)
        }
        Spacer()
        Text(primaryMetric)
          .font(.system(size: 18, weight: .semibold, design: .rounded))
          .monospacedDigit()
      }
      UsageSparkline(values: graphValues, tint: graphTint)
        .frame(height: 27)
    }
    .padding(.horizontal, 15)
    .padding(.top, 10)
    .padding(.bottom, 8)
  }

  private var expandedContent: some View {
    VStack(spacing: 12) {
      HStack(spacing: 10) {
        LiveOrb(active: store.codexActive)
        VStack(alignment: .leading, spacing: 2) {
          Text(islandModelName)
            .font(.system(size: 15, weight: .semibold, design: .rounded))
          Text(sourceLabel)
            .font(.system(size: 8, weight: .bold, design: .monospaced))
            .tracking(0.9)
            .foregroundStyle(routerMuted)
        }
        Spacer()
        Text(primaryMetric)
          .font(.system(size: 25, weight: .semibold, design: .rounded))
          .monospacedDigit()
        Button { display.setState(.peek) } label: {
          Image(systemName: "chevron.up")
            .font(.system(size: 10, weight: .bold))
            .frame(width: 25, height: 25)
            .background(Color.white.opacity(0.08), in: Circle())
        }
        .buttonStyle(.plain)
      }

      HStack(spacing: 8) {
        MetricTile(title: primaryTitle, value: primaryMetric, detail: primaryDetail, tint: routerAccent)
        MetricTile(title: secondaryTitle, value: secondaryMetric, detail: secondaryDetail, tint: routerMint)
      }

      UsageSparkline(values: graphValues, tint: graphTint)
        .frame(height: 58)

      HStack {
        Text("PIN A MODEL")
          .font(.system(size: 8, weight: .bold, design: .monospaced))
          .tracking(1.1)
          .foregroundStyle(routerMuted)
        Spacer()
        Text("Settings live in the tray")
          .font(.system(size: 9, design: .rounded))
          .foregroundStyle(routerMuted)
      }

      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 7) {
          ForEach(enabledModels) { candidate in
            Button {
              store.pin(candidate)
            } label: {
              HStack(spacing: 5) {
                Image(systemName: candidate.slug == store.pinnedModelSlug ? "pin.fill" : "circle.fill")
                  .font(.system(size: candidate.slug == store.pinnedModelSlug ? 8 : 4))
                Text(shortName(candidate))
                  .font(.system(size: 10, weight: .semibold, design: .rounded))
              }
              .foregroundStyle(candidate.slug == store.pinnedModelSlug ? Color.black : Color.white.opacity(0.72))
              .padding(.horizontal, 10)
              .padding(.vertical, 7)
              .background(
                candidate.slug == store.pinnedModelSlug ? routerAccent : Color.white.opacity(0.075),
                in: Capsule()
              )
            }
            .buttonStyle(.plain)
          }
        }
      }
    }
    .padding(.horizontal, 17)
    .padding(.top, 13)
    .padding(.bottom, 12)
  }

  private var glow: some View {
    IslandSilhouette()
      .stroke(
        AngularGradient(
          colors: [.clear, routerAccent.opacity(0.15), routerAccent, .white.opacity(0.8), .clear],
          center: .center
        ),
        lineWidth: store.isRefreshing ? 3 : 1.4
      )
      .blur(radius: store.isRefreshing ? 4 : 2)
      .shadow(color: routerAccent.opacity(store.isRefreshing ? 0.52 : 0.25), radius: 14)
      .opacity(store.codexActive ? 1 : 0.45)
      .animation(.easeInOut(duration: 0.3), value: store.isRefreshing)
  }

  private var enabledModels: [RouterModel] {
    store.snapshot.targets["codex"]?.models.filter(\.enabled) ?? []
  }

  private var sourceLabel: String {
    guard let model else { return "LOCAL MODEL BRIDGE" }
    if model.provider == "chatgpt-oauth" {
      return "CODEX \(store.quota.plan?.uppercased() ?? "SUBSCRIPTION")"
    }
    if model.provider == "grok-api" { return "XAI • METERED API" }
    if model.provider.hasSuffix("-api") || model.provider == "deepseek" { return "METERED API" }
    return "OAUTH ROUTE"
  }

  private var islandModelName: String {
    guard let name = model?.displayName else { return "Codex Router" }
    return name.split(separator: "(", maxSplits: 1).first
      .map(String.init)?
      .trimmingCharacters(in: .whitespacesAndNewlines) ?? name
  }

  private var primaryMetric: String {
    guard let model else { return "—" }
    if model.provider == "chatgpt-oauth", let used = store.quota.primary?.usedFraction {
      return "\(Int((used * 100).rounded()))%"
    }
    return "\(recentEvents(hours: 1).count)"
  }

  private var primaryTitle: String {
    model?.provider == "chatgpt-oauth" ? "5H WINDOW" : "LAST HOUR"
  }

  private var primaryDetail: String {
    if let reset = store.quota.primary?.resetAt, model?.provider == "chatgpt-oauth" {
      return "resets \(relativeTime(to: reset))"
    }
    return "routed requests"
  }

  private var secondaryTitle: String {
    model?.provider == "chatgpt-oauth" ? "WEEKLY" : "LAST 24H"
  }

  private var secondaryMetric: String {
    if model?.provider == "chatgpt-oauth" {
      guard let used = store.quota.weekly?.usedFraction else { return "—" }
      return "\(Int((used * 100).rounded()))%"
    }
    return "\(recentEvents(hours: 24).count)"
  }

  private var secondaryDetail: String {
    if model?.provider == "chatgpt-oauth" {
      guard let reset = store.quota.weekly?.resetAt else { return "window unavailable" }
      return "resets \(relativeTime(to: reset))"
    }
    return "private local count"
  }

  private var graphValues: [Double] {
    guard let model else { return [0, 0] }
    if model.provider == "chatgpt-oauth" {
      let values = store.quotaHistory.suffix(40).map(\.usedFraction)
      let current = store.quota.primary.map { [$0.usedFraction] } ?? []
      let combined = Array(values) + current
      return combined.count > 1 ? combined : [0, combined.first ?? 0]
    }
    let bucketCount = 24
    let bucketDuration: TimeInterval = 15 * 60
    let start = Date().addingTimeInterval(-Double(bucketCount) * bucketDuration)
    var buckets = Array(repeating: 0.0, count: bucketCount)
    for event in store.usageEvents(for: model) where event.at >= start {
      let index = Int(event.at.timeIntervalSince(start) / bucketDuration)
      if buckets.indices.contains(index) { buckets[index] += 1 }
    }
    return buckets
  }

  private var graphTint: Color {
    model?.provider == "chatgpt-oauth" ? routerAccent : routerMint
  }

  private func recentEvents(hours: Double) -> [RouterUsageEvent] {
    guard let model else { return [] }
    let cutoff = Date().addingTimeInterval(-hours * 60 * 60)
    return store.usageEvents(for: model).filter { $0.at >= cutoff }
  }

  private func shortName(_ model: RouterModel) -> String {
    for name in ["Sol", "Terra", "Luna", "Grok 4.5", "K3", "V4 Pro", "V4 Flash"]
    where model.displayName.localizedCaseInsensitiveContains(name) {
      return name
    }
    return model.displayName.split(separator: " ").first.map(String.init) ?? model.slug
  }

  private func relativeTime(to date: Date) -> String {
    let seconds = max(0, date.timeIntervalSinceNow)
    if seconds < 3600 { return "in \(max(1, Int(seconds / 60)))m" }
    if seconds < 86_400 { return "in \(Int(seconds / 3600))h" }
    return "in \(Int(seconds / 86_400))d"
  }
}

private struct IslandSilhouette: InsettableShape {
  var inset: CGFloat = 0

  func path(in rect: CGRect) -> Path {
    let r = rect.insetBy(dx: inset, dy: inset)
    let radius = min(22, r.height * 0.34)
    var path = Path()
    path.move(to: CGPoint(x: r.minX, y: r.minY))
    path.addLine(to: CGPoint(x: r.maxX, y: r.minY))
    path.addLine(to: CGPoint(x: r.maxX, y: r.maxY - radius))
    path.addCurve(
      to: CGPoint(x: r.maxX - radius, y: r.maxY),
      control1: CGPoint(x: r.maxX, y: r.maxY - radius * 0.38),
      control2: CGPoint(x: r.maxX - radius * 0.38, y: r.maxY)
    )
    path.addLine(to: CGPoint(x: r.minX + radius, y: r.maxY))
    path.addCurve(
      to: CGPoint(x: r.minX, y: r.maxY - radius),
      control1: CGPoint(x: r.minX + radius * 0.38, y: r.maxY),
      control2: CGPoint(x: r.minX, y: r.maxY - radius * 0.38)
    )
    path.closeSubpath()
    return path
  }

  func inset(by amount: CGFloat) -> IslandSilhouette {
    var copy = self
    copy.inset += amount
    return copy
  }
}

private struct LiveOrb: View {
  let active: Bool
  @State private var pulsing = false

  var body: some View {
    ZStack {
      Circle()
        .fill((active ? routerMint : routerMuted).opacity(0.18))
        .frame(width: 16, height: 16)
        .scaleEffect(active && pulsing ? 1.32 : 0.82)
      Circle()
        .fill(active ? routerMint : routerMuted)
        .frame(width: 6, height: 6)
    }
    .onAppear {
      guard active else { return }
      withAnimation(.easeInOut(duration: 1.4).repeatForever(autoreverses: true)) {
        pulsing = true
      }
    }
  }
}

private struct MetricTile: View {
  let title: String
  let value: String
  let detail: String
  let tint: Color

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(title)
        .font(.system(size: 8, weight: .bold, design: .monospaced))
        .tracking(0.9)
        .foregroundStyle(routerMuted)
      Text(value)
        .font(.system(size: 18, weight: .semibold, design: .rounded))
        .foregroundStyle(tint)
        .monospacedDigit()
      Text(detail)
        .font(.system(size: 9, design: .rounded))
        .foregroundStyle(routerMuted)
        .lineLimit(1)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.horizontal, 11)
    .padding(.vertical, 8)
    .background(Color.white.opacity(0.055), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .stroke(Color.white.opacity(0.08), lineWidth: 0.6)
    )
  }
}
