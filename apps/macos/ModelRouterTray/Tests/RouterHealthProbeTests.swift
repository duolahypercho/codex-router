import Foundation
import Testing

@testable import ModelRouterTray

@Suite("Router health probe")
struct RouterHealthProbeTests {
  private func stateDirectory(secret: String?) throws -> URL {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("router-health-probe-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    if let secret {
      try Data(secret.utf8).write(to: directory.appendingPathComponent("caller-secret"))
    }
    return directory
  }

  @Test("the probe reads the protected leaf behind the caller key in the state directory")
  func buildsTheProtectedHealthURL() throws {
    let secret = String(repeating: "a", count: 32)
    let directory = try stateDirectory(secret: "\(secret)\n")
    let url = try RouterHealthProbe.healthURL(
      environment: ["MODEL_ROUTER_STATE_DIR": directory.path, "CODEX_ROUTER_PORT": "4999"],
      home: URL(fileURLWithPath: "/nonexistent", isDirectory: true)
    )
    #expect(url.absoluteString == "http://127.0.0.1:4999/_codex-router/\(secret)/v1/health")
  }

  @Test("a short, malformed, or missing caller key is rejected the way caller-auth.mjs rejects it")
  func rejectsInvalidCallerSecrets() throws {
    let short = String(repeating: "a", count: 31)
    let tooShort = try stateDirectory(secret: short)
    let malformed = try stateDirectory(secret: "\(short)!")
    let missing = try stateDirectory(secret: nil)
    #expect(RouterHealthProbe.callerSecret(stateDirectory: tooShort) == nil)
    #expect(RouterHealthProbe.callerSecret(stateDirectory: malformed) == nil)
    #expect(RouterHealthProbe.callerSecret(stateDirectory: missing) == nil)
  }

  @Test("the port follows paths.mjs: first non-empty alias, default 4202, invalid is an error")
  func resolvesTheRouterPort() throws {
    #expect(try RouterHealthProbe.routerPort(environment: [:]) == 4202)
    #expect(
      try RouterHealthProbe.routerPort(
        environment: ["MODEL_ROUTER_PORT": "", "KIMI_ROUTER_PORT": "4300"]
      ) == 4300
    )
    #expect(try RouterHealthProbe.routerPort(environment: ["MODEL_ROUTER_PORT": " 4.202e3 "]) == 4202)
    #expect(try RouterHealthProbe.routerPort(environment: ["MODEL_ROUTER_PORT": "4202.0"]) == 4202)
    #expect(throws: (any Error).self) {
      try RouterHealthProbe.routerPort(environment: ["MODEL_ROUTER_PORT": "80000"])
    }
    #expect(throws: (any Error).self) {
      try RouterHealthProbe.routerPort(environment: ["MODEL_ROUTER_PORT": "4202.5"])
    }
  }

  @Test("the state directory defaults to $CODEX_HOME/codex-router under ~/.codex")
  func resolvesTheStateDirectory() {
    let home = URL(fileURLWithPath: "/Users/example", isDirectory: true)
    #expect(
      RouterStateDirectory.resolve(environment: [:], home: home).path
        == "/Users/example/.codex/codex-router"
    )
    #expect(
      RouterStateDirectory.resolve(
        environment: ["MODEL_ROUTER_STATE_DIR": "", "KIMI_CODEX_STATE_DIR": "/tmp/state"],
        home: home
      ).path == "/tmp/state"
    )
  }
}
