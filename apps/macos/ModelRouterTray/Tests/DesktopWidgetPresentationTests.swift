import Foundation
import Testing

@testable import ModelRouterTray

@Suite("Desktop widget presentation")
struct DesktopWidgetPresentationTests {
  @Test("today tokens render as a full scannable count")
  func tokenCountFormatting() {
    #expect(DesktopWidgetPresentation.tokenCountLabel(0) == "0")
    #expect(DesktopWidgetPresentation.tokenCountLabel(1_410_272_747) == "1,410,272,747")
    #expect(DesktopWidgetPresentation.tokenCountLabel(-50) == "0")
    #expect(DesktopWidgetPresentation.tokenCountLabel(.infinity) == "0")
  }

  @Test("quota colors change only at the warning boundaries")
  func quotaSeverityBoundaries() {
    #expect(DesktopWidgetPresentation.quotaSeverity(31) == .healthy)
    #expect(DesktopWidgetPresentation.quotaSeverity(30) == .warning)
    #expect(DesktopWidgetPresentation.quotaSeverity(11) == .warning)
    #expect(DesktopWidgetPresentation.quotaSeverity(10) == .critical)
  }

  @Test("quota accessibility carries provider, window, remaining amount, and reset")
  func quotaAccessibility() {
    let now = Date(timeIntervalSince1970: 1_770_000_000)
    let row = DesktopQuotaRow(
      id: "openai-primary",
      providerID: "openai",
      providerName: "ChatGPT",
      label: "5-hour limit",
      remainingPercent: 42,
      resetAt: now.addingTimeInterval(2 * 3600 + 12 * 60).timeIntervalSince1970
    )
    #expect(
      DesktopWidgetPresentation.quotaAccessibilityLabel(row, now: now, language: .english)
        == "ChatGPT, 5-hour limit, 42 percent left, in 2h 12m"
    )
  }

  @Test("the same quota label reads in Chinese when that is the selected language")
  func quotaAccessibilityInChinese() {
    let now = Date(timeIntervalSince1970: 1_770_000_000)
    let row = DesktopQuotaRow(
      id: "openai-primary",
      providerID: "openai",
      providerName: "ChatGPT",
      label: "5-hour limit",
      remainingPercent: 42,
      resetAt: now.addingTimeInterval(2 * 3600 + 12 * 60).timeIntervalSince1970
    )
    #expect(
      DesktopWidgetPresentation.quotaAccessibilityLabel(row, now: now, language: .chinese)
        == "ChatGPT，5 小时限制，剩余 42%，2 小时 12 分后"
    )
  }
}
