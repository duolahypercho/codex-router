import Foundation
import Testing

@testable import ModelRouterTray

@Suite("Router Widget snapshot")
struct RouterWidgetSnapshotTests {
  private func snapshot(generatedAt: Date, todayTokens: Int64 = 42) -> RouterWidgetSnapshot {
    let contentDate = Date(timeIntervalSince1970: 1_700_000_000)
    return RouterWidgetSnapshot(
      schemaVersion: 1,
      generatedAt: generatedAt,
      activityState: "idle",
      activeChatCount: 0,
      selectedProviderID: "openai",
      selectedProviderName: "ChatGPT",
      todayTokens: todayTokens,
      daily: [RouterWidgetDailyPoint(date: contentDate, tokens: todayTokens)],
      quotas: [RouterWidgetQuota(
        id: "openai-primary",
        providerID: "openai",
        providerName: "ChatGPT",
        label: "5-hour limit",
        remainingPercent: 58,
        resetAt: contentDate.addingTimeInterval(3600)
      )],
      usageSources: [RouterWidgetUsageSource(
        id: "openai",
        name: "Codex",
        todayTokens: todayTokens,
        daily: [RouterWidgetDailyPoint(date: contentDate, tokens: todayTokens)]
      )]
    )
  }

  private func encodedSnapshot(
    _ snapshot: RouterWidgetSnapshot,
    changing change: (inout [String: Any]) -> Void
  ) throws -> Data {
    let encoded = try JSONEncoder.routerWidget.encode(snapshot)
    var object = try #require(
      JSONSerialization.jsonObject(with: encoded) as? [String: Any]
    )
    change(&object)
    return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
  }

  @Test("snapshot contains only the Widget projection")
  func safeProjection() throws {
    let data = try JSONEncoder.routerWidget.encode(snapshot(generatedAt: .now))
    let text = String(decoding: data, as: UTF8.self)
    #expect(text.contains("todayTokens"))
    #expect(text.contains("remainingPercent"))
    #expect(text.contains("usageSources"))
    #expect(!text.localizedCaseInsensitiveContains("token" + "="))
    #expect(!text.localizedCaseInsensitiveContains("credential"))
    #expect(!text.localizedCaseInsensitiveContains("dashboardUrl"))
  }

  // The widget extension is a separate bundle and cannot read the tray's
  // language selection, so the snapshot carries it. That field is new, and the
  // two-sided compatibility is what keeps an updated tray and a not-yet-updated
  // extension reading each other's files instead of falling back to "waiting
  // for router data".
  @Test("a snapshot written before the language field still decodes")
  func legacySnapshotWithoutLanguageDecodes() throws {
    let now = Date(timeIntervalSince1970: 1_700_000_000)
    // Tagged explicitly so the removal below is a real edit of a present key
    // rather than a no-op on a snapshot that never carried one.
    let current = taggedSnapshot(generatedAt: now, language: "english")
    let legacyData = try encodedSnapshot(current) { object in
      #expect(object["language"] as? String == "english")
      object.removeValue(forKey: "language")
    }
    let decoded = try #require(RouterWidgetSnapshotStore.decode(legacyData))
    #expect(decoded.language == nil)
    #expect(decoded.isSemanticallyValid)
    #expect(decoded.todayTokens == current.todayTokens)
    #expect(decoded.availableUsageSources.map(\.id) == current.availableUsageSources.map(\.id))
  }

  @Test("the language field round-trips and stays inside the size and semantics bounds")
  func languageRoundTrips() throws {
    let now = Date(timeIntervalSince1970: 1_700_000_000)
    let payload = try JSONEncoder.routerWidget.encode(snapshot(generatedAt: now))
    let withoutLanguage = try #require(
      JSONSerialization.jsonObject(with: payload) as? [String: Any]
    )
    // A snapshot whose language is nil omits the key entirely rather than
    // encoding a JSON null. That omission is the compatibility guarantee, so it
    // is asserted strictly.
    #expect(withoutLanguage["language"] == nil)

    let tagged = RouterWidgetSnapshot(
      schemaVersion: RouterWidgetSnapshot.schemaVersion,
      generatedAt: now,
      activityState: "idle",
      activeChatCount: 0,
      selectedProviderID: "openai",
      selectedProviderName: "ChatGPT",
      todayTokens: 42,
      daily: [RouterWidgetDailyPoint(date: now, tokens: 42)],
      quotas: [],
      usageSources: nil,
      language: ResolvedTrayLanguage.chinese.widgetIdentifier
    )
    let encoded = try JSONEncoder.routerWidget.encode(tagged)
    let object = try #require(
      JSONSerialization.jsonObject(with: encoded) as? [String: Any]
    )
    #expect(object["language"] as? String == "chinese")
    let decoded = try #require(RouterWidgetSnapshotStore.decode(encoded))
    #expect(decoded.language == "chinese")
    #expect(decoded.isSemanticallyValid)
    // An oversized language string is rejected the same way every other
    // bounded string is, so a hostile snapshot cannot carry one.
    let oversizedLanguage = try encodedSnapshot(tagged) { object in
      object["language"] = String(repeating: "z", count: RouterWidgetSnapshot.maximumStringBytes + 1)
    }
    #expect(RouterWidgetSnapshotStore.decode(oversizedLanguage) == nil)
  }

  /// The base fixture plus a published language, for tests that need the field
  /// present.
  private func taggedSnapshot(
    generatedAt: Date,
    language: String?
  ) -> RouterWidgetSnapshot {
    let base = snapshot(generatedAt: generatedAt)
    return RouterWidgetSnapshot(
      schemaVersion: base.schemaVersion,
      generatedAt: base.generatedAt,
      activityState: base.activityState,
      activeChatCount: base.activeChatCount,
      selectedProviderID: base.selectedProviderID,
      selectedProviderName: base.selectedProviderName,
      todayTokens: base.todayTokens,
      daily: base.daily,
      quotas: base.quotas,
      usageSources: base.usageSources,
      language: language
    )
  }

  @Test("a language change republishes while an unchanged snapshot is deduplicated")
  func languageChangeIsPublishable() throws {
    let now = Date(timeIntervalSince1970: 1_700_000_000)
    let english = snapshot(generatedAt: now)
    let chinese = taggedSnapshot(generatedAt: now, language: "chinese")
    // `content` is the deduplication key: switching language while every
    // measured number stays put has to count as a change, or the widget would
    // keep rendering the old language until some usage moved.
    #expect(chinese.content != english.content)
    #expect(english.content == snapshot(generatedAt: now).content)
  }

  @Test("token projection and cumulative totals saturate instead of trapping")
  func tokenSaturation() {
    #expect(RouterWidgetTokenCount.from(-1) == 0)
    #expect(RouterWidgetTokenCount.from(.nan) == 0)
    #expect(RouterWidgetTokenCount.from(Double(Int64.max)) == Int64.max)
    #expect(RouterWidgetTokenCount.from(.infinity) == 0)

    let date = Date(timeIntervalSince1970: 1_700_000_000)
    let source = RouterWidgetUsageSource(
      id: "bounded",
      name: "Bounded",
      todayTokens: Int64.max,
      daily: [
        RouterWidgetDailyPoint(date: date, tokens: Int64.max),
        RouterWidgetDailyPoint(date: date.addingTimeInterval(86_400), tokens: Int64.max),
      ]
    )
    #expect(source.periodTokens == Int64.max)
    #expect(source.cumulativeDaily.map(\.tokens) == [Int64.max, Int64.max])

    let hugeQuota = RouterWidgetQuota(
      id: "huge",
      providerID: "provider",
      providerName: "Provider",
      label: "Window",
      remainingPercent: 1e300,
      resetAt: nil
    )
    #expect(hugeQuota.boundedRemainingPercent == 100)
    #expect(hugeQuota.roundedRemainingPercent == 100)
  }

  @Test("atomic writer skips unchanged content and refreshes stale snapshots")
  func atomicWriteAndFingerprint() throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("router-widget-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let destination = root.appendingPathComponent("snapshot.json")
    let now = Date(timeIntervalSince1970: 1_770_000_000)

    #expect(try RouterWidgetSnapshotStore.write(snapshot(generatedAt: now), to: destination, now: now))
    let originalData = try RouterWidgetSnapshotStore.readData(at: destination)
    let originalModificationDate = try #require(
      FileManager.default.attributesOfItem(atPath: destination.path)[.modificationDate]
        as? Date
    )
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o755],
      ofItemAtPath: root.path
    )
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o644],
      ofItemAtPath: destination.path
    )
    #expect(
      try RouterWidgetSnapshotStore.write(
        snapshot(generatedAt: now.addingTimeInterval(30)),
        to: destination,
        now: now.addingTimeInterval(30)
      ) == false
    )
    #expect(try RouterWidgetSnapshotStore.readData(at: destination) == originalData)
    let unchangedModificationDate = try #require(
      FileManager.default.attributesOfItem(atPath: destination.path)[.modificationDate]
        as? Date
    )
    #expect(unchangedModificationDate == originalModificationDate)
    let repairedFilePermissions = try FileManager.default.attributesOfItem(
      atPath: destination.path
    )[.posixPermissions] as? NSNumber
    #expect(repairedFilePermissions?.intValue == 0o600)
    let repairedDirectoryPermissions = try FileManager.default.attributesOfItem(
      atPath: root.path
    )[.posixPermissions] as? NSNumber
    #expect(repairedDirectoryPermissions?.intValue == 0o700)
    #expect(
      try RouterWidgetSnapshotStore.write(
        snapshot(generatedAt: now.addingTimeInterval(601)),
        to: destination,
        now: now.addingTimeInterval(601)
      )
    )

    let decoded = try #require(
      RouterWidgetSnapshotStore.decode(
        try RouterWidgetSnapshotStore.readData(at: destination)
      )
    )
    #expect(decoded.generatedAt == now.addingTimeInterval(601))
    let permissions = try FileManager.default.attributesOfItem(atPath: destination.path)[.posixPermissions] as? NSNumber
    #expect(permissions?.intValue == 0o600)
    let directoryPermissions = try FileManager.default.attributesOfItem(
      atPath: root.path
    )[.posixPermissions] as? NSNumber
    #expect(directoryPermissions?.intValue == 0o700)
  }

  @Test("storage modes select exactly one supported snapshot location")
  func storageModePaths() {
    let home = URL(fileURLWithPath: "/Users/example", isDirectory: true)
    let group = URL(fileURLWithPath: "/registered/group", isDirectory: true)
    #expect(
      RouterWidgetSnapshotStore.snapshotURL(
        mode: .local,
        configuredAppGroup: "group.invalid",
        registeredContainer: group,
        localHomeDirectory: home
      )?.path
        == "/Users/example/Library/Application Support/Codex Router Widget/usage-widget.json"
    )
    #expect(
      RouterWidgetSnapshotStore.snapshotURL(
        mode: .appGroup,
        configuredAppGroup: RouterWidgetSnapshot.defaultAppGroup,
        registeredContainer: group,
        localHomeDirectory: home
      ) == group.appendingPathComponent(RouterWidgetSnapshot.fileName)
    )
    #expect(
      RouterWidgetSnapshotStore.snapshotURL(
        mode: .appGroup,
        configuredAppGroup: "group.invalid",
        registeredContainer: group,
        localHomeDirectory: home
      ) == nil
    )
    #expect(
      RouterWidgetSnapshotStore.snapshotURL(
        mode: .appGroup,
        configuredAppGroup: RouterWidgetSnapshot.defaultAppGroup,
        registeredContainer: nil,
        localHomeDirectory: home
      ) == nil
    )
  }

  @Test("bounded reader and writer reject oversized snapshots")
  func boundedSnapshotIO() throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("router-widget-bounds-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let oversizedFile = root.appendingPathComponent("oversized.json")
    try Data(
      repeating: 0x61,
      count: RouterWidgetSnapshot.maximumEncodedBytes + 1
    ).write(to: oversizedFile)
    #expect(throws: RouterWidgetSnapshotStoreError.snapshotTooLarge) {
      try RouterWidgetSnapshotStore.readData(at: oversizedFile)
    }
    let symlink = root.appendingPathComponent("linked.json")
    try FileManager.default.createSymbolicLink(at: symlink, withDestinationURL: oversizedFile)
    #expect(throws: RouterWidgetSnapshotStoreError.unsafeSnapshotLocation) {
      try RouterWidgetSnapshotStore.readData(at: symlink)
    }

    let now = Date(timeIntervalSince1970: 1_700_000_000)
    #expect(throws: RouterWidgetSnapshotStoreError.unsafeSnapshotLocation) {
      try RouterWidgetSnapshotStore.write(
        snapshot(generatedAt: now),
        to: symlink,
        now: now
      )
    }
    let realDirectory = root.appendingPathComponent("real", isDirectory: true)
    let linkedDirectory = root.appendingPathComponent("linked", isDirectory: true)
    try FileManager.default.createDirectory(at: realDirectory, withIntermediateDirectories: false)
    try FileManager.default.createSymbolicLink(
      at: linkedDirectory,
      withDestinationURL: realDirectory
    )
    #expect(throws: RouterWidgetSnapshotStoreError.unsafeSnapshotLocation) {
      try RouterWidgetSnapshotStore.write(
        snapshot(generatedAt: now),
        to: linkedDirectory.appendingPathComponent("snapshot.json"),
        now: now
      )
    }

    let daily = (0..<RouterWidgetSnapshot.maximumDailyPoints).map {
      RouterWidgetDailyPoint(date: now.addingTimeInterval(Double($0 * 86_400)), tokens: 1)
    }
    let longName = String(repeating: "n", count: RouterWidgetSnapshot.maximumStringBytes)
    let sources = (0..<RouterWidgetSnapshot.maximumUsageSources).map {
      RouterWidgetUsageSource(id: "source-\($0)", name: longName, todayTokens: 1, daily: daily)
    }
    let quotas = (0..<RouterWidgetSnapshot.maximumQuotas).map {
      RouterWidgetQuota(
        id: "quota-\($0)",
        providerID: "source-\($0 % RouterWidgetSnapshot.maximumUsageSources)",
        providerName: longName,
        label: longName,
        remainingPercent: 50,
        resetAt: now
      )
    }
    let oversizedSnapshot = RouterWidgetSnapshot(
      schemaVersion: RouterWidgetSnapshot.schemaVersion,
      generatedAt: now,
      activityState: longName,
      activeChatCount: 0,
      selectedProviderID: "openai",
      selectedProviderName: longName,
      todayTokens: 1,
      daily: daily,
      quotas: quotas,
      usageSources: sources
    )
    #expect(oversizedSnapshot.isSemanticallyValid)
    #expect(
      try JSONEncoder.routerWidget.encode(oversizedSnapshot).count
        > RouterWidgetSnapshot.maximumEncodedBytes
    )
    #expect(throws: RouterWidgetSnapshotStoreError.snapshotTooLarge) {
      try RouterWidgetSnapshotStore.write(
        oversizedSnapshot,
        to: root.appendingPathComponent("encoded.json"),
        now: now
      )
    }
  }

  @Test("decoder bounds arrays and UTF-8 strings")
  func semanticSizeBounds() throws {
    let valid = snapshot(generatedAt: Date(timeIntervalSince1970: 1_700_000_000))
    let hugeName = String(repeating: "🧭", count: 65)
    let hugeString = try encodedSnapshot(valid) { $0["selectedProviderName"] = hugeName }
    #expect(RouterWidgetSnapshotStore.decode(hugeString) == nil)

    let tooManyDaily = try encodedSnapshot(valid) { object in
      let point = (object["daily"] as! [[String: Any]])[0]
      object["daily"] = (0...RouterWidgetSnapshot.maximumDailyPoints).map { index in
        var copy = point
        copy["date"] = ISO8601DateFormatter().string(
          from: valid.generatedAt.addingTimeInterval(Double(index * 86_400))
        )
        return copy
      }
    }
    #expect(RouterWidgetSnapshotStore.decode(tooManyDaily) == nil)

    let tooManySources = try encodedSnapshot(valid) { object in
      let source = (object["usageSources"] as! [[String: Any]])[0]
      object["usageSources"] = (0...RouterWidgetSnapshot.maximumUsageSources).map { index in
        var copy = source
        copy["id"] = "source-\(index)"
        return copy
      }
    }
    #expect(RouterWidgetSnapshotStore.decode(tooManySources) == nil)

    let tooManyQuotas = try encodedSnapshot(valid) { object in
      let quota = (object["quotas"] as! [[String: Any]])[0]
      object["quotas"] = (0...RouterWidgetSnapshot.maximumQuotas).map { index in
        var copy = quota
        copy["id"] = "quota-\(index)"
        return copy
      }
    }
    #expect(RouterWidgetSnapshotStore.decode(tooManyQuotas) == nil)
  }

  @Test("decoder rejects invalid and duplicate identifiers and dates")
  func semanticIdentityBounds() throws {
    let valid = snapshot(generatedAt: Date(timeIntervalSince1970: 1_700_000_000))
    let invalidPayloads = try [
      encodedSnapshot(valid) { $0["selectedProviderID"] = "OpenAI" },
      encodedSnapshot(valid) { object in
        var quotas = object["quotas"] as! [[String: Any]]
        quotas[0]["id"] = "quota_record"
        object["quotas"] = quotas
      },
      encodedSnapshot(valid) { object in
        var quotas = object["quotas"] as! [[String: Any]]
        quotas[0]["providerID"] = "OpenAI"
        object["quotas"] = quotas
      },
      encodedSnapshot(valid) { object in
        var sources = object["usageSources"] as! [[String: Any]]
        sources[0]["id"] = "open_ai"
        object["usageSources"] = sources
      },
      encodedSnapshot(valid) { object in
        let quota = (object["quotas"] as! [[String: Any]])[0]
        object["quotas"] = [quota, quota]
      },
      encodedSnapshot(valid) { object in
        let source = (object["usageSources"] as! [[String: Any]])[0]
        object["usageSources"] = [source, source]
      },
      encodedSnapshot(valid) { object in
        let point = (object["daily"] as! [[String: Any]])[0]
        object["daily"] = [point, point]
      },
      encodedSnapshot(valid) { object in
        var sources = object["usageSources"] as! [[String: Any]]
        let point = (sources[0]["daily"] as! [[String: Any]])[0]
        sources[0]["daily"] = [point, point]
        object["usageSources"] = sources
      },
    ]
    for payload in invalidPayloads {
      #expect(RouterWidgetSnapshotStore.decode(payload) == nil)
    }
  }

  @Test("decoder rejects negative counts and invalid quotas")
  func semanticNumericBounds() throws {
    let valid = snapshot(generatedAt: Date(timeIntervalSince1970: 1_700_000_000))
    let invalidPayloads = try [
      encodedSnapshot(valid) { $0["activeChatCount"] = -1 },
      encodedSnapshot(valid) { $0["todayTokens"] = -1 },
      encodedSnapshot(valid) { object in
        var daily = object["daily"] as! [[String: Any]]
        daily[0]["tokens"] = -1
        object["daily"] = daily
      },
      encodedSnapshot(valid) { object in
        var sources = object["usageSources"] as! [[String: Any]]
        sources[0]["todayTokens"] = -1
        object["usageSources"] = sources
      },
      encodedSnapshot(valid) { object in
        var quotas = object["quotas"] as! [[String: Any]]
        quotas[0]["remainingPercent"] = -1
        object["quotas"] = quotas
      },
      encodedSnapshot(valid) { object in
        var quotas = object["quotas"] as! [[String: Any]]
        quotas[0]["remainingPercent"] = 101
        object["quotas"] = quotas
      },
      encodedSnapshot(valid) { object in
        var quotas = object["quotas"] as! [[String: Any]]
        quotas[0]["remainingPercent"] = 1e300
        object["quotas"] = quotas
      },
    ]
    for payload in invalidPayloads {
      #expect(RouterWidgetSnapshotStore.decode(payload) == nil)
    }

    let encoded = String(decoding: try JSONEncoder.routerWidget.encode(valid), as: UTF8.self)
    let nonfiniteEquivalent = encoded.replacingOccurrences(
      of: "\"remainingPercent\":58",
      with: "\"remainingPercent\":1e999"
    )
    #expect(nonfiniteEquivalent != encoded)
    #expect(RouterWidgetSnapshotStore.decode(Data(nonfiniteEquivalent.utf8)) == nil)
  }

  @Test("legacy current-schema snapshots keep the single-source projection")
  func legacyUsageSourcesRemainSupported() throws {
    let current = snapshot(generatedAt: Date(timeIntervalSince1970: 1_700_000_000))
    let legacy = RouterWidgetSnapshot(
      schemaVersion: current.schemaVersion,
      generatedAt: current.generatedAt,
      activityState: current.activityState,
      activeChatCount: current.activeChatCount,
      selectedProviderID: current.selectedProviderID,
      selectedProviderName: current.selectedProviderName,
      todayTokens: current.todayTokens,
      daily: current.daily,
      quotas: current.quotas,
      usageSources: nil
    )
    let decoded = try #require(
      RouterWidgetSnapshotStore.decode(try JSONEncoder.routerWidget.encode(legacy))
    )
    #expect(decoded.usageSources == nil)
    #expect(decoded.availableUsageSources.map(\.id) == ["openai"])
  }
}
