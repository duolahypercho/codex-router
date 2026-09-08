import AppIntents
import AppKit
import OSLog
import SwiftUI
import WidgetKit

private func widgetColor(light: NSColor, dark: NSColor) -> Color {
  Color(nsColor: NSColor(name: nil) { appearance in
    appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
  })
}

private let widgetAccent = widgetColor(
  light: NSColor(red: 0.31, green: 0.44, blue: 0.68, alpha: 1),
  dark: NSColor(red: 0.57, green: 0.68, blue: 0.94, alpha: 1)
)
private let widgetHealthy = widgetColor(
  light: NSColor(red: 0.09, green: 0.52, blue: 0.28, alpha: 1),
  dark: NSColor(red: 0.39, green: 0.74, blue: 0.51, alpha: 1)
)
private let widgetWarning = widgetColor(
  light: NSColor(red: 0.60, green: 0.41, blue: 0.09, alpha: 1),
  dark: NSColor(red: 0.84, green: 0.66, blue: 0.34, alpha: 1)
)
private let widgetCritical = widgetColor(
  light: NSColor(red: 0.65, green: 0.25, blue: 0.25, alpha: 1),
  dark: NSColor(red: 0.84, green: 0.56, blue: 0.56, alpha: 1)
)

enum RouterWidgetDestination: String {
  case usage
  case usageResets = "usage-resets"

  func url(sourceID: String? = nil) -> URL {
    var components = URLComponents()
    components.scheme = "codex-router"
    components.host = "control-center"
    components.path = "/\(rawValue)"
    if let sourceID, sourceID.range(of: #"^[a-z0-9][a-z0-9-]{0,63}$"#, options: .regularExpression) != nil {
      components.queryItems = [URLQueryItem(name: "source", value: sourceID)]
    }
    return components.url!
  }
}

struct RouterUsageSourceEntity: AppEntity, Hashable {
  static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Usage Source")
  static var defaultQuery = RouterUsageSourceQuery()

  let id: String
  let name: String

  var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(title: "\(name)")
  }

  static let codex = RouterUsageSourceEntity(
    id: RouterWidgetSnapshot.defaultUsageSourceID,
    name: "Codex"
  )
}

struct RouterUsageSourceQuery: EntityQuery {
  func entities(for identifiers: [RouterUsageSourceEntity.ID]) async throws -> [RouterUsageSourceEntity] {
    let wanted = Set(identifiers)
    return Self.availableEntities().filter { wanted.contains($0.id) }
  }

  func suggestedEntities() async throws -> [RouterUsageSourceEntity] {
    Self.availableEntities()
  }

  func defaultResult() async -> RouterUsageSourceEntity? {
    Self.availableEntities().first(where: {
      $0.id == RouterWidgetSnapshot.defaultUsageSourceID
    }) ?? .codex
  }

  static func availableEntities(snapshot: RouterWidgetSnapshot? = RouterUsageProvider.readSnapshot())
    -> [RouterUsageSourceEntity] {
    let entities = snapshot?.availableUsageSources.map {
      RouterUsageSourceEntity(id: $0.id, name: $0.name)
    } ?? []
    if entities.contains(where: { $0.id == RouterWidgetSnapshot.defaultUsageSourceID }) {
      return entities
    }
    return [.codex] + entities
  }
}

struct RouterUsageConfigurationIntent: WidgetConfigurationIntent {
  static var title: LocalizedStringResource = "Usage Source"
  static var description = IntentDescription("Choose which connected usage source this widget shows.")

  @Parameter(title: "Usage Source")
  var usageSource: RouterUsageSourceEntity?

  init() {
    usageSource = .codex
  }

  var sourceID: String {
    usageSource?.id ?? RouterWidgetSnapshot.defaultUsageSourceID
  }
}

struct RouterUsageEntry: TimelineEntry {
  let date: Date
  let snapshot: RouterWidgetSnapshot?
  let sourceID: String

  init(
    date: Date,
    snapshot: RouterWidgetSnapshot?,
    sourceID: String = RouterWidgetSnapshot.defaultUsageSourceID
  ) {
    self.date = date
    self.snapshot = snapshot
    self.sourceID = sourceID
  }

  var effectiveSourceID: String {
    snapshot?.usageSource(id: sourceID).id ?? sourceID
  }
}

