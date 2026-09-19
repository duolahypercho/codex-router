import Foundation
import Testing

@testable import ModelRouterTray

/// The tray's provider-catalog panel is a second implementation of a surface
/// Electron already ships. Everything it agrees with lives in another language
/// in another directory, so these tests read those files rather than restating
/// their contents -- a copy that drifts is the whole failure mode here.
@Suite("Provider catalogs")
struct ProviderCatalogTests {
  /// apps/macos/ModelRouterTray/Tests/ThisFile.swift -> repository root.
  static let repositoryRoot: URL = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()  // Tests
    .deletingLastPathComponent()  // ModelRouterTray
    .deletingLastPathComponent()  // macos
    .deletingLastPathComponent()  // apps
    .deletingLastPathComponent()  // <root>

  static func repositoryFile(_ relativePath: String) throws -> String {
    let url = repositoryRoot.appendingPathComponent(relativePath)
    return try String(contentsOf: url, encoding: .utf8)
  }

  // MARK: - Parity with the Electron surface

  @Test("catalog eligibility follows backend source descriptors")
  func catalogEligibilityFollowsBackendSources() throws {
    #expect(Self.providerSetup(id: "openai").supportsLiveModelCatalog == false)
    let deepseek = Self.providerSetup(
      id: "deepseek",
      catalogSources: [("deepseek", "DeepSeek", "models-endpoint")]
    )
    #expect(deepseek.supportsLiveModelCatalog)
    #expect(deepseek.catalogSources?.map(\.id) == ["deepseek"])
  }

  @Test("one credential card can expose several independent catalogs")
  func decodesMultipleCatalogSources() throws {
    let provider = Self.providerSetup(
      id: "opencode-go",
      catalogSources: [
        ("opencode-go", "opencode Go", "models-endpoint"),
        ("opencode-zen", "opencode Zen", "models-endpoint"),
      ]
    )
    #expect(provider.catalogSources?.map(\.id) == ["opencode-go", "opencode-zen"])
  }

