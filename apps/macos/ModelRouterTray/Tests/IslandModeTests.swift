import Testing

@testable import ModelRouterTray

// Regression for #180. The overlay covers the notch on every display, so which
// mode a launch resolves to is the whole behavior of that issue.
@Suite("Dynamic Island default")
struct IslandModeTests {
  @Test("a fresh install starts with the overlay off")
  func freshInstallIsOff() {
    #expect(
      RouterStore.resolveIslandMode(
        storedMode: nil,
        legacyVisible: nil,
        hasLaunchedBefore: false
      ) == .off
    )
  }

  @Test("an install that has launched before keeps the overlay")
  func existingInstallKeepsNotch() {
    #expect(
      RouterStore.resolveIslandMode(
        storedMode: nil,
        legacyVisible: nil,
        hasLaunchedBefore: true
      ) == .notch
    )
  }

  @Test("an explicit choice always wins", arguments: ["off", "notch", "desktop"])
  func explicitChoiceWins(raw: String) {
    let expected = IslandMode(rawValue: raw)
    #expect(
      RouterStore.resolveIslandMode(
        storedMode: raw,
        legacyVisible: nil,
        hasLaunchedBefore: false
      ) == expected
    )
    // Even against a legacy boolean that disagrees, and on a fresh install.
    #expect(
      RouterStore.resolveIslandMode(
        storedMode: raw,
        legacyVisible: false,
        hasLaunchedBefore: false
      ) == expected
    )
  }

  @Test("an unreadable stored mode falls through rather than crashing")
  func unknownStoredModeFallsThrough() {
    #expect(
      RouterStore.resolveIslandMode(
        storedMode: "sideways",
        legacyVisible: nil,
        hasLaunchedBefore: false
      ) == .off
    )
  }

  @Test("the pre-desktop-mode boolean still migrates", arguments: [true, false])
  func legacyBooleanMigrates(visible: Bool) {
    #expect(
      RouterStore.resolveIslandMode(
        storedMode: nil,
        legacyVisible: visible,
        hasLaunchedBefore: false
      ) == (visible ? .notch : .off)
    )
    // The legacy answer outranks launch history: it is an actual answer.
    #expect(
      RouterStore.resolveIslandMode(
        storedMode: nil,
        legacyVisible: visible,
        hasLaunchedBefore: true
      ) == (visible ? .notch : .off)
    )
  }
}