struct RouterUsageProvider: AppIntentTimelineProvider {
  private static let logger = Logger(
    subsystem: "io.github.codex-router.tray.widget",
    category: "snapshot"
  )

  func placeholder(in context: Context) -> RouterUsageEntry {
    RouterUsageEntry(date: .now, snapshot: .preview)
  }

  func snapshot(
    for configuration: RouterUsageConfigurationIntent,
    in context: Context
  ) async -> RouterUsageEntry {
    RouterUsageEntry(
      date: .now,
      snapshot: Self.snapshotPayload(stored: Self.readSnapshot(), isPreview: context.isPreview),
      sourceID: configuration.sourceID
    )
  }

  func timeline(
    for configuration: RouterUsageConfigurationIntent,
    in context: Context
  ) async -> Timeline<RouterUsageEntry> {
    let now = Date()
    return Timeline(
      entries: [RouterUsageEntry(
        date: now,
        snapshot: Self.readSnapshot(),
        sourceID: configuration.sourceID
      )],
      policy: .after(now.addingTimeInterval(15 * 60))
    )
  }

  static func readSnapshot() -> RouterWidgetSnapshot? {
    let rawMode = Bundle.main.object(
      forInfoDictionaryKey: RouterWidgetSnapshot.storageModeInfoKey
    ) as? String
    guard let mode = rawMode.flatMap(RouterWidgetStorageMode.init(rawValue:)) else {
      Self.logger.error("Widget storage mode is missing or unexpected")
      return nil
    }
    let configured = Bundle.main.object(forInfoDictionaryKey: "ModelRouterWidgetAppGroup") as? String
    let group = configured?.trimmingCharacters(in: .whitespacesAndNewlines)
    if mode == .appGroup && group != RouterWidgetSnapshot.defaultAppGroup {
      Self.logger.error("Widget App Group is missing or unexpected")
      return nil
    }

    let registeredContainer = mode == .appGroup
      ? group.flatMap(FileManager.default.containerURL(forSecurityApplicationGroupIdentifier:))
      : nil
    guard let url = Self.snapshotURL(
      mode: mode,
      configuredGroup: group,
      registeredContainer: registeredContainer,
      actualHomeDirectory: RouterWidgetSnapshotStore.actualUserHomeDirectory
    ) else {
      Self.logger.error("No widget snapshot location was available")
      return nil
    }
    do {
      let data = try RouterWidgetSnapshotStore.readData(at: url)
      if let snapshot = Self.decodeSnapshot(data) { return snapshot }
      Self.logger.error("Snapshot has an unsupported schema or invalid payload")
    } catch {
      Self.logger.error(
        "Could not read the widget snapshot: \(error.localizedDescription, privacy: .public)"
      )
    }
    return nil
  }

  static func snapshotURL(
    mode: RouterWidgetStorageMode,
    configuredGroup: String?,
    registeredContainer: URL?,
    actualHomeDirectory: URL?
  ) -> URL? {
    RouterWidgetSnapshotStore.snapshotURL(
      mode: mode,
      configuredAppGroup: configuredGroup,
      registeredContainer: registeredContainer,
      localHomeDirectory: actualHomeDirectory
    )
  }

  static func decodeSnapshot(_ data: Data) -> RouterWidgetSnapshot? {
    RouterWidgetSnapshotStore.decode(data)
  }

  static func snapshotPayload(
    stored: RouterWidgetSnapshot?,
    isPreview: Bool
  ) -> RouterWidgetSnapshot? {
    stored ?? (isPreview ? .preview : nil)
  }
}

