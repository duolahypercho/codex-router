import AppKit
import SwiftUI

private let islandBezel = Color(red: 0.004, green: 0.005, blue: 0.007)

private struct IslandActivitySession: Identifiable {
  let id: String
  let name: String
  let requests: [RouterActiveRequest]

  var agents: [RouterActiveRequest] {
    var seen = Set<String>()
    return requests.filter { request in
      seen.insert(request.threadId ?? request.id).inserted
    }
  }

  var latestStartedAt: Double {
    requests.map(\.startedAt).max() ?? 0
  }
}

@MainActor
final class IslandDisplayModel: ObservableObject {
  enum State: Equatable {
    case compact
    case peek
    case expanded
  }

  @Published private(set) var state: State = .compact
  @Published private(set) var activeRequestCount = 0

  var size: CGSize {
    switch state {
    case .compact: return CGSize(width: 320, height: 40)
    case .peek:
      let activityHeight = min(360, 126 + CGFloat(activeRequestCount) * 40)
      return CGSize(width: 404, height: activeRequestCount > 0 ? activityHeight : 148)
    case .expanded: return CGSize(width: 520, height: 372)
    }
  }

  func setState(_ next: State) {
    guard state != next else { return }
    state = next
  }

  func setActiveRequestCount(_ count: Int) {
    activeRequestCount = max(0, count)
  }
}

@MainActor
final class IslandWindowController {
  static let windowSize = CGSize(width: 720, height: 400)

  private let window: NSPanel
  private let store: RouterStore
  private let display = IslandDisplayModel()
  private var globalMouseMonitor: Any?
  private var localMouseMonitor: Any?
  private var initialTrackingTimer: Timer?
  private var screenObserver: NSObjectProtocol?
  private var trackingInstalled = false
  private let ownsOverlay: Bool

  // Only one process may draw the overlay. Nothing else enforces this, and two
  // aggravators made duplicate overlays easy to hit: a stale bundle at another
  // path can launch alongside the installed app, and a `swift run` debug binary
  // has no bundle identifier at all -- so it reads a different UserDefaults
  // domain and can never observe a preference set by the installed app. A user
  // who turned the Island off then watched an overlay stay on screen was
  // looking at that second process. Suppress the unbundled build outright, and
  // yield to an installed tray that is already running.
  private static func claimsOverlay() -> Bool {
    guard let identifier = Bundle.main.bundleIdentifier else { return false }
    let others = NSRunningApplication.runningApplications(withBundleIdentifier: identifier)
      .filter { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }
    return others.isEmpty
  }

  init(store: RouterStore) {
    self.store = store
    ownsOverlay = Self.claimsOverlay()
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
    window.contentView = nil
  }

  func setVisible(_ visible: Bool) {
    // A process that does not own the overlay still tears down on `false`, so a
    // window it somehow put up can never outlive the setting.
    if visible && ownsOverlay {
      installContentIfNeeded()
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
      window.contentView = nil
      removeMouseTracking()
      removeScreenObserver()
    }
  }

  deinit {
    if let globalMouseMonitor { NSEvent.removeMonitor(globalMouseMonitor) }
    if let localMouseMonitor { NSEvent.removeMonitor(localMouseMonitor) }
    if let screenObserver { NotificationCenter.default.removeObserver(screenObserver) }
    initialTrackingTimer?.invalidate()
  }

  private func installContentIfNeeded() {
    guard window.contentView == nil else { return }
    window.contentView = NSHostingView(
      rootView: IslandOverlayView(store: store, display: display)
        .frame(width: Self.windowSize.width, height: Self.windowSize.height, alignment: .top)
        .preferredColorScheme(.dark)
    )
  }

  private func removeMouseTracking() {
    if let globalMouseMonitor { NSEvent.removeMonitor(globalMouseMonitor) }
    if let localMouseMonitor { NSEvent.removeMonitor(localMouseMonitor) }
    globalMouseMonitor = nil
    localMouseMonitor = nil
    initialTrackingTimer?.invalidate()
    initialTrackingTimer = nil
    trackingInstalled = false
  }

