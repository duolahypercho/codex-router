import Foundation
#if os(macOS)
import Darwin
#endif

enum RouterWidgetStorageMode: String {
  case appGroup = "app-group"
  case local
}

enum RouterWidgetTokenCount {
  static func from(_ value: Double) -> Int64 {
    guard value.isFinite, value > 0 else { return 0 }
    guard value < Double(Int64.max) else { return .max }
    return Int64(value.rounded())
  }

  static func adding(_ left: Int64, _ right: Int64) -> Int64 {
    let safeLeft = max(0, left)
    let safeRight = max(0, right)
    let (sum, overflow) = safeLeft.addingReportingOverflow(safeRight)
    return overflow ? .max : sum
  }
}

/// An account stream can omit a date entirely -- OpenAI does not publish a
/// bucket for the current day until it settles, and it drops quiet days
/// outright. Router telemetry fills those gaps, but it only measures this Mac,
/// so a filled point is not a global account total. This used to be published
/// as a flat zero, which the widget then rendered as a confident "0 tokens
/// today" on a day the account simply had not reported yet. Carry the
/// provenance instead and let the presentation say which one it is showing.
struct RouterWidgetDailyPoint: Codable, Equatable, Identifiable {
  let date: Date
  let tokens: Int64
  let isRouterFallback: Bool

  init(date: Date, tokens: Int64, isRouterFallback: Bool = false) {
    self.date = date
    self.tokens = tokens
    self.isRouterFallback = isRouterFallback
  }

  private enum CodingKeys: String, CodingKey {
    case date
    case tokens
    case isRouterFallback
  }

  // The flag is additive within schema 1: it is omitted for account points, so
  // a host and an extension on either side of an app update keep reading each
  // other's snapshots instead of falling back to "Waiting for router data".
  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    date = try container.decode(Date.self, forKey: .date)
    tokens = try container.decode(Int64.self, forKey: .tokens)
    isRouterFallback = try container.decodeIfPresent(Bool.self, forKey: .isRouterFallback) ?? false
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(date, forKey: .date)
    try container.encode(tokens, forKey: .tokens)
    if isRouterFallback { try container.encode(true, forKey: .isRouterFallback) }
  }

  var id: Date { date }
}

struct RouterWidgetUsageSource: Codable, Equatable, Identifiable {
  let id: String
  let name: String
  let todayTokens: Int64
  let daily: [RouterWidgetDailyPoint]

  var cumulativeDaily: [RouterWidgetDailyPoint] {
    var total: Int64 = 0
    return daily.map { point in
      total = RouterWidgetTokenCount.adding(total, point.tokens)
      return RouterWidgetDailyPoint(
        date: point.date,
        tokens: total,
        isRouterFallback: point.isRouterFallback
      )
    }
  }

  var periodTokens: Int64 {
    daily.reduce(0) { RouterWidgetTokenCount.adding($0, $1.tokens) }
  }

  /// Today is the point most likely to be router-only: the account stream lags
  /// the current day, so a headline number for it usually measures this Mac.
  var todayIsRouterFallback: Bool {
    daily.last?.isRouterFallback ?? false
  }
}

struct RouterWidgetQuota: Codable, Equatable, Identifiable {
  let id: String
  let providerID: String
  let providerName: String
  let label: String
  let remainingPercent: Double
  let resetAt: Date?

  static func normalizedRemainingPercent(_ value: Double) -> Double {
    guard value.isFinite else { return 0 }
    return max(0, min(100, value))
  }

  var boundedRemainingPercent: Double {
    Self.normalizedRemainingPercent(remainingPercent)
  }

  var roundedRemainingPercent: Int {
    Int(boundedRemainingPercent.rounded())
  }
}

struct RouterWidgetSnapshot: Codable, Equatable {
  static let schemaVersion = 1
  static let fileName = "usage-widget.json"
  static let kind = "io.github.codex-router.usage-widget"
  static let resetKind = "io.github.codex-router.reset-widget"
  static let defaultUsageSourceID = "openai"
  static let defaultAppGroup = "group.io.github.codex-router"
  static let extensionBundleIdentifier = "io.github.codex-router.tray.widget"
  static let supportDirectoryName = "Codex Router Widget"
  static let storageModeInfoKey = "ModelRouterWidgetStorageMode"
  static let maximumEncodedBytes = 64 * 1024
  static let maximumDailyPoints = 31
  static let maximumQuotas = 64
  static let maximumUsageSources = 32
  static let maximumStringBytes = 256
  static let maximumProviderIDBytes = 64
  static let maximumRecordIDBytes = 128

  let schemaVersion: Int
  let generatedAt: Date
  let activityState: String
  let activeChatCount: Int
  let selectedProviderID: String
  let selectedProviderName: String
  let todayTokens: Int64
  let daily: [RouterWidgetDailyPoint]
  let quotas: [RouterWidgetQuota]
  let usageSources: [RouterWidgetUsageSource]?

  var availableUsageSources: [RouterWidgetUsageSource] {
    if let usageSources, !usageSources.isEmpty { return usageSources }
    return [RouterWidgetUsageSource(
      id: selectedProviderID,
      name: selectedProviderName,
      todayTokens: todayTokens,
      daily: daily
    )]
  }