struct RouterUsageWidget: Widget {
  var body: some WidgetConfiguration {
    AppIntentConfiguration(
      kind: RouterWidgetSnapshot.kind,
      intent: RouterUsageConfigurationIntent.self,
      provider: RouterUsageProvider()
    ) { entry in
      RouterUsageWidgetView(entry: entry)
        .containerBackground(for: .widget) { RouterWidgetBackground() }
        .widgetURL(RouterWidgetDestination.usage.url(sourceID: entry.effectiveSourceID))
    }
    .configurationDisplayName("Codex Router Usage")
    .description("Track cumulative token usage for any connected source.")
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}

struct RouterResetWidget: Widget {
  var body: some WidgetConfiguration {
    AppIntentConfiguration(
      kind: RouterWidgetSnapshot.resetKind,
      intent: RouterUsageConfigurationIntent.self,
      provider: RouterUsageProvider()
    ) { entry in
      RouterResetWidgetView(entry: entry)
        .containerBackground(for: .widget) { RouterWidgetBackground() }
        .widgetURL(RouterWidgetDestination.usageResets.url(sourceID: entry.effectiveSourceID))
    }
    .configurationDisplayName("Codex Router Reset")
    .description("See when the selected provider quota resets.")
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}

struct RouterUsageWidgetView: View {
  @Environment(\.widgetFamily) private var environmentFamily
  let entry: RouterUsageEntry
  private let familyOverride: WidgetFamily?

  init(entry: RouterUsageEntry, familyOverride: WidgetFamily? = nil) {
    self.entry = entry
    self.familyOverride = familyOverride
  }

  private var family: WidgetFamily { familyOverride ?? environmentFamily }

  var body: some View {
    Group {
      if let snapshot = entry.snapshot {
        if snapshot.generatedAt.timeIntervalSince(entry.date) < -45 * 60 {
          stale
        } else if family == .systemSmall {
          small(snapshot, source: snapshot.usageSource(id: entry.sourceID))
        } else {
          medium(snapshot, source: snapshot.usageSource(id: entry.sourceID))
        }
      } else {
        emptyState
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .foregroundStyle(.primary)
  }

  private func small(_ snapshot: RouterWidgetSnapshot, source: RouterWidgetUsageSource) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      WidgetHeader(snapshot: snapshot, compact: true)
      Spacer(minLength: 9)
      Text("Today · \(source.name) · UTC")
        .font(.caption2.weight(.semibold))
        .textCase(.uppercase)
        .tracking(0.35)
        .foregroundStyle(.secondary)
      Text(Self.fullTokens(source.todayTokens))
        .font(.system(size: 27, weight: .semibold, design: .rounded))
        .tracking(-0.6)
        .monospacedDigit()
        .lineLimit(1)
        .minimumScaleFactor(0.64)
      Text(Self.todayTokenLabel(for: source))
        .font(.caption2)
        .foregroundStyle(.secondary)
        .lineLimit(2)
        .minimumScaleFactor(0.8)
        .fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 7)
      cumulativeLabel(source, compact: true)
      RouterWidgetCumulativeLineChart(points: source.cumulativeDaily)
        .frame(height: 31)
    }
  }

