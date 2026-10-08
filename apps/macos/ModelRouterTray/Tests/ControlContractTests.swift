import Foundation
import Testing

@testable import ModelRouterTray

@Suite("Native control contract")
struct ControlContractTests {
  private static func fixture(
    version: String = "0.5.0",
    protocolVersion: Int = 1
  ) throws -> (root: URL, package: URL) {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("model-router-contract-\(UUID().uuidString)", isDirectory: true)
    let controlCenter = root
      .appendingPathComponent("apps", isDirectory: true)
      .appendingPathComponent("control-center", isDirectory: true)
    try FileManager.default.createDirectory(at: controlCenter, withIntermediateDirectories: true)
    let package = controlCenter.appendingPathComponent("package.json")
    let data = try JSONSerialization.data(
      withJSONObject: ["version": version, "controlProtocol": protocolVersion]
    )
    try data.write(to: package)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: root.path)
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o755],
      ofItemAtPath: root.appendingPathComponent("apps").path
    )
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: controlCenter.path)
    try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: package.path)
    return (root, package)
  }

  @Test("reads, recovery commands, and mutations have explicit boundaries")
  func classifiesCommandsFailClosed() {
    #expect(RouterControlContractPolicy.access(for: ["--json"]) == .read)
    #expect(RouterControlContractPolicy.access(for: ["providers", "--json"]) == .read)
    #expect(
      RouterControlContractPolicy.access(for: ["local-models", "list", "--json"]) == .read
    )
    #expect(RouterControlContractPolicy.access(for: ["doctor", "--fix"]) == .recovery)
    #expect(RouterControlContractPolicy.access(for: ["maintenance"]) == .recovery)
    #expect(RouterControlContractPolicy.access(for: ["tray", "refresh"]) == .recovery)
    #expect(RouterControlContractPolicy.access(for: ["service", "start"]) == .recovery)
    #expect(
      RouterControlContractPolicy.access(for: ["providers", "enable", "deepseek"])
        == .mutation
    )
    #expect(RouterControlContractPolicy.access(for: ["future-command"]) == .mutation)
    #expect(RouterControlContractPolicy.drainsBeforeTermination(["doctor", "--fix"]))
    #expect(RouterControlContractPolicy.drainsBeforeTermination(["providers", "enable", "deepseek"]))
    #expect(!RouterControlContractPolicy.drainsBeforeTermination(["maintenance"]))
    #expect(!RouterControlContractPolicy.drainsBeforeTermination(["tray", "refresh"]))
    #expect(!RouterControlContractPolicy.drainsBeforeTermination(["tray", "rebuild"]))
    #expect(RouterControlContractPolicy.outlivesApplication(["maintenance"]))
    #expect(RouterControlContractPolicy.outlivesApplication(["tray", "refresh"]))
    #expect(RouterControlContractPolicy.outlivesApplication(["tray", "rebuild"]))
    #expect(!RouterControlContractPolicy.outlivesApplication(["doctor", "--fix"]))
    #expect(RouterControlContractPolicy.requiresDetachedTrayRefresh(["maintenance"]))
    #expect(RouterControlContractPolicy.requiresDetachedTrayRefresh(["doctor", "--fix"]))
    #expect(!RouterControlContractPolicy.requiresDetachedTrayRefresh(["tray", "refresh"]))
  }

  @Test("termination waits for every native mutation and replies exactly once")
  func drainsNativeMutations() {
    var drain = NativeMutationDrain()
    let initiallyTerminates = drain.requestTermination()
    #expect(initiallyTerminates)
    drain.begin()
    drain.begin()
    let deferred = drain.requestTermination()
    #expect(!deferred)
    let firstFinished = drain.finish()
    #expect(!firstFinished)
    #expect(drain.active == 1)
    let finalFinished = drain.finish()
    #expect(finalFinished)
    #expect(drain.active == 0)
    #expect(!drain.terminationPending)
    let terminatesAfterDrain = drain.requestTermination()
    #expect(terminatesAfterDrain)
  }

  @Test("a trusted matching installed package authorizes mutations")
  func acceptsMatchingContract() throws {
    let fixture = try Self.fixture()
    defer { try? FileManager.default.removeItem(at: fixture.root) }
    let installed = RouterControlContractPolicy.installedContract(sourceRoot: fixture.root)
    #expect(installed == RouterControlContract(version: "0.5.0", controlProtocol: 1))
    #expect(
      RouterControlContractPolicy.matches(
        installed: installed,
        expectedVersion: "0.5.0",
        expectedProtocol: 1
      )
    )
    #expect(
      !RouterControlContractPolicy.matches(
        installed: installed,
        expectedVersion: "0.4.0-beta.4",
        expectedProtocol: 1
      )
    )
  }

  @Test("unsafe or implausibly large package metadata is refused")
  func refusesUnsafePackage() throws {
    let fixture = try Self.fixture()
    defer { try? FileManager.default.removeItem(at: fixture.root) }

    try FileManager.default.setAttributes([.posixPermissions: 0o666], ofItemAtPath: fixture.package.path)
    #expect(RouterControlContractPolicy.installedContract(sourceRoot: fixture.root) == nil)

    try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: fixture.package.path)
    let oversized = Data(repeating: 0x20, count: RouterControlContractPolicy.packageLimit + 1)
    try oversized.write(to: fixture.package)
    #expect(RouterControlContractPolicy.installedContract(sourceRoot: fixture.root) == nil)
  }

  @Test("only superseded Control Center bundles are retired before launch")
  func selectsSupersededControlCenters() {
    let embedded = URL(fileURLWithPath: "/Applications/Codex Router.app/Contents/Resources/Control Center.app")
    #expect(
      !ControlCenterLauncher.shouldRetireControlCenter(
        at: embedded,
        embeddedApplication: embedded
      )
    )
    #expect(
      ControlCenterLauncher.shouldRetireControlCenter(
        at: URL(fileURLWithPath: "/Applications/Codex Router.app"),
        embeddedApplication: embedded
      )
    )
    #expect(ControlCenterLauncher.shouldRetireControlCenter(at: nil, embeddedApplication: embedded))
  }

  @Test("embedded Control Center inherits only shared-plane path aliases")
  func forwardsEmbeddedSharedPlaneEnvironment() {
    let source = [
      "CODEX_ROUTER_SOURCE_ROOT": "/opt/router",
      "MODEL_ROUTER_SOURCE_ROOT": "/opt/router-alias",
      "MODEL_ROUTER_STATE_DIR": "/state/model",
      "CODEX_ROUTER_STATE_DIR": "/state/codex",
      "KIMI_CODEX_STATE_DIR": "/state/legacy",
      "CODEX_HOME": "/clients/codex",
      "EMPTY_ALIAS": "",
      "ANTHROPIC_API_KEY": "must-not-cross-the-app-boundary",
    ]
    let forwarded = ControlCenterLauncher.embeddedEnvironment(processEnvironment: source)
    #expect(forwarded["CODEX_ROUTER_EMBEDDED_CONTROL_CENTER"] == "1")
    for key in [
      "CODEX_ROUTER_SOURCE_ROOT", "MODEL_ROUTER_SOURCE_ROOT",
      "MODEL_ROUTER_STATE_DIR", "CODEX_ROUTER_STATE_DIR", "KIMI_CODEX_STATE_DIR",
      "CODEX_HOME",
    ] {
      #expect(forwarded[key] == source[key], "missing shared-plane alias \(key)")
    }
    #expect(forwarded["ANTHROPIC_API_KEY"] == nil)
    #expect(forwarded["EMPTY_ALIAS"] == nil)
  }

  @Test("widget URLs map only to fixed Control Center destinations")
  func validatesWidgetDestinations() {
    let usage = ControlCenterNavigationRequest(
      url: URL(string: "codex-router://control-center/usage?source=deepseek")!
    )
    #expect(usage?.destination == .usage)
    #expect(usage?.sourceID == "deepseek")
    #expect(usage?.arguments == [
      "--router-destination", "usage", "--router-source", "deepseek",
    ])
    #expect(usage?.url.absoluteString == "codex-router://control-center/usage?source=deepseek")
    let reset = ControlCenterNavigationRequest(
      url: URL(string: "codex-router://control-center/usage-resets?source=openai")!
    )
    #expect(reset?.destination == .usageResets)
    #expect(reset?.sourceID == "openai")
    for unsafe in [
      "https://control-center/usage",
      "codex-router://other/usage",
      "codex-router://control-center/settings",
      "codex-router://control-center/usage?source=deep_seek",
      "codex-router://control-center/usage?source=openai&source=deepseek",
      "codex-router://control-center/usage?next=settings",
      "codex-router://control-center//usage",
      "codex-router://user@control-center/usage",
      "codex-router://control-center/usage#reset",
    ] {
      #expect(ControlCenterNavigationRequest(url: URL(string: unsafe)!) == nil)
    }
  }

  @Test("the Settings item opens the Settings page; the link parser still refuses it")
  func settingsItemNavigatesOnlyFromTheTray() {
    let settings = ControlCenterNavigationRequest(destination: .settings)
    #expect(settings.arguments == ["--router-destination", "settings"])
    #expect(settings.url.absoluteString == "codex-router://control-center/settings")
    // The tray hands that URL to the Control Center itself; the parser for
    // widget and other external URLs still refuses it.
    #expect(ControlCenterNavigationRequest(url: settings.url) == nil)
  }

  @Test("the private install-owner manifest resolves and unsafe copies do not")
  func validatesInstallManifest() throws {
    let state = FileManager.default.temporaryDirectory
      .appendingPathComponent("model-router-manifest-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: state, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: state) }
    let manifest = state.appendingPathComponent("install-manifest.json")
    let expected = "/Users/example/.local/share/codex-router"
    let data = try JSONSerialization.data(
      withJSONObject: ["version": 1, "current": ["sourceRoot": expected]]
    )
    try data.write(to: manifest)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: state.path)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: manifest.path)
    #expect(
      RouterInstallManifestPolicy.sourceRoot(stateDirectory: state)?.path == expected
    )

    try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: manifest.path)
    #expect(RouterInstallManifestPolicy.sourceRoot(stateDirectory: state) == nil)

    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: manifest.path)
    try Data(repeating: 0x20, count: RouterInstallManifestPolicy.manifestLimit + 1)
      .write(to: manifest)
    #expect(RouterInstallManifestPolicy.sourceRoot(stateDirectory: state) == nil)
  }
}
