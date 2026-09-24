import Foundation
import Testing
@testable import ModelRouterTray

@Suite("Chinese presentation compatibility")
struct TraditionalChineseTests {
  @Test("Chinese script wins over region and existing preference ids survive")
  func localeResolution() {
    for tag in ["zh-TW", "zh-Hant", "zh-HK", "zh_MO", "zh-Hant-CN", "zh-Hant-x-hans"] {
      #expect(RouterLanguage.resolve(tag) == .traditionalChinese)
    }
    for tag in ["zh", "zh-CN", "zh-SG", "zh-Hans-HK", "zh-Hans-TW", "zh-x-hant", "zh-x-TW", "zh-u-rg-twzzzz"] {
      #expect(RouterLanguage.resolve(tag) == .chinese)
    }
    #expect(TrayLanguage(rawValue: "chinese") == .chinese)
    #expect(ResolvedTrayLanguage.chinese.widgetIdentifier == "chinese")
    #expect(TrayLanguage(rawValue: "traditionalChinese") == .traditionalChinese)
    #expect(ResolvedTrayLanguage.traditionalChinese.widgetIdentifier == "traditionalChinese")
    #expect(RouterLanguage.resolve("unknown") == .english)
    #expect(RouterLanguage.resolve("zh-Latn-TW") == .english)
    #expect(RouterLanguage.resolve("zh---CN") == .english)
  }

  @Test("whole native sentences keep named placeholders in both scripts")
  func catalogParity() throws {
    let pattern = try NSRegularExpression(pattern: #"\{(\w+)\}"#)
    func tokens(_ value: String) -> [String] {
      pattern.matches(in: value, range: NSRange(value.startIndex..., in: value))
        .map { String(value[Range($0.range, in: value)!]) }.sorted()
    }
    let english = RouterMessageCatalog.english
    #expect(Set(english.keys) == Set(RouterMessageKey.allCases))
    for table in [RouterMessageCatalog.simplifiedChinese, RouterMessageCatalog.traditionalChinese] {
      #expect(Set(english.keys) == Set(table.keys))
      for (key, source) in english {
        #expect(tokens(source) == tokens(table[key] ?? ""), "\(key) changed placeholders")
      }
    }
  }

  @Test("inserted model ids are never translated or interpolated a second time")
  func interpolationIsOnePass() {
    let model = "vendor/{count}/file.swift"
    let rendered = routerMessage(.providerUsage, ["provider": model, "count": "BAD"], language: .traditionalChinese)
    #expect(rendered == "顯示 vendor/{count}/file.swift 用量")
    #expect(routerMessage(.remainingPercent, ["count": "25"], language: .chinese) == "剩余 25%")
    #expect(routerMessage(.remainingPercent, ["count": "25"], language: .traditionalChinese) == "剩餘 25%")
    #expect(routerMessage(.remainingPercent, ["count": "25"], language: .english) == "25% left")
    #expect(routerMessage(.remainingPercent, language: .english) == "{count}% left")
    #expect(routerMessage(.runningChatsOne, ["count": "1"], language: .english) == "1 running chat")
    #expect(routerMessage(.runningChats, ["count": "2"], language: .english) == "2 running chats")
  }

  @Test("countdowns use the explicit Traditional locale and retain the legacy override")
  func countdownCompatibility() {
    let now = Date(timeIntervalSince1970: 1_700_000_000)
    #expect(resetCountdownLabel(now, now: now, language: .traditionalChinese) == "即將重置")
    #expect(resetCountdownLabel(now.addingTimeInterval(120), now: now, language: .traditionalChinese) == "2 分鐘後")
    #expect(resetCountdownLabel(now, now: now, chinese: false, language: .traditionalChinese) == "resets soon")
  }
}