  private func medium(_ snapshot: RouterWidgetSnapshot, source: RouterWidgetUsageSource) -> some View {
    let quotas = snapshot.quotas(for: source.id)
    return VStack(alignment: .leading, spacing: 10) {
      WidgetHeader(snapshot: snapshot)
      HStack(alignment: .top, spacing: 15) {
        VStack(alignment: .leading, spacing: 1) {
          Text("Today · \(source.name) · UTC")
            .font(.caption2.weight(.semibold))
            .textCase(.uppercase)
            .tracking(0.35)
            .foregroundStyle(.secondary)
            .lineLimit(1)
          Text(Self.fullTokens(source.todayTokens))
            .font(.system(size: 28, weight: .semibold, design: .rounded))
            .tracking(-0.6)
            .monospacedDigit()
            .lineLimit(1)
            .minimumScaleFactor(0.64)
          Text(Self.todayTokenLabel(for: source))
            .font(.caption2)
            .foregroundStyle(.secondary)
            .lineLimit(2)
            .minimumScaleFactor(0.8)
            .fixedSize(horizontal: false, vertical: true)
          Spacer(minLength: 4)
          cumulativeLabel(source)
          RouterWidgetCumulativeLineChart(points: source.cumulativeDaily)
            .frame(height: 32)
            .padding(.horizontal, 2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)

        Divider()

        VStack(alignment: .leading, spacing: 8) {
          Text("Limits")
            .font(.caption2.weight(.semibold))
            .textCase(.uppercase)
            .tracking(0.35)
            .foregroundStyle(.secondary)
          if quotas.isEmpty {
            Text("No quota available")
              .font(.caption)
              .foregroundStyle(.secondary)
              .frame(maxWidth: .infinity, alignment: .leading)
          } else {
            ForEach(quotas.prefix(2)) { quota in
              RouterWidgetQuotaRow(quota: quota, compact: false, now: entry.date)
            }
          }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
      }
    }
  }

  private func cumulativeLabel(
    _ source: RouterWidgetUsageSource,
    compact: Bool = false
  ) -> some View {
    HStack(spacing: 4) {
      Text(compact ? "7D cumulative" : "7-day cumulative")
        .lineLimit(1)
        .minimumScaleFactor(0.8)
      Spacer(minLength: 4)
      Text(Self.compactTokens(source.periodTokens))
        .monospacedDigit()
    }
    .font(.caption2.weight(.medium))
    .textCase(.uppercase)
    .tracking(0.25)
    .foregroundStyle(.secondary)
  }

  private var stale: some View {
    WidgetUnavailableState(
      icon: "clock.badge.exclamationmark",
      title: "Usage snapshot is stale",
      message: "Open Codex Router to refresh usage.",
      tint: widgetWarning,
      compact: family == .systemSmall
    )
  }

  private var emptyState: some View {
    WidgetUnavailableState(
      icon: "chart.xyaxis.line",
      title: "Waiting for router data",
      message: "Open Codex Router once to publish usage.",
      tint: widgetAccent,
      compact: family == .systemSmall
    )
  }

  static func fullTokens(_ value: Int64) -> String {
    max(0, value).formatted(.number.grouping(.automatic))
  }

  static func compactTokens(_ value: Int64) -> String {
    let safe = Double(max(0, value))
    if safe >= 1_000_000_000 { return String(format: "%.1fB", safe / 1_000_000_000) }
    if safe >= 1_000_000 { return String(format: "%.1fM", safe / 1_000_000) }
    if safe >= 1_000 { return String(format: "%.1fK", safe / 1_000) }
    return String(Int64(safe))
  }

  static func todayTokenLabel(for source: RouterWidgetUsageSource) -> String {
    // A router-only day is this Mac's traffic, not the account total, and
    // saying so is the whole point of carrying provenance into the snapshot.
    // Without it a lagging account stream reads as a real zero.
    if source.todayIsRouterFallback { return "this Mac · account not reported yet" }
    return source.id == RouterWidgetSnapshot.defaultUsageSourceID ? "account tokens" : "tokens routed"
  }
}

struct RouterResetWidgetView: View {
  @Environment(\.widgetFamily) private var environmentFamily
  let entry: RouterUsageEntry
  private let familyOverride: WidgetFamily?

  init(entry: RouterUsageEntry, familyOverride: WidgetFamily? = nil) {
    self.entry = entry
    self.familyOverride = familyOverride
  }

  private var family: WidgetFamily { familyOverride ?? environmentFamily }

  var body: some View {
    Group {
      if let snapshot = entry.snapshot {
        let source = snapshot.usageSource(id: entry.sourceID)
        let resets = snapshot.quotas(for: source.id)
          .filter { $0.resetAt != nil }
          .sorted { ($0.resetAt ?? .distantFuture) < ($1.resetAt ?? .distantFuture) }
        if snapshot.generatedAt.timeIntervalSince(entry.date) < -45 * 60 {
          unavailable(icon: "clock.badge.exclamationmark", title: "Reset data is stale")
        } else if resets.isEmpty {
          unavailable(icon: "clock.arrow.circlepath", title: "No reset available")
        } else if family == .systemSmall {
          small(source: source, quota: resets[0])
        } else {
          medium(source: source, quotas: Array(resets.prefix(2)))
        }
      } else {
        unavailable(icon: "clock.arrow.circlepath", title: "Waiting for reset data")
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .foregroundStyle(.primary)
  }

  private func small(source: RouterWidgetUsageSource, quota: RouterWidgetQuota) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      WidgetHeader(snapshot: entry.snapshot, compact: true, section: "Reset")
      Spacer(minLength: 10)
      Text("Next · \(quota.label)")
        .font(.caption2.weight(.semibold))
        .textCase(.uppercase)
        .tracking(0.35)
        .foregroundStyle(.secondary)
        .lineLimit(1)
      Text(Self.countdown(to: quota.resetAt, now: entry.date))
        .font(.system(size: 27, weight: .semibold, design: .rounded))
        .tracking(-0.5)
        .monospacedDigit()
        .lineLimit(1)
        .minimumScaleFactor(0.65)
      Text("until reset · \(source.name)")
        .font(.caption2)
        .foregroundStyle(.secondary)
        .lineLimit(1)
      Spacer(minLength: 10)
      RouterWidgetQuotaRow(quota: quota, compact: true, now: entry.date)
    }
  }

  private func medium(source: RouterWidgetUsageSource, quotas: [RouterWidgetQuota]) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      WidgetHeader(snapshot: entry.snapshot, section: "Reset")
      HStack(alignment: .top, spacing: 15) {
        if let first = quotas.first {
          VStack(alignment: .leading, spacing: 2) {
            Text("Next reset")
              .font(.caption2.weight(.semibold))
              .textCase(.uppercase)
              .tracking(0.35)
              .foregroundStyle(.secondary)
            Text(Self.countdown(to: first.resetAt, now: entry.date))
              .font(.system(size: 28, weight: .semibold, design: .rounded))
              .tracking(-0.5)
              .monospacedDigit()
              .lineLimit(1)
              .minimumScaleFactor(0.65)
            Text("\(first.label) · \(source.name)")
              .font(.caption)
              .foregroundStyle(.secondary)
              .lineLimit(1)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }
        Divider()
        VStack(alignment: .leading, spacing: 9) {
          ForEach(quotas) { quota in
            RouterWidgetQuotaRow(quota: quota, compact: false, now: entry.date)
          }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
      }
    }
  }

  private func unavailable(icon: String, title: String) -> some View {
    WidgetUnavailableState(
      icon: icon,
      title: title,
      message: "Open Codex Router to refresh provider limits.",
      tint: widgetAccent,
      compact: family == .systemSmall,
      headerSection: "Reset"
    )
  }

  static func countdown(to date: Date?, now: Date) -> String {
    guard let date else { return "Soon" }
    let seconds = max(0, Int(date.timeIntervalSince(now)))
    if seconds < 60 { return "<1m" }
    let minutes = seconds / 60
    if minutes < 60 { return "\(minutes)m" }
    let hours = minutes / 60
    if hours < 24 { return "\(hours)h \(minutes % 60)m" }
    return "\(hours / 24)d \(hours % 24)h"
  }
}

private struct WidgetUnavailableState: View {
  let icon: String
  let title: String
  let message: String
  let tint: Color
  let compact: Bool
  var headerSection: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      WidgetHeader(snapshot: nil, compact: compact, section: headerSection)
      Spacer()
      Image(systemName: icon)
        .font(.system(size: 22, weight: .semibold))
        .foregroundStyle(tint)
      Text(title)
        .font(.headline)
      Text(message)
        .font(.caption)
        .foregroundStyle(.secondary)
        .lineLimit(2)
      Spacer()
    }
  }
}

private struct WidgetHeader: View {
  let snapshot: RouterWidgetSnapshot?
  var compact = false
  var title = "Codex Router"
  var section: String?

