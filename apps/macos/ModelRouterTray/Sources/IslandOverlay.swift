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
    case .compact: return CGSize(width: 320, height: 40)
    case .peek: return CGSize(width: 404, height: 148)
    case .expanded: return CGSize(width: 520, height: 372)
    }
  }

  func setState(_ next: State) {
    guard state != next else { return }
    state = next
  }
}

@MainActor
final class IslandWindowController {
  static let windowSize = CGSize(width: 720, height: 400)

  private let window: NSPanel
  private let display = IslandDisplayModel()
  private var globalMouseMonitor: Any?
  private var localMouseMonitor: Any?
  private var initialTrackingTimer: Timer?
  private var screenObserver: NSObjectProtocol?
  private var trackingInstalled = false

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

  func setVisible(_ visible: Bool) {
    if visible {
      reposition()
      window.orderFrontRegardless()
      if !trackingInstalled {
        installMouseTracking()
        trackingInstalled = true
      }
      if screenObserver == nil {
        screenObserver = NotificationCenter.default.addObserver(
          forName: NSApplication.didChangeScreenParametersNotification,
          object: nil,
          queue: .main
        ) { [weak self] _ in
          Task { @MainActor in self?.reposition() }
        }
      }
    } else {
      window.orderOut(nil)
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
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @ObservedObject var store: RouterStore
  @ObservedObject var display: IslandDisplayModel
  @State private var range: UsageRange = .week

  var body: some View {
    VStack(spacing: 0) {
      ZStack {
        IslandSilhouette()
          .fill(routerInk.opacity(0.985))
          .overlay {
            IslandSilhouette()
              .fill(
                LinearGradient(
                  colors: [Color.white.opacity(0.045), .clear, Color.white.opacity(0.018)],
                  startPoint: .topLeading,
                  endPoint: .bottomTrailing
                )
              )
          }
        glow
        content
      }
      .frame(width: display.size.width, height: display.size.height)
      .contentShape(IslandSilhouette())
      .onTapGesture {
        if display.state != .expanded { display.setState(.expanded) }
      }
      .animation(
        reduceMotion ? nil : .spring(response: 0.42, dampingFraction: 0.82),
        value: display.state
      )
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
    HStack(spacing: 7) {
      LiveOrb(state: store.activityState, count: store.activeRequestCount)
      Text(store.activitySummaryLabel)
        .font(.system(size: 10, weight: .semibold, design: .rounded))
        .foregroundStyle(store.activityState.tint)
      Text("·")
        .foregroundStyle(routerMuted)
      Text(store.compactActivityProvidersLabel)
        .font(.system(size: 11, weight: .medium, design: .rounded))
        .lineLimit(1)
      Spacer(minLength: 6)
      if store.hasConcurrentActivity {
        Text(compactActiveModelsLabel)
          .font(.system(size: 10, weight: .medium, design: .rounded))
          .foregroundStyle(.white.opacity(0.78))
          .lineLimit(1)
      } else {
        Text(store.selectedUsageText ?? "Usage —")
          .font(.system(size: 10, weight: .medium, design: .monospaced))
          .foregroundStyle(.white.opacity(0.78))
      }
    }
    .padding(.horizontal, 14)
  }

  private var peekContent: some View {
    VStack(spacing: 9) {
      HStack(spacing: 9) {
        LiveOrb(state: store.activityState, count: store.activeRequestCount)
        VStack(alignment: .leading, spacing: 1) {
          Text(peekTitle)
            .font(.system(size: 12, weight: .semibold, design: .rounded))
            .lineLimit(1)
          Text("\(store.activitySummaryLabel) · \(sourceLabel)")
            .font(.system(size: 9, weight: .medium, design: .rounded))
            .foregroundStyle(store.activityState.tint.opacity(0.92))
        }
        Spacer()
        VStack(alignment: .trailing, spacing: 1) {
          Text(primaryMetric)
            .font(.system(size: 18, weight: .semibold, design: .rounded))
            .monospacedDigit()
          Text(primaryLabel)
            .font(.system(size: 7, weight: .semibold, design: .monospaced))
            .tracking(0.7)
            .foregroundStyle(routerMuted)
        }
      }
      if store.hasConcurrentActivity {
        ActiveRequestList(store: store, limit: 3, compact: true)
      } else {
        UsageBarChart(points: store.dailyUsage(days: 7), tint: graphTint)
          .id("\(store.selectedUsageProviderID)-peek")
          .frame(height: 43)
      }
    }
    .padding(.horizontal, 15)
    .padding(.top, 10)
    .padding(.bottom, 8)
  }

  private var expandedContent: some View {
    VStack(spacing: 13) {
      HStack(spacing: 10) {
        LiveOrb(state: store.activityState, count: store.activeRequestCount)
        VStack(alignment: .leading, spacing: 2) {
          Text(peekTitle)
            .font(.system(size: 15, weight: .semibold, design: .rounded))
          Text("\(store.activitySummaryLabel) · \(sourceLabel)")
            .font(.system(size: 9, weight: .medium, design: .rounded))
            .foregroundStyle(store.activityState.tint)
        }
        Spacer()
        Text(primaryMetric)
          .font(.system(size: 25, weight: .semibold, design: .rounded))
          .monospacedDigit()
        Button("Collapse") { display.setState(.peek) }
        .buttonStyle(.plain)
        .font(.system(size: 9, weight: .medium, design: .rounded))
        .foregroundStyle(routerMuted)
      }

      HStack(spacing: 8) {
        MetricTile(title: primaryTitle, value: primaryTileMetric, detail: primaryDetail, tint: routerAccent)
        MetricTile(title: secondaryTitle, value: secondaryMetric, detail: secondaryDetail, tint: .white.opacity(0.82))
      }

      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Text("DAILY TOKEN USAGE")
          .font(.system(size: 8, weight: .semibold, design: .monospaced))
          .tracking(0.8)
          .foregroundStyle(routerMuted)
        if let reset = store.selectedUsageResetDate {
          Text("· \(usageResetCaption(reset))")
            .font(.system(size: 8, design: .rounded))
            .foregroundStyle(routerMuted)
            .lineLimit(1)
        }
        Spacer()
        UsageRangePicker(selection: $range)
      }

      UsageBarChart(points: graphPoints, tint: graphTint)
        .id("\(store.selectedUsageProviderID)-\(range.rawValue)-expanded")
        .frame(height: 78)

      HStack {
        Text(store.hasConcurrentActivity ? "ACTIVE NOW" : "ACTIVE PROVIDER")
          .font(.system(size: 8, weight: .semibold, design: .monospaced))
          .tracking(0.8)
          .foregroundStyle(routerMuted)
        Spacer()
        Text(store.hasConcurrentActivity
          ? "\(store.activeRequestCount) concurrent model requests"
          : "Account and traffic are provider-scoped")
          .font(.system(size: 9, design: .rounded))
          .foregroundStyle(routerMuted)
      }

      if store.hasConcurrentActivity {
        ActiveRequestList(store: store, limit: 4, compact: false)
      } else {
        HStack {
          VStack(alignment: .leading, spacing: 2) {
            Text(store.selectedUsageProvider.displayName)
              .font(.system(size: 10, weight: .semibold, design: .rounded))
            Text(store.selectedUsageProvider.detail)
              .font(.system(size: 8, design: .rounded))
              .foregroundStyle(routerMuted)
          }
          Spacer()
          Text(store.activityState == .generating ? "Live" : "Last used")
            .font(.system(size: 9, weight: .medium, design: .rounded))
            .foregroundStyle(store.activityState.tint)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(Color.white.opacity(0.045), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
      }
    }
    .padding(.horizontal, 17)
    .padding(.top, 13)
    .padding(.bottom, 12)
  }

  private var glow: some View {
    StatusGlow(state: store.activityState)
      .id("\(store.activityState.rawValue)-\(store.activeRequestCount)")
  }

  private var peekTitle: String {
    if store.hasConcurrentActivity {
      return store.compactActivityProvidersLabel
    }
    return store.selectedUsageProvider.displayName
  }

  private var compactActiveModelsLabel: String {
    let models = store.activeRequests.prefix(2).map(store.modelLabel(for:))
    if models.isEmpty { return "Live" }
    if store.activeRequests.count > 2 {
      return "\(models.joined(separator: " · ")) +\(store.activeRequests.count - 2)"
    }
    return models.joined(separator: " · ")
  }

  private var sourceLabel: String {
    let provider = store.selectedUsageProviderID
    if provider == "openai" { return "CHATGPT • NATIVE" }
    if provider == "grok-oauth" { return "XAI • OAUTH SESSION" }
    if provider == "grok-api" { return "XAI • METERED API" }
    if provider.hasSuffix("-api") || provider == "deepseek" { return "METERED API" }
    return "OAUTH ROUTE"
  }

  private var primaryMetric: String {
    if store.selectedUsageUsesChatGPT {
      guard let remaining = store.accountUsage?.primary?.remainingPercent else { return "—" }
      return "\(remaining)%"
    }
    guard store.providerUsage != nil else { return "—" }
    if let metric = store.selectedAccountMetric { return formattedAccountMetric(metric) }
    return compactTokenCount(store.localUsageTotals(days: range.rawValue).tokens)
  }

  private var primaryLabel: String {
    if store.selectedUsageUsesChatGPT { return "SUBSCRIPTION LEFT" }
    return store.selectedAccountMetric?.label.uppercased() ?? "\(range.rawValue)D LOCAL TOKENS"
  }

  private var primaryTitle: String {
    if store.selectedUsageUsesChatGPT {
      return store.accountUsage?.primary?.durationLabel.uppercased() ?? "CHATGPT LIMIT"
    }
    if let metric = store.selectedAccountMetric { return metric.label.uppercased() }
    return "\(range.rawValue)-DAY REQUESTS"
  }

  private var primaryTileMetric: String {
    if store.selectedUsageUsesChatGPT { return primaryMetric }
    if let metric = store.selectedAccountMetric { return formattedAccountMetric(metric) }
    return "\(store.localUsageTotals(days: range.rawValue).requests)"
  }

  private var primaryDetail: String {
    if store.selectedUsageUsesChatGPT {
      guard let reset = store.accountUsage?.primary?.resetDate else { return "Native Codex subscription" }
      return "Resets \(reset.formatted(date: .abbreviated, time: .shortened))"
    }
    if let metric = store.selectedAccountMetric {
      if let reset = metric.resetDate {
        return "Resets \(reset.formatted(date: .abbreviated, time: .shortened))"
      }
      if let detail = metric.detail, !detail.isEmpty { return detail }
      return "Official provider account"
    }
    return "Measured on this Mac"
  }

  private var secondaryTitle: String {
    "\(range.rawValue)-DAY USAGE"
  }

  private var secondaryMetric: String {
    compactTokenCount(graphValues.reduce(0, +))
  }

  private var secondaryDetail: String {
    return "tokens by day"
  }

  private var graphValues: [Double] {
    graphPoints.map(\.tokens)
  }

  private var graphPoints: [DailyUsagePoint] {
    store.dailyUsage(days: range.rawValue)
  }

  private var graphTint: Color {
    routerAccent
  }

}


private struct ActiveRequestList: View {
  @ObservedObject var store: RouterStore
  let limit: Int
  let compact: Bool

  var body: some View {
    VStack(spacing: compact ? 5 : 6) {
      ForEach(Array(store.activeRequests.prefix(limit))) { request in
        HStack(spacing: 8) {
          Circle()
            .fill(routerYellow)
            .frame(width: 6, height: 6)
          VStack(alignment: .leading, spacing: 1) {
            Text(store.modelLabel(for: request))
              .font(.system(size: compact ? 10 : 11, weight: .semibold, design: .rounded))
              .lineLimit(1)
            Text(store.displayName(forProvider: request.provider))
              .font(.system(size: compact ? 8 : 9, weight: .medium, design: .rounded))
              .foregroundStyle(routerMuted)
              .lineLimit(1)
          }
          Spacer(minLength: 6)
          Text(elapsedLabel(for: request))
            .font(.system(size: compact ? 9 : 10, weight: .medium, design: .monospaced))
            .foregroundStyle(routerYellow.opacity(0.95))
            .monospacedDigit()
        }
        .padding(.horizontal, compact ? 8 : 10)
        .padding(.vertical, compact ? 5 : 7)
        .background(Color.white.opacity(0.045), in: RoundedRectangle(cornerRadius: compact ? 8 : 10, style: .continuous))
      }
      if store.activeRequests.count > limit {
        Text("+\(store.activeRequests.count - limit) more")
          .font(.system(size: 9, weight: .medium, design: .rounded))
          .foregroundStyle(routerMuted)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
  }

  private func elapsedLabel(for request: RouterActiveRequest) -> String {
    let started = Date(timeIntervalSince1970: request.startedAt / 1000)
    let seconds = max(0, Int(Date().timeIntervalSince(started)))
    if seconds < 60 { return "\(seconds)s" }
    let minutes = seconds / 60
    let rem = seconds % 60
    return "\(minutes)m \(rem)s"
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
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let state: RouterActivityState
  var count: Int = 0
  @State private var pulsing = false

  var body: some View {
    ZStack(alignment: .topTrailing) {
      ZStack {
        Circle()
          .fill(state.tint.opacity(0.2))
          .frame(width: 18, height: 18)
          .scaleEffect(state == .generating && pulsing ? 1.34 : 0.94)
        Circle()
          .fill(state.tint)
          .frame(width: 8, height: 8)
          .overlay(Circle().stroke(Color.white.opacity(0.42), lineWidth: 0.6))
      }
      if count > 1 {
        Text("\(min(count, 9))")
          .font(.system(size: 7, weight: .bold, design: .rounded))
          .foregroundStyle(.black.opacity(0.88))
          .frame(width: 11, height: 11)
          .background(state.tint, in: Circle())
          .overlay(Circle().stroke(Color.black.opacity(0.35), lineWidth: 0.6))
          .offset(x: 5, y: -4)
      }
    }
    .onAppear { animate() }
    .onChange(of: state) { _ in animate() }
    .onChange(of: count) { _ in animate() }
  }

  private func animate() {
    pulsing = false
    guard state == .generating, !reduceMotion else { return }
    withAnimation(.easeInOut(duration: 0.72).repeatForever(autoreverses: true)) {
      pulsing = true
    }
  }
}

private struct StatusGlow: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let state: RouterActivityState

  var body: some View {
    TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion)) { timeline in
      let elapsed = timeline.date.timeIntervalSinceReferenceDate
      let angle = Angle.degrees(
        reduceMotion ? 0 : (elapsed / sweepDuration).truncatingRemainder(dividingBy: 1) * 360
      )
      let wave = reduceMotion ? 0.5 : (sin(elapsed * 2 * .pi / flashDuration) + 1) / 2
      ZStack {
        IslandSilhouette()
          .inset(by: 1)
          .strokeBorder(state.tint.opacity(0.14), lineWidth: 1)
        IslandSilhouette()
          .inset(by: 1)
          .strokeBorder(
            sweepGradient(angle: angle),
            lineWidth: state == .generating ? 7 : 5
          )
          .blur(radius: state == .error ? 4.5 : 3.5)
          .opacity(0.34 + wave * 0.48)
        IslandSilhouette()
          .inset(by: 1.5)
          .strokeBorder(
            sweepGradient(angle: angle),
            lineWidth: state == .generating ? 2.5 : 2
          )
          .opacity(0.58 + wave * 0.42)
        IslandSilhouette()
          .inset(by: 3.5)
          .strokeBorder(Color.white.opacity(0.09), lineWidth: 0.55)
      }
    }
    .animation(.easeInOut(duration: 0.25), value: state)
  }

  private func sweepGradient(angle: Angle) -> AngularGradient {
    AngularGradient(
      gradient: Gradient(stops: [
        .init(color: .clear, location: 0),
        .init(color: .clear, location: 0.55),
        .init(color: state.tint.opacity(0.12), location: 0.66),
        .init(color: state.tint.opacity(0.88), location: 0.74),
        .init(color: Color.white.opacity(0.98), location: 0.79),
        .init(color: state.tint.opacity(0.82), location: 0.84),
        .init(color: .clear, location: 0.96),
        .init(color: .clear, location: 1),
      ]),
      center: .center,
      startAngle: angle,
      endAngle: .degrees(angle.degrees + 360)
    )
  }

  private var sweepDuration: Double {
    switch state {
    case .idle: return 2.6
    case .generating: return 1.15
    case .error: return 0.82
    }
  }

  private var flashDuration: Double {
    state == .idle ? 1.25 : 0.62
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
