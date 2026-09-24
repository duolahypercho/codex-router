import Foundation
import Testing

@testable import ModelRouterTray

/// The language tables are only as good as the call sites that read them.
/// `LocalizationTests` proves the tables agree with each other; this suite
/// proves the tray actually asks for a string that is in them, so a new button
/// or status line cannot ship as English-only in Chinese by accident.
///
/// It reads the sources rather than running the UI, because the gap this
/// guards against is a missing dictionary entry, and a missing entry is
/// invisible at runtime -- `routerLocalized` deliberately falls back to the
/// English source text instead of rendering an empty label.
@Suite("Localization coverage")
struct LocalizationCoverageTests {
  /// `@"/Users/…/apps/macos/ModelRouterTray/Tests/<this file>"` at compile time.
  private static var sourcesDirectory: URL {
    URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .appendingPathComponent("Sources", isDirectory: true)
  }

  @Test("every routerLocalized/routerFormat key used by the tray is in the table")
  func keysUsedByTheTrayExist() throws {
    let files = try FileManager.default.contentsOfDirectory(
      at: Self.sourcesDirectory,
      includingPropertiesForKeys: nil
    )
    .filter { $0.pathExtension == "swift" }
    .sorted { $0.lastPathComponent < $1.lastPathComponent }
    #expect(!files.isEmpty)

    let pattern = #"router(?:Localized|Format)\(\s*"((?:[^"\\]|\\.)*)""#
    let regex = try NSRegularExpression(pattern: pattern)
    var missing: [String] = []
    for file in files {
      let text = try String(contentsOf: file, encoding: .utf8)
      let range = NSRange(text.startIndex..., in: text)
      for match in regex.matches(in: text, range: range) {
        guard let keyRange = Range(match.range(at: 1), in: text) else { continue }
        // The regex reads the source file, so an escape such as `\n` arrives
        // as the two characters the file contains. Decode it the way the
        // compiler does, or a key that legitimately contains a newline is
        // reported as missing from a table that has it.
        let key = Self.decodedLiteral(String(text[keyRange]))
        if RouterChineseText.values[key] == nil {
          missing.append("\(file.lastPathComponent): \(key)")
        }
      }
    }
    #expect(missing.isEmpty, "untranslated keys: \(missing.sorted().joined(separator: " | "))")
  }

  /// Resolves the escapes a Swift string literal may carry. Only the ones the
  /// tray's keys actually use are listed; anything else is left untouched so a
  /// path (`./bin/doctor`) or a percent-format specifier passes through.
  private static func decodedLiteral(_ raw: String) -> String {
    var result = ""
    result.reserveCapacity(raw.count)
    var iterator = raw.makeIterator()
    var pending: Character?
    while let character = pending ?? iterator.next() {
      pending = nil
      guard character == "\\" else {
        result.append(character)
        continue
      }
      guard let escape = iterator.next() else {
        result.append("\\")
        break
      }
      switch escape {
      case "n": result.append("\n")
      case "t": result.append("\t")
      case "r": result.append("\r")
      case "\\": result.append("\\")
      case "\"": result.append("\"")
      case "'": result.append("'")
      case "0": result.append("\0")
      default:
        // Unknown escape: keep it verbatim rather than inventing a character.
        result.append("\\")
        pending = escape
      }
    }
    return result
  }

  /// Two helpers localize their arguments, so their call sites carry keys the
  /// regex above cannot see. Both are lists a reviewer can keep in step with
  /// the code by hand.
  @Test("keys passed through the localizing view helpers are in the table")
  func indirectKeysExist() {
    let downloadHeaders = [
      "QWEN MLX",
      "ON THIS MAC",
      "QUICK PICKS",
      "DISCOVER OLLAMA",
      "INSTALL A MODEL",
      "shortlist for this Mac",
      "Ollama tag or URL",
      "LM Studio · 4-bit · ~15 GB",
    ]
    let serviceHealthRows = [
      "Gateway",
      "OAuth forwarder",
      "API forwarder",
    ]
    let toolbarButtons = [
      "Subagents on",
      "Subagents off",
      "Show all",
      "Hide all",
    ]
    for key in downloadHeaders + serviceHealthRows + toolbarButtons {
      #expect(RouterChineseText.values[key] != nil, "\(key) has no Chinese entry")
    }
  }

  @Test("the tray's own status, dialog, and accessibility text is translated")
  func statusAndAccessibilityTextIsTranslated() {
    for english in [
      "Context savings",
      "Tool results compressed into recoverable receipts",
      "%d requests compacted all-time",
      "No compactions in this window",
      "saved all-time",
      "Checking the local runtime and downloader",
      "Qwen3.8 27B MLX is ready for Codex. Fully quit and reopen Codex to refresh its picker.",
      "No local model operation is running.",
      "Local model removal failed",
      "Apple silicon required",
      "Served only on this Mac and published to the Codex model picker.",
      "Reduced safety guardrails. Treat outputs as untrusted and keep the server local.",
      "Install runtime + ~15 GB model and wire Codex",
      "Codex Router usage widget",
      "%@ tokens over %d days",
      "%d percent left",
      "%@, %@, %@, %@",
      "Running update and doctor…",
      "Model settings applied. Restart Codex to refresh its picker.",
    ] {
      let translated = RouterChineseText.values[english]
      #expect(translated != nil, "\(english) has no Chinese entry")
      #expect(translated != english, "\(english) is still English in Chinese")
    }
    // Control: the lookup falls back to the English source text, which is what
    // an untranslated key renders as.
    #expect((RouterChineseText.values["no translation exists for this"] ?? "no translation exists for this")
      == "no translation exists for this")
  }

  @Test("composed status text keeps its numbers and reads in Chinese")
  func composedStatusTextRenders() {
    // Composed through the Chinese table directly rather than through
    // `routerFormat`, whose language is process-wide and is mutated by the
    // serialized language suite while other suites run in parallel.
    #expect(chineseFormat("%d requests compacted all-time", 12) == "累计压缩 12 个请求")
    #expect(chineseFormat("~%@ tok", "1.2M") == "~1.2M tok")
    #expect(chineseFormat("Detected: %@ · %@", "macOS", "arm64") == "检测到：macOS · arm64")
    #expect(chineseFormat("%d percent left", 42) == "剩余 42%")
    #expect(
      chineseFormat("%@, %@, %@", "ChatGPT", "5 小时限制", "剩余 42%")
        == "ChatGPT，5 小时限制，剩余 42%"
    )
  }

  private func chineseFormat(_ english: String, _ arguments: CVarArg...) -> String {
    String(format: RouterChineseText.values[english] ?? english, arguments: arguments)
  }
}
