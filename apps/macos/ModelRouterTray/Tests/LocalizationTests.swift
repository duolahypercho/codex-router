import Foundation
import Testing

@testable import ModelRouterTray

// Serialized: these mutate RouterLanguage.selection, a process-wide value.
// Parallel cases would clobber each other's language mid-assertion.
@Suite("Tray language", .serialized)
struct LocalizationTests {
  @Test("an explicit choice overrides the system language in both directions")
  func explicitChoiceWins() {
    let original = RouterLanguage.selection
    defer { RouterLanguage.setSelection(original) }

    RouterLanguage.setSelection(.english)
    #expect(RouterLanguage.isSimplifiedChinese == false)
    #expect(routerLocalized("Idle") == "Idle")

    RouterLanguage.setSelection(.chinese)
    #expect(RouterLanguage.isSimplifiedChinese == true)
    #expect(routerLocalized("Idle") == "空闲")
  }

  @Test("system follows the OS rather than a stored answer")
  func systemFollowsOS() {
    let original = RouterLanguage.selection
    defer { RouterLanguage.setSelection(original) }
    RouterLanguage.setSelection(.system)
    #expect(RouterLanguage.isSimplifiedChinese == RouterLanguage.systemPrefersChinese)
  }

  @Test("the choice survives a relaunch")
  func selectionPersists() {
    let original = RouterLanguage.selection
    defer { RouterLanguage.setSelection(original) }
    RouterLanguage.setSelection(.chinese)
    // What a fresh launch reads.
    let reloaded = UserDefaults.standard.string(forKey: RouterLanguage.storageKey)
      .flatMap(TrayLanguage.init(rawValue:))
    #expect(reloaded == .chinese)
  }

  @Test("an untranslated string falls back to English rather than rendering empty")
  func fallsBackToEnglish() {
    let original = RouterLanguage.selection
    defer { RouterLanguage.setSelection(original) }
    RouterLanguage.setSelection(.chinese)
    #expect(routerLocalized("no translation exists for this") == "no translation exists for this")
  }

  @Test("each option is labelled in the language it selects")
  func labelsAreSelfDescribing() {
    // Somebody who cannot read the current language still has to find the way out.
    #expect(TrayLanguage.english.label == "English")
    #expect(TrayLanguage.chinese.label == "中文")
    #expect(TrayLanguage.arabic.label == "العربية")
    #expect(TrayLanguage.hindi.label == "हिन्दी")
    #expect(TrayLanguage.japanese.label == "日本語")
    #expect(TrayLanguage.korean.label == "한국어")
  }

  @Test("system names the language it currently resolves to")
  func systemLabelNamesItsResolution() {
    let original = RouterLanguage.selection
    defer { RouterLanguage.setSelection(original) }
    let resolved = RouterLanguage.systemResolution.nativeName

    // The point of the suffix: it must say what you would get, in both modes,
    // so "System" can never read as Chinese while resolving to English.
    RouterLanguage.setSelection(.english)
    #expect(TrayLanguage.system.label == "System · \(resolved)")
    RouterLanguage.setSelection(.chinese)
    #expect(TrayLanguage.system.label == "跟随系统 · \(resolved)")
  }

  @Test(
    "each explicit language renders from its own table",
    arguments: [TrayLanguage.arabic, .hindi, .japanese, .korean]
  )
  func explicitLanguageUsesItsTable(language: TrayLanguage) {
    let original = RouterLanguage.selection
    defer { RouterLanguage.setSelection(original) }
    RouterLanguage.setSelection(language)
    let translated = routerLocalized("Idle")
    #expect(translated != "Idle")
    #expect(translated == RouterLanguage.resolution.table?["Idle"])
  }

  @Test("every language translates exactly the key set Chinese does")
  func keyParityAcrossLanguages() {
    let reference = Set(RouterChineseText.values.keys)
    let tables: [(String, [String: String])] = [
      ("Arabic", RouterArabicText.values),
      ("Hindi", RouterHindiText.values),
      ("Japanese", RouterJapaneseText.values),
      ("Korean", RouterKoreanText.values),
    ]
    for (name, table) in tables {
      let keys = Set(table.keys)
      #expect(
        keys == reference,
        "\(name): missing \(reference.subtracting(keys).sorted()), extra \(keys.subtracting(reference).sorted())"
      )
    }
  }

  @Test("interpolated strings keep their format specifiers")
  func formatSpecifiersSurvive() {
    let original = RouterLanguage.selection
    defer { RouterLanguage.setSelection(original) }
    RouterLanguage.setSelection(.chinese)
    #expect(routerFormat("%d chats", 3) == "3 个会话")
    #expect(routerFormat("%@ left", "5m") == "剩余 5m")
  }

  @Test(
    "every translation keeps the specifiers its English source declares",
    arguments: [
      RouterChineseText.values,
      RouterArabicText.values,
      RouterHindiText.values,
      RouterJapaneseText.values,
      RouterKoreanText.values,
    ]
  )
  func specifierParity(table: [String: String]) {
    func specifiers(_ value: String) -> [String] {
      let pattern = try! NSRegularExpression(pattern: "%[@dfs]|%[0-9]+\\$[@dfs]")
      let range = NSRange(value.startIndex..., in: value)
      return pattern.matches(in: value, range: range).map {
        String(value[Range($0.range, in: value)!])
      }
    }
    for (english, translated) in table {
      #expect(
        specifiers(english) == specifiers(translated),
        "\(english) -> \(translated) changes its format specifiers"
      )
    }
  }
}
