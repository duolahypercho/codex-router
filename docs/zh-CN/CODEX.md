# Codex 设置与可选功能

[English](../CODEX.md) · 简体中文 · [日本語](../ja/CODEX.md)

命令从已安装源码目录执行。Windows 将 `./bin/model-router codex` 替换为 `.\model-router.ps1 codex`，`./bin/control` 替换为 `node src/control.mjs`。

## 模型菜单与请求限制

配置完成后运行诊断，检查供应商状态为 `SHOW` 和 `ready`，完全退出并重新打开 Codex，再新建任务选择模型。菜单目录在 Codex 启动时加载。

```sh
./bin/model-router codex doctor
./bin/model-router codex providers
./bin/refresh-catalog
```

当前 Router 运行时每五分钟检查原生模型目录差异；刷新后的菜单由下一次 Codex 启动加载。若新型号仍未出现，查看[故障排查](TROUBLESHOOTING.md)。

默认请求限制为编码体 64 MiB、解码体 256 MiB、并发推理 64 个、缓冲错误体 8 MiB。活动记录保留 15 分钟，执行截止为独立的 24 小时设置。可通过 `MODEL_ROUTER_MAX_BODY_BYTES`、`MODEL_ROUTER_MAX_DECODED_BODY_BYTES`、`MODEL_ROUTER_MAX_ACTIVE_REQUESTS`、`MODEL_ROUTER_MAX_BUFFERED_RESPONSE_BYTES`、`MODEL_ROUTER_ACTIVITY_RECORD_RETENTION_MS`、`MODEL_ROUTER_REQUEST_EXECUTION_TIMEOUT_MS` 调整。

## 连接器工具

`CODEX_ROUTER_APP_CONNECTORS` 控制外部模型的 eager 连接器工具：空值或 `all` 保留普通连接器，`none` 暂缓全部，逗号分隔的 ID 仅保留所选连接器。历史调用、强制工具选择或允许列表仍可要求重新声明；显式 deferred 工具遵循客户端工具搜索流程。更改后台服务环境后重新生成服务定义并重启。

## 受管理配置与调用凭据

Router 在 Codex 配置中管理标记块、模型目录路径和带随机本地调用凭据的回环 URL。完整 URL 包含秘密，分享日志或截图时应遮蔽该路径。轮换凭据使用：

```sh
./bin/model-router codex caller-key rotate
```

轮换时运行中的服务会停止并重新启动，成功后旧凭据失效。完成后重启 Codex 和正在运行的 Gemini CLI，加载新 URL。

## 旧工具输出归档与回读

**Token maxxing** 默认关闭，启用后下一次请求生效，选择会持久保存。

```sh
node src/control.mjs tool-result-aging status
node src/control.mjs tool-result-aging on
node src/control.mjs tool-result-aging off
```

普通老化处理已被模型使用、超过 32 KiB 的旧文本结果，保留最新四项。被识别的 AGENTS.md、SKILL.md 等指令读取及 Cua 运行时文档在老化处理中保留。

省略文本前，Router 保存完整原文并验证同一对话/权限范围内的本地回读凭证。验证前原文连同只读恢复说明保留在请求里。存储失败、访问失败或无效凭证时保留完整内容。

按结果附带的原样读命令操作，命令中包含 Node、脚本、签名句柄与存储路径。返回 `text`、`nextOffset`、`eof`；分页使用 `--offset N --limit N`，查找使用 `--find 'literal text'`。找不到对应句柄时，用现有合法句柄执行同范围搜索。历史原文已删除、过期或损坏时，将其记为不可用证据；重新执行原命令得到的是新的观察结果。

上下文压缩沿用相同的老化策略，保留近期结果。原生 GPT 的改写另行启用：

```sh
node src/control.mjs tool-result-aging native on
node src/control.mjs tool-result-aging native off
```

`CODEX_ROUTER_TOOL_RESULT_AGING=0` 停止普通与原生改写，已有原文的到期处理仍按保存策略运行。

原文保存在 `<state dir>/retained-tool-results`，默认最多 512 个文件或 512 MiB，TTL 为七天。读取会验证有效期；写入或手动清理时删除过期文件。