  @Test("the model-id rule is the one ipc.mjs declares")
  func modelSlugMatchesElectron() throws {
    let source = try Self.repositoryFile("apps/control-center/electron/ipc.mjs")
    // If the Electron pattern is edited, this fails and points at the Swift
    // copy that has to move with it.
    #expect(
      source.contains("const MODEL_SLUG = /^[A-Za-z0-9][A-Za-z0-9._/:+-]{0,200}$/;"),
      "MODEL_SLUG in ipc.mjs changed; update ProviderCatalogInput to match"
    )
    #expect(
      source.contains("const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,80}$/;"),
      "PROVIDER_ID in ipc.mjs changed; update ProviderCatalogInput to match"
    )
    #expect(source.contains("const CATALOG_MUTATION_TIMEOUT_MS = 1_320_000;"))
    #expect(source.contains("{ timeoutMs: 45_000 }"))
  }

  @Test("the tray's script timeouts are the Electron budgets")
  func timeoutsMatchElectron() {
    #expect(RouterScriptWatchdog.discoveryTimeout == 45)
    #expect(RouterScriptWatchdog.catalogMutationTimeout == 1_320)
    #expect(RouterScriptWatchdog.catalogPublicationOperationTimeout == 1_280)
    #expect(RouterScriptWatchdog.catalogControlOperationTimeout == 1_300)
    #expect(RouterScriptWatchdog.processTreeCleanupReserve == 10)
    #expect(RouterScriptWatchdog.antigravityOperationTimeout == 600)
    #expect(RouterScriptWatchdog.antigravityRunnerTimeout == 660)
    #expect(RouterScriptWatchdog.ordinaryOperationTimeout == 840)
    #expect(RouterScriptWatchdog.defaultControlTimeout == 900)
    #expect(
      RouterScriptWatchdog.controlTimeout(arguments: ["credential", "deepseek"])
        == 1_320
    )
    #expect(
      RouterScriptWatchdog.controlTimeout(
        arguments: ["probe-provider", "antigravity-oauth", "--live", "--yes"]
      ) == 660
    )
    #expect(
      RouterScriptWatchdog.controlTimeout(arguments: ["login", "antigravity-oauth"]) == 660
    )
    #expect(RouterScriptWatchdog.controlTimeout(arguments: ["providers", "--json"]) == 900)
    #expect(
      RouterScriptWatchdog.operationTimeout(arguments: ["credential", "deepseek"])
        == 1_300
    )
    #expect(
      RouterScriptWatchdog.operationTimeout(
        arguments: ["probe-provider", "antigravity-oauth", "--live", "--yes"]
      ) == 600
    )
    #expect(
      RouterScriptWatchdog.operationOwnerTimeout(
        arguments: ["probe-provider", "antigravity-oauth", "--live", "--yes"]
      ) == 610
    )
    #expect(RouterScriptWatchdog.operationOwnerTimeout(arguments: ["providers", "--json"]) == 850)
  }

  @Test("credential boundaries supersede only their in-flight catalog reads")
  func credentialBoundaryInvalidatesCatalogGeneration() {
    var ledger = ProviderCatalogGenerationLedger()
    let oldGo = ledger.begin("opencode-go")
    let oldZen = ledger.begin("opencode-zen")
    let deepseek = ledger.begin("deepseek")
    ledger.invalidate(["opencode-go", "opencode-zen"])
    #expect(!ledger.isCurrent(oldGo, for: "opencode-go"))
    #expect(!ledger.isCurrent(oldZen, for: "opencode-zen"))
    #expect(ledger.isCurrent(deepseek, for: "deepseek"))
    let freshGo = ledger.begin("opencode-go")
    #expect(ledger.isCurrent(freshGo, for: "opencode-go"))
  }

  @Test("bulk catalog reload reports every failure instead of replacing it with success")
  func bulkReloadPreservesFailures() {
    var failed = ProviderCatalogReloadBatch()
    failed.record(.failed("deepseek: provider unavailable"), sourceID: "deepseek")
    // Expectation built from the same table as the message: the batch reports
    // through `routerFormat`, so a hard-coded English string would only pass
    // on a machine whose preferred language is English.
    #expect(
      failed.message
        == routerFormat("Catalog reload failed: %@", "deepseek: provider unavailable")
    )

    var partial = ProviderCatalogReloadBatch()
    partial.record(.loaded, sourceID: "deepseek")
    partial.record(.failed("opencode-go: unauthorized"), sourceID: "opencode-go")
    #expect(
      partial.message
        == routerFormat("%d reloaded; %d failed: %@", 1, 1, "opencode-go: unauthorized")
    )

    var superseded = ProviderCatalogReloadBatch()
    superseded.record(.superseded, sourceID: "opencode-zen")
    #expect(
      superseded.message
        == routerFormat(
          "Catalog reload failed: %@",
          routerFormat("%@: reload superseded by a credential change", "opencode-zen")
        )
    )
  }

  // MARK: - Decoding the discovery payload

  /// Verbatim `node src/model-discovery.mjs deepseek --fixture … --json`.
  /// Keys the tray does not read (`contextLengths`, `note`, provider-specific
  /// `free`) are present on purpose: dropping one must not break decoding.
  static let discoveryOutput = """
  {
    "provider": "deepseek",
    "discovered": [
      "deepseek-v4-pro",
      "deepseek-v5-preview"
    ],
    "registered": [
      "deepseek-chat",
      "deepseek-reasoner",
      "deepseek-v4-flash",
      "deepseek-v4-flash-vision-exp",
      "deepseek-v4-pro"
    ],
    "unregistered": [
      "deepseek-v5-preview"
    ],
    "addable": [
      "deepseek-v5-preview"
    ],
    "blocked": {},
    "unavailable": [
      "deepseek-chat",
      "deepseek-reasoner",
      "deepseek-v4-flash",
      "deepseek-v4-flash-vision-exp"
    ],
    "contextLengths": {},
    "cached": false,
    "stale": false,
    "fetchedAt": "2026-08-22T17:52:15.003Z",
    "note": "Discovery never edits the registry. New models must pass the live compatibility test before they are listed in Codex."
  }
  """

  @Test("a real discovery payload decodes into the catalog the panel renders")
  func decodesDiscoveryOutput() throws {
    let catalog = try JSONDecoder().decode(
      ProviderModelCatalog.self,
      from: Data(Self.discoveryOutput.utf8)
    )
    #expect(catalog.provider == "deepseek")
    #expect(catalog.discovered == ["deepseek-v4-pro", "deepseek-v5-preview"])
    #expect(catalog.unregistered == ["deepseek-v5-preview"])
    #expect(catalog.addableModelIDs == ["deepseek-v5-preview"])
    #expect(catalog.blocked == [:])
    #expect(catalog.unavailable.count == 4)
    #expect(catalog.registered.contains("deepseek-v4-pro"))
    #expect(catalog.cached == false)
    #expect(catalog.stale == false)
    #expect(catalog.fetchedAt == "2026-08-22T17:52:15.003Z")
  }

  @Test("the freshness fields stay optional so an older router still decodes")
  func decodesWithoutFreshnessFields() throws {
    let catalog = try JSONDecoder().decode(
      ProviderModelCatalog.self,
      from: Data("""
      {
        "provider": "kimi",
        "discovered": ["kimi-k2.6"],
        "registered": [],
        "unregistered": ["kimi-k2.6"],
        "unavailable": []
      }
      """.utf8)
    )
    #expect(catalog.cached == nil)
    #expect(catalog.stale == nil)
    #expect(catalog.fetchedAt == nil)
    #expect(catalog.addable == nil)
    #expect(catalog.blocked == nil)
    #expect(catalog.addableModelIDs == ["kimi-k2.6"])
  }

  @Test("unsupported candidates decode as visible but non-addable")
  func decodesBlockedCandidates() throws {
    let reason = "The provider catalog lists future-model. This Codex Router version has not verified whether the model uses Chat, Messages, or Responses, so it cannot be added safely. This is a router compatibility limitation; a future update can enable it after testing."
    let catalog = try JSONDecoder().decode(
      ProviderModelCatalog.self,
      from: Data("""
      {
        "provider": "opencode-go",
        "discovered": ["future-model"],
        "registered": [],
        "unregistered": ["future-model"],
        "addable": [],
        "blocked": {"future-model": "\(reason)"},
        "unavailable": []
      }
      """.utf8)
    )
    #expect(catalog.unregistered == ["future-model"])
    #expect(catalog.addableModelIDs.isEmpty)
    #expect(catalog.blocked?["future-model"] == reason)
  }

  @Test("every discovered id the router can publish passes the tray's own rule")
  func discoveredIdsAreAcceptable() throws {
    let catalog = try JSONDecoder().decode(
      ProviderModelCatalog.self,
      from: Data(Self.discoveryOutput.utf8)
    )
    for id in catalog.discovered + catalog.registered {
      #expect(ProviderCatalogInput.isValidModelID(id), "\(id) was rejected")
    }
  }

  // MARK: - Model-id validation

  @Test(
    "ids the providers actually serve are accepted",
    arguments: [
      "deepseek-v4-pro",
      "deepseek/deepseek-v4-flash",
      "Qwen3.8-27B",
      "meta-llama/Llama-4.2:free",
      "gpt-5.5+preview",
      "a",
      "0",
    ]
  )
  func acceptsRealModelIDs(id: String) {
    #expect(ProviderCatalogInput.isValidModelID(id))
  }

  @Test(
    "ids that would change the meaning of the --models argument are rejected",
    arguments: [
      // The concrete bug: one selection silently becomes two ids.
      "deepseek-v4,deepseek-secret",
      // Would be read as another flag rather than a model.
      "--apply",
      "-refresh",
      // Not a slug at all.
      "",
      " ",
      "model id",
      "model\nid",
      "model\"id",
      "model$id",
      "model;id",
      "モデル",
      "/leading-slash",
      ".leading-dot",
    ]
  )
  func rejectsHostileModelIDs(id: String) {
    #expect(ProviderCatalogInput.isValidModelID(id) == false)
  }

  @Test("the length ceiling is the one the Electron pattern encodes")
  func enforcesLengthCeiling() {
    let atLimit = "a" + String(repeating: "b", count: 200)
    #expect(atLimit.count == ProviderCatalogInput.maxModelIDLength)
    #expect(ProviderCatalogInput.isValidModelID(atLimit))
    #expect(ProviderCatalogInput.isValidModelID(atLimit + "b") == false)
  }

  @Test("a selection carrying an invalid id is refused whole, not filtered")
  func refusesSelectionWithInvalidID() {
    #expect(throws: ProviderCatalogInput.Failure.invalidModelID("good,evil")) {
      _ = try ProviderCatalogInput.validatedModelIDs(["fine-model", "good,evil"])
    }
  }

  @Test("duplicates are rejected rather than silently collapsed")
  func rejectsDuplicates() {
    // Electron reports this instead of deduplicating, so a catalog that served
    // the same id twice is surfaced rather than hidden.
    #expect(throws: ProviderCatalogInput.Failure.duplicateModelID) {
      _ = try ProviderCatalogInput.validatedModelIDs(["a-model", "a-model"])
    }
    #expect(throws: ProviderCatalogInput.Failure.duplicateModelID) {
      _ = try ProviderCatalogInput.validatedModelIDs(["a-model", " a-model "])
    }
  }

  @Test("the selection size bounds match the Electron handler")
  func enforcesSelectionBounds() {
    #expect(throws: ProviderCatalogInput.Failure.emptySelection) {
      _ = try ProviderCatalogInput.validatedModelIDs([])
    }
    let tooMany = (0...ProviderCatalogInput.maxModelIDCount).map { "model-\($0)" }
    #expect(throws: ProviderCatalogInput.Failure.tooManyModels(tooMany.count)) {
      _ = try ProviderCatalogInput.validatedModelIDs(tooMany)
    }
    let atLimit = (1...ProviderCatalogInput.maxModelIDCount).map { "model-\($0)" }
    #expect(throws: Never.self) {
      _ = try ProviderCatalogInput.validatedModelIDs(atLimit)
    }
  }

  @Test("a valid selection is trimmed and ordered deterministically")
  func normalizesValidSelection() throws {
    let ids = try ProviderCatalogInput.validatedModelIDs(["b-model", " a-model ", "c-model"])
    #expect(ids == ["a-model", "b-model", "c-model"])
    // What actually reaches `--models`.
    #expect(ids.joined(separator: ",") == "a-model,b-model,c-model")
  }

  @Test(
    "provider ids are held to the lowercase rule ipc.mjs uses",
    arguments: [
      ("deepseek", true),
      ("github-copilot", true),
      ("z-ai-2", true),
      ("DeepSeek", false),
      ("-leading", false),
      ("has_underscore", false),
      ("has/slash", false),
      ("", false),
    ]
  )
  func validatesProviderIDs(id: String, expected: Bool) {
    #expect(ProviderCatalogInput.isValidProviderID(id) == expected)
  }

  // MARK: - Helpers

  static func providerSetup(
    id: String,
    catalogSources: [(String, String, String)] = []
  ) -> ProviderSetupState {
    let sources = catalogSources.map { id, displayName, kind in
      "{\"id\":\"\(id)\",\"displayName\":\"\(displayName)\",\"kind\":\"\(kind)\"}"
    }.joined(separator: ",")
    let json = """
    {
      "id": "\(id)",
      "displayName": "\(id)",
      "kind": "api",
      "configured": true,
      "action": "connect",
      "catalogSources": [\(sources)]
    }
    """
    // Force-tried: a decode failure here means the struct's own contract broke,
    // which every other test in this file already depends on.
    return try! JSONDecoder().decode(ProviderSetupState.self, from: Data(json.utf8))
  }

}

