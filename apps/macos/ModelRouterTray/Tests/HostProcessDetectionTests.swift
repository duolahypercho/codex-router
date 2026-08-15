import Foundation
import Testing

@testable import ModelRouterTray

// Follow mode decided whether Codex was open by asking NSRunningApplication for
// two bundle identifiers. The npm CLI is a plain terminal process and has
// neither, so every CLI session read as "Codex is not running": the menu bar
// item was hidden immediately and the router was stopped thirty seconds later,
// mid-session. These cover the process scan that closes that gap.
@Suite("Codex CLI detection")
struct HostProcessDetectionTests {
  @Test("a process that is certainly running is found")
  func findsLiveProcess() {
    // launchd is pid 1 on every macOS machine, so this asserts the scan works
    // at all rather than asserting anything about the test host's software.
    #expect(RouterStore.anyProcessRunning(named: ["launchd"]))
  }

  @Test("a name nothing owns is not matched")
  func rejectsAbsentProcess() {
    #expect(!RouterStore.anyProcessRunning(named: ["codex-router-no-such-process"]))
  }

  @Test("matching ignores case, because p_comm casing is not ours to predict")
  func matchesCaseInsensitively() {
    #expect(RouterStore.anyProcessRunning(named: ["LAUNCHD"]))
  }

  @Test("an empty name list matches nothing")
  func emptyListMatchesNothing() {
    #expect(!RouterStore.anyProcessRunning(named: []))
  }

  @Test("the watched name is the executable name, not a path or a bundle id")
  func watchesExecutableName() {
    // p_comm holds at most 16 characters and never a path, so anything longer
    // or slash-bearing here would silently never match.
    for name in RouterStore.hostProcessNames {
      #expect(!name.contains("/"))
      #expect(name.count <= 16)
    }
  }
}
