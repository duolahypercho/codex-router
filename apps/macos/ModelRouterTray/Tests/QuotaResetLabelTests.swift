import Foundation
import Testing

@testable import ModelRouterTray

// The status panel's quota-reset rows pair a countdown with a clock time so
// the 5-hour, weekly, and monthly windows read at a glance. The language is
// passed explicitly: the Tray language suite mutates the process-wide
// selection from a parallel suite, so reading it here would race.
@Suite("Quota reset labels")
struct QuotaResetLabelTests {
  let now = Date(timeIntervalSince1970: 1_770_000_000)

  @Test("countdowns collapse to the largest two useful units")
  func countdownUnits() {
    #expect(resetCountdownLabel(now.addingTimeInterval(-5), now: now, chinese: false) == "resets soon")
    #expect(resetCountdownLabel(now.addingTimeInterval(45 * 60), now: now, chinese: false) == "in 45m")
    #expect(resetCountdownLabel(now.addingTimeInterval(2 * 3600 + 14 * 60), now: now, chinese: false) == "in 2h 14m")
    #expect(resetCountdownLabel(now.addingTimeInterval(3 * 24 * 3600 + 5 * 3600), now: now, chinese: false) == "in 3d 5h")
    #expect(resetCountdownLabel(now.addingTimeInterval(45 * 60), now: now, chinese: true) == "45 分钟后")
  }

  @Test("clock labels add calendar context only when the day is not obvious")
  func clockContext() {
    let sameDay = resetClockLabel(now.addingTimeInterval(60), now: now)
    #expect(!sameDay.contains(","))

    let thisWeek = now.addingTimeInterval(3 * 24 * 3600)
    let weekday = thisWeek.formatted(.dateTime.weekday(.abbreviated))
    #expect(resetClockLabel(thisWeek, now: now).contains(weekday))

    let nextMonth = now.addingTimeInterval(20 * 24 * 3600)
    let month = nextMonth.formatted(.dateTime.month(.abbreviated))
    #expect(resetClockLabel(nextMonth, now: now).contains(month))
  }
}
