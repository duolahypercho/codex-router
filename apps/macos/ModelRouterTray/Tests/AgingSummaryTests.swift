import Foundation
import Testing

@testable import ModelRouterTray

// The savings card has to explain an idle pass without contradicting itself.
// Size is only one of the two reasons a result is skipped -- a result the
// model has not acted on yet is passed over whatever its size -- so the copy
// has to agree with the number printed beside it.
@Suite("Tool-result aging summary")
struct AgingSummaryTests {
  private func stats(
    requests: Int? = nil,
    evaluated: Int? = nil,
    largest: Int? = nil,
    bytesSaved: Int? = nil,
    tokensSaved: Int? = nil,
  ) -> ToolResultAgingStats {
    let payload: [String: Any] = [
      "requests": requests as Any,
      "evaluatedRequests": evaluated as Any,
      "largestResultBytes": largest as Any,
      "bytesSaved": bytesSaved as Any,
      "estimatedTokensSaved": tokensSaved as Any,
    ].compactMapValues { $0 is NSNull ? nil : $0 }
    let data = try! JSONSerialization.data(withJSONObject: payload)
    return try! JSONDecoder().decode(ToolResultAgingStats.self, from: data)
  }

  @Test("a pass that never ran stays silent")
  func neverRan() {
    #expect(stats().savingsSummary == nil)
    #expect(stats(evaluated: 0).savingsSummary == nil)
  }

  @Test("an idle pass under the floor names the floor")
  func idleUnderFloor() {
    let summary = stats(evaluated: 8, largest: 12_000).savingsSummary
    #expect(summary == "No result over 32 KB in 8 requests (largest 12 KB)")
  }

  @Test("an idle pass over the floor does not claim nothing was big enough")
  func idleOverFloor() {
    // 40 KB cleared the floor and still aged nothing, so the blocker was the
    // acted-after gate. Saying "no result over 32 KB (largest 40 KB)" would
    // contradict itself in one sentence.
    let summary = stats(evaluated: 5, largest: 40 * 1024).savingsSummary
    #expect(summary?.contains("No result over 32 KB") == false)
    #expect(summary == "Nothing aged yet in 5 requests (largest 40 KB)")
  }

  @Test("a pass that saved something reports the savings instead")
  func reportsSavings() {
    let summary = stats(
      requests: 3,
      evaluated: 9,
      largest: 90_000,
      bytesSaved: 2 * 1024 * 1024,
      tokensSaved: 4_000,
    ).savingsSummary
    #expect(summary?.hasPrefix("Saved ~") == true)
    #expect(summary?.contains("across 3 requests") == true)
  }
}