  func usageSource(id requestedID: String?) -> RouterWidgetUsageSource {
    let sources = availableUsageSources
    if let requestedID,
       let requested = sources.first(where: { $0.id == requestedID }) {
      return requested
    }
    if let codex = sources.first(where: { $0.id == Self.defaultUsageSourceID }) {
      return codex
    }
    return sources[0]
  }

  func quotas(for sourceID: String) -> [RouterWidgetQuota] {
    quotas.filter { $0.providerID == sourceID }
  }

  var content: Content {
    Content(
      activityState: activityState,
      activeChatCount: activeChatCount,
      selectedProviderID: selectedProviderID,
      selectedProviderName: selectedProviderName,
      todayTokens: todayTokens,
      daily: daily,
      quotas: quotas,
      usageSources: usageSources
    )
  }

  struct Content: Codable, Equatable {
    let activityState: String
    let activeChatCount: Int
    let selectedProviderID: String
    let selectedProviderName: String
    let todayTokens: Int64
    let daily: [RouterWidgetDailyPoint]
    let quotas: [RouterWidgetQuota]
    let usageSources: [RouterWidgetUsageSource]?
  }

  var isSemanticallyValid: Bool {
    guard schemaVersion == Self.schemaVersion,
          generatedAt.timeIntervalSinceReferenceDate.isFinite,
          Self.isBoundedString(activityState),
          activeChatCount >= 0,
          Self.isProviderID(selectedProviderID),
          Self.isBoundedString(selectedProviderName),
          todayTokens >= 0,
          Self.hasValidDailyPoints(daily),
          quotas.count <= Self.maximumQuotas,
          Set(quotas.map(\.id)).count == quotas.count
    else { return false }

    for quota in quotas {
      guard Self.isRecordID(quota.id),
            Self.isProviderID(quota.providerID),
            Self.isBoundedString(quota.providerName),
            Self.isBoundedString(quota.label),
            quota.remainingPercent.isFinite,
            (0...100).contains(quota.remainingPercent),
            quota.resetAt?.timeIntervalSinceReferenceDate.isFinite != false
      else { return false }
    }

    guard let usageSources else { return true }
    guard usageSources.count <= Self.maximumUsageSources,
          Set(usageSources.map(\.id)).count == usageSources.count
    else { return false }
    for source in usageSources {
      guard Self.isProviderID(source.id),
            Self.isBoundedString(source.name),
            source.todayTokens >= 0,
            Self.hasValidDailyPoints(source.daily)
      else { return false }
    }
    return true
  }

  private static func hasValidDailyPoints(_ points: [RouterWidgetDailyPoint]) -> Bool {
    guard points.count <= maximumDailyPoints,
          Set(points.map(\.date)).count == points.count
    else { return false }
    return points.allSatisfy {
      $0.date.timeIntervalSinceReferenceDate.isFinite && $0.tokens >= 0
    }
  }

  private static func isBoundedString(_ value: String) -> Bool {
    value.utf8.count <= maximumStringBytes
  }

  private static func isProviderID(_ value: String) -> Bool {
    isLowercaseIdentifier(value, maximumBytes: maximumProviderIDBytes)
  }

  private static func isRecordID(_ value: String) -> Bool {
    isLowercaseIdentifier(value, maximumBytes: maximumRecordIDBytes)
  }

  private static func isLowercaseIdentifier(_ value: String, maximumBytes: Int) -> Bool {
    guard !value.isEmpty, value.utf8.count <= maximumBytes else { return false }
    let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789-")
    guard value.unicodeScalars.allSatisfy(allowed.contains),
          value.unicodeScalars.first.map(
            CharacterSet.lowercaseLetters.union(.decimalDigits).contains
          ) == true
    else { return false }
    return true
  }
}

enum RouterWidgetSnapshotStoreError: Error, Equatable, LocalizedError {
  case invalidSnapshot
  case snapshotTooLarge
  case unsafeSnapshotLocation

  var errorDescription: String? {
    switch self {
    case .invalidSnapshot: "The widget snapshot is invalid."
    case .snapshotTooLarge: "The widget snapshot exceeds its size limit."
    case .unsafeSnapshotLocation: "The widget snapshot location is not a regular private path."
    }
  }
}

enum RouterWidgetSnapshotStore {
  static func storageMode(bundle: Bundle = .main) -> RouterWidgetStorageMode? {
    let configured = bundle.object(
      forInfoDictionaryKey: RouterWidgetSnapshot.storageModeInfoKey
    ) as? String
    return configured.flatMap(RouterWidgetStorageMode.init(rawValue:))
  }

  static func configuredAppGroup(bundle: Bundle = .main) -> String? {
    let configured = bundle.object(forInfoDictionaryKey: "ModelRouterWidgetAppGroup") as? String
    let trimmed = configured?.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed?.isEmpty == false ? trimmed : nil
  }

