import AppKit
import Foundation
import Testing

@testable import ModelRouterTray

@Suite("Menu bar settings", .serialized)
struct MenuBarSettingsTests {
  @Test("the borderless tray panel accepts text-field focus")
  @MainActor
  func trayPanelCanBecomeKeyWithoutBecomingMain() {
    let panel = TrayInputPanel(
      contentRect: .zero,
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )
    #expect(panel.canBecomeKey)
    #expect(!panel.canBecomeMain)
    #expect(panel.styleMask.contains(.nonactivatingPanel))
  }

  @Test("the visible tray keeps enabled controls in their colored key state")
  func trayControlsUseKeyAppearance() {
    #expect(TrayControlAppearance.activeState == .key)
  }

  @Test("visible unverified subagent models remain selectable")
  func subagentTogglePolicyKeepsTheVerificationPathReachable() {
    #expect(!TraySubagentTogglePolicy.isDisabled(certification: "unknown"))
    #expect(!TraySubagentTogglePolicy.isDisabled(certification: "v2"))
    #expect(TraySubagentTogglePolicy.isDisabled(certification: "v1"))
  }

  @Test("subagent switches follow the effective router selection")
  func subagentSelectionDoesNotSnapBackToRegistryProvenance() {
    #expect(TraySubagentSelectionPolicy.isOn(
      certification: "unknown",
      mode: "selected",
      explicitlyEnabled: true,
      explicitlyDisabled: false
    ))
    #expect(TraySubagentSelectionPolicy.isOn(
      certification: "unknown",
      mode: "all",
      explicitlyEnabled: false,
      explicitlyDisabled: false
    ))
    #expect(!TraySubagentSelectionPolicy.isOn(
      certification: "unknown",
      mode: "proven",
      explicitlyEnabled: false,
      explicitlyDisabled: false
    ))
    #expect(TraySubagentSelectionPolicy.isOn(
      certification: "v2",
      mode: "proven",
      explicitlyEnabled: false,
      explicitlyDisabled: false
    ))
    #expect(!TraySubagentSelectionPolicy.isOn(
      certification: "v2",
      mode: "all",
      explicitlyEnabled: true,
      explicitlyDisabled: true
    ))
    #expect(!TraySubagentSelectionPolicy.isOn(
      certification: "v1",
      mode: "selected",
      explicitlyEnabled: true,
      explicitlyDisabled: false
    ))
  }

  @Test("picker-hidden models remain independently selectable as subagents")
  func pickerVisibilityDoesNotDisableSubagents() {
    #expect(!TraySubagentTogglePolicy.isDisabled(certification: "unknown"))
    #expect(TraySubagentSelectionPolicy.isOn(
      certification: "unknown",
      mode: "selected",
      explicitlyEnabled: true,
      explicitlyDisabled: false
    ))
  }

  @Test("global click dismissal preserves tray controls")
  func globalClickDismissalIgnoresPanelAndStatusItem() {
    let panel = NSRect(x: 100, y: 100, width: 320, height: 500)
    let statusItem = NSRect(x: 390, y: 610, width: 30, height: 20)

    #expect(!TrayPanelClickPolicy.shouldClose(
      screenPoint: NSPoint(x: 400, y: 350),
      panelFrame: panel,
      statusItemFrame: statusItem
    ))
    #expect(!TrayPanelClickPolicy.shouldClose(
      screenPoint: NSPoint(x: 400, y: 615),
      panelFrame: panel,
      statusItemFrame: statusItem
    ))
    #expect(TrayPanelClickPolicy.shouldClose(
      screenPoint: NSPoint(x: 50, y: 50),
      panelFrame: panel,
      statusItemFrame: statusItem
    ))
  }

  @Test("activity dot keeps an explicit state color")
  func activityDotUsesNonTemplateImage() {
    let image = MenuBarActivityDotImage.make(state: .generating, size: 6)
    let color = RouterActivityState.generating.menuBarColor.usingColorSpace(.genericRGB)
    #expect(image.isTemplate == false)
    #expect(image.size == NSSize(width: 6, height: 6))
    #expect(abs((color?.redComponent ?? 0) - 0.68) < 0.001)
    #expect(abs((color?.greenComponent ?? 0) - 0.40) < 0.001)
    #expect(abs((color?.blueComponent ?? 0) - 0.03) < 0.001)
  }

  @Test("the bundled router SVG loads as a menu bar template image")
  func bundledRouterMarkLoadsAsTemplate() {
    guard let image = MenuBarRouterMarkImage.make() else {
      Issue.record("RouterMark.svg could not be loaded from the SwiftPM resource bundle")
      return
    }
    #expect(image.isTemplate)
    #expect(image.size == NSSize(width: 32, height: 32))

    guard let statusImage = MenuBarRouterMarkImage.make(size: 15) else {
      Issue.record("RouterMark.svg could not be sized for the menu bar")
      return
    }
    #expect(statusImage.isTemplate)
    #expect(statusImage.size == NSSize(width: 15, height: 15))

    guard let activeImage = MenuBarRouterMarkImage.make(resourceName: "RouterMarkActive", size: 15) else {
      Issue.record("RouterMarkActive.svg could not be loaded from the SwiftPM resource bundle")
      return
    }
    #expect(activeImage.isTemplate)
    #expect(activeImage.size == NSSize(width: 15, height: 15))
  }

  @Test("a missing key uses the bundled router mark")
  func missingKeysUseRouterMark() {
    let settings = RouterStore.resolveMenuBarSettings(
      storedDisplayMode: nil,
      storedShowModelName: nil,
      storedIconStyle: nil,
      storedPresetIcon: nil,
      storedCustomIconPath: nil
    )
    #expect(settings.displayMode == .iconOnly)
    #expect(settings.showModelName == true)
    #expect(settings.iconStyle == .router)
    #expect(settings.presetIcon == "cpu")
    #expect(settings.customIconPath == nil)
  }

  @Test("an explicit choice always wins", arguments: ["router", "provider", "indicator", "preset", "custom"])
  func explicitIconStyleWins(raw: String) {
    let expected = TrayMenuBarIconStyle(rawValue: raw)
    let settings = RouterStore.resolveMenuBarSettings(
      storedDisplayMode: "iconOnly",
      storedShowModelName: false,
      storedIconStyle: raw,
      storedPresetIcon: "sparkles",
      storedCustomIconPath: "/tmp/icon.png"
    )
    #expect(settings.iconStyle == expected)
    #expect(settings.displayMode == .iconOnly)
    #expect(settings.showModelName == false)
    #expect(settings.presetIcon == "sparkles")
    #expect(settings.customIconPath == "/tmp/icon.png")
  }

  @Test("an unreadable stored value falls through rather than crashing")
  func unknownStoredValuesFallThrough() {
    let settings = RouterStore.resolveMenuBarSettings(
      storedDisplayMode: "sideways",
      storedShowModelName: nil,
      storedIconStyle: "rainbow",
      storedPresetIcon: nil,
      storedCustomIconPath: ""
    )
    #expect(settings.displayMode == .iconOnly)
    #expect(settings.iconStyle == .router)
    #expect(settings.presetIcon == "cpu")
    #expect(settings.customIconPath == nil)
  }

  @Test("standard mode keeps a reserved width even when the name is hidden")
  func standardWidthIsReserved() {
    #expect(MenuBarLayoutMetrics.standardIconSize == 15)
    #expect(MenuBarLayoutMetrics.iconOnlyIconSize == MenuBarLayoutMetrics.standardIconSize)
    #expect(MenuBarLayoutMetrics.statusItemWidth(displayMode: .standard) == 180)
    #expect(MenuBarLayoutMetrics.statusItemWidth(displayMode: .iconOnly) == 22)
    #expect(MenuBarLayoutMetrics.statusItemHeight(displayMode: .standard) == 22)
    #expect(MenuBarLayoutMetrics.statusItemHeight(displayMode: .iconOnly) == 22)
  }

  @Test("the icon-only mark stays inside the native square during a pulse")
  func iconOnlyPulseKeepsScaledContentInsideBounds() {
    #expect(MenuBarLayoutMetrics.statusItemWidth(displayMode: .iconOnly, pulsing: true) == 22)
    #expect(MenuBarLayoutMetrics.statusItemHeight(displayMode: .iconOnly, pulsing: true) == 22)
    #expect(MenuBarLayoutMetrics.statusItemWidth(displayMode: .standard, pulsing: true) == 180)
    #expect(MenuBarLayoutMetrics.statusItemHeight(displayMode: .standard, pulsing: true) == 22)
  }

  @Test("provider marks fit transparent crops without leaving the target slot")
  func providerMarkCropFitsTargetSlot() {
    let drawRect = ProviderIconLayout.fittedRect(
      sourceRect: NSRect(x: 2, y: 1, width: 6, height: 8),
      targetSize: NSSize(width: 20, height: 20)
    )
    #expect(drawRect.width == 15)
    #expect(drawRect.height == 20)
    #expect(drawRect.minX >= 0)
    #expect(drawRect.maxX <= 20)
    #expect(drawRect.minY >= 0)
    #expect(drawRect.maxY <= 20)
  }

  @Test("provider layout finds visible content in a transparent bitmap")
  func providerLayoutFindsVisibleContent() {
    let url = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .appendingPathComponent("Sources/Resources/ProviderIcons/openai.png")
    guard let image = NSImage(contentsOf: url) else {
      Issue.record("Provider icon fixture could not be loaded")
      return
    }

    let visibleRect = ProviderIconLayout.visibleImageRect(image)
    #expect(visibleRect.width > 0)
    #expect(visibleRect.height > 0)
    #expect(visibleRect.width <= image.size.width)
    #expect(visibleRect.height <= image.size.height)
    #expect(visibleRect.width < image.size.width || visibleRect.height < image.size.height)
    let drawRect = ProviderIconLayout.fittedRect(
      sourceRect: visibleRect,
      targetSize: NSSize(width: 18, height: 18)
    )
    #expect(drawRect.minX >= 0)
    #expect(drawRect.maxX <= 18)
    #expect(drawRect.minY >= 0)
    #expect(drawRect.maxY <= 18)
  }

  @Test("provider layout handles alpha-first bitmap representations")
  func providerLayoutHandlesAlphaFirstBitmaps() {
    guard let representation = NSBitmapImageRep(
      bitmapDataPlanes: nil,
      pixelsWide: 10,
      pixelsHigh: 8,
      bitsPerSample: 8,
      samplesPerPixel: 4,
      hasAlpha: true,
      isPlanar: false,
      colorSpaceName: .deviceRGB,
      bitmapFormat: .alphaFirst,
      bytesPerRow: 0,
      bitsPerPixel: 0
    ) else {
      Issue.record("Alpha-first bitmap fixture could not be created")
      return
    }

    func setPixel(_ values: [Int], atX x: Int, y: Int) {
      var values = values
      values.withUnsafeMutableBufferPointer { buffer in
        representation.setPixel(buffer.baseAddress!, atX: x, y: y)
      }
    }

    for y in 0..<representation.pixelsHigh {
      for x in 0..<representation.pixelsWide {
        setPixel([0, 0, 0, 0], atX: x, y: y)
      }
    }
    setPixel([255, 255, 255, 255], atX: 2, y: 1)
    setPixel([255, 255, 255, 255], atX: 7, y: 6)
    let image = NSImage(size: NSSize(width: 10, height: 8))
    image.addRepresentation(representation)

    let visibleRect = ProviderIconLayout.visibleImageRect(image)
    #expect(visibleRect.minX == 2)
    #expect(visibleRect.minY == 1)
    #expect(visibleRect.width == 6)
    #expect(visibleRect.height == 6)
  }

  @Test("choosing a custom image copies it into Application Support")
  func persistCopiesIntoApplicationSupport() throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("menubar-icon-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let sourceDir = root.appendingPathComponent("src", isDirectory: true)
    let support = root.appendingPathComponent("support", isDirectory: true)
    try FileManager.default.createDirectory(at: sourceDir, withIntermediateDirectories: true)
    let source = sourceDir.appendingPathComponent("picked.png")
    try Data([0x89, 0x50, 0x4E, 0x47]).write(to: source)

    let dest = try RouterStore.persistCustomMenuBarIcon(from: source, into: support)
    #expect(dest.lastPathComponent == "menu-bar-icon.png")
    #expect(FileManager.default.fileExists(atPath: dest.path))
    #expect(dest.path.contains("ModelRouterTray"))
  }

  @Test("a failed persist leaves the previous copy in place")
  func persistFailureKeepsPreviousCopy() throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("menubar-icon-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let sourceDir = root.appendingPathComponent("src", isDirectory: true)
    let support = root.appendingPathComponent("support", isDirectory: true)
    try FileManager.default.createDirectory(at: sourceDir, withIntermediateDirectories: true)
    let first = sourceDir.appendingPathComponent("first.png")
    try Data([0x89, 0x50, 0x4E, 0x47, 0x01]).write(to: first)
    let dest = try RouterStore.persistCustomMenuBarIcon(from: first, into: support)
    let before = try Data(contentsOf: dest)

    let missing = sourceDir.appendingPathComponent("gone.jpg")
    #expect(throws: (any Error).self) {
      try RouterStore.persistCustomMenuBarIcon(from: missing, into: support)
    }
    #expect(FileManager.default.fileExists(atPath: dest.path))
    #expect(try Data(contentsOf: dest) == before)
  }

  @Test("replacing a custom image drops the previous extension only after success")
  func persistReplacesPreviousExtension() throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("menubar-icon-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let sourceDir = root.appendingPathComponent("src", isDirectory: true)
    let support = root.appendingPathComponent("support", isDirectory: true)
    try FileManager.default.createDirectory(at: sourceDir, withIntermediateDirectories: true)
    let png = sourceDir.appendingPathComponent("first.png")
    let jpg = sourceDir.appendingPathComponent("second.jpg")
    try Data([0x89, 0x50, 0x4E, 0x47]).write(to: png)
    try Data([0xFF, 0xD8, 0xFF]).write(to: jpg)

    let first = try RouterStore.persistCustomMenuBarIcon(from: png, into: support)
    let second = try RouterStore.persistCustomMenuBarIcon(from: jpg, into: support)
    #expect(second.lastPathComponent == "menu-bar-icon.jpg")
    #expect(FileManager.default.fileExists(atPath: second.path))
    #expect(!FileManager.default.fileExists(atPath: first.path))
  }

  @Test("an oversized custom image is rejected")
  func persistRejectsOversizedImage() throws {
    let root = FileManager.default.temporaryDirectory
      .appendingPathComponent("menubar-icon-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let sourceDir = root.appendingPathComponent("src", isDirectory: true)
    try FileManager.default.createDirectory(at: sourceDir, withIntermediateDirectories: true)
    let source = sourceDir.appendingPathComponent("huge.png")
    try Data(repeating: 0x41, count: 32).write(to: source)
    #expect(throws: MenuBarCustomIconError.tooLarge) {
      try RouterStore.persistCustomMenuBarIcon(
        from: source,
        into: root.appendingPathComponent("support"),
        maxBytes: 16
      )
    }
  }

  @Test("a missing custom file is reported instead of looking selected")
  func missingCustomFileIsFlagged() {
    let loaded = RouterStore.loadCustomMenuBarIcon(path: "/definitely/missing/menu-bar-icon.png")
    #expect(loaded.image == nil)
    #expect(loaded.missing == true)

    let empty = RouterStore.loadCustomMenuBarIcon(path: nil)
    #expect(empty.image == nil)
    #expect(empty.missing == false)
  }

  @Test("the tooltip format keeps its specifiers")
  func tooltipUsesLocalizedFormat() {
    let original = RouterLanguage.selection
    defer { RouterLanguage.setSelection(original) }

    RouterLanguage.setSelection(.english)
    #expect(
      RouterStore.menuBarTooltip(provider: "Grok", state: "Idle", usage: "45% left")
        == "Codex Router · Grok (Idle) · 45% left"
    )
    #expect(
      RouterStore.menuBarTooltip(provider: "Grok", state: "Idle", usage: nil)
        == "Codex Router · Grok (Idle)"
    )

    RouterLanguage.setSelection(.chinese)
    #expect(
      RouterStore.menuBarTooltip(provider: "Grok", state: "空闲", usage: "剩余 45%")
        == "Codex Router · Grok (空闲) · 剩余 45%"
    )
  }
}