```sh
node src/control.mjs tool-result-aging purge
node src/control.mjs tool-result-aging purge --expired --yes
node src/control.mjs tool-result-aging ttl 30
node src/control.mjs tool-result-aging ttl off
node src/control.mjs tool-result-aging ttl default
```

`purge` 默认预览；`--yes` 执行删除，`--dry-run` 优先。删除会使现有句柄失去原文。详见[回读凭证](tool-result-readback-proof.md)、[范围搜索](tool-result-scope-search.md)、[按模型策略](tool-result-model-policy.md)。

## 登录与原生模型

控制中心的 **Use Router with ChatGPT** 保留 ChatGPT 登录并使用受管理的已登录传输。**Use without OpenAI login** 使用已启用外部供应商，并保留可恢复的原设置；切换后重启 Codex。原生 GPT、云任务等账户功能使用 OpenAI 登录。

`native-redirect` 将匹配的原生请求送往指定外部路由；清除方式如下。自动审批的额度回退单独配置，只在原生审批服务报告额度不足后接管后续审批：

```sh
./bin/control auth-mode on
./bin/control auth-mode off
./bin/control native-redirect clear
./bin/control auto-review-fallback set kimi-oauth/k3
./bin/control auto-review-fallback status
./bin/control auto-review-fallback clear
```

多账户切换见[ChatGPT 账户](CHATGPT-ACCOUNT-MODES.md)。原生 `gpt-5.6-sol-1m` 上下文变体默认隐藏，仅在原生目录存在相应基础型号时显示；它向上游发送基础型号 ID。可用 `picker set gpt-5.6-sol-1m show` 显示，`hide` 隐藏。

Windows Desktop 与 WSL 共存时，检查 `CODEX_HOME` 和 `CODEX_ROUTER_STATE_DIR` 指向实际使用的目录，目录路径应能被运行 Codex 的环境读取。

## 本地模型和图片桥接

本地模型的安装、内存适配、取消和发布见[本地 LLM](LOCAL-MODELS.md)。图片桥接默认开启：当前无保存选择时使用 `gpt-5.6-luna`、`low`；该默认不可用时按已启用候选排序。显式 Auto 使用偏好启发式排序。

每次读图只调用选定的引擎一次。读取失败时，主对话继续并说明该图片未能读取；可另选可用引擎。缓存按图片和问题保存，默认一小时；新问题、重启、过期或身份变化可触发新请求。

```sh
./bin/control vision-bridge status
./bin/control vision-bridge off
./bin/control vision-bridge engine qwen-plan/qwen3.6-flash
./bin/control vision-bridge engine auto
./bin/control vision-bridge local qwen2.5vl:3b
```

桥接输出提供可见文字、布局、图表值和不确定处；细节准确性取决于实际读图结果。

## 额度与连接故障转移

默认开启。额度耗尽、`402`、等待超过一分钟的 `429`，以及转发器标记的响应开始前连接故障可触发切换。普通供应商 `5xx`、无效密钥和参数错误保留原错误。响应已经开始后保持当前流的结果。

自动顺序优先已选择的匿名免费模型，再按偏好选择其他就绪路由。本地模型需要显式链。候选还须满足上下文、图片和搜索等要求。供应商给出的恢复时间最多保存六小时。

```sh
./bin/control failover status
./bin/control failover off
./bin/control failover chain opencode-free/big-pickle,kimi-api/kimi-k3
./bin/control failover auto
./bin/control failover reset
```

`failoverCandidate: false` 使本机模型条目仅用于手动选择。实际接管的模型记录在托盘、日志和用量中。

## 配套 skills 与效果评估

安装器提供 Router、聊天管理、浏览器和电脑操作的配套 skills。安装、移除以及外部管理目录审批：

```sh
./bin/model-router codex skills install
./bin/model-router codex skills uninstall
./bin/model-router codex skills approve-external codex-router
./bin/model-router codex skills revoke-external codex-router
node scripts/measure-tool-result-aging.mjs /path/to/rollout.jsonl
node scripts/aging-benchmark.mjs
```

已安装 skill 中的 API 描述对应当前运行时。归档节省量用实际账单 token 和任务结果评估；回读请求、缓存变化和额外模型调用会影响总消耗。