  static var actualUserHomeDirectory: URL? {
#if os(macOS)
    guard let entry = getpwuid(getuid()), let path = entry.pointee.pw_dir else { return nil }
    return URL(fileURLWithPath: String(cString: path), isDirectory: true)
#else
    return FileManager.default.homeDirectoryForCurrentUser
#endif
  }

  static func localSnapshotURL(homeDirectory: URL) -> URL {
    homeDirectory
      .appendingPathComponent("Library/Application Support", isDirectory: true)
      .appendingPathComponent(RouterWidgetSnapshot.supportDirectoryName, isDirectory: true)
      .appendingPathComponent(RouterWidgetSnapshot.fileName, isDirectory: false)
  }

  static func snapshotURL(
    mode: RouterWidgetStorageMode,
    configuredAppGroup: String?,
    registeredContainer: URL?,
    localHomeDirectory: URL?
  ) -> URL? {
    switch mode {
    case .local:
      return localHomeDirectory.map(localSnapshotURL(homeDirectory:))
    case .appGroup:
      guard configuredAppGroup == RouterWidgetSnapshot.defaultAppGroup,
            let registeredContainer
      else { return nil }
      return registeredContainer.appendingPathComponent(
        RouterWidgetSnapshot.fileName,
        isDirectory: false
      )
    }
  }

  static func hostSnapshotURL(
    bundle: Bundle = .main,
    fileManager: FileManager = .default
  ) -> URL? {
    guard let mode = storageMode(bundle: bundle) else { return nil }
    let group = configuredAppGroup(bundle: bundle)
    let container = mode == .appGroup
      ? group.flatMap(fileManager.containerURL(forSecurityApplicationGroupIdentifier:))
      : nil
    return snapshotURL(
      mode: mode,
      configuredAppGroup: group,
      registeredContainer: container,
      localHomeDirectory: actualUserHomeDirectory
    )
  }

  static func readData(at source: URL) throws -> Data {
    let values = try source.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
    guard values.isRegularFile == true, values.isSymbolicLink != true else {
      throw RouterWidgetSnapshotStoreError.unsafeSnapshotLocation
    }
    let handle = try FileHandle(forReadingFrom: source)
    defer { try? handle.close() }
    var result = Data()
    while result.count <= RouterWidgetSnapshot.maximumEncodedBytes {
      let remaining = RouterWidgetSnapshot.maximumEncodedBytes + 1 - result.count
      guard remaining > 0,
            let chunk = try handle.read(upToCount: remaining),
            !chunk.isEmpty
      else { break }
      result.append(chunk)
    }
    guard result.count <= RouterWidgetSnapshot.maximumEncodedBytes else {
      throw RouterWidgetSnapshotStoreError.snapshotTooLarge
    }
    return result
  }

  static func decode(_ data: Data) -> RouterWidgetSnapshot? {
    guard data.count <= RouterWidgetSnapshot.maximumEncodedBytes,
          let snapshot = try? JSONDecoder.routerWidget.decode(
            RouterWidgetSnapshot.self,
            from: data
          ),
          snapshot.isSemanticallyValid
    else { return nil }
    return snapshot
  }

  @discardableResult
  static func write(
    _ snapshot: RouterWidgetSnapshot,
    to destination: URL,
    now: Date = Date(),
    fileManager: FileManager = .default
  ) throws -> Bool {
    guard snapshot.isSemanticallyValid else {
      throw RouterWidgetSnapshotStoreError.invalidSnapshot
    }
    let data = try JSONEncoder.routerWidget.encode(snapshot)
    guard data.count <= RouterWidgetSnapshot.maximumEncodedBytes else {
      throw RouterWidgetSnapshotStoreError.snapshotTooLarge
    }

    let directory = destination.deletingLastPathComponent()
    if fileManager.fileExists(atPath: directory.path) {
      let values = try directory.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
      guard values.isDirectory == true, values.isSymbolicLink != true else {
        throw RouterWidgetSnapshotStoreError.unsafeSnapshotLocation
      }
    } else {
      try fileManager.createDirectory(
        at: directory,
        withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700]
      )
    }
    try fileManager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)

    if fileManager.fileExists(atPath: destination.path) {
      let values = try destination.resourceValues(
        forKeys: [.isRegularFileKey, .isSymbolicLinkKey]
      )
      guard values.isRegularFile == true, values.isSymbolicLink != true else {
        throw RouterWidgetSnapshotStoreError.unsafeSnapshotLocation
      }
      try fileManager.setAttributes(
        [.posixPermissions: 0o600],
        ofItemAtPath: destination.path
      )
    }

    if let previousData = try? readData(at: destination),
       let previous = decode(previousData),
       previous.content == snapshot.content,
       now.timeIntervalSince(previous.generatedAt) >= 0,
       now.timeIntervalSince(previous.generatedAt) < 10 * 60 {
      return false
    }
    try data.write(to: destination, options: .atomic)
    try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination.path)
    return true
  }
}

extension JSONEncoder {
  static var routerWidget: JSONEncoder {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    encoder.outputFormatting = [.sortedKeys]
    return encoder
  }
}

extension JSONDecoder {
  static var routerWidget: JSONDecoder {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    return decoder
  }
}
