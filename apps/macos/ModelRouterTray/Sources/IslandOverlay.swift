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
        Text(compactUsageSummary)
          .font(.system(size: 10, weight: .medium, design: .monospaced))
          .foregroundStyle(.white.opacity(0.78))
          .lineLimit(1)
          .minimumScaleFactor(0.75)
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
        HStack(spacing: 12) {
          IslandHeaderMetric(value: todayTokenValue, label: "TODAY TOKENS")
          if let accountHeaderValue {
            IslandHeaderMetric(value: accountHeaderValue, label: accountHeaderLabel)
          }
        }
      }
      IslandUsageLineChart(points: dailyGraphPoints, tint: graphTint, showsAxis: false)
        .id("\(store.selectedUsageProviderID)-daily-peek")
        .frame(height: 43)
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
        Button("Collapse") { display.setState(.peek) }
        .buttonStyle(.plain)
        .font(.system(size: 9, weight: .medium, design: .rounded))
        .foregroundStyle(routerMuted)
      }

      HStack(spacing: 8) {
        MetricTile(
          title: "TODAY'S TOKENS",
          value: todayTokenValue,
          detail: tokenSourceDetail,
          tint: .white.opacity(0.88)
        )
        MetricTile(
          title: accountTileTitle,
          value: accountTileValue,
          detail: accountTileDetail,
          tint: routerAccent
        )
      }

      HStack(alignment: .firstTextBaseline) {
        Text("DAILY TOKEN TREND")
          .font(.system(size: 8, weight: .semibold, design: .monospaced))
          .tracking(0.8)
          .foregroundStyle(routerMuted)
        Spacer()
        Text("LAST 7 DAYS")
          .font(.system(size: 8, weight: .semibold, design: .monospaced))
          .tracking(0.6)
          .foregroundStyle(routerMuted)
      }

      IslandUsageLineChart(points: dailyGraphPoints, tint: graphTint)
        .id("\(store.selectedUsageProviderID)-daily-expanded")
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

  private var compactUsageSummary: String {
    let tokens = "\(todayTokenValue) today"
    guard let accountCompactValue else { return tokens }
    return "\(tokens) · \(accountCompactValue)"
  }

  private var todayTokenValue: String {
    compactTokenCount(store.selectedTodayTokens)
  }

  private var dailyGraphPoints: [DailyUsagePoint] {
    store.dailyUsage(days: 7)
  }

  private var graphTint: Color {
    routerAccent
  }

  private var quotaUsedPercent: Double? {
    if store.selectedUsageUsesChatGPT {
      guard let used = store.accountUsage?.primary?.usedPercent else { return nil }
      return Double(max(0, min(100, used)))
    }
    guard store.selectedAccountMetric?.kind == "quota",
          let used = store.selectedAccountMetric?.usedPercent
    else { return nil }
    return max(0, min(100, used))
  }

  private var accountUsageLabel: String {
    if store.selectedUsageUsesChatGPT {
      return store.accountUsage?.primary?.durationLabel ?? "ChatGPT limit"
    }
    if let metric = store.selectedAccountMetric {
      return metric.kind == "quota" ? standardizedLimitLabel(metric.label) : metric.label
    }
    return "Usage limit"
  }

  private var accountHeaderValue: String? {
    if let quotaUsedPercent { return "\(Int(quotaUsedPercent.rounded()))%" }
    guard let metric = store.selectedAccountMetric, metric.kind == "balance" else { return nil }
    return formattedAccountMetric(metric)
  }

  private var accountHeaderLabel: String {
    if quotaUsedPercent != nil {
      let window = accountUsageLabel.replacingOccurrences(
        of: " limit",
        with: "",
        options: [.caseInsensitive]
      )
      return "\(window.uppercased()) USED"
    }
    return accountUsageLabel.uppercased()
  }

  private var accountCompactValue: String? {
    if let quotaUsedPercent { return "\(Int(quotaUsedPercent.rounded()))% used" }
    guard let metric = store.selectedAccountMetric, metric.kind == "balance" else { return nil }
    return formattedAccountMetric(metric)
  }

  private var accountTileTitle: String {
    accountUsageLabel.uppercased()
  }

  private var accountTileValue: String {
    if let quotaUsedPercent { return "\(Int(quotaUsedPercent.rounded()))% used" }
    if let metric = store.selectedAccountMetric, metric.kind == "balance" {
      return formattedAccountMetric(metric)
    }
    return "—"
  }

  private var accountTileDetail: String {
    if let reset = store.selectedUsageResetDate { return usageResetCaption(reset) }
    if let detail = store.selectedAccountMetric?.detail, !detail.isEmpty { return detail }
    return quotaUsedPercent == nil ? "Not reported by provider" : "No reset reported"
  }

  private var tokenSourceDetail: String {
    store.selectedUsageUsesChatGPT ? "ChatGPT account usage" : "Measured by this router"
  }

}