/// `runRouterScript` is private, so these exercise the watchdog it installs
/// against real child processes -- including the two failures that motivated
/// it: a child that never exits, and a child that outfills the 64KB pipe.
@Suite("Router script watchdog")
struct RouterScriptWatchdogTests {
  /// Mirrors the ordering inside `runRouterScript`: drain both pipes, arm the
  /// watchdog, then wait. Reversing the first two would deadlock on the large
  /// output case below.
  private static func runScript(
    _ command: String,
    timeout: TimeInterval
  ) async throws -> (stdout: Data, timedOut: Bool, status: Int32) {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/bin/sh")
    task.arguments = ["-c", command]
    let output = Pipe()
    let errors = Pipe()
    task.standardOutput = output
    task.standardError = errors
    try task.run()
    let stdoutReader = Task.detached { output.fileHandleForReading.readDataToEndOfFile() }
    let stderrReader = Task.detached { errors.fileHandleForReading.readDataToEndOfFile() }
    let watchdog = RouterScriptWatchdog(task: task)
    watchdog.arm(after: timeout)
    task.waitUntilExit()
    watchdog.disarm()
    let stdout = await stdoutReader.value
    _ = await stderrReader.value
    return (stdout, watchdog.didTimeOut, task.terminationStatus)
  }

  @Test("a child that never answers is stopped instead of hanging the caller")
  func terminatesAWedgedChild() async throws {
    // The concrete failure: a provider endpoint that accepts the connection
    // and then goes silent. Without the watchdog this never returns, the
    // caller's `defer` never clears the loading flag, and both catalog
    // buttons stay disabled for the rest of the app's life.
    let started = Date()
    let result = try await Self.runScript("sleep 60", timeout: 0.4)
    #expect(result.timedOut)
    #expect(result.status != 0)
    #expect(Date().timeIntervalSince(started) < 20)
  }