  var body: some View {
    HStack {
      Text(title)
        .font(.caption.weight(.semibold))
        .lineLimit(1)
        .minimumScaleFactor(0.8)
      Spacer()
      if let section, !compact {
        Text(section)
          .font(.system(size: 9, weight: .semibold))
          .tracking(0.45)
          .textCase(.uppercase)
          .foregroundStyle(widgetAccent)
          .padding(.horizontal, 6)
          .padding(.vertical, 3)
          .background(widgetAccent.opacity(0.11), in: Capsule())
          .widgetAccentable()
      } else if let snapshot, !compact {
        Circle()
          .fill(activityTint(snapshot.activityState))
          .frame(width: 6, height: 6)
          .widgetAccentable()
        Text(activityLabel(snapshot))
          .font(.caption2.weight(.medium))
          .foregroundStyle(.secondary)
      }
    }
  }

  private func activityLabel(_ snapshot: RouterWidgetSnapshot) -> String {
    if snapshot.activeChatCount > 1 { return "\(snapshot.activeChatCount) active" }
    return snapshot.activityState == "generating" ? "Active" : "Ready"
  }

  private func activityTint(_ state: String) -> Color {
    switch state {
    case "error": return widgetCritical
    case "starting": return widgetWarning
    case "generating": return widgetHealthy
    default: return Color.secondary
    }
  }
}

private struct RouterWidgetQuotaRow: View {
  let quota: RouterWidgetQuota
  let compact: Bool
  let now: Date

