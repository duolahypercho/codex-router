import Foundation
import WidgetKit

// Publish the measured number together with where it came from. Zeroing the
// router-only dates kept the snapshot from overstating account usage, but it
// understated it instead: an account stream that has not reported today yet
// rendered as a confident "0". The schema now carries provenance per point and
// the widget marks the router-only ones, so neither side has to lie.
func routerWidgetDailyPoints(_ points: [DailyUsagePoint]) -> [RouterWidgetDailyPoint] {
  points.map {
    RouterWidgetDailyPoint(
      date: $0.date,
      tokens: RouterWidgetTokenCount.from($0.tokens),
      isRouterFallback: $0.isRouterFallback
    )
  }
}

@MainActor
extension RouterStore {
  func widgetSnapshot(now: Date = Date()) -> RouterWidgetSnapshot {
    var availableProviders = visibleUsageProviders
    if !availableProviders.contains(where: { $0.id == RouterWidgetSnapshot.defaultUsageSourceID }),
       let codex = usageProviderChoices.first(where: {
         $0.id == RouterWidgetSnapshot.defaultUsageSourceID
       }) {
      availableProviders.insert(codex, at: 0)
    }
    let usageSources = availableProviders.map { provider in
      let daily = routerWidgetDailyPoints(dailyUsage(for: provider.id, days: 7))
      return RouterWidgetUsageSource(
        id: provider.id,
        name: provider.id == RouterWidgetSnapshot.defaultUsageSourceID
          ? "Codex"
          : provider.shortName,
        todayTokens: daily.last?.tokens ?? 0,
        daily: daily
      )
    }
    let selectedDaily = routerWidgetDailyPoints(dailyUsage(days: 7))
    return RouterWidgetSnapshot(
      schemaVersion: RouterWidgetSnapshot.schemaVersion,
      generatedAt: now,
      activityState: activityState.rawValue,
      activeChatCount: activeChatCount,
      selectedProviderID: selectedUsageProviderID,
      selectedProviderName: selectedUsageProvider.shortName,
      todayTokens: selectedDaily.last?.tokens ?? 0,
      daily: selectedDaily,
      quotas: desktopQuotaRows.map {
        RouterWidgetQuota(
          id: $0.id,
          providerID: $0.providerID,
          providerName: $0.providerName,
          label: $0.label,
          remainingPercent: RouterWidgetQuota.normalizedRemainingPercent(
            $0.remainingPercent
          ),
          resetAt: $0.resetAt.map(Date.init(timeIntervalSince1970:))
        )
      },
      usageSources: usageSources
    )
  }

  func publishWidgetSnapshot(now: Date = Date()) {
    let snapshot = widgetSnapshot(now: now)
    guard let destination = RouterWidgetSnapshotStore.hostSnapshotURL() else { return }
    let didWrite = (try? RouterWidgetSnapshotStore.write(
      snapshot,
      to: destination,
      now: now
    )) == true

    if didWrite {
      WidgetCenter.shared.reloadTimelines(ofKind: RouterWidgetSnapshot.kind)
      WidgetCenter.shared.reloadTimelines(ofKind: RouterWidgetSnapshot.resetKind)
    }
  }
}
