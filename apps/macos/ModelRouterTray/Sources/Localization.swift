import Foundation

/// The language the tray renders in. `system` follows macOS's preferred
/// languages, which is what somebody who has already set their Mac to Chinese
/// expects; the explicit cases are for everyone whose Mac is in one language
/// and who wants this app in another. That combination is common enough --
/// a Chinese speaker on an English macOS install, or the reverse -- that
/// following the OS alone leaves them with no way to ask.
enum TrayLanguage: String, CaseIterable, Identifiable {
  case system
  case english
  case chinese
  case arabic
  case hindi
  case japanese
  case korean

  var id: String { rawValue }

  /// Deliberately shown in the language each option selects, not in the
  /// current one: somebody who cannot read the current language still has to
  /// be able to find their way out.
  ///
  /// `system` additionally names what it currently resolves to. Without that
  /// it is the one option whose label says nothing about the language you
  /// would get -- and worse, it is itself translated, so picking Chinese makes
  /// "System" read as 跟随系统 even on an English Mac, which looks like the
  /// setting is stuck.
  var label: String {
    switch self {
    case .system:
      return "\(routerLocalized("System")) · \(RouterLanguage.systemResolution.nativeName)"
    case .english: return "English"
    case .chinese: return "中文"
    case .arabic: return "العربية"
    case .hindi: return "हिन्दी"
    case .japanese: return "日本語"
    case .korean: return "한국어"
    }
  }
}

/// A concrete language the tray can render in: `TrayLanguage` minus `system`,
/// which resolves to one of these.
enum ResolvedTrayLanguage {
  case english
  case chinese
  case arabic
  case hindi
  case japanese
  case korean

  var nativeName: String {
    switch self {
    case .english: return "English"
    case .chinese: return "中文"
    case .arabic: return "العربية"
    case .hindi: return "हिन्दी"
    case .japanese: return "日本語"
    case .korean: return "한국어"
    }
  }

  /// English is the source text itself, so it carries no table.
  var table: [String: String]? {
    switch self {
    case .english: return nil
    case .chinese: return RouterChineseText.values
    case .arabic: return RouterArabicText.values
    case .hindi: return RouterHindiText.values
    case .japanese: return RouterJapaneseText.values
    case .korean: return RouterKoreanText.values
    }
  }

  /// The identifier this language is published under in the widget snapshot.
  /// The widget extension is a separate process with its own bundle, so it
  /// cannot read `RouterLanguage`; the tray has to carry the choice over.
  var widgetIdentifier: String {
    switch self {
    case .english: return "english"
    case .chinese: return "chinese"
    case .arabic: return "arabic"
    case .hindi: return "hindi"
    case .japanese: return "japanese"
    case .korean: return "korean"
    }
  }
}

enum RouterLanguage {
  static let storageKey = "ModelRouterTray.language"

  /// Read on every localized string, so it is cached rather than hitting
  /// UserDefaults each time. `setSelection` is the only writer.
  private(set) static var selection: TrayLanguage = {
    let raw = UserDefaults.standard.string(forKey: storageKey)
    return raw.flatMap(TrayLanguage.init(rawValue:)) ?? .system
  }()

  static func setSelection(_ next: TrayLanguage) {
    selection = next
    UserDefaults.standard.set(next.rawValue, forKey: storageKey)
  }

  static var systemResolution: ResolvedTrayLanguage {
    let preferred = (Locale.preferredLanguages.first ?? Locale.current.identifier).lowercased()
    if preferred.hasPrefix("zh") { return .chinese }
    if preferred.hasPrefix("ar") { return .arabic }
    if preferred.hasPrefix("hi") { return .hindi }
    if preferred.hasPrefix("ja") { return .japanese }
    if preferred.hasPrefix("ko") { return .korean }
    return .english
  }

  static var systemPrefersChinese: Bool { systemResolution == .chinese }

  static var resolution: ResolvedTrayLanguage {
    switch selection {
    case .system: return systemResolution
    case .english: return .english
    case .chinese: return .chinese
    case .arabic: return .arabic
    case .hindi: return .hindi
    case .japanese: return .japanese
    case .korean: return .korean
    }
  }

  /// Kept for the call sites that compose Chinese strings inline; those fall
  /// back to English in every other translated language.
  static var isSimplifiedChinese: Bool { resolution == .chinese }
}

/// Small, dependency-free localization layer for strings rendered by the
/// native tray and Dynamic Island. English remains the source text and the
/// fallback, so a newly added string is still usable before its translation is
/// added.
func routerLocalized(_ english: String) -> String {
  RouterLanguage.resolution.table?[english] ?? english
}

func routerFormat(_ english: String, _ arguments: CVarArg...) -> String {
  let format = routerLocalized(english)
  return String(format: format, arguments: arguments)
}