  @Test("wedged children are stopped even when every other thread is blocked")
  func terminatesWedgedChildrenUnderThreadPressure() async throws {
    // This is the case CI caught and the single-child test above misses. Each
    // in-flight run blocks a thread in `waitUntilExit()` and holds two more in
    // its pipe readers. The first watchdog scheduled its deadline on
    // libdispatch's global queue, which on a small machine had no thread left
    // to run it -- so every child ran to completion and nothing was killed.
    // Run enough of them at once to starve the pool on a CI-sized box.
    let started = Date()
    let wedged = 8
    let results = try await withThrowingTaskGroup(of: (Bool, Int32).self) { group in
      for _ in 0 ..< wedged {
        group.addTask {
          let result = try await Self.runScript("sleep 60", timeout: 0.4)
          return (result.timedOut, result.status)
        }
      }
      var collected: [(Bool, Int32)] = []
      for try await result in group { collected.append(result) }
      return collected
    }

    #expect(results.count == wedged)
    for (timedOut, status) in results {
      #expect(timedOut, "a wedged child was not stopped by the watchdog")
      #expect(status != 0, "a wedged child exited normally instead of being signalled")
    }
    // Generous, but far below the 60s a starved watchdog produces.
    #expect(Date().timeIntervalSince(started) < 30)
  }

  @Test("a child that finishes in time is never signalled")
  func leavesAFastChildAlone() async throws {
    let result = try await Self.runScript("printf ok", timeout: 30)
    #expect(result.timedOut == false)
    #expect(result.status == 0)
    #expect(String(data: result.stdout, encoding: .utf8) == "ok")
  }

  @Test("output larger than the pipe buffer still arrives whole")
  func drainsPastThePipeBuffer() async throws {
    // 200KB is comfortably past the 64KB pipe: a child blocked writing into a
    // full pipe never exits, so waiting before draining would deadlock and the
    // watchdog would report a timeout that is really the caller's own bug.
    let result = try await Self.runScript("head -c 200000 /dev/zero | tr '\\0' a", timeout: 30)
    #expect(result.timedOut == false)
    #expect(result.status == 0)
    #expect(result.stdout.count == 200_000)
  }

  @Test("disarming after the process is gone is inert")
  func disarmIsIdempotent() async throws {
    let result = try await Self.runScript("printf ok", timeout: 0.05)
    // The timer may well have fired during teardown; it must not have signalled
    // a reaped process nor claimed a timeout on a run that completed.
    #expect(result.status == 0)
    #expect(String(data: result.stdout, encoding: .utf8) == "ok")
  }
}