private struct IslandHeaderMetric: View {
  let value: String
  let label: String

  var body: some View {
    VStack(alignment: .trailing, spacing: 1) {
      Text(value)
        .font(.system(size: 17, weight: .semibold, design: .rounded))
        .monospacedDigit()
      Text(label)
        .font(.system(size: 7, weight: .semibold, design: .monospaced))
        .tracking(0.7)
        .foregroundStyle(routerMuted)
        .lineLimit(1)
    }
  }
}

private struct IslandUsageLineChart: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let points: [DailyUsagePoint]
  let tint: Color
  var showsAxis = true

  @State private var hoveredIndex: Int?
  @State private var revealProgress: CGFloat = 0

  var body: some View {
    GeometryReader { geometry in
      let axisHeight: CGFloat = showsAxis ? 14 : 0
      let plotHeight = max(1, geometry.size.height - axisHeight)
      let maximum = max(points.map(\.tokens).max() ?? 0, 1)
      let coordinates = chartCoordinates(
        width: geometry.size.width,
        height: plotHeight,
        maximum: maximum
      )
      let visibleProgress = reduceMotion ? 1 : revealProgress

      ZStack(alignment: .topLeading) {
        Path { path in
          let y = plotHeight * 0.5
          path.move(to: CGPoint(x: 0, y: y))
          path.addLine(to: CGPoint(x: geometry.size.width, y: y))
        }
        .stroke(Color.white.opacity(0.035), style: StrokeStyle(lineWidth: 0.45, dash: [2, 4]))

        if !coordinates.isEmpty {
          areaPath(coordinates, baseline: plotHeight - 2)
            .fill(
              LinearGradient(
                colors: [tint.opacity(0.10), tint.opacity(0.006)],
                startPoint: .top,
                endPoint: .bottom
              )
            )
            .opacity(Double(visibleProgress))

          linePath(coordinates)
            .trim(from: 0, to: visibleProgress)
            .stroke(
              tint.opacity(0.78),
              style: StrokeStyle(lineWidth: 1.25, lineCap: .round, lineJoin: .round)
            )
        }

        if showsAxis {
          ForEach(Array(points.enumerated()), id: \.element.id) { index, point in
            if shouldLabel(index: index), coordinates.indices.contains(index) {
              Text(axisLabel(for: point))
                .font(.system(size: 7.5, weight: .medium, design: .rounded))
                .foregroundStyle(routerMuted)
                .fixedSize()
                .position(
                  x: min(
                    geometry.size.width - 10,
                    max(10, coordinates[index].x)
                  ),
                  y: plotHeight + 6
                )
            }
          }
        }

        if let hoveredIndex,
           points.indices.contains(hoveredIndex),
           coordinates.indices.contains(hoveredIndex) {
          let coordinate = coordinates[hoveredIndex]
          Path { path in
            path.move(to: CGPoint(x: coordinate.x, y: 2))
            path.addLine(to: CGPoint(x: coordinate.x, y: plotHeight - 2))
          }
          .stroke(Color.white.opacity(0.14), lineWidth: 0.5)

          Circle()
            .fill(tint)
            .frame(width: 6, height: 6)
            .overlay(Circle().stroke(Color.white.opacity(0.65), lineWidth: 0.7))
            .position(coordinate)

          Text(hoverText(for: points[hoveredIndex]))
            .font(.system(size: 8, weight: .medium, design: .monospaced))
            .foregroundStyle(.white)
            .padding(.horizontal, 7)
            .padding(.vertical, 4)
            .background(routerInk.opacity(0.92), in: Capsule())
            .overlay(Capsule().stroke(Color.white.opacity(0.12), lineWidth: 0.5))
            .fixedSize()
            .position(
              x: min(geometry.size.width - 66, max(66, coordinate.x)),
              y: 11
            )
        }
      }
      .contentShape(Rectangle())
      .onContinuousHover { phase in
        switch phase {
        case .active(let location):
          hoveredIndex = nearestIndex(to: location.x, width: geometry.size.width)
        case .ended:
          hoveredIndex = nil
        }
      }
    }
    .onAppear { animateReveal() }
    .onChange(of: points.map(\.tokens)) { _ in animateReveal() }
    .onChange(of: reduceMotion) { _ in animateReveal() }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Daily token usage line chart")
    .accessibilityValue("\(formattedTotalTokens) tokens over \(points.count) days")
  }

  private func animateReveal() {
    withAnimation(nil) { revealProgress = reduceMotion ? 1 : 0 }
    guard !reduceMotion else { return }
    Task { @MainActor in
      await Task<Never, Never>.yield()
      withAnimation(.easeOut(duration: 0.72)) { revealProgress = 1 }
    }
  }

  private var formattedTotalTokens: String {
    Int64(points.reduce(0) { $0 + $1.tokens }).formatted(.number.grouping(.automatic))
  }

  private func chartCoordinates(width: CGFloat, height: CGFloat, maximum: Double) -> [CGPoint] {
    let horizontalInset: CGFloat = 3
    let topInset: CGFloat = 5
    let bottomInset: CGFloat = 3
    let usableWidth = max(1, width - horizontalInset * 2)
    let usableHeight = max(1, height - topInset - bottomInset)
    return points.enumerated().map { index, point in
      let x = points.count > 1
        ? horizontalInset + usableWidth * CGFloat(index) / CGFloat(points.count - 1)
        : width / 2
      let normalized = max(0, min(1, point.tokens / maximum))
      let y = topInset + usableHeight * (1 - CGFloat(normalized))
      return CGPoint(x: x, y: y)
    }
  }

  private func linePath(_ coordinates: [CGPoint]) -> Path {
    Path { path in
      guard let first = coordinates.first else { return }
      path.move(to: first)
      for coordinate in coordinates.dropFirst() {
        path.addLine(to: coordinate)
      }
    }
  }

  private func areaPath(_ coordinates: [CGPoint], baseline: CGFloat) -> Path {
    Path { path in
      guard let first = coordinates.first, let last = coordinates.last else { return }
      path.move(to: CGPoint(x: first.x, y: baseline))
      path.addLine(to: first)
      for coordinate in coordinates.dropFirst() {
        path.addLine(to: coordinate)
      }
      path.addLine(to: CGPoint(x: last.x, y: baseline))
      path.closeSubpath()
    }
  }

  private func nearestIndex(to x: CGFloat, width: CGFloat) -> Int? {
    guard !points.isEmpty else { return nil }
    guard points.count > 1, width > 0 else { return 0 }
    let fraction = max(0, min(1, x / width))
    return Int((fraction * CGFloat(points.count - 1)).rounded())
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
    let date = point.date.formatted(.dateTime.month(.abbreviated).day())
    let tokens = Int64(point.tokens).formatted(.number.grouping(.automatic))
    return "\(date) · \(tokens) tok"
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
  @State private var rippling = false

  var body: some View {
    ZStack(alignment: .topTrailing) {
      ZStack {
        Circle()
          .stroke(state.tint.opacity(0.38), lineWidth: 0.7)
          .frame(width: 11, height: 11)
          .scaleEffect(rippling ? (state == .idle ? 2.0 : 2.3) : 0.72)
          .opacity(rippling ? 0 : (state == .idle ? 0.24 : 0.38))
        Circle()
          .fill(state.tint.opacity(orbHaloOpacity))
          .frame(width: 18, height: 18)
          .scaleEffect(orbHaloScale)
        Circle()
          .fill(state.tint)
          .frame(width: 8, height: 8)
          .overlay(Circle().stroke(Color.white.opacity(0.42), lineWidth: 0.6))
          .shadow(
            color: state.tint.opacity(pulsing ? 0.42 : 0.16),
            radius: pulsing ? 3.5 : 1.2
          )
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
    .onChange(of: reduceMotion) { _ in animate() }
  }

  private var orbHaloOpacity: Double {
    if state == .idle { return pulsing ? 0.16 : 0.08 }
    return pulsing ? 0.24 : 0.13
  }

  private var orbHaloScale: CGFloat {
    if state == .idle { return pulsing ? 1.14 : 0.94 }
    if state == .error { return 1 }
    return pulsing ? 1.28 : 0.92
  }

  private func animate() {
    withAnimation(nil) {
      pulsing = false
      rippling = false
    }
    guard !reduceMotion else { return }

    if state == .error {
      withAnimation(.easeOut(duration: 0.8)) {
        pulsing = true
        rippling = true
      }
      return
    }

    let pulseDuration = state == .idle ? 2.6 : 1.35
    withAnimation(.easeInOut(duration: pulseDuration).repeatForever(autoreverses: true)) {
      pulsing = true
    }
    let rippleDuration = state == .idle ? 3.2 : 1.9
    withAnimation(.easeOut(duration: rippleDuration).repeatForever(autoreverses: false)) {
      rippling = true
    }
  }
}

private struct StatusGlow: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let state: RouterActivityState

  @State private var sweepAngle = -120.0
  @State private var sweepOpacity = 0.0
  @State private var breathing = false
  @State private var errorPulse = false
  @State private var effectTask: Task<Void, Never>?

  var body: some View {
    ZStack(alignment: .topLeading) {
      IslandSilhouette()
        .inset(by: 1)
        .strokeBorder(Color.white.opacity(0.065), lineWidth: 0.7)

      if state != .idle {
        IslandSilhouette()
          .inset(by: 1)
          .strokeBorder(state.tint.opacity(edgeOpacity * 0.55), lineWidth: 2.4)
          .blur(radius: 2.2)
        IslandSilhouette()
          .inset(by: 1)
          .strokeBorder(state.tint.opacity(edgeOpacity), lineWidth: edgeLineWidth)
      }

      Circle()
        .fill(
          RadialGradient(
            colors: [state.tint.opacity(0.9), state.tint.opacity(0.18), .clear],
            center: .center,
            startRadius: 0,
            endRadius: 22
          )
        )
        .frame(width: 44, height: 44)
        .offset(x: 1, y: -2)
        .opacity(localHaloOpacity)

      if sweepOpacity > 0.001 {
        IslandSilhouette()
          .inset(by: 1)
          .strokeBorder(sweepGradient(angle: .degrees(sweepAngle)), lineWidth: 3)
          .blur(radius: 2.4)
          .opacity(sweepOpacity * 0.35)
        IslandSilhouette()
          .inset(by: 1)
          .strokeBorder(sweepGradient(angle: .degrees(sweepAngle)), lineWidth: 1.15)
          .opacity(sweepOpacity)
      }

      IslandSilhouette()
        .inset(by: 3.5)
        .strokeBorder(Color.white.opacity(0.035), lineWidth: 0.45)
    }
    .onAppear { restartEffects() }
    .onChange(of: state) { _ in restartEffects() }
    .onChange(of: reduceMotion) { _ in restartEffects() }
    .onDisappear { effectTask?.cancel() }
    .animation(.easeInOut(duration: 0.25), value: state)
    .accessibilityHidden(true)
  }

  private var edgeOpacity: Double {
    switch state {
    case .idle:
      return 0
    case .starting:
      return 0.065
    case .generating:
      return 0.09
    case .error:
      return errorPulse ? 0.22 : 0.12
    }
  }

  private var edgeLineWidth: Double {
    state == .error && errorPulse ? 1.3 : 0.8
  }

  private var localHaloOpacity: Double {
    switch state {
    case .idle:
      return breathing ? 0.11 : 0.045
    case .starting:
      return breathing ? 0.20 : 0.09
    case .generating:
      return breathing ? 0.24 : 0.11
    case .error:
      return errorPulse ? 0.20 : 0.12
    }
  }

  private func sweepGradient(angle: Angle) -> AngularGradient {
    AngularGradient(
      gradient: Gradient(stops: [
        .init(color: .clear, location: 0),
        .init(color: .clear, location: 0.70),
        .init(color: state.tint.opacity(0.20), location: 0.74),
        .init(color: state.tint.opacity(0.68), location: 0.79),
        .init(color: Color.white.opacity(0.28), location: 0.81),
        .init(color: state.tint.opacity(0.42), location: 0.84),
        .init(color: .clear, location: 0.90),
        .init(color: .clear, location: 1),
      ]),
      center: .center,
      startAngle: angle,
      endAngle: .degrees(angle.degrees + 360)
    )
  }

  private func restartEffects() {
    effectTask?.cancel()
    withAnimation(nil) {
      sweepAngle = -120
      sweepOpacity = 0
      breathing = false
      errorPulse = false
    }
    guard !reduceMotion else { return }

    let nextState = state
    effectTask = Task { @MainActor in
      await Task<Never, Never>.yield()
      guard !Task.isCancelled else { return }

      switch nextState {
      case .idle:
        withAnimation(.easeInOut(duration: 3.2).repeatForever(autoreverses: true)) {
          breathing = true
        }
      case .starting:
        withAnimation(.easeInOut(duration: 1.8).repeatForever(autoreverses: true)) {
          breathing = true
        }
      case .generating:
        withAnimation(nil) {
          sweepAngle = -120
          sweepOpacity = 0.52
        }
        await Task<Never, Never>.yield()
        guard !Task.isCancelled else { return }
        withAnimation(.linear(duration: 3.2).repeatForever(autoreverses: false)) {
          sweepAngle = 240
        }
        withAnimation(.easeInOut(duration: 1.35).repeatForever(autoreverses: true)) {
          breathing = true
        }
      case .error:
        withAnimation(nil) { errorPulse = true }
        await Task<Never, Never>.yield()
        guard !Task.isCancelled else { return }
        withAnimation(.easeOut(duration: 0.8)) { errorPulse = false }
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
