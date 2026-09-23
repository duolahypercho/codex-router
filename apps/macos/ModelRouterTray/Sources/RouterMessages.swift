import Foundation

/// Stable message IDs for previously inline, two-language native sentences.
/// Regional dictionaries keep word order and complete singular/plural forms.
enum RouterMessageKey: String, CaseIterable {
  case runningChats
  case runningChatsOne
  case runningChatsUpper
  case runningChatsUpperOne
  case chatsRunning
  case chatsRunningOne
  case assignedAgents
  case tokensToday
  case dateTokensCompact
  case agents
  case agentsOne
  case thinkingElapsed
  case moreRequests
  case quotaWindows
  case quotaWindowsOne
  case remainingPercent
  case activeChats
  case requestsShort
  case dayLimit
  case hourLimit
  case minuteLimit
  case sampleReplies
  case sampleRepliesOne
  case oversizeWarning
  case moreQuickPicks
  case cloudCountSuffix
  case noOllamaMatches
  case ollamaMissing
  case ollamaRuntime
  case ollamaFamilySummary
  case benchmarkExplanation
  case modelMetadata
  case tagCount
  case fitCount
  case cloudCount
  case availableNone
  case installedSummary
  case readerEngine
  case enabledSummary
  case visibilitySummary
  case credentialReplacement
  case credentialPaste
  case readyVisibility
  case credentialReplace
  case credentialRemove
  case credentialAdd
  case streakDays
  case providerTraffic
  case periodRequests
  case periodTokens
  case moreModels
  case moreModelsOne
  case tokenCountCompact
  case requestsUnmetered
  case inputOutputRequests
  case providerUsage
  case recentLocalRequests
  case recentLocalUnreported
  case recentLocalTraffic
  case dateTokens
  case meteredApi
  case catalogSummary
  case catalogMatches
  case availableSuffix
  case activityBothOne
  case activityChatOne
  case activityRequestOne
  case activityMany
  case resetSoon
  case resetMinutes
  case resetHours
  case resetDays
}