enum RouterChineseText {
  static let values: [String: String] = [
    "Uninstalling": "正在卸载",
    "Off by default · compacts old results; RTK shapes routed compaction": "默认关闭 · 压缩旧结果；RTK 精简路由压缩输出",
    "Fix Codex Router installation": "修复 Codex 路由安装",
    "Language": "语言",
    "System": "跟随系统",
    "Tray language. Reopen the panel to apply everywhere.": "托盘语言。重新打开面板即可全部生效。",
    "Usage and activity over the notch on every display": "在每个显示器的刘海处显示用量和活动",
    "Off by default. The menu-bar panel stays available either way.": "默认关闭。无论如何，菜单栏面板始终可用。",
    "Idle": "空闲",
    "LOCAL FALLBACK": "本地回退",
    "local fallback": "本地回退",
    "%d local fallback dates": "%d 天使用本地回退",
    "1 local fallback date": "1 天使用本地回退",
    "OpenAI account usage; missing dates use local router fallback": "OpenAI 账户用量；缺失日期使用本地路由器回退",
    "OpenAI supplied no account bucket for these dates; local router traffic fills the gap. These are not global account totals.": "OpenAI 未提供这些日期的账户用量桶，已用本地路由器流量填补；这些数据不是全局账户总量。",
    "Thinking": "思考中",
    "Starting": "启动中",
    "Error": "错误",
    "Codex subscription": "Codex 订阅",
    "%@ left": "剩余 %@",
    "%d chats": "%d 个会话",
    "Active session": "活动会话",
    "No traffic": "暂无流量",
    "Ready to enable": "已准备好启用",
    "Needs setup": "需要设置",
    "OAuth · enabled": "OAuth · 已启用",
    "API · enabled": "API · 已启用",
    "Always": "始终显示",
    "With Codex": "随 Codex 显示",
    "Off": "关闭",
    "Notch": "刘海区域",
    "Desktop": "桌面",
    "Usage": "用量",
    "Usage and live activity": "用量与实时活动",
    "Status": "状态",
    "Settings": "设置",
    "Control Center": "控制中心",
    "Codex Router": "Codex Router",
    "Updated": "已更新",
    "None": "无",
    "none": "无",
    "Local": "本地",
    "Auto": "自动",
    "Codex account": "Codex 账户",
    "ChatGPT %@": "ChatGPT %@",
    "ChatGPT limit": "ChatGPT 限制",
    "Current usage": "当前用量",
    "All usage": "全部用量",
    "7-day snapshot": "过去 7 天快照",
    "Tokens by model": "按模型统计 token",
    "Router": "路由",
    "Model speed": "模型速度",
    "Live requests": "实时请求",
    "Quota resets": "额度重置",
    "No traffic right now": "当前没有流量",
    "Ready for the next request": "已准备好处理下一个请求",
    "No model observed": "尚未观测到模型",
    "No usage recorded yet": "尚未记录用量",
    "Waiting": "等待中",
    "No samples": "暂无样本",
    "Appears after a metered reply": "完成一次计量回复后显示",
    "Observed output throughput": "已观测的输出吞吐量",
    "Nothing in flight": "当前没有进行中的请求",
    "no tools — can't chat": "没有工具 — 无法聊天",
    "works in Codex": "可在 Codex 中运行",
    "unreliable in Codex": "在 Codex 中不稳定",
    "not offered yet": "暂未提供",
    "fails in Codex": "在 Codex 中失败",
    "chat — untested": "聊天 — 未测试",
    "Provider added. Restart Codex to refresh its model picker.": "提供商已添加。请重启 Codex 以刷新模型选择器。",
    "Provider hidden. Restart Codex to refresh its model picker.": "提供商已隐藏。请重启 Codex 以刷新模型选择器。",
    "Show tray": "显示菜单栏图标",
    "Appears with Codex or ChatGPT, hides when they quit": "Codex 或 ChatGPT 运行时显示，退出后隐藏",
    "Kept on: a terminal session has no window to follow": "保持开启：终端会话没有可跟随的窗口",
    "DeepSeek Harness": "DeepSeek Harness",
    "Install DeepSeek Harness and publish this router's models into it": "安装 DeepSeek Harness 并将本路由的模型发布到其中",
    "Not installed · installs the CLI, then publishes this router's models": "未安装 · 将安装 CLI，然后发布本路由的模型",
    "Needs Node %@ or newer; this router runs Node %@": "需要 Node %@ 或更高版本；本路由运行的是 Node %@",
    "%@ · routed models published · `dsh web` to start": "%@ · 已发布路由模型 · 运行 `dsh web` 启动",
    "%@ · installed but not routed here yet": "%@ · 已安装，但尚未接入本路由",
    "%d models published. Run `%@` to start.": "已发布 %d 个模型。运行 `%@` 启动。",
    "Installing DeepSeek Harness…": "正在安装 DeepSeek Harness…",
    "Publishing routed models…": "正在发布路由模型…",
    "Setting up DeepSeek Harness": "正在设置 DeepSeek Harness",
    "Connect": "接入",
    "Open site": "打开网页",
    "Turn off": "关闭",
    "Disconnect": "断开连接",
    "Stopping…": "正在停止…",
    "Stopped. Memory and CPU released.": "已停止。内存和 CPU 已释放。",
    "This harness was started outside the router — stop it where you started it.": "该 Harness 不是由本路由启动的 — 请在启动它的位置停止。",
    "Stop the harness process and free its memory and CPU": "停止 Harness 进程并释放其内存和 CPU",
    "Disconnecting…": "正在断开…",
    "Turned off. The harness and its own settings were kept.": "已关闭。Harness 及其自身设置已保留。",
    "Remove this router's models from the harness, keeping the harness itself": "从 Harness 中移除本路由的模型，但保留 Harness 本身",
    "Start": "启动",
    "Open the DeepSeek Harness browser UI": "打开 DeepSeek Harness 浏览器界面",
    "Start the DeepSeek Harness browser UI": "启动 DeepSeek Harness 浏览器界面",
    "Starting DeepSeek Harness…": "正在启动 DeepSeek Harness…",
    "%@ · running at %@": "%@ · 运行于 %@",
    "%@ · routed models published · not running": "%@ · 已发布路由模型 · 未运行",
    "%d models published. Press play to open the harness.": "已发布 %d 个模型。按播放按钮打开 Harness。",
    "%d models published, but the harness UI did not start: %@": "已发布 %d 个模型，但 Harness 界面未能启动：%@",
    "Menu bar icon stays visible": "菜单栏图标始终显示",
    "Dynamic Island": "动态岛",
    "Quotas and live activity pinned to the desktop": "将额度和实时活动固定在桌面",
    "Show provider usage and activity status": "显示提供商用量和活动状态",
    "Use Router with ChatGPT": "在 ChatGPT 中使用路由",
    "Turn off 'Use Router with ChatGPT' first": "请先关闭「在 ChatGPT 中使用路由」",
    "Turn off 'Use without OpenAI login' first": "请先关闭「不使用 OpenAI 登录」",
    "Share ChatGPT subscription": "共享 ChatGPT 订阅",
    "Sharing status unavailable": "无法读取共享状态",
    "Sharing enabled": "共享已启用",
    "Sharing disabled": "共享已禁用",
    "login usable · about %@h left": "登录可用 · 约剩 %@ 小时",
    "login usable": "登录可用",
    "login expired": "登录已过期",
    "login unavailable · sign-in data detected": "登录不可用 · 检测到登录数据",
    "login unavailable · run codex login": "登录不可用 · 请运行 codex login",
    "Enable ChatGPT session sharing?": "启用 ChatGPT 会话共享？",
    "Enabling lets other local Codex Router clients spend this user's ChatGPT subscription. Only continue for clients you trust on this Mac.": "启用后，其他本地 Codex Router 客户端可以消耗此用户的 ChatGPT 订阅。仅对这台 Mac 上你信任的客户端继续。",
    "Enable sharing": "启用共享",
    "A usable ChatGPT login is required before sharing can be enabled. Run codex login first.": "启用共享前需要可用的 ChatGPT 登录。请先运行 codex login。",
    "ChatGPT session-sharing status is unavailable. Refresh before changing it.": "无法读取 ChatGPT 会话共享状态。请刷新后再更改。",
    "ChatGPT session sharing enabled for local router clients.": "已为本地路由客户端启用 ChatGPT 会话共享。",
    "ChatGPT session sharing disabled. Installed client catalogs were refreshed.": "已禁用 ChatGPT 会话共享，并刷新了已安装客户端的目录。",
    "Native GPT + external models · task history preserved": "原生 GPT + 外部模型 · 保留任务历史",
    "Keep ChatGPT login and the current task history": "保留 ChatGPT 登录和当前任务历史",
    "Use without OpenAI login": "不使用 OpenAI 登录",
    "External providers · Codex restarts automatically": "外部提供商 · Codex 会自动重启",
    "Use connected models and restart Codex": "使用已连接模型并重启 Codex",
    "Token maxxing": "Token 精简",
    "Cannot run subagents": "无法运行子代理",
    "Effort as subagent": "作为子代理的思考强度",
    "Forced off by CODEX_ROUTER_TOOL_RESULT_AGING=0": "已被 CODEX_ROUTER_TOOL_RESULT_AGING=0 强制关闭",
    "External models · applies on the next request": "外部模型 · 下次请求生效",
    "Providers": "提供商",
    "Auto-saved": "自动保存",
    "Applying…": "应用中…",
    "Subagent models": "子代理模型",
    "All proven models": "所有已验证模型",
    "Model picker": "模型选择器",
    "Local LLMs": "本地 LLM",
    "Vision": "视觉",
    "Subagent choices do not hide models from Codex's picker — use Model picker below for that.": "子代理选择不会隐藏 Codex 选择器中的模型；如需隐藏模型，请使用下面的模型选择器。",
    "Hidden models stay connected but are not offered by Codex.": "隐藏的模型仍保持连接，但不会提供给 Codex。",
    "Run models locally through Ollama. Enable an installed model to make it available to Codex.": "通过 Ollama 在本地运行模型。启用已安装的模型即可提供给 Codex。",
    "Run local models through Ollama or the curated MLX runtime. Installed models are wired into the same Codex proxy.": "通过 Ollama 或精选的 MLX 运行时在本地运行模型。已安装的模型会接入同一个 Codex 代理。",
    "Nothing installed yet. Start with a quick pick or browse the Ollama catalog below.": "尚未安装模型。请选择快速选项，或浏览下面的 Ollama 目录。",
    "Install a model": "安装模型",
    "Install": "安装",
    "Clear": "清除",
    "Download": "下载",
    "Cancel": "取消",
    "Confirm": "确认",
    "Confirm removal?": "确认移除？",
    "Remove model": "移除模型",
    "Measure speed": "测量速度",
    "Test image reading": "测试图像读取",
    "Use for image reading": "用于图像读取",
    "Reading images": "读取图像",
    "loaded": "已加载",
    "Installing local model": "正在安装本地模型",
    "Local model ready": "本地模型已就绪",
    "Local model install failed": "本地模型安装失败",
    "Text-only models can't see images. When on, a vision model reads the paste and hands over the text.": "纯文本模型无法查看图像。开启后，将使用视觉模型读取粘贴内容并交给文本模型。",
    "Read images for text-only models": "为纯文本模型读取图像",
    "Engine": "引擎",
    "Paid (cloud)": "付费（云端）",
    "Your ChatGPT plan": "你的 ChatGPT 方案",
    "Model default": "模型默认",
    "Update": "更新",
    "Fix": "修复",
    "Working…": "处理中…",
    "Update or fix failed": "更新或修复失败",
    "Router unavailable": "路由不可用",
    "Run setup, then refresh this panel.": "请先运行设置，然后刷新此面板。",
    "Refresh": "刷新",
    "Refreshing…": "刷新中…",
    "%d accounts": "%d 个账号",
    "1 account": "1 个账号",
    "Restart": "重启",
    "Restarting…": "正在重启…",
    "Restart failed: %@": "重启失败：%@",
    "Restarted without updating: %@": "已重启但未更新：%@",
    "Awaiting data": "等待数据",
    "Quit": "退出",
    "API key": "API 密钥",
    "Replacement %@": "替换 %@",
    "Paste %@": "粘贴 %@",
    "Click the check again to delete this credential": "再次点击勾号以删除此凭据",
    "Checking setup…": "正在检查设置…",
    "Session expired · reconnect for account usage": "会话已过期 · 请重新连接以查看账户用量",
    "Official CLI required": "需要官方 CLI",
    "Sign in with the official CLI": "使用官方 CLI 登录",
    "Operator-owned Google OAuth client required": "需要操作者自有的 Google OAuth 客户端",
    "Live test required · sends a small prompt and uses quota": "需要实时测试 · 会发送一条简短提示并消耗配额",
    "Disconnect the incompatible router record before signing in": "请先断开不兼容的路由器凭据记录，再登录",
    "Setup required": "需要设置",
    "Reconnect": "重新连接",
    "Reconnect OAuth": "重新连接 OAuth",
    "Open browser sign-in": "打开浏览器登录",
    "Finish sign-in in browser": "在浏览器中完成登录",
    "OAuth sessions refresh automatically. Reconnect opens browser sign-in when approval is required.": "OAuth 会话会自动刷新。需要重新授权时，“重新连接”会打开浏览器登录。",
    "Install & Sign In": "安装并登录",
    "Sign In": "登录",
    "Install the official CLI and sign in": "安装官方 CLI 并登录",
    "Sign in again with the official CLI": "使用官方 CLI 重新登录",
    "Cancel credential replacement": "取消替换凭据",
    "Click again to delete the stored credential": "再次点击以删除已保存的凭据",
    "Remove stored OAuth client and session": "移除已保存的 OAuth 客户端和会话",
    "Test & Enable": "测试并启用",
    "Remove stored %@": "移除已保存的 %@",
    "Available in Codex": "可在 Codex 中使用",
    "Hidden from Codex": "已从 Codex 隐藏",
    "Signed in": "已登录",
    "Add Key": "添加密钥",
    "Save": "保存",
    "Open usage dashboard": "打开用量面板",
    "Daily token usage": "每日 token 用量",
    "Full": "完整",
    "Full token numbers": "完整 token 数",
    "Millions of tokens": "百万 token",
    "Token unit": "token 单位",
    "Router traffic": "路由流量",
    "Loading provider usage…": "正在加载提供商用量…",
    "Loading native Codex usage…": "正在加载原生 Codex 用量…",
    "Set up this provider below to fetch its account usage.": "请在下方设置此提供商以获取账户用量。",
    "Usage limit": "用量限制",
    "No reset reported": "未提供重置时间",
    "Reconnect below": "请在下方重新连接",
    "OAuth expired · reconnect below": "OAuth 已过期 · 请在下方重新连接",
    "No router traffic yet": "尚无路由流量",
    "Configured · currently hidden": "已配置 · 当前隐藏",
    "Sign in again to restore quota": "请重新登录以恢复额度",
    "Local router traffic": "本地路由流量",
    "What do these tags mean?": "这些标签是什么意思？",
    "Hide tag guide": "隐藏标签说明",
    "Show fewer tags": "收起标签",
    "View all %@ tags": "查看全部 %@ 个标签",
    "Hide machine & runtime": "隐藏设备和运行时",
    "Machine & runtime": "设备和运行时",
    "Show fewer quick picks": "收起快速选项",
    "View more quick picks": "查看更多快速选项",
    "Show all": "全部显示",
    "Hide all": "全部隐藏",
    "Update and verify Codex Router": "更新并验证 Codex 路由",
    "Running Codex Router maintenance": "正在维护 Codex 路由",
    "Daily token usage chart. Hover a day for its displayed token count.": "每日 token 用量图表。将鼠标悬停在某天上可查看当前显示的 token 数。",
    "Show %@ usage": "显示 %@ 用量",
    "WEEKLY LEFT": "每周剩余",
    "TODAY TOKENS": "今日 token",
    "DAILY USAGE": "每日用量",
    "LAST 7 DAYS": "过去 7 天",
    "Collapse": "收起",
    "TODAY'S TOKENS": "今日 token",
    "DAILY TOKEN TREND": "每日 token 趋势",
    "ACTIVE NOW": "当前活动",
    "ACTIVE PROVIDER": "当前提供商",
    "USED": "已使用",
    "Account and traffic are provider-scoped": "账户和流量按提供商区分",
    "Live": "实时",
    "Last used": "上次使用",
    "Running chats": "运行中的会话",
    "Router overview": "路由概览",
    "Ready": "就绪",
    "CHATGPT • NATIVE": "CHATGPT · 原生",
    "XAI • OAUTH SESSION": "XAI · OAUTH 会话",
    "XAI • METERED API": "XAI · 计量 API",
    "METERED API": "计量 API",
    "OAUTH ROUTE": "OAUTH 路由",
    "ChatGPT account usage": "ChatGPT 账户用量",
    "Measured by this router": "由此路由测量",
    "Not reported by provider": "提供商未报告",
    "Thinking · %@": "思考中 · %@",
    "ROUTER": "路由",
    "QUOTAS": "额度",
    "Connect a provider to see its quota here.": "连接提供商后可在此查看额度。",
    "DAILY TOKENS": "每日 token",
    "resets soon": "即将重置",
    "Download anyway?": "仍要下载？",
    "local model": "本地模型",
    "none installed": "尚未安装",
    "installed": "已安装",
    "ON THIS MAC": "本机",
    "MODEL": "模型",
    "SIZE": "大小",
    "QUICK PICKS": "快速选项",
    "shortlist for this Mac": "适合本机的精选",
    "CODING": "编程",
    "IMAGE READING": "图像读取",
    "DISCOVER OLLAMA": "发现 Ollama",
    "cloud-only": "仅云端",
    "Size tags choose the model scale. Q4/Q8/BF16 are weight precision; MLX/NVFP4 are hardware-oriented builds; cloud tags run remotely. Codex compatibility is checked only after a pull.": "大小标签表示模型规模。Q4/Q8/BF16 是权重精度，MLX/NVFP4 是面向硬件的构建，云端标签表示远程运行。只有拉取模型后才会检查 Codex 兼容性。",
    "Search family or tag": "搜索系列或标签",
    "INSTALL A MODEL": "安装模型",
    "Ollama tag or URL": "Ollama 标签或 URL",
    "Use a tag or model-page URL. Downloads stay headless.": "输入标签或模型页面 URL。下载会在后台进行。",
    "gemma4:12b or ollama.com/library/gemma4:12b": "gemma4:12b 或 ollama.com/library/gemma4:12b",
    "BEST FIT FOR THIS MAC": "最适合本机",
    "CLOUD ONLY · NO LOCAL DOWNLOAD": "仅云端 · 不下载本地模型",
    "NO LOCAL VARIANT FITS THIS MAC": "没有适配本机的本地变体",
    "managed": "已管理",
    "not started": "未启动",
    "Models:": "模型：",
    "Update Ollama": "更新 Ollama",
    "cloud": "云端",
    "won't fit": "无法适配",
    "cloud only": "仅云端",
    "Anyway": "仍要下载",
    "Default": "默认",
    "Cloud": "云端",
    "Apple Silicon build": "Apple 芯片构建",
    "NVFP4 build": "NVFP4 构建",
    "4-bit build": "4 位构建",
    "8-bit build": "8 位构建",
    "BF16 build": "BF16 构建",
    "Coding build": "编程构建",
    "Specialized build": "专用构建",
    "BEST FIT": "最适合",
    "CLOUD": "云端",
    "DEFAULT": "默认",
    "TIGHT": "内存紧张",
    "WON'T FIT": "无法适配",
    "memory tight": "内存紧张",
    "verified": "已验证",
    "untested": "未测试",
    "accurate": "准确",
    "inaccurate": "不准确",
    "tight": "紧张",
    "too-large": "过大",
    "good": "适合",
    "tags": "标签",
    "fit": "适配",
    "none fit": "无适配项",
    "Local model": "本地模型",
    "Installing": "正在安装",
    "testing…": "测试中…",
    "Actions for %@": "%@ 的操作",
    "speed unmeasured": "速度未测量",
    "vision only — no tools": "仅视觉 — 不支持工具",
    "Downloading": "正在下载",
    "Last download failed": "上次下载失败",
    "ChatGPT subscription": "ChatGPT 订阅",
    "measured on this Mac": "在本机测量",
    "tokens": "token",
    "requests": "请求",
    "All good": "一切正常",
    "Router ready": "路由已就绪",
    "Current limit": "当前限制",
    "Daily limit": "每日限制",
    "Weekly limit": "每周限制",
    "Monthly limit": "每月限制",
    "5-hour limit": "5 小时限制",
    "Hidden from picker — show it below to use it here": "已从选择器隐藏 — 请在下方显示后才能使用",
    "Apply the checked-out router revision, then run the Codex doctor": "应用已检出的路由版本，然后运行 Codex doctor",
    "Run the Codex doctor and repair managed router files": "运行 Codex doctor 并修复受管理的路由文件",
    "Sign in or paste an API key": "登录或粘贴 API 密钥",
    "required": "必填",
    "Checking…": "检查中…",
    "Reading via": "读取引擎",
    "Off — text-only models refuse pasted images": "关闭 — 纯文本模型无法读取粘贴的图像",
    "Daily token usage line chart": "每日 token 用量折线图",
    "agent": "代理",
    "agents": "代理",
    "Active": "活动中",
    "Low": "低",
    "Medium": "中",
    "High": "高",
    "Model provider": "模型提供商",
    "Resets": "重置时间",
    "Menu bar mode": "菜单栏模式",
    "Standard": "标准模式",
    "Icon only": "仅图标",
    "Compact icon only, no model name text": "仅显示紧凑图标，隐藏模型名称文本",
    "Show icon, model name, and usage": "显示图标、模型名称及用量",
    "Show model name": "显示模型名称",
    "Current model or provider is visible in menu bar": "在菜单栏中显示当前模型或提供商名称",
    "Hide model name text in menu bar": "在菜单栏中隐藏模型名称文本",
    "Menu bar icon": "菜单栏图标",
    "Router mark": "路由器标志",
    "Provider icon": "提供商图标",
    "Activity dot": "活动状态点",
    "Preset icon": "预设图标",
    "Custom image": "自定义图片",
    "Choose the icon displayed in the menu bar": "选择菜单栏中显示的图标",
    "Choose Image…": "选择图片…",
    "No custom image selected": "未选择自定义图片",
    "Custom image missing": "自定义图片已丢失",
    "Codex Router · %@ (%@) · %@": "Codex Router · %@ (%@) · %@",
    "Codex Router · %@ (%@)": "Codex Router · %@ (%@)",
    "Select": "选择",
    // Service health panel. The state words are shared with the Control
    // Center's panel, so they are translated as the same vocabulary: a row is
    // Ready/Standby/Degraded/Offline and its detail says why.
    "Service health": "服务健康",
    "Checking": "检查中",
    "All clear": "一切正常",
    "Serving locally": "正在本地提供服务",
    "Degraded": "降级",
    "Offline": "离线",
    "Health endpoint unavailable": "健康检查端点不可用",
    "Unknown": "未知",
    "Waiting for health report": "等待健康报告",
    "Standby": "待命",
    "Not enabled": "未启用",
    "Unreachable": "无法连接",
    "Reachable": "可连接",
    "External forwarders": "外部转发器",
    // Composed as "\(effort) \(thinking)", so this follows the effort word.
    // "思考强度" is the vocabulary already used for effort elsewhere here.
    "Subagent": "子代理",
    "thinking": "思考强度",

    // Provider catalogs: the on-demand panel that asks a configured
    // provider for its current model list and curates from it.
    "Provider catalogs": "服务商模型目录",
    "Load the latest provider models": "加载服务商的最新模型",
    "Connect a supported provider to load its latest models.": "先连接受支持的服务商，才能加载其最新模型。",
    "Load models asks that provider for its current list. Choosing models adds them to the router and republishes every installed client.": "“加载模型”会向该服务商索取当前列表。选择模型后会将其加入路由，并重新发布所有已安装的客户端。",
    "Reload provider models": "重新加载服务商模型",
    "Reloading provider models…": "正在重新加载服务商模型…",
    "Fetch the current catalog from every connected provider that supports live model discovery.": "从每个支持实时模型发现的已连接服务商获取当前目录。",
    "Refresh models": "刷新模型",
    "Reload installed and available local models from the router.": "从路由重新加载已安装和可用的本地模型。",
    "Loading models": "正在加载模型",
    "Search available models": "搜索可用模型",
    "No provider models match this search.": "没有服务商模型匹配此搜索。",
    "Search providers": "搜索提供商",
    "No providers match this search.": "没有提供商匹配此搜索。",
    "Search subagent models": "搜索子代理模型",
    "No subagent models match this search.": "没有子代理模型匹配此搜索。",
    "Clear search": "清除搜索",
    "Added": "已添加",
    "Showing the first 80 matches. Search to narrow the list.": "仅显示前 80 条匹配结果。请搜索以缩小范围。",
    "%d selected": "已选择 %d 个",
    "Add selected": "添加所选",
    "Load the current list from this provider.": "从该服务商加载当前列表。",
    "Run the provider's local configuration command, then refresh": "运行服务商的本地配置命令，然后刷新",
    "saved list": "已保存列表",
    "live list": "实时列表",
    "%d models · %d added · %@": "%d 个模型 · 已添加 %d 个 · %@",
    // Added by the Simplified Chinese coverage pass: tray status, dialogs,
    // accessibility, and local-model panels. English stays the key.
    "Router %@: %@": "路由 %@：%@",
    "%@: reload superseded by a credential change": "%@：凭据变更，重新加载已作废",
    "Reloaded current models from 1 catalog.": "已从 1 个目录重新加载当前模型。",
    "Reloaded current models from %d catalogs.": "已从 %d 个目录重新加载当前模型。",
    "Catalog reload failed: %@": "目录重新加载失败：%@",
    "%d reloaded; %d failed: %@": "已重新加载 %d 个；%d 个失败：%@",
    "%d %@ models loaded from %@. Select the ones to add below.": "%d 个 %@ 模型已从 %@ 加载。请在下方选择要添加的模型。",
    "saved": "已保存",
    "current": "最新",
    "%@ is not an addable %@ catalog candidate.": "%@ 不是可添加的 %@ 目录候选项。",
    "1 %@ model added. Restart Codex to refresh its model picker.": "已添加 1 个 %@ 模型。请重启 Codex 以刷新模型选择器。",
    "%d %@ models added. Restart Codex to refresh its model picker.": "已添加 %d 个 %@ 模型。请重启 Codex 以刷新模型选择器。",
    "Live compatibility verified and provider enabled. Restart Codex to refresh its model picker.": "实时兼容性已验证并已启用该提供商。请重启 Codex 以刷新模型选择器。",
    "Opening %@ sign-in in your browser…": "正在浏览器中打开 %@ 登录…",
    "Starting %@ sign-in…": "正在启动 %@ 登录…",
    "Signed in. Run the live compatibility test before enabling this provider.": "已登录。启用该提供商前请先运行实时兼容性测试。",
    "Signed in again. Run the live compatibility test before re-enabling this provider.": "已重新登录。重新启用该提供商前请先运行实时兼容性测试。",
    "Provider reconnected.": "提供商已重新连接。",
    "Provider connected. Restart Codex to refresh its model picker.": "提供商已连接。请重启 Codex 以刷新模型选择器。",
    "%@ saved. Restart Codex to refresh its model picker.": "%@ 已保存。请重启 Codex 以刷新模型选择器。",
    "%@ removed. Restart Codex to refresh its model picker.": "%@ 已移除。请重启 Codex 以刷新模型选择器。",
    "Running update and doctor…": "正在运行更新和 doctor…",
    "Update installed. Fully quit and reopen Codex to load updated models and agents.": "更新已安装。请完全退出并重新打开 Codex，以加载更新后的模型和代理。",
    "Running doctor --fix…": "正在运行 doctor --fix…",
    "Repair verified. Fully quit and reopen Codex if models changed.": "修复已验证。如有模型变化，请完全退出并重新打开 Codex。",
    "Mode changed.": "模式已更改。",
    "Codex restarted with external-provider mode.": "Codex 已以外部提供商模式重启。",
    "Codex restarted with OpenAI login restored.": "Codex 已重启，OpenAI 登录已恢复。",
    "Mode changed, but Codex could not restart: %@": "模式已更改，但 Codex 无法重启：%@",
    "Router with ChatGPT enabled. Fully quit and reopen Codex when ready.": "已启用 ChatGPT 路由。准备好后请完全退出并重新打开 Codex。",
    "Previous provider restored. Fully quit and reopen Codex when ready.": "已恢复之前的提供商。准备好后请完全退出并重新打开 Codex。",
    "Model settings applied. Restart Codex to refresh its picker.": "模型设置已应用。请重启 Codex 以刷新模型选择器。",
    "Token maxxing is on for the next external-model request.": "Token 精简已开启，将在下一次外部模型请求中生效。",
    "Token maxxing is off; exact tool results will be sent on the next external-model request.": "Token 精简已关闭；下一次外部模型请求将发送完整工具结果。",
    "%@ tested. The score is on its row.": "%@ 已测试。评分显示在该行。",
    "%@ speed measured. Tokens per second is on its row.": "%@ 速度已测量。每秒 token 数显示在该行。",
    "Checking the local runtime and downloader": "正在检查本地运行时和下载器",
    "The MLX install could not start": "MLX 安装无法启动",
    "Qwen3.8 27B MLX is ready for Codex. Fully quit and reopen Codex to refresh its picker.": "Qwen3.8 27B MLX 已可供 Codex 使用。请完全退出并重新打开 Codex 以刷新模型选择器。",
    "Qwen3.8 27B MLX installation cancelled.": "Qwen3.8 27B MLX 安装已取消。",
    "The MLX installation failed.": "MLX 安装失败。",
    "Ollama updated. Its headless server will be reused for local models.": "Ollama 已更新。其后台服务器将继续用于本地模型。",
    "No local model operation is running.": "当前没有正在运行的本地模型操作。",
    "%@ was removed.": "%@ 已移除。",
    "%@ ready for Codex. Restart Codex to refresh its picker.": "%@ 已可供 Codex 使用。请重启 Codex 以刷新模型选择器。",
    "%@ removal cancelled.": "%@ 移除已取消。",
    "%@ download cancelled.": "%@ 下载已取消。",
    "The local model removal failed.": "本地模型移除失败。",
    "The local model download failed.": "本地模型下载失败。",
    "%@ downloaded. Restart Codex to refresh its picker.": "%@ 已下载。请重启 Codex 以刷新模型选择器。",
    "The download failed.": "下载失败。",
    "The embedded Control Center is missing. Rebuild Codex Router.": "内置控制中心缺失。请重新构建 Codex 路由。",
    "A superseded Codex Router Control Center is still running. Quit it, then reopen Codex Router.": "仍有一个被取代的 Codex 路由控制中心在运行。请退出它，然后重新打开 Codex 路由。",
    "Control Center could not open: %@": "控制中心无法打开：%@",
    "the Codex desktop app could not be found": "找不到 Codex 桌面应用",
    "Codex did not accept a graceful quit request": "Codex 未接受正常的退出请求",
    "Codex did not quit in time; restart it manually": "Codex 未及时退出；请手动重启",
    "This maintenance command does not schedule a desktop refresh.": "该维护命令不会安排桌面刷新。",
    "Unsupported detached tray command.": "不支持的后台菜单栏命令。",
    "Could not create the private maintenance error log.": "无法创建私有维护错误日志。",
    "Codex Router control command exceeded its absolute deadline and was stopped.": "Codex 路由控制命令超出绝对时限，已被停止。",
    "Codex Router control command failed.": "Codex 路由控制命令失败。",
    "Unsupported Codex Router script.": "不支持的 Codex 路由脚本。",
    "%@ did not answer within %d seconds and was stopped. The provider may be unreachable; try again.": "%@ 在 %d 秒内没有响应，已被停止。提供商可能无法连接；请重试。",
    "Codex Router command failed.": "Codex 路由命令失败。",
    "Cannot find the installed Codex Router checkout. Install the router or rebuild this app from its checkout.": "找不到已安装的 Codex 路由检出目录。请安装路由，或从检出目录重新构建此应用。",
    "This Codex Router app does not match the installed router control protocol. Install or update the router and desktop app from the same build, then reopen the app.": "此 Codex 路由应用与已安装的路由控制协议不匹配。请使用同一构建安装或更新路由和桌面应用，然后重新打开应用。",
    "The Codex Router checkout is missing or has unsafe ownership or permissions.": "Codex 路由检出目录缺失，或其所有者或权限不安全。",
    "MODEL_ROUTER_PORT must be a TCP port between 1 and 65535.": "MODEL_ROUTER_PORT 必须是 1 到 65535 之间的 TCP 端口。",
    "The local router caller key is missing or invalid; run ./bin/doctor --fix.": "本地路由调用方密钥缺失或无效；请运行 ./bin/doctor --fix。",
    "The local router health URL could not be built.": "无法构建本地路由健康检查 URL。",
    "Choose between 1 and %d provider models.": "请选择 1 到 %d 个提供商模型。",
    "Model id is invalid: %@": "模型 ID 无效：%@",
    "Provider model ids must be unique.": "提供商模型 ID 必须唯一。",
    "Provider is invalid: %@": "提供商无效：%@",
    "%d/%d routes enabled": "%d/%d 条路由已启用",
    "Context savings": "上下文节省",
    "%d requests compacted all-time": "累计压缩 %d 个请求",
    "Tool results compressed into recoverable receipts": "工具结果已压缩为可恢复的凭据",
    "%d compacted requests in this window": "此时间窗口内压缩了 %d 个请求",
    "No compactions in this window": "此时间窗口内没有压缩记录",
    "Nothing compacted in this window": "此时间窗口内没有压缩内容",
    "~%@ tok": "~%@ tok",
    "saved all-time": "累计节省",
    "%@ tok · %d req": "%@ token · %d 个请求",
    "%d dependency needs attention": "%d 个依赖需要处理",
    "%d dependencies need attention": "%d 个依赖需要处理",
    "Gateway": "网关",
    "OAuth forwarder": "OAuth 转发器",
    "API forwarder": "API 转发器",
    "No external forwarders enabled": "未启用外部转发器",
    "Every proven v2 model can run as a subagent": "所有已验证的 v2 模型都可作为子代理运行",
    "Only selected proven v2 models can run as subagents": "只有选中的已验证 v2 模型可作为子代理运行",
    "Subagents on": "启用全部子代理",
    "Subagents off": "停用全部子代理",
    "Load models": "加载模型",
    "Reload models": "重新加载模型",
    "Removing": "正在移除",
    "Not installed": "未安装",
    "Installation cancelled": "安装已取消",
    "Installation failed": "安装失败",
    "Preparing runtime": "正在准备运行时",
    "Downloading model": "正在下载模型",
    "Loading model": "正在加载模型",
    "Starting local server": "正在启动本地服务器",
    "Verifying model": "正在验证模型",
    "Wiring Codex": "正在接入 Codex",
    "Ready for Codex": "已可供 Codex 使用",
    "MLX requires Apple silicon": "MLX 需要 Apple 芯片",
    "Qwen MLX ready for Codex": "Qwen MLX 已可供 Codex 使用",
    "MLX install failed": "MLX 安装失败",
    "Last removal failed": "上次移除失败",
    "Removal cancelled": "移除已取消",
    "Download cancelled": "下载已取消",
    "Local model removal failed": "本地模型移除失败",
    "Local model removal cancelled": "本地模型移除已取消",
    "Local model download cancelled": "本地模型下载已取消",
    "Local model removed": "本地模型已移除",
    "Uninstalling local model": "正在卸载本地模型",
    "QWEN MLX": "QWEN MLX",
    "CODEX": "CODEX",
    "LM Studio · 4-bit · ~15 GB": "LM Studio · 4-bit · ~15 GB",
    "%@ MLX · %dK context": "%@ MLX · %dK 上下文",
    "4-bit MLX · 32K context · Apple silicon": "4-bit MLX · 32K 上下文 · Apple 芯片",
    "Apple silicon required": "需要 Apple 芯片",
    "Served only on this Mac and published to the Codex model picker.": "仅在本机提供服务，并已发布到 Codex 模型选择器。",
    "This MLX model is available only on Apple silicon Macs.": "此 MLX 模型仅在 Apple 芯片的 Mac 上可用。",
    "Detected: %@ · %@": "检测到：%@ · %@",
    "LM Studio runtime": "LM Studio 运行时",
    "Model downloader": "模型下载器",
    "Reduced safety guardrails. Treat outputs as untrusted and keep the server local.": "安全防护已降低。请将输出视为不可信，并保持服务器仅在本地运行。",
    "Install runtime + ~15 GB model and wire Codex": "安装运行时和约 15 GB 的模型并接入 Codex",
    "This MLX model requires an Apple silicon Mac.": "此 MLX 模型需要 Apple 芯片的 Mac。",
    "Installs official local prerequisites when missing, downloads the curated 4-bit model, and publishes it through Codex Router.": "在缺失时安装官方本地依赖，下载精选的 4 位模型，并通过 Codex 路由发布。",
    "The local MLX setup did not complete.": "本地 MLX 设置未完成。",
    "ready": "就绪",
    "official installer on click": "点击后使用官方安装程序",
    "Source: %@": "来源：%@",
    "%d %@ · %.1f GB": "%d %@ · %.1f GB",
    "No result over 32 KB in %d requests (largest %@)": "在 %d 个请求中没有超过 32 KB 的结果（最大 %@）",
    "Nothing aged yet in %d requests (largest %@)": "在 %d 个请求中尚无内容被压缩（最大 %@）",
    "Saved ~%@ tokens (%@ MB) across %d requests": "节省约 %@ token（%@ MB），共 %d 个请求",
    "tokens saved · last 24 hours": "节省的 token · 最近 24 小时",
    "tokens saved · last 7 days": "节省的 token · 最近 7 天",
    "tokens saved · last 30 days": "节省的 token · 最近 30 天",
    "Cache %@ normal · %@ compacted (n=%d)": "缓存命中 %@ 未压缩 · %@ 已压缩（n=%d）",
    "peak %@/%@": "峰值 %@/%@",
    "%@, peak %d per %@": "%@，峰值 %d，单位 %@",
    "hour": "小时",
    "day": "天",
    "%@\nIf this keeps failing, run ./bin/support-bundle and share the path.": "%@\n如果持续失败，请运行 ./bin/support-bundle 并分享其路径。",
    "Codex Router usage widget": "Codex Router 用量小组件",
    "%@ tokens over %d days": "%@ 个 token，覆盖 %d 天",
    "%d percent left": "剩余 %d%%",
    "%@, %@, %@": "%@，%@，%@",
    "%@, %@, %@, %@": "%@，%@，%@，%@",
  ]
}