  private var tint: Color {
    if quota.boundedRemainingPercent < 15 { return widgetCritical }
    if quota.boundedRemainingPercent < 35 { return widgetWarning }
    return widgetAccent
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 5) {
        Text(quota.label)
          .font(.caption.weight(.medium))
          .lineLimit(1)
        Spacer(minLength: 4)
        Text("\(quota.roundedRemainingPercent)%")
          .font(.caption.weight(.semibold))
          .monospacedDigit()
          .foregroundStyle(tint)
      }
      GeometryReader { geometry in
        ZStack(alignment: .leading) {
          Capsule().fill(Color.secondary.opacity(0.14))
          Capsule()
            .fill(tint)
            .frame(width: geometry.size.width * CGFloat(quota.boundedRemainingPercent / 100))
        }
      }
      .frame(height: 3)
      if !compact {
        HStack(spacing: 4) {
          Text("Resets")
            .lineLimit(1)
          Spacer(minLength: 3)
          if let resetAt = quota.resetAt {
            Text(Self.resetLabel(resetAt, now: now))
              .monospacedDigit()
          }
        }
        .font(.caption2)
        .foregroundStyle(.secondary)
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(accessibilityLabel)
  }

  private var accessibilityLabel: String {
    let reset = quota.resetAt.map { ", resets \(Self.resetLabel($0, now: now))" } ?? ""
    return "\(quota.providerName), \(quota.label), \(quota.roundedRemainingPercent) percent left\(reset)"
  }

  static func resetLabel(_ date: Date, now: Date) -> String {
    let seconds = date.timeIntervalSince(now)
    if seconds <= 0 { return "soon" }
    let minutes = Int(seconds / 60)
    if minutes < 60 { return "in \(minutes)m" }
    let hours = minutes / 60
    if hours < 24 { return "in \(hours)h" }
    return "in \(hours / 24)d"
  }
}

private struct RouterWidgetCumulativeLineChart: View {
  let points: [RouterWidgetDailyPoint]

  private var visiblePoints: [RouterWidgetDailyPoint] { Array(points.suffix(7)) }

  private var endsOnRouterFallback: Bool {
    visiblePoints.last?.isRouterFallback == true
  }