  private func removeScreenObserver() {
    if let screenObserver { NotificationCenter.default.removeObserver(screenObserver) }
    screenObserver = nil
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
  @State private var selectedSessionID: String?

  var body: some View {
    VStack(spacing: 0) {
      ZStack {
        IslandSilhouette()
          .fill(islandBezel.opacity(0.998))
          .overlay {
            IslandSilhouette()
              .fill(
                LinearGradient(
                  colors: [Color.white.opacity(0.018), .clear, Color.white.opacity(0.008)],
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
    .onAppear { display.setActiveRequestCount(activeSessions.count) }
    .onChange(of: store.activeRequests.count) { count in
      display.setActiveRequestCount(activeSessions.count)
      if count == 0 { selectedSessionID = nil }
    }
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
      LiveOrb(state: store.activityState)
      Text(store.activityState.label)
        .font(.system(size: 10, weight: .semibold, design: .rounded))
        .foregroundStyle(store.activityState.tint)
        .fixedSize()
      Text("·")
        .foregroundStyle(routerMuted)
        .fixedSize()
      ProviderIcon(providerID: compactProviderID, size: 18)
      BouncingSessionName(text: compactSessionName, fontSize: 10.5, weight: .medium)
        .frame(maxWidth: .infinity)
        .layoutPriority(1)
      if !store.activeRequests.isEmpty {
        Label("\(activeSessions.count)", systemImage: "bubble.left.and.bubble.right.fill")
          .font(.system(size: 9.5, weight: .semibold, design: .rounded))
          .foregroundStyle(.white.opacity(0.72))
          .fixedSize()
          .help(RouterLanguage.isSimplifiedChinese
            ? "\(activeSessions.count) 个会话运行中"
            : "\(activeSessions.count) running \(activeSessions.count == 1 ? "chat" : "chats")")
      }
      if store.activeRequests.isEmpty {
        Text(compactUsageSummary)
          .font(.system(size: 10, weight: .medium, design: .monospaced))
          .foregroundStyle(.white.opacity(0.78))
          .lineLimit(1)
          .minimumScaleFactor(0.75)
      }
      if let weeklyRemainingPercent {
        VStack(alignment: .trailing, spacing: 0) {
          Text("\(Int(weeklyRemainingPercent.rounded()))%")
            .font(.system(size: 10, weight: .semibold, design: .monospaced))
            .foregroundStyle(.white.opacity(0.9))
            .monospacedDigit()
          Text(routerLocalized("WEEKLY LEFT"))
            .font(.system(size: 6.5, weight: .semibold, design: .monospaced))
            .foregroundStyle(routerMuted)
        }
        .fixedSize()
      }
    }
    .padding(.horizontal, 14)
  }

  @ViewBuilder
  private var peekContent: some View {
    if store.activeRequests.isEmpty {
      usagePeekContent
    } else {
      activityPeekContent
    }
  }

  private var usagePeekContent: some View {
    VStack(spacing: 9) {
      HStack(spacing: 9) {
        LiveOrb(state: store.activityState, count: store.activeChatCount)
        VStack(alignment: .leading, spacing: 1) {
          Text(store.activityState.label)
            .font(.system(size: 12, weight: .semibold, design: .rounded))
            .foregroundStyle(store.activityState.tint)
            .lineLimit(1)
          Text("\(peekTitle) · \(sourceLabel)")
            .font(.system(size: 9, weight: .medium, design: .rounded))
            .foregroundStyle(routerMuted)
            .lineLimit(1)
        }
        Spacer()
        HStack(spacing: 12) {
          IslandHeaderMetric(value: todayTokenValue, label: routerLocalized("TODAY TOKENS"))
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

  private var activityPeekContent: some View {
    VStack(spacing: 8) {
      HStack(spacing: 9) {
        LiveOrb(state: store.activityState)
        VStack(alignment: .leading, spacing: 1) {
          Text(store.activityState.label)
            .font(.system(size: 12, weight: .semibold, design: .rounded))
            .foregroundStyle(store.activityState.tint)
          Text(RouterLanguage.isSimplifiedChinese
            ? "\(activeSessions.count) 个会话运行中"
            : "\(activeSessions.count) \(activeSessions.count == 1 ? "CHAT" : "CHATS") RUNNING")
            .font(.system(size: 8, weight: .semibold, design: .monospaced))
            .foregroundStyle(routerMuted)
        }
        Spacer()
        HStack(spacing: 12) {
          IslandHeaderMetric(value: todayTokenValue, label: routerLocalized("TODAY TOKENS"))
          if let accountHeaderValue {
            IslandHeaderMetric(value: accountHeaderValue, label: accountHeaderLabel)
          }
        }
      }
      ScrollView(.vertical) {
        IslandSessionList(sessions: activeSessions, compact: true)
      }
      .scrollIndicators(.hidden)
      .frame(maxHeight: CGFloat(max(1, activeSessions.count)) * 40)

      HStack {
        Text(routerLocalized("DAILY USAGE"))
          .font(.system(size: 8, weight: .semibold, design: .monospaced))
          .foregroundStyle(routerMuted)
        Spacer()
        Text(routerLocalized("LAST 7 DAYS"))
          .font(.system(size: 8, weight: .semibold, design: .monospaced))
          .foregroundStyle(routerMuted)
      }

      IslandUsageLineChart(points: dailyGraphPoints, tint: graphTint, showsAxis: false)
        .id("\(store.selectedUsageProviderID)-daily-active-peek")
        .frame(height: 43)
    }
    .padding(.horizontal, 14)
    .padding(.top, 10)
    .padding(.bottom, 10)
  }

  private var expandedContent: some View {
    Group {
      if activeSessions.isEmpty {
        usageExpandedContent
      } else {
        sessionExpandedContent
      }
    }
  }

  private var usageExpandedContent: some View {
    VStack(spacing: 13) {
      HStack(spacing: 10) {
        LiveOrb(state: store.activityState, count: store.activeChatCount)
        VStack(alignment: .leading, spacing: 2) {
          Text(peekTitle)
            .font(.system(size: 15, weight: .semibold, design: .rounded))
          Text("\(store.activitySummaryLabel) · \(sourceLabel)")
            .font(.system(size: 9, weight: .medium, design: .rounded))
            .foregroundStyle(store.activityState.tint)
        }
        Spacer()
        Button(routerLocalized("Collapse")) { display.setState(.peek) }
        .buttonStyle(.plain)
        .font(.system(size: 9, weight: .medium, design: .rounded))
        .foregroundStyle(routerMuted)
      }

      HStack(spacing: 8) {
        MetricTile(
          title: routerLocalized("TODAY'S TOKENS"),
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
        Text(routerLocalized("DAILY TOKEN TREND"))
          .font(.system(size: 8, weight: .semibold, design: .monospaced))
          .tracking(0.8)
          .foregroundStyle(routerMuted)
        Spacer()
        Text(routerLocalized("LAST 7 DAYS"))
          .font(.system(size: 8, weight: .semibold, design: .monospaced))
          .tracking(0.6)
          .foregroundStyle(routerMuted)
      }

      IslandUsageLineChart(points: dailyGraphPoints, tint: graphTint)
        .id("\(store.selectedUsageProviderID)-daily-expanded")
        .frame(height: 78)

      HStack {
        Text(routerLocalized(store.hasConcurrentActivity ? "ACTIVE NOW" : "ACTIVE PROVIDER"))
          .font(.system(size: 8, weight: .semibold, design: .monospaced))
          .tracking(0.8)
          .foregroundStyle(routerMuted)
        Spacer()
        Text(store.hasConcurrentActivity
          ? (RouterLanguage.isSimplifiedChinese
            ? "\(store.activeChatCount) 个会话运行中"
            : "\(store.activeChatCount) chats running")
          : routerLocalized("Account and traffic are provider-scoped"))
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
          Text(routerLocalized(store.activityState == .generating ? "Live" : "Last used"))
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

  private var sessionExpandedContent: some View {
    VStack(spacing: 12) {
      HStack(spacing: 10) {
        if selectedSession != nil {
          Button {
            selectedSessionID = nil
          } label: {
            Image(systemName: "chevron.left")
          }
          .buttonStyle(.plain)
          .foregroundStyle(routerMuted)
        }
        LiveOrb(state: store.activityState, count: activeSessions.count)
        VStack(alignment: .leading, spacing: 2) {
          Text(selectedSession?.name ?? routerLocalized("Running chats"))
            .font(.system(size: 15, weight: .semibold, design: .rounded))
            .lineLimit(1)
          Text(selectedSession == nil
            ? (RouterLanguage.isSimplifiedChinese
              ? "\(activeSessions.count) 个会话运行中"
              : "\(activeSessions.count) \(activeSessions.count == 1 ? "chat" : "chats") running")
            : (RouterLanguage.isSimplifiedChinese
              ? "\(selectedSession?.agents.count ?? 0) 个已分配智能体"
              : "\(selectedSession?.agents.count ?? 0) assigned agents"))
            .font(.system(size: 9, weight: .medium, design: .rounded))
            .foregroundStyle(store.activityState.tint)
        }
        Spacer()
        if let weeklyRemainingPercent {
          IslandHeaderMetric(
            value: "\(Int(weeklyRemainingPercent.rounded()))%",
            label: routerLocalized("WEEKLY LEFT")
          )
        }
        Button(routerLocalized("Collapse")) { display.setState(.peek) }
          .buttonStyle(.plain)
          .font(.system(size: 9, weight: .medium, design: .rounded))
          .foregroundStyle(routerMuted)
      }

      Divider().overlay(Color.white.opacity(0.08))

      if let session = selectedSession {
        ScrollView(.vertical) {
          IslandAgentList(store: store, session: session)
        }
        .scrollIndicators(.hidden)
      } else {
        ScrollView(.vertical) {
          IslandSessionList(
            sessions: activeSessions,
            compact: false,
            onSelect: { selectedSessionID = $0 }
          )
        }
        .scrollIndicators(.hidden)
      }

      Spacer(minLength: 0)
    }
    .padding(.horizontal, 17)
    .padding(.top, 13)
    .padding(.bottom, 12)
  }

  private var glow: some View {
    StatusGlow(state: store.activityState)
      .id("\(store.activityState.rawValue)-\(store.activeChatCount)")
  }

  private var peekTitle: String {
    store.activeRequests.first.map(store.sessionName(for:))
      ?? store.activitySessionName
      ?? routerLocalized("Router overview")
  }

  private var compactProviderID: String {
    store.activeRequests.first?.provider ?? store.selectedUsageProviderID
  }

  private var compactSessionName: String {
    store.activeRequests.first.map(store.sessionName(for:))
      ?? store.activitySessionName
      ?? routerLocalized("Ready")
  }

  private var activeSessions: [IslandActivitySession] {
    let grouped = Dictionary(grouping: store.activeRequests) { request in
      request.sessionId ?? request.sessionName ?? "request-\(request.id)"
    }
    return grouped.map { id, requests in
      let fallback = requests.first.map(store.sessionName(for:)) ?? "Active session"
      let name = requests.compactMap(\.sessionName).first
        ?? (grouped.count == 1 ? store.activitySessionName : nil)
        ?? fallback
      return IslandActivitySession(id: id, name: name, requests: requests)
    }
    .sorted { $0.latestStartedAt > $1.latestStartedAt }
  }

  private var selectedSession: IslandActivitySession? {
    guard let selectedSessionID else { return nil }
    return activeSessions.first(where: { $0.id == selectedSessionID })
  }

  private var sourceLabel: String {
    let provider = store.selectedUsageProviderID
    if provider == "openai" { return routerLocalized("CHATGPT • NATIVE") }
    if provider == "grok-oauth" { return routerLocalized("XAI • OAUTH SESSION") }
    if provider == "grok-api" { return routerLocalized("XAI • METERED API") }
    if provider.hasSuffix("-api") || ["deepseek", "chutes"].contains(provider) {
      if RouterLanguage.isSimplifiedChinese { return "计量 API" }
      return "METERED API"
    }
    return routerLocalized("OAUTH ROUTE")
  }

  private var compactUsageSummary: String {
    RouterLanguage.isSimplifiedChinese ? "今天 \(todayTokenValue)" : "\(todayTokenValue) today"
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

  private var weeklyRemainingPercent: Double? {
    if store.selectedUsageUsesChatGPT {
      let windows = [store.accountUsage?.primary, store.accountUsage?.secondary].compactMap { $0 }
      guard let weekly = windows.first(where: { $0.durationLabel == "Weekly limit" }) else {
        return nil
      }
      return Double(max(0, min(100, weekly.remainingPercent)))
    }
    guard let weekly = store.selectedProviderUsage?.account.metrics.first(where: {
      $0.kind == "quota" && standardizedLimitLabel($0.label) == "Weekly limit"
    }), let remaining = weekly.remainingPercent else {
      return nil
    }
    return max(0, min(100, remaining))
  }

  private var accountUsageLabel: String {
    if store.selectedUsageUsesChatGPT {
      return routerLocalized(store.accountUsage?.primary?.durationLabel ?? "ChatGPT limit")
    }
    if let metric = store.selectedAccountMetric {
      return metric.kind == "quota"
        ? routerLocalized(standardizedLimitLabel(metric.label))
        : metric.label
    }
    return routerLocalized("Usage limit")
  }

  private var accountHeaderValue: String? {
    if let weeklyRemainingPercent { return "\(Int(weeklyRemainingPercent.rounded()))%" }
    if let quotaUsedPercent { return "\(Int(quotaUsedPercent.rounded()))%" }
    guard let metric = store.selectedAccountMetric, metric.kind == "balance" else { return nil }
    return formattedAccountMetric(metric)
  }

  private var accountHeaderLabel: String {
    if weeklyRemainingPercent != nil { return routerLocalized("WEEKLY LEFT") }
    if quotaUsedPercent != nil {
      let window = accountUsageLabel.replacingOccurrences(
        of: " limit",
        with: "",
        options: [.caseInsensitive]
      )
      return "\(window.uppercased()) \(routerLocalized("USED"))"
    }
    return accountUsageLabel.uppercased()
  }

  private var accountTileTitle: String {
    accountUsageLabel.uppercased()
  }

  private var accountTileValue: String {
    if let quotaUsedPercent {
      return RouterLanguage.isSimplifiedChinese
        ? "已使用 \(Int(quotaUsedPercent.rounded()))%"
        : "\(Int(quotaUsedPercent.rounded()))% used"
    }
    if let metric = store.selectedAccountMetric, metric.kind == "balance" {
      return formattedAccountMetric(metric)
    }
    return "—"
  }

  private var accountTileDetail: String {
    if let reset = store.selectedUsageResetDate { return usageResetCaption(reset) }
    if let detail = store.selectedAccountMetric?.detail, !detail.isEmpty { return detail }
    return quotaUsedPercent == nil
      ? routerLocalized("Not reported by provider")
      : routerLocalized("No reset reported")
  }

  private var tokenSourceDetail: String {
    store.selectedUsageUsesChatGPT
      ? routerLocalized("ChatGPT account usage")
      : routerLocalized("Measured by this router")
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
    .accessibilityLabel(routerLocalized("Daily token usage line chart"))
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
    return RouterLanguage.isSimplifiedChinese ? "\(date) · \(tokens) token" : "\(date) · \(tokens) tok"
  }
}


private struct ProviderIcon: View {
  let providerID: String
  let size: CGFloat

  var body: some View {
    Group {
      if let providerImage {
        Image(nsImage: providerImage)
          .resizable()
          .interpolation(.high)
          .scaledToFit()
      } else {
        Image(systemName: "cpu")
          .font(.system(size: size * 0.5, weight: .semibold))
          .foregroundStyle(routerMuted)
      }
    }
    .frame(width: size, height: size)
    .help(providerName)
    .accessibilityLabel(providerName)
  }

  private var providerImage: NSImage? {
    guard let assetName else { return nil }
    // Installed apps keep SwiftPM resources in the standard sealed resources
    // directory. Bundle.module remains the development fallback for swift run.
    let installedBundle = Bundle.main.resourceURL
      .map { $0.appendingPathComponent("ModelRouterTray_ModelRouterTray.bundle") }
      .flatMap(Bundle.init(url:))
    let resources = installedBundle ?? Bundle.module
    let url = resources.url(
      forResource: assetName,
      withExtension: assetExtension,
      subdirectory: "ProviderIcons"
    ) ?? resources.url(forResource: assetName, withExtension: assetExtension)
    return url.flatMap(NSImage.init(contentsOf:))
  }

  private var assetName: String? {
    if providerID == "openai" { return "openai" }
    if providerID.hasPrefix("grok") { return "grok" }
    if providerID.hasPrefix("kimi") { return "kimi" }
    if providerID == "deepseek" { return "deepseek" }
    if providerID == "anthropic-api" { return "anthropic" }
    if providerID.hasPrefix("commandcode") { return "commandcode" }
    if providerID == "github-copilot" { return "github-copilot" }
    if providerID == "chutes" { return "chutes" }
    if providerID == "opencode-free" { return "opencode-free" }
    if providerID == "kilo-free" { return "kilo-free" }
    return nil
  }

  private var assetExtension: String {
    ["github-copilot", "chutes", "opencode-free", "kilo-free"].contains(providerID) ? "svg" : "png"
  }

  private var providerName: String {
    if providerID == "openai" { return "ChatGPT" }
    if providerID.hasPrefix("grok") { return "Grok" }
    if providerID.hasPrefix("kimi") { return "Kimi" }
    if providerID == "deepseek" { return "DeepSeek" }
    if providerID == "anthropic-api" { return "Anthropic" }
    if providerID.hasPrefix("zai-") { return "GLM" }
    if providerID == "qwen-plan" { return "Qwen" }
    if providerID == "ollama-cloud" { return "Ollama" }
    if providerID.hasPrefix("commandcode") { return "Command Code" }
    if providerID == "github-copilot" { return "GitHub Copilot" }
    if providerID == "clinepass" { return "ClinePass" }
    if providerID == "chutes" { return "Chutes" }
    if providerID == "opencode-free" { return "OpenCode Free" }
    if providerID == "kilo-free" { return "Kilo Free" }
    return routerLocalized("Model provider")
  }
}

private struct SessionTextWidthKey: PreferenceKey {
  static var defaultValue: CGFloat = 0
  static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
    value = max(value, nextValue())
  }
}

private struct BouncingSessionName: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let text: String
  let fontSize: CGFloat
  let weight: Font.Weight

  @State private var containerWidth: CGFloat = 0
  @State private var textWidth: CGFloat = 0
  @State private var offset: CGFloat = 0
  @State private var animationTask: Task<Void, Never>?

  var body: some View {
    GeometryReader { geometry in
      Text(text)
        .font(.system(size: fontSize, weight: weight, design: .rounded))
        .foregroundStyle(.white.opacity(0.92))
        .fixedSize(horizontal: true, vertical: false)
        .background {
          GeometryReader { textGeometry in
            Color.clear.preference(key: SessionTextWidthKey.self, value: textGeometry.size.width)
          }
        }
        .offset(x: offset)
        .frame(maxWidth: .infinity, alignment: .leading)
        .onAppear { updateContainerWidth(geometry.size.width) }
        .onChange(of: geometry.size.width) { updateContainerWidth($0) }
    }
    .frame(height: max(14, fontSize + 4))
    .clipped()
    .onPreferenceChange(SessionTextWidthKey.self) { width in
      textWidth = width
      restartAnimation()
    }
    .onChange(of: text) { _ in restartAnimation() }
    .onChange(of: reduceMotion) { _ in restartAnimation() }
    .onDisappear { animationTask?.cancel() }
    .accessibilityLabel(text)
  }

  private func updateContainerWidth(_ width: CGFloat) {
    guard abs(containerWidth - width) > 0.5 else { return }
    containerWidth = width
    restartAnimation()
  }

  private func restartAnimation() {
    animationTask?.cancel()
    withAnimation(nil) { offset = 0 }
    let overflow = max(0, textWidth - containerWidth)
    guard !reduceMotion, containerWidth > 0, overflow > 2 else { return }
    animationTask = Task { @MainActor in
      try? await Task.sleep(nanoseconds: 850_000_000)
      guard !Task.isCancelled else { return }
      let travelDuration = max(2.8, Double(overflow / 18))
      while !Task.isCancelled {
        withAnimation(.easeInOut(duration: travelDuration)) { offset = -overflow }
        try? await Task.sleep(nanoseconds: UInt64((travelDuration + 0.7) * 1_000_000_000))
        guard !Task.isCancelled else { return }
        withAnimation(.easeInOut(duration: travelDuration)) { offset = 0 }
        try? await Task.sleep(nanoseconds: UInt64((travelDuration + 0.7) * 1_000_000_000))
      }
    }
  }
}

private struct IslandSessionList: View {
  let sessions: [IslandActivitySession]
  let compact: Bool
  var onSelect: ((String) -> Void)?

  init(
    sessions: [IslandActivitySession],
    compact: Bool,
    onSelect: ((String) -> Void)? = nil
  ) {
    self.sessions = sessions
    self.compact = compact
    self.onSelect = onSelect
  }

  var body: some View {
    VStack(spacing: compact ? 5 : 7) {
      ForEach(sessions) { session in
        Group {
          if let onSelect {
            Button { onSelect(session.id) } label: { row(session) }
              .buttonStyle(.plain)
          } else {
            row(session)
          }
        }
      }
    }
  }

  private func row(_ session: IslandActivitySession) -> some View {
    HStack(spacing: 9) {
      ProviderIcon(providerID: session.requests.first?.provider ?? "openai", size: compact ? 22 : 26)
      VStack(alignment: .leading, spacing: 2) {
        Text(session.name)
          .font(.system(size: compact ? 10.5 : 11.5, weight: .semibold, design: .rounded))
          .foregroundStyle(.white.opacity(0.94))
          .lineLimit(1)
        Text(
          RouterLanguage.isSimplifiedChinese
            ? "\(session.agents.count) 个代理"
            : "\(session.agents.count) \(session.agents.count == 1 ? "agent" : "agents")"
        )
          .font(.system(size: 8.5, weight: .medium, design: .monospaced))
          .foregroundStyle(routerMuted)
      }
      Spacer()
      if !compact {
        Text(shortModelSummary(session))
          .font(.system(size: 8.5, weight: .medium, design: .rounded))
          .foregroundStyle(routerYellow.opacity(0.9))
          .lineLimit(1)
        Image(systemName: "chevron.right")
          .font(.system(size: 8, weight: .bold))
          .foregroundStyle(routerMuted)
      }
    }
    .padding(.horizontal, compact ? 8 : 11)
    .padding(.vertical, compact ? 5 : 9)
    .frame(maxWidth: .infinity, alignment: .leading)
    .contentShape(Rectangle())
    .background(Color.white.opacity(0.038), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    .overlay {
      RoundedRectangle(cornerRadius: 8, style: .continuous)
        .stroke(Color.white.opacity(0.055), lineWidth: 0.5)
    }
  }

  private func shortModelSummary(_ session: IslandActivitySession) -> String {
    let models = Array(Set(session.agents.compactMap(\.model))).sorted()
    guard let first = models.first else { return routerLocalized("Active") }
    let short = first.split(separator: "/").last.map(String.init) ?? first
    return models.count == 1 ? short : "\(short) +\(models.count - 1)"
  }
}

private struct IslandAgentList: View {
  @ObservedObject var store: RouterStore
  let session: IslandActivitySession

  var body: some View {
    VStack(spacing: 7) {
      ForEach(session.agents) { request in
        HStack(spacing: 10) {
          ProviderIcon(providerID: request.provider, size: 24)
          VStack(alignment: .leading, spacing: 2) {
            Text(agentLabel(request))
              .font(.system(size: 11, weight: .semibold, design: .rounded))
              .foregroundStyle(.white.opacity(0.94))
              .lineLimit(1)
            Text(store.modelLabel(for: request))
              .font(.system(size: 8.5, weight: .medium, design: .monospaced))
              .foregroundStyle(routerMuted)
              .lineLimit(1)
          }
          Spacer()
          TimelineView(.periodic(from: .now, by: 1)) { context in
            Text(elapsedLabel(for: request, now: context.date))
              .font(.system(size: 9, weight: .medium, design: .rounded))
              .foregroundStyle(routerYellow.opacity(0.95))
              .monospacedDigit()
          }
        }
        .padding(.horizontal, 11)
        .padding(.vertical, 9)
        .background(Color.white.opacity(0.038), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay {
          RoundedRectangle(cornerRadius: 8, style: .continuous)
            .stroke(Color.white.opacity(0.055), lineWidth: 0.5)
        }
      }
    }
  }

  private func agentLabel(_ request: RouterActiveRequest) -> String {
    if let name = request.agentName, !name.isEmpty {
      return name.replacingOccurrences(of: "_", with: " ")
    }
    if let nickname = request.agentNickname, !nickname.isEmpty { return nickname }
    return request.isSubagent == true ? "Agent" : "Primary"
  }

  private func elapsedLabel(for request: RouterActiveRequest, now: Date) -> String {
    let started = Date(timeIntervalSince1970: request.startedAt / 1000)
    let seconds = max(0, Int(now.timeIntervalSince(started)))
    if seconds < 60 { return "\(seconds)s" }
    return "\(seconds / 60)m \(seconds % 60)s"
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
          ProviderIcon(providerID: request.provider, size: compact ? 22 : 24)
          BouncingSessionName(
            text: store.sessionName(for: request),
            fontSize: compact ? 10.5 : 11,
            weight: .semibold
          )
          .frame(maxWidth: .infinity)
          TimelineView(.periodic(from: .now, by: 1)) { context in
            let elapsed = elapsedLabel(for: request, now: context.date)
            Text(RouterLanguage.isSimplifiedChinese
              ? "思考中 · \(elapsed)"
              : "Thinking · \(elapsed)")
              .font(.system(size: compact ? 8.5 : 9, weight: .medium, design: .rounded))
              .foregroundStyle(routerYellow.opacity(0.95))
              .monospacedDigit()
              .fixedSize()
          }
        }
        .padding(.horizontal, compact ? 8 : 10)
        .padding(.vertical, compact ? 5 : 7)
        .background(Color.white.opacity(0.038), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
        .overlay {
          RoundedRectangle(cornerRadius: 7, style: .continuous)
            .stroke(Color.white.opacity(0.055), lineWidth: 0.5)
        }
      }
      if store.activeRequests.count > limit {
        Text(RouterLanguage.isSimplifiedChinese
          ? "+\(store.activeRequests.count - limit) 个更多"
          : "+\(store.activeRequests.count - limit) more")
          .font(.system(size: 9, weight: .medium, design: .rounded))
          .foregroundStyle(routerMuted)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
  }

  private func elapsedLabel(for request: RouterActiveRequest, now: Date) -> String {
    let started = Date(timeIntervalSince1970: request.startedAt / 1000)
    let seconds = max(0, Int(now.timeIntervalSince(started)))
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
  @State private var effectTask: Task<Void, Never>?

  var body: some View {
    ZStack(alignment: .topTrailing) {
      Group {
        if state == .idle || state == .generating || state == .error {
          ThinkingOrbView(
            mode: orbMode,
            reduceMotion: reduceMotion,
            size: 18
          )
            .frame(width: 18, height: 18)
        } else {
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
              .scaleEffect(coreScale)
              .opacity(coreOpacity)
              .shadow(
                color: state.tint.opacity(pulsing ? 0.42 : 0.16),
                radius: pulsing ? 3.5 : 1.2
              )
          }
        }
      }
      .frame(width: 18, height: 18)

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
    .onDisappear { effectTask?.cancel() }
  }

  private var orbMode: ThinkingOrbMode {
    switch state {
    case .generating: return .composing
    case .error: return .solving
    case .idle, .starting: return .shaping
    }
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

  private var coreScale: CGFloat {
    if reduceMotion { return 1 }
    switch state {
    case .idle:
      return pulsing ? 1.10 : 0.92
    case .starting, .generating:
      return pulsing ? 1.16 : 0.88
    case .error:
      return pulsing ? 1.18 : 1
    }
  }

  private var coreOpacity: Double {
    if reduceMotion { return 1 }
    if state == .idle { return pulsing ? 1 : 0.76 }
    return pulsing ? 1 : 0.84
  }

  private func animate() {
    effectTask?.cancel()
    withAnimation(nil) {
      pulsing = false
      rippling = false
    }
    // ThinkingOrbView owns animation for idle, generating, and error. These
    // state values only affect the fallback status-dot branch used at startup.
    guard !reduceMotion, state == .starting else { return }

    withAnimation(.easeInOut(duration: 1.35).repeatForever(autoreverses: true)) {
      pulsing = true
    }
    withAnimation(.easeOut(duration: 1.9).repeatForever(autoreverses: false)) {
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

@MainActor
final class DesktopPanelWindowController {
  static let panelSize = CGSize(width: 340, height: 432)
  private static let frameName = "ModelRouterTray.desktopPanel"
  private let window: NSPanel
  private let store: RouterStore

  init(store: RouterStore) {
    self.store = store
    window = NSPanel(
      contentRect: NSRect(origin: .zero, size: Self.panelSize),
      styleMask: [.borderless, .nonactivatingPanel, .fullSizeContentView],
      backing: .buffered,
      defer: false
    )
    window.isOpaque = false
    window.backgroundColor = .clear
    window.hasShadow = true
    // Sit just above the desktop icons so the panel behaves like a widget:
    // always readable on the desktop, never covering application windows.
    window.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopIconWindow)) + 1)
    window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
    window.isMovable = true
    window.isMovableByWindowBackground = true
    window.hidesOnDeactivate = false
    window.contentView = nil
    window.setFrameAutosaveName(Self.frameName)
  }

  func setVisible(_ visible: Bool) {
    if visible {
      installContentIfNeeded()
      if !window.setFrameUsingName(Self.frameName), let screen = NSScreen.main {
        let frame = screen.visibleFrame
        window.setFrameOrigin(NSPoint(
          x: frame.maxX - Self.panelSize.width - 24,
          y: frame.maxY - Self.panelSize.height - 24
        ))
      }
      window.orderFrontRegardless()
    } else {
      window.orderOut(nil)
      window.contentView = nil
    }
  }

  private func installContentIfNeeded() {
    guard window.contentView == nil else { return }
    window.contentView = NSHostingView(
      rootView: DesktopPanelView(store: store)
        .frame(width: Self.panelSize.width, height: Self.panelSize.height)
        .preferredColorScheme(.dark)
    )
  }
}

private struct DesktopPanelView: View {
  @ObservedObject var store: RouterStore

  var body: some View {
    VStack(alignment: .leading, spacing: 11) {
      HStack(spacing: 10) {
        LiveOrb(state: store.activityState, count: store.activeChatCount)
        VStack(alignment: .leading, spacing: 2) {
          Text(store.activityState.label)
            .font(.system(size: 14, weight: .semibold, design: .rounded))
          Text(store.activitySummaryLabel)
            .font(.system(size: 9, weight: .medium, design: .rounded))
            .foregroundStyle(store.activityState.tint)
            .lineLimit(1)
        }
        Spacer()
        Text(routerLocalized("ROUTER"))
          .font(.system(size: 8, weight: .bold, design: .monospaced))
          .tracking(1.1)
          .foregroundStyle(routerMuted)
      }

      if store.hasConcurrentActivity {
        ActiveRequestList(store: store, limit: 3, compact: true)
      }

      Text(routerLocalized("QUOTAS"))
        .font(.system(size: 8, weight: .semibold, design: .monospaced))
        .tracking(0.8)
        .foregroundStyle(routerMuted)

      if store.desktopQuotaRows.isEmpty {
        Text(routerLocalized("Connect a provider to see its quota here."))
          .font(.system(size: 10, design: .rounded))
          .foregroundStyle(routerMuted)
      } else {
        ScrollView(.vertical, showsIndicators: false) {
          VStack(spacing: 8) {
            ForEach(store.desktopQuotaRows) { row in
              DesktopQuotaBarRow(row: row)
            }
          }
        }
        .frame(maxHeight: 190)
      }

      Spacer(minLength: 0)

      HStack(alignment: .firstTextBaseline) {
        Text(routerLocalized("DAILY TOKENS"))
          .font(.system(size: 8, weight: .semibold, design: .monospaced))
          .tracking(0.8)
          .foregroundStyle(routerMuted)
        Spacer()
        Text(routerLocalized("LAST 7 DAYS"))
          .font(.system(size: 8, weight: .semibold, design: .monospaced))
          .tracking(0.6)
          .foregroundStyle(routerMuted)
      }
      IslandUsageLineChart(points: store.dailyUsage(days: 7), tint: routerAccent)
        .frame(height: 54)
    }
    .padding(16)
    .background(
      RoundedRectangle(cornerRadius: 20, style: .continuous)
        .fill(islandBezel.opacity(0.97))
    )
    .overlay(
      RoundedRectangle(cornerRadius: 20, style: .continuous)
        .stroke(Color.white.opacity(0.09), lineWidth: 0.8)
    )
  }
}

private struct DesktopQuotaBarRow: View {
  let row: DesktopQuotaRow

  private var tint: Color {
    if row.usedPercent >= 90 { return routerRed }
    if row.usedPercent >= 70 { return routerYellow }
    return routerMint
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      HStack(spacing: 6) {
        ProviderIcon(providerID: row.providerID, size: 14)
        Text("\(row.providerName) · \(row.label)")
          .font(.system(size: 10, weight: .medium, design: .rounded))
          .lineLimit(1)
        Spacer()
        if let resetAt = row.resetAt {
          Text(desktopResetLabel(resetAt))
            .font(.system(size: 8, design: .rounded))
            .foregroundStyle(routerMuted)
        }
        Text("\(Int(row.usedPercent.rounded()))%")
          .font(.system(size: 10, weight: .semibold, design: .rounded))
          .monospacedDigit()
          .foregroundStyle(tint)
      }
      GeometryReader { geometry in
        ZStack(alignment: .leading) {
          Capsule().fill(Color.white.opacity(0.08))
          Capsule()
            .fill(tint)
            .frame(width: max(3, geometry.size.width * min(1, row.usedPercent / 100)))
        }
      }
      .frame(height: 4)
    }
  }
}

private func desktopResetLabel(_ epoch: TimeInterval) -> String {
  let seconds = epoch - Date().timeIntervalSince1970
  if seconds <= 0 { return routerLocalized("resets soon") }
  let minutes = Int(seconds / 60)
  if minutes < 60 {
    return RouterLanguage.isSimplifiedChinese
      ? "将在 \(minutes) 分钟后重置"
      : "resets in \(minutes)m"
  }
  let hours = minutes / 60
  if hours < 24 {
    return RouterLanguage.isSimplifiedChinese
      ? "将在 \(hours) 小时后重置"
      : "resets in \(hours)h"
  }
  return RouterLanguage.isSimplifiedChinese
    ? "将在 \(hours / 24) 天 \(hours % 24) 小时后重置"
    : "resets in \(hours / 24)d \(hours % 24)h"
}