enum RouterMessageCatalog {
  static let english: [RouterMessageKey: String] = [
    .runningChats: "{count} running chats",
    .runningChatsOne: "{count} running chat",
    .runningChatsUpper: "{count} CHATS RUNNING",
    .runningChatsUpperOne: "{count} CHAT RUNNING",
    .chatsRunning: "{count} chats running",
    .chatsRunningOne: "{count} chat running",
    .assignedAgents: "{count} assigned agents",
    .tokensToday: "{tokens} today",
    .dateTokensCompact: "{date} · {tokens} tok",
    .agents: "{count} agents",
    .agentsOne: "{count} agent",
    .thinkingElapsed: "Thinking · {elapsed}",
    .moreRequests: "+{count} more",
    .quotaWindows: "{count} windows",
    .quotaWindowsOne: "{count} window",
    .remainingPercent: "{count}% left",
    .activeChats: "{count} chats",
    .requestsShort: "{count} req",
    .dayLimit: "{count}-day limit",
    .hourLimit: "{count}-hour limit",
    .minuteLimit: "{count}-minute limit",
    .sampleReplies: "{count} replys",
    .sampleRepliesOne: "{count} reply",
    .oversizeWarning: "{tag} is rated too large for this machine's memory or free disk. It will download, but it may fail to load or run very slowly.",
    .moreQuickPicks: "Show {count} more quick picks",
    .cloudCountSuffix: " · {count} cloud-only",
    .noOllamaMatches: "No Ollama tags match \"{query}\".",
    .ollamaMissing: "Ollama not installed",
    .ollamaRuntime: "{runtime} · headless server {state}",
    .ollamaFamilySummary: "{count} Ollama families; exact tags are grouped above.",
    .benchmarkExplanation: "Speed is measured after install with Ollama's eval counters; unmeasured models show no invented number.",
    .modelMetadata: "{accuracy} · {fit}",
    .tagCount: "{count} tags",
    .fitCount: "{count} fit",
    .cloudCount: "{count} cloud",
    .availableNone: "none installed · {count} available",
    .installedSummary: "{count} installed · {chat} for Codex · {size} GB{suffix}",
    .readerEngine: "Reading via {engine}",
    .enabledSummary: "{count} enabled · {mode}",
    .visibilitySummary: "{visible} visible · {hidden} hidden",
    .credentialReplacement: "Replacement {credential}",
    .credentialPaste: "Paste {credential}",
    .readyVisibility: "Ready · {visibility}",
    .credentialReplace: "Replace {credential}",
    .credentialRemove: "Remove stored {credential}",
    .credentialAdd: "Add {credential}",
    .streakDays: "{count}-day streak",
    .providerTraffic: "{provider} traffic · measured on this Mac",
    .periodRequests: "{tokens} tokens · {requests} requests over {days} days",
    .periodTokens: "{tokens} tokens over {days} days",
    .moreModels: "+{count} more models",
    .moreModelsOne: "+{count} more model",
    .tokenCountCompact: "{tokens} tok",
    .requestsUnmetered: "{count} req · not metered",
    .inputOutputRequests: "{input} in · {output} out · {requests} req",
    .providerUsage: "Show {provider} usage",
    .recentLocalRequests: "7D local · {count} requests",
    .recentLocalUnreported: "7D local · tokens not reported",
    .recentLocalTraffic: "7D local traffic",
    .dateTokens: "{date} · {tokens} tokens",
    .meteredApi: "METERED API",
    .catalogSummary: "{families} families · {count} tags",
    .catalogMatches: "{families} families · {count} matches",
    .availableSuffix: " · {count} available",
    .activityBothOne: "{chats} chat · {requests} request in flight",
    .activityChatOne: "{chats} chat · {requests} requests in flight",
    .activityRequestOne: "{chats} chats · {requests} request in flight",
    .activityMany: "{chats} chats · {requests} requests in flight",
    .resetSoon: "resets soon",
    .resetMinutes: "in {minutes}m",
    .resetHours: "in {hours}h {minutes}m",
    .resetDays: "in {days}d {hours}h",
  ]
  static let simplifiedChinese: [RouterMessageKey: String] = [
    .runningChats: "{count} 个会话运行中",
    .runningChatsOne: "{count} 个会话运行中",
    .runningChatsUpper: "{count} 个会话运行中",
    .runningChatsUpperOne: "{count} 个会话运行中",
    .chatsRunning: "{count} 个会话运行中",
    .chatsRunningOne: "{count} 个会话运行中",
    .assignedAgents: "{count} 个已分配智能体",
    .tokensToday: "今天 {tokens}",
    .dateTokensCompact: "{date} · {tokens} token",
    .agents: "{count} 个代理",
    .agentsOne: "{count} 个代理",
    .thinkingElapsed: "思考中 · {elapsed}",
    .moreRequests: "+{count} 个更多",
    .quotaWindows: "{count} 个窗口",
    .quotaWindowsOne: "{count} 个窗口",
    .remainingPercent: "剩余 {count}%",
    .activeChats: "{count} 个会话",
    .requestsShort: "{count} 个请求",
    .dayLimit: "{count} 天限制",
    .hourLimit: "{count} 小时限制",
    .minuteLimit: "{count} 分钟限制",
    .sampleReplies: "{count} 条回复",
    .sampleRepliesOne: "{count} 条回复",
    .oversizeWarning: "{tag} 对本机内存或可用磁盘空间来说过大。仍会下载，但可能无法加载或运行非常缓慢。",
    .moreQuickPicks: "再显示 {count} 个快速选项",
    .cloudCountSuffix: " · {count} 个仅云端",
    .noOllamaMatches: "没有匹配“{query}”的 Ollama 标签。",
    .ollamaMissing: "Ollama 未安装",
    .ollamaRuntime: "{runtime} · 后台服务器 {state}",
    .ollamaFamilySummary: "上方已按系列归类 {count} 个 Ollama 系列的具体标签。",
    .benchmarkExplanation: "安装后会使用 Ollama 的评测计数器测量速度；未测量的模型不会显示臆造的数字。",
    .modelMetadata: "{accuracy} · {fit}",
    .tagCount: "{count} 个标签",
    .fitCount: "{count} 个适配",
    .cloudCount: "{count} 个云端",
    .availableNone: "尚未安装 · 有 {count} 个可用",
    .installedSummary: "已安装 {count} 个 · {chat} 个可用于 Codex · {size} GB{suffix}",
    .readerEngine: "读取引擎：{engine}",
    .enabledSummary: "{count} 个已启用 · {mode}",
    .visibilitySummary: "{visible} 个显示 · {hidden} 个隐藏",
    .credentialReplacement: "替换{credential}",
    .credentialPaste: "粘贴{credential}",
    .readyVisibility: "就绪 · {visibility}",
    .credentialReplace: "替换{credential}",
    .credentialRemove: "移除已保存的{credential}",
    .credentialAdd: "添加{credential}",
    .streakDays: "连续 {count} 天",
    .providerTraffic: "{provider} 流量 · 本机测量",
    .periodRequests: "{tokens} token · {requests} 个请求 · 近 {days} 天",
    .periodTokens: "{tokens} token · 近 {days} 天",
    .moreModels: "还有 {count} 个模型",
    .moreModelsOne: "还有 {count} 个模型",
    .tokenCountCompact: "{tokens} token",
    .requestsUnmetered: "{count} 个请求 · 未计量",
    .inputOutputRequests: "输入 {input} · 输出 {output} · {requests} 个请求",
    .providerUsage: "显示 {provider} 用量",
    .recentLocalRequests: "近 7 天本地 · {count} 个请求",
    .recentLocalUnreported: "近 7 天本地 · 未报告 token",
    .recentLocalTraffic: "近 7 天本地流量",
    .dateTokens: "{date} · {tokens} token",
    .meteredApi: "计量 API",
    .catalogSummary: "{families} 个系列 · {count} 个标签",
    .catalogMatches: "{families} 个系列 · {count} 个匹配",
    .availableSuffix: " · {count} 个可用",
    .activityBothOne: "{chats} 个会话 · {requests} 个请求进行中",
    .activityChatOne: "{chats} 个会话 · {requests} 个请求进行中",
    .activityRequestOne: "{chats} 个会话 · {requests} 个请求进行中",
    .activityMany: "{chats} 个会话 · {requests} 个请求进行中",
    .resetSoon: "即将重置",
    .resetMinutes: "{minutes} 分钟后",
    .resetHours: "{hours} 小时 {minutes} 分后",
    .resetDays: "{days} 天 {hours} 小时后",
  ]
  static let traditionalChinese: [RouterMessageKey: String] = [
    .runningChats: "{count} 個工作階段運行中",
    .runningChatsOne: "{count} 個工作階段運行中",
    .runningChatsUpper: "{count} 個工作階段運行中",
    .runningChatsUpperOne: "{count} 個工作階段運行中",
    .chatsRunning: "{count} 個工作階段運行中",
    .chatsRunningOne: "{count} 個工作階段運行中",
    .assignedAgents: "{count} 個已分配智能體",
    .tokensToday: "今天 {tokens}",
    .dateTokensCompact: "{date} · {tokens} token",
    .agents: "{count} 個代理",
    .agentsOne: "{count} 個代理",
    .thinkingElapsed: "思考中 · {elapsed}",
    .moreRequests: "+{count} 個更多",
    .quotaWindows: "{count} 個視窗",
    .quotaWindowsOne: "{count} 個視窗",
    .remainingPercent: "剩餘 {count}%",
    .activeChats: "{count} 個工作階段",
    .requestsShort: "{count} 個請求",
    .dayLimit: "{count} 天限制",
    .hourLimit: "{count} 小時限制",
    .minuteLimit: "{count} 分鐘限制",
    .sampleReplies: "{count} 條回復",
    .sampleRepliesOne: "{count} 條回復",
    .oversizeWarning: "{tag} 對本機記憶體或可用磁碟空間來說過大。仍會下載，但可能無法載入或運行非常緩慢。",
    .moreQuickPicks: "再顯示 {count} 個快速選項",
    .cloudCountSuffix: " · {count} 個僅雲端",
    .noOllamaMatches: "沒有匹配“{query}”的 Ollama 標籤。",
    .ollamaMissing: "Ollama 未安裝",
    .ollamaRuntime: "{runtime} · 後台伺服器 {state}",
    .ollamaFamilySummary: "上方已按系列歸類 {count} 個 Ollama 系列的具體標籤。",
    .benchmarkExplanation: "安裝後會使用 Ollama 的評測計數器測量速度；未測量的模型不會顯示臆造的數字。",
    .modelMetadata: "{accuracy} · {fit}",
    .tagCount: "{count} 個標籤",
    .fitCount: "{count} 個適配",
    .cloudCount: "{count} 個雲端",
    .availableNone: "尚未安裝 · 有 {count} 個可用",
    .installedSummary: "已安裝 {count} 個 · {chat} 個可用於 Codex · {size} GB{suffix}",
    .readerEngine: "讀取引擎：{engine}",
    .enabledSummary: "{count} 個已啓用 · {mode}",
    .visibilitySummary: "{visible} 個顯示 · {hidden} 個隱藏",
    .credentialReplacement: "替換{credential}",
    .credentialPaste: "貼上{credential}",
    .readyVisibility: "就緒 · {visibility}",
    .credentialReplace: "替換{credential}",
    .credentialRemove: "移除已保存的{credential}",
    .credentialAdd: "新增{credential}",
    .streakDays: "連續 {count} 天",
    .providerTraffic: "{provider} 流量 · 本機測量",
    .periodRequests: "{tokens} token · {requests} 個請求 · 近 {days} 天",
    .periodTokens: "{tokens} token · 近 {days} 天",
    .moreModels: "還有 {count} 個模型",
    .moreModelsOne: "還有 {count} 個模型",
    .tokenCountCompact: "{tokens} token",
    .requestsUnmetered: "{count} 個請求 · 未計量",
    .inputOutputRequests: "輸入 {input} · 輸出 {output} · {requests} 個請求",
    .providerUsage: "顯示 {provider} 用量",
    .recentLocalRequests: "近 7 天本地 · {count} 個請求",
    .recentLocalUnreported: "近 7 天本地 · 未報告 token",
    .recentLocalTraffic: "近 7 天本地流量",
    .dateTokens: "{date} · {tokens} token",
    .meteredApi: "計量 API",
    .catalogSummary: "{families} 個系列 · {count} 個標籤",
    .catalogMatches: "{families} 個系列 · {count} 個匹配",
    .availableSuffix: " · {count} 個可用",
    .activityBothOne: "{chats} 個工作階段 · {requests} 個請求進行中",
    .activityChatOne: "{chats} 個工作階段 · {requests} 個請求進行中",
    .activityRequestOne: "{chats} 個工作階段 · {requests} 個請求進行中",
    .activityMany: "{chats} 個工作階段 · {requests} 個請求進行中",
    .resetSoon: "即將重置",
    .resetMinutes: "{minutes} 分鐘後",
    .resetHours: "{hours} 小時 {minutes} 分後",
    .resetDays: "{days} 天 {hours} 小時後",
  ]
}

func routerMessage(
  _ key: RouterMessageKey,
  _ values: [String: String] = [:],
  language: ResolvedTrayLanguage = RouterLanguage.resolution
) -> String {
  let table: [RouterMessageKey: String]
  switch language {
  case .chinese: table = RouterMessageCatalog.simplifiedChinese
  case .traditionalChinese: table = RouterMessageCatalog.traditionalChinese
  default: table = RouterMessageCatalog.english
  }
  let template = table[key] ?? RouterMessageCatalog.english[key] ?? key.rawValue
  // Match only the source template, so an inserted model id or user name that
  // contains braces cannot turn into a second interpolation or execute code.
  guard let pattern = try? NSRegularExpression(pattern: #"\{(\w+)\}"#) else { return template }
  let matches = pattern.matches(in: template, range: NSRange(template.startIndex..., in: template))
  var result = template
  for match in matches.reversed() {
    guard let keyRange = Range(match.range(at: 1), in: template),
          let value = values[String(template[keyRange])],
          let range = Range(match.range, in: result) else { continue }
    result.replaceSubrange(range, with: value)
  }
  return result
}