  var body: some View {
    GeometryReader { geometry in
      let values = visiblePoints
      let maximum = max(values.map(\.tokens).max() ?? 0, 1)
      let width = geometry.size.width
      let height = geometry.size.height
      let step = values.count > 1 ? width / CGFloat(values.count - 1) : 0
      let coordinates = values.enumerated().map { index, point in
        CGPoint(
          x: CGFloat(index) * step,
          y: height - height * CGFloat(Double(max(0, point.tokens)) / Double(maximum))
        )
      }
      // A segment is drawn dashed when the day it arrives at was filled from
      // router telemetry, matching how the tray hatches those bars. The line
      // stays continuous so the shape still reads, while the dashes keep a
      // router-only stretch from passing as account history.
      let segments = coordinates.indices.dropFirst().map { index in
        (
          start: coordinates[index - 1],
          end: coordinates[index],
          isRouterFallback: values[index].isRouterFallback
        )
      }

      ZStack {
        Path { path in
          for fraction in [CGFloat(0.34), CGFloat(0.67)] {
            let y = height * fraction
            path.move(to: CGPoint(x: 0, y: y))
            path.addLine(to: CGPoint(x: width, y: y))
          }
        }
        .stroke(Color.secondary.opacity(0.11), style: StrokeStyle(lineWidth: 0.5))

        Path { path in
          guard let first = coordinates.first, let last = coordinates.last else { return }
          path.move(to: CGPoint(x: first.x, y: height))
          path.addLine(to: first)
          for point in coordinates.dropFirst() { path.addLine(to: point) }
          path.addLine(to: CGPoint(x: last.x, y: height))
          path.closeSubpath()
        }
        .fill(LinearGradient(
          colors: [widgetAccent.opacity(0.28), widgetAccent.opacity(0.02)],
          startPoint: .top,
          endPoint: .bottom
        ))

        Path { path in
          for segment in segments where !segment.isRouterFallback {
            path.move(to: segment.start)
            path.addLine(to: segment.end)
          }
        }
        .stroke(widgetAccent, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
        .widgetAccentable()

        Path { path in
          for segment in segments where segment.isRouterFallback {
            path.move(to: segment.start)
            path.addLine(to: segment.end)
          }
        }
        .stroke(widgetAccent, style: StrokeStyle(
          lineWidth: 2,
          lineCap: .round,
          lineJoin: .round,
          dash: [2.5, 2.5]
        ))
        .widgetAccentable()

        if let last = coordinates.last {
          // A hollow cap says the newest point is this Mac's own count, which
          // is the usual state: the account stream settles a day behind.
          Circle()
            .strokeBorder(widgetAccent, lineWidth: endsOnRouterFallback ? 1.5 : 2.5)
            .frame(width: 5, height: 5)
            .position(last)
            .widgetAccentable()
        }
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(
      endsOnRouterFallback
        ? "Seven day cumulative token usage, most recent day measured locally"
        : "Seven day cumulative token usage"
    )
  }
}

private struct RouterWidgetBackground: View {
  var body: some View {
    ZStack {
      Color(nsColor: .windowBackgroundColor)
      LinearGradient(
        colors: [widgetAccent.opacity(0.07), Color.clear],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
      )
    }
  }
}

enum RouterWidgetPreviewKind {
  case usage
  case reset
}

struct RouterWidgetPreviewCanvas: View {
  let family: WidgetFamily
  let entry: RouterUsageEntry
  let size: CGSize
  var kind: RouterWidgetPreviewKind = .usage

  var body: some View {
    ZStack {
      RouterWidgetBackground()
      Group {
        if kind == .usage {
          RouterUsageWidgetView(entry: entry, familyOverride: family)
        } else {
          RouterResetWidgetView(entry: entry, familyOverride: family)
        }
      }
      .padding(16)
    }
    .frame(width: size.width, height: size.height)
    .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
  }
}

extension RouterWidgetSnapshot {
  static var preview: RouterWidgetSnapshot {
    let now = Date()
    let calendar = Calendar.current
    let codexDaily = [320_400, 451_200, 281_900, 722_100, 590_800, 940_500, 1_284_730]
      .enumerated()
      .map { offset, tokens in
        RouterWidgetDailyPoint(
          date: calendar.date(byAdding: .day, value: offset - 6, to: now) ?? now,
          tokens: Int64(tokens)
        )
      }
    let deepSeekDaily = [112_000, 203_000, 184_000, 312_000, 260_000, 403_000, 510_000]
      .enumerated()
      .map { offset, tokens in
        RouterWidgetDailyPoint(
          date: calendar.date(byAdding: .day, value: offset - 6, to: now) ?? now,
          tokens: Int64(tokens)
        )
      }
    return RouterWidgetSnapshot(
      schemaVersion: schemaVersion,
      generatedAt: now,
      activityState: "generating",
      activeChatCount: 2,
      selectedProviderID: "openai",
      selectedProviderName: "Codex",
      todayTokens: 1_284_730,
      daily: codexDaily,
      quotas: [
        RouterWidgetQuota(
          id: "openai-primary",
          providerID: "openai",
          providerName: "Codex",
          label: "5-hour limit",
          remainingPercent: 68,
          resetAt: now.addingTimeInterval(2.2 * 3600)
        ),
        RouterWidgetQuota(
          id: "openai-secondary",
          providerID: "openai",
          providerName: "Codex",
          label: "Weekly limit",
          remainingPercent: 27,
          resetAt: now.addingTimeInterval(3.4 * 86_400)
        ),
        RouterWidgetQuota(
          id: "deepseek-account",
          providerID: "deepseek",
          providerName: "DeepSeek",
          label: "Monthly limit",
          remainingPercent: 82,
          resetAt: now.addingTimeInterval(8.1 * 86_400)
        ),
      ],
      usageSources: [
        RouterWidgetUsageSource(
          id: "openai",
          name: "Codex",
          todayTokens: 1_284_730,
          daily: codexDaily
        ),
        RouterWidgetUsageSource(
          id: "deepseek",
          name: "DeepSeek",
          todayTokens: 510_000,
          daily: deepSeekDaily
        ),
      ]
    )
  }
}
