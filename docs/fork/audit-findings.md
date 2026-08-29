# Prime Agent 源码审计问题清单（2026-08-29）

> 来源：九代理独立审计 + 交叉对质 + 亲验裁决。审计基线：本地 fork HEAD `1cf21237e`（分支 fix/subagent-storm-and-cjk-lag）。
> 各代理完整报告：/tmp/prime-audit-{arch,runtime,mechanics,security,grok-tui,grok-providers,grok-tests,grok-wire,grok-entry}.md
> 状态栏： [ ] 未处理  [~] 进行中  [x] 已修

## P0 — 确认的高危缺陷

- [x] **F1 父催子队列可永久卡死**（会话队列） — 已修，落点：9afa2cd78 + 648bf8891
  `requestAbort` 挂起输入泵后，`queueAgentMessagePrompt` 入队不带 `resumeIfIdle`，`wake` 恒为 `on_lower_boundary`，无人唤醒泵。裸 RLM 子代理（无心跳/cron）队列非空即静默卡死，发送方只收到 `queued` 无感知。带心跳/cron 的会话下个 tick 自愈。
  证据：`agent-session.ts:6878-6904, 4575-4595, 5463-5468, 5573-5577`；`daemon-mode.ts:5968-5990`
  修法方向：agent-message 入队路径补 `resumeIfIdle`（对齐 TUI steer/follow_up/heartbeat 的做法），或在 `_admitSessionInput` 对 `on_lower_boundary` 增加「泵悬置中则唤醒」分支。
  验证：子代理 streaming → cancel_rlm_child → 再催促 → 当前永不运行；修复后应入队即醒。

- [x] **F2 print/json 模式杀在途子代理**（子代理生命周期 / 入口一致性） — 已修，落点：82683e4ee
  `print-mode.ts:121` 调 `waitForHeadlessCompletion()` 不传 `waitForRlmQuiescence`，root 回合一结束即 `complete_owned_session` → supervisor 停 worker → 级联 abort 全部在途 RLM 子代理。ACP 已显式传 true（`acp-mode.ts:638`，d98d0762c 加的能力门 `rlm_quiescence_barrier`），print/json 没接上。
  修法方向：print/json 同样等待 RLM quiescence（复用 ACP 的能力门），或文档明写「print 不留后」语义。
  证据：`print-mode.ts:121`；`headless-completion.ts:89-92`；`daemon-agent-connection.ts:1453`；`daemon-mode.ts:7094-7096, 6497-6500`

- [x] **F3 session 记录与日志文件权限过宽**（密钥与日志） — 已修，落点：e4bb3f3cf（#1249）
  session jsonl（含 prompt/工具输出/bash 记录）`appendFileSync` 无 mode，默认 umask 下落成 0644；`~/.prime/agent` 与日志目录可建为 0755。多用户机器上跨 uid 泄漏会话内容。
  证据：`session-manager.ts:1444`（无 mode）、`config.ts:586-598`、`logging.ts:18-21`、`main.ts:1048`
  修法方向：session/log 文件显式 0600，目录 0700（对齐 descriptor/lease 已有的做法）。

- [x] **F4 Windows 命名管道无 ACL**（权限边界，双代理互证） — 已修，落点：2637973c1（Windows 未实机验证）
  Windows 上管道名是全局 `\\.\pipe\prime-agent-daemon`，chmod/uid 检查全是 no-op → 任何本地用户可连 daemon、attach 会话、发 shutdown。
  证据：`daemon-socket.ts:39-41, 137-141`
  修法方向：Windows 分支用命名管道 ACL（SID 限制）或退化为 localhost TCP + token。

## P1 — 确认的中危缺陷

- [ ] **F5 capability 门只在客户端侧**（协议兼容，双代理互证）（W7 在跑）
  supervisor/worker 不校验入站命令的 capability，客户端侧门控被绕过即可越用新命令。
  证据：`daemon-supervisor.ts:1409-1422` vs `daemon-client.ts:304-327`
- [ ] **F6 shutdown/restart/prepare_update_restart 无鉴权**（失败路径）（W7 在跑）
  任何能连 socket、能写合法 protocol-7 envelope 的进程即可关停 daemon；无控制面/会话面分流。默认 0700 socket 把威胁限制在同 uid，但同 uid 任意进程（如恶意扩展）可 DoS 全部会话。
  证据：`daemon-supervisor.ts:1819-1827, 1085`；`daemon-protocol.ts:1084-1105`
- [x] **F7 流式事件载荷 O(n²)**（资源） — 已修，落点：c72b9940f（streaming_deltas, schema 25）
  `message_update` 每个 token 把整条 message 推上公开 JSONL（compact delta 只在 worker→supervisor 一跳生效）；长消息总成本平方级。`omitStreamingMessages` 能力可缓解但需客户端主动协商。
  证据：`daemon-extension-binding.ts:33-68`；`agent-loop.ts:533-541`；`daemon-supervisor.ts:4660-4664`
- [x] **F8 Codex provider 重试缺陷三连**（模型请求） — 已修，落点：b003173a6 + a6988e947
  (a) catch 门 B 只看 message 不含 "usage limit"，401/400 也重试 4 次；(b) 429 不读 Retry-After，固定 1s*2^n；(c) 忽略 options.maxRetries。
  证据：`openai-codex-responses.ts:90-94, 217-264`
- [x] **F9 Mistral/Google/Vertex 无重试 + maxRetryDelayMs 死选项**（模型请求，双代理互证） — 已修，落点：a6988e947
  `maxRetryDelayMs` 有设置有文档、全链路传递、零消费者；`timeoutMs/maxRetries` 只接了 anthropic/openai/azure。
  证据：`mistral.ts:214-217`；`google.ts:337-340`；`ai/types.ts:126-133`；`simple-options.ts:18`
- [x] **F10 edit 工具 abort 拦不住写盘 + 非原子写**（工具执行） — 已修，落点：577f1032b（W2）
  abort 时结果报 aborted 但文件可能已被改；`fsWriteFile` 非原子，写一半崩溃即损坏。
  证据：`edit.ts:375-377, 424, 86`
  修法方向：tempfile+rename 原子写；abort 先查 signal 再落盘。
- [x] **F11 exec.ts 只杀直接子进程 + stdout 无界累积**（工具执行 / 资源） — 已修，落点：8dde3fdfa（W2）
  abort/超时未 detached 也不杀进程组，孙进程存活；stdout/stderr 字符串拼接无上限。
  证据：`exec.ts:57-64, 76-86, 104, 108`
- [x] **F12 TUI 未终止 bracketed paste 吞键盘**（状态机 / TUI） — 已修，落点：ca2ec0bda + 9afc14f35
  只见 `200~` 不见 `201~` 时 pasteMode 无超时、无字节上限、无任何键盘退出路径，ctrl+c 也被吞，只能杀进程。触发前提：未终止 paste 或伪造 `200~` 信封（完整粘贴不受影响）。
  证据：`stdin-buffer.ts:266-300, 367-384`
  修法方向：pasteMode 加超时（如 30s 无 201~ 自动 flush 退出）+ 字节上限 + Esc 强制退出。
  待验证：哪些终端/tmux 会只发 200~（需终端矩阵或 pty 录制）。
- [x] **F13 14 处键绑定硬编码绕过配置表**（违反仓库 AGENTS.md） — 已修，落点：142022669（B8/W5）
  证据：`tui.ts:935`；`editor.ts:850,854,967,885,1330`；`settings-list.ts:173`；`input.ts:86`；`config-selector.ts:400,404`；`scoped-models-selector.ts:314,324`；`extension-selector.ts:143,146,149`；`extension-input.ts:75`；另有 `select-list.ts:119` 不用已登记的 pageUp/pageDown。
- [x] **F14 ACP stdin EOF 只 detach 不 complete，worker 残留**（关闭与清理 / 入口一致性） — 已修，落点：9f03ec6f5
  ACP 是 headless 中唯一默认 resident 的模式；EOF 后 worker 残留至 90 分钟空闲驱逐。高频短会话场景（评测 harness）会在窗口内堆积。`daemon.md` 的 client-owned 名单漏了 ACP。
  证据：`main.ts:197, 1545`；`daemon-agent-connection.ts:1456-1462`；`daemon-supervisor.ts:931`
- [ ] **F15 attach 竞态丢事件**（并发与竞态）（W9 留档）
  supervisor 在「worker 返回快照」到「登记客户端转发」之间的事件不转发给新客户端；客户端只按 max 去重、无序号缺口检测，窗口内丢 message_end 则缺消息直到被动 resync。
  证据：`daemon-supervisor.ts:3954, 4675-4695`；`daemon-agent-connection.ts:2085-2119`
- [x] **F16 update-restart 恢复期的孤儿路径**（子代理生命周期 / 失败路径） — 已修，落点：5b6c0e94e（#1864）+ 1597ef8c3
  恢复阶段父 create 失败仅 warning 继续；子的 `parentActiveSessionId` 重映射失败即被丢弃成孤儿（级联关闭/被动化只认该字段）。
  证据：`package-manager-cli.ts:964-983, 999-1002`；`daemon-mode.ts:7119-7129`
- [ ] **F17 idle 驱逐可杀「心跳注册在途」的 worker**（进程所有权，对质后收窄）（W9 留档）
  已注册心跳的 worker 永不驱逐（硬性条件），但 fence 设置→stopWorker 之间到达的注册被 fence 阻塞且发生在 mutationDrain 之前 → 驱逐先落地。需同时满足 90min idle + 0 attached clients，后果限于会话归档、无数据丢失。
  证据：`daemon-supervisor.ts:904-928, 1489-1496`；`session-action-store.ts:380-388`

## P2 — 文档漂移与死参数（亲验）

- [x] **F18** `daemon.md:76` 写 "Public Daemon Protocol v4"，代码已是 v7（`daemon-protocol.ts:54`）；`daemon.md:93` "Protocol v1 retained" 说法过时 — 已修，落点：f12fcbdea
- [x] **F19** `settings.md:20,298` 声称 `defaultThinkingLevel` 默认 `"xhigh"`，代码是 `"medium"`（`defaults.ts:3`） — 已修，落点：f12fcbdea
- [x] **F20** `development.md` 要求 Node 22.8+，`install.sh` 放行 20.6+（两边应取齐） — 已修，落点：f12fcbdea
- [x] **F21** `usage.md` mode 表缺 `acp`；`--mode text` 被解析但 `resolveAppMode` 不使用（死参数，帮助文本还写 `default:text`）——`args.ts:104-107`、`main.ts:174-190` — 已修，落点：f12fcbdea

## P2 — 测试盲区（对质收窄后）

- [x] **F22** LLM HTTP 429 重试零测试（faux 写死 200；`isRetryableError`/`MAX_RETRIES` 测试目录 0 命中）——与 F8/F9 闭环：有缺陷且无测试 — 已修，落点：codex-retry-behavior.test.ts
- [x] **F23** bash 工具 abort 不验证 OS 子进程真死（BashOperations 边界被 mock）；`killProcessTree` 符号零测试引用（行为仅经 autonomous gate 间接覆盖） — 已修，落点：exec.test.ts + repl-kernel-bash-interrupt.test.ts
- [x] **F24** 子代理消息风暴零测试——8981a31c3 的修复无回归保护；且 turn_start/turn_end/session_replaced/session_closed 仍走 urgent 全量行（`daemon-supervisor.ts:4696-4705, 3299-3339`） — 已修，落点：1229-snapshot-transfer-identity.test.ts + daemon-supervisor-streaming-list.test.ts
- [x] **F25** worker streaming 中途崩溃无测；双客户端 attach 同 session 仅 mock；RLM 子死父不知零测试；Windows silent return 假绿 3 处（`4603-worker-recovery.test.ts:754,857,1029`） — 已修，落点：4602-snapshot-transfer-idempotency.test.ts + 4606-update-restart-coordinator.test.ts

## 已被对质推翻/降级（不要再追）

- ~~孤儿 toolCall → Anthropic 每请求 400、会话永久污染~~：**推翻**。所有 provider 请求路径都过 `transformMessages`（`anthropic.ts:1064`、`amazon-bedrock.ts:645` 等），error/aborted 消息整条丢弃、孤儿自动补合成 `"No result provided"`（`transform-messages.ts:152-210`），有 `tool-call-without-result.test.ts` 钉死。孤儿确实落盘，但请求层永远打补丁。
- ~~clientId 自声明劫持 client_owned / 同 uid attach 驻留会话~~：降级 low。同 uid 本就能读 descriptor 内的 worker token，伪造不提供新能力；是合作客户端间的礼貌 ACL。
- ~~launchEnv 全量 process.env 不过滤~~：有意设计（daemon 非安全沙箱，`architecture.md:37-38` 自述）；`adoptClientEnv` 先到先得，第二客户端无法改驻留 worker 环境。
- ~~公开 JSONL 无单行上限~~：安全 low（同 uid 本可杀进程）/ 健壮性 med（合法超大消息也会撑爆）。可补 `maxLineLength`（worker stderr 已有 64KiB 先例）。
- ~~「abort 后 usage 全 0 → 上下文记账偏低」~~：窗口记账有尾部估算兜底不偏低；真实残留是**成本归因**永久漏计 aborted 回合（OpenAI 系）+ 首回合即 abort 的无锚点死角（暂时性）。
- ~~「1MB 大粘贴假死」~~：完整粘贴自带 201~ 不受影响；问题仅是 F12 的未终止场景。

## 已核对无误（审计确认的好消息）

8981a31c3 两处修复真实成立（omitStreamingMessages 能力门 + snapshotTransferSeq）；状态机不会永久假 working（summarizer 失败兜底 needs_input）；worker_auth 不上 argv；descriptor/lease 0600/0700；假重复防护完备（message_end 唯一追加点）；命令日志从不重放 pending；update-restart 三阶段围栏 + stale 客户端检测；abort 无 token 双重计数；kernel 回收链完整（旧 IPython 内核，见下）。

## 附：内核换血说明（upstream 已合并）

upstream main 已用 #1684–#1687 把 Jupyter/ipykernel/ZMQ 内核换成自研极简 CPython REPL（`python -m rlm.repl`，JSON-lines over stdio，启动 ~30ms vs 原 ~1.2s）。本地 fork 落后 18 个提交仍在旧内核。合入计划见本节底部 TODO。
- [x] **F26** 合并 upstream 新内核（rlm.repl）到本地 fork，解决与本地 8 个 perf/storm 提交的冲突，跑通内核测试 — 已修，落点：bf542ce7e（内核合并）


---

# 2026-08-29 第二轮追加：内存专项 + 官方 PR 评估 + 内核合并

## F27 [P0] TUI 长会话内存膨胀（实测：38 小时 RSS 2.4GB，峰值 3.5GB；daemon 同期仅 204MB）

- [x] **F27a 流式全量事件 + 全帧重渲染 → V8 堆棘轮**（最大头）：supervisor 每 token 向 TUI 广播整条 message JSON（daemon-supervisor.ts:4576-4592），TUI 每 token 全量 JSON.parse + 全文 markdown re-lex（markdown.ts:225-244）。堆对象可回收但 RSS 高水位不归还。 — 已修，落点：c72b9940f（streaming deltas）
- [x] **F27b 同一 transcript 驻留 ~3 份全量拷贝**：latestSnapshot.messages + sessionContext.messages + chatContainer 组件树（400 条截断只在初始渲染，直播追加无上限——interactive-mode.ts:6303-6425）。每条消息驻留 ≈4.5-5.5× 原文（组件+Markdown blockCache+LineAggregator 扁平行）。 — 已修，落点：670c7cb77 + a526eb6f0（chat cap）
- [x] **F27c 图片 base64 常驻**：Image 组件持整段 base64Data（image.ts:40-45），聊天图不受编辑器 64MB 粘贴帽限制；1000 张截图 ≈ 0.3-2GB。 — 已修，落点：05279c433（drop base64）
- [x] **F27d 编辑器无界结构**：UndoStack 无上限且跨会话存活（undo-stack.ts:8、editor.ts:2059）、KillRing 永不释放（kill-ring.ts:9）、pastedImages 仅会话重置时修剪。 — 已修，落点：fb8a90893（undo/kill ring cap）
- [ ] **F27e 次要**：subagentSnapshots 会话内单调增（仅 cancelled 才删）；sideQuestionTurns 按轮累积；completedSnapshots 最坏 128 份全量快照。（待父代理确认：次要项：completedSnapshots 有 128 上限；subagentSnapshots/sideQuestionTurns 未变）
- 修法优先级：①流式改增量 patch ②transcript 组件树窗口化 ③blockCache LRU 限量 ④undo/kill/pastes 加帽 ⑤图片转磁盘引用。
- **官方 72 个开放 PR 无一治理此问题**（worker 侧同类曾修过：#1063/#1288/#957/#1717）。

## F28 [P2] exec.ts 瞬时峰值（收窄后）：仅扩展 pi.exec 路径，100MB 输出≈100-300MB 瞬时 RSS，无跨调用残留；自修（抄 bash-executor 环形+临时文件方案）。

## 官方 PR 评估终裁（10 代理分片，72 个 open PR 全扫）

### 已随内核合并白拿（upstream main 已合并）
#1841（rename 校验真 bug）、#1846、#1849、#1852、#1853

### 待集成 TAKE 清单（按风险从低到高）
1. [ ] **#1882** bash 并发共享 AbortController 修复（带 3 个回归测试；零冲突）
2. [ ] **#367** Anthropic Record schema 递归改写（只动 packages/ai；零冲突）
3. [ ] **#1700** 远程 agent 消息重复投递修复（小改+测试）
4. [ ] **#413** Ghostty 图片默认关（与 #427 互斥，拿 413）
5. [ ] **#1249** session/log 文件 0600/0700（治 F3；需 rebase 我们 619144b6e 的增量扫描改动）
6. [ ] **#1253** 宿主拆除取消 RLM 子代理（需把语义移植到新内核 rlm.repl）
7. [ ] **#1251** --no-session 子代不落盘（叠在 #1249 之后）
8. [ ] **#1519** Enter 恢复 parked queue（F1 同族，拿测试脚手架；F1 本体仍自修）
9. [ ] **#887** 滚轮 3 行→1 行（rebase 一行常量）

### 条件观察（暂不拿）
#485（治 F16，1047 行 DIRTY，先 rebase 演练）、#1756（撞 8981a31c3）、#565、#1845、#1859、#1580（anthropic sdk bump）、#1523、#1631、#1854、#1857、#569、#1115+1106（429 测试网，stacked）

### SKIP（已裁）
#795（DRAFT+熔断器方向不对，不治 F8 实际病）、#1236（把 ACP resident 当设计，与 F14 反向）、#506/#480/#522（架构重写太险）、#1885（+2308 新子系统）、#1170/#1168/#1166（DRAFT 栈）、#531、#1864、#1123、#644、#1239、#1338、#1337、#374、#1349、#1633、#1860、#1851、#1855、#1848、#1106、#1578、#427、#1145、#1146、#1842、#1107

### 官方无人治、必须自修
F1（队列卡死唤醒）、F4（Windows 管道 ACL）、F14（ACP EOF complete）、F8（Codex 重试三宗罪）、F12（paste 吞键盘）、F13（键绑定硬编码）、F27（TUI 内存全家桶）

## 内核合并记录（merge/repl-kernel @ bf542ce7e）
- upstream/main 18 提交已并入，含内核四连 #1684-#1687 + 修复 #1835/#1836/#1838/#1839
- 冲突 2 个文件已解：schema 撞号升 24（新 ID protocol-7-schema-24-3e65c87439aa，内容哈希对齐测试）；删本地 roster 推送法吃 upstream 拉模型；保留风暴节流调度器
- #1886 fixture 修复（protocol 2→3）已手动应用
- npm run check 全绿；daemon-protocol/streaming-list/agents-view/repl-kernel 测试 117/117 绿
- 注意：新内核废除 %%bash/%cd/%env/! 魔法单元（改 bash()/os.chdir/os.environ）；旧 kernel venv 下次启动自动重建（无 ipykernel，更瘦）


---

# 2026-08-29 第三轮追加：逻辑缺陷扫描（测试绿之外的第二道闸）

> 打法：测试全绿后，4 路窄镜头逻辑扫描（3×grok 快扫 + 1×qwen 深挖），专找「测试没挡住的行为错误」。第一轮即中 4 个 high——全是小细节引发、不容易察觉的类。

## 扫描新发现（返工中）

- [x] **F29 B1b 内存帽默认配置下永不触发**（high）：`enforceChatComponentCap` 的守卫 `if (this.ui.isFullscreen()) return` 把「全屏渲染模式」（默认开，tui.ts:783-785 + settings-manager.ts:1142）误当「全屏回看覆盖层」→ 默认用户永远 trim 不到。修法：守卫换成精确的回看状态。 — 已修，落点：3b92861ec + 4bd308a8a（fullscreen-aware chat cap）
- [x] **F30 B6 paste watchdog 是墙钟不是空闲超时**（high）：armPasteWatchdog 只在进 pasteMode arm 一次（stdin-buffer.ts:317），慢终端/SSH 上 >30s 合法粘贴被腰斩，后半截 `201~` 泄漏成普通按键。修法：每 chunk 续期。 — 已修，落点：dbd3297c0（paste idle timeout）
- [x] **F31 B6 Esc 语义反了 + flush 路径病理**（high）：Esc 取消变成把半截粘贴插进草稿，且连锁可清掉用户原草稿；超时/超限 flush 走逐字符 process()——8MB 即百万次 insertCharacter + undo 帽打爆 + 误触 autocomplete。修法：Esc=丢弃；flush 走原子 paste 通道。 — 已修，落点：88f557d38（Esc discard + atomic paste）
- [x] **F32 session 写失败静默吞掉**（high，老 bug 被 A5 放大）：`_agentEventQueue` 尾部 catch 空 + appendMessage 无 try → 一次写失败该条永不补写、UI 无提示。A5 的 ensureNoSymlinkPath 只许首段 symlink，`~/.prime` 整体 symlink 布局（常见）下每次追加都抛错并被吞 → 会话全部静默不持久化。修法：失败响亮可见 + 中间组件 realpath 解析后校验。 — 已修，落点：28f1f0e53（session write failure visibility）

## 审查排除项（确认无误，不再追）

O_EXCL 挡合法改写（temp+rename 模式，append 对已存在文件不加 EXCL）；B1a×B1b 重建后图片显示（fallback 只用 mime+尺寸）；滚轮 3→1 行高一致性；B1b 重建不清编辑器草稿。

## 环境坑备忘（本机测试时必读）

1. **主仓过期 `packages/coding-agent/dist/` 会影子覆盖新运行时**（bootstrap 优先看 dist）——症状 `No module named rlm.repl`；删 dist 即解。跑过 build 就要记得再删。
2. 子代理 shell 会继承 `RLM_DEPTH/RLM_SESSION_DIR/RLM_MAX_DEPTH` → refine 相关测试假红；测试命令前缀 `env -u RLM_DEPTH -u RLM_SESSION_DIR -u RLM_MAX_DEPTH -u FORCE_COLOR`。
3. worktree 的 node_modules 用符号链接共享即可跑测试（已验证）；husky 钩子在 worktree 可能不挂，提交前手动 npm run check。

## 合并瀑布记录（merge/repl-kernel）
已并入：exec-ai(A2+B4+B5)、exec-tui(A4+A9+B1a+B1d+B6)、exec-headless(B9/F2)、exec-daemon(A3+B7+docs)、exec-memory(A8+B1b)、exec-queue①(A1+F1)、exec-security(A5+A6)。每步并后重验（含交叠区并集测试 259/259）。在途：exec-queue B2（流式增量协议）、两个返工。

## L4 深挖新发现（runtime-reviewer，FIX-R1~R4 工单已派发 exec-runtime 分支）

- [x] **F33 派发后 abort 永不结算**（med，确认）：排队回合被泵派发后遭 abort，running 动作永不结算 → unfinishedActionCount 永久 ≥1 → wait_for_idle/quiescence 永挂、会话假忙、驱逐被挡（agent-session.ts:6930-6936, 5793-5815）。F1/B9 的测试都只盖「排队未派发」，没人测「派发后 abort」。 — 已修，落点：cd0b2a600 + c59b414e1（R1 settlement）
- [x] **F34 B9 的 wait_for_headless_completion 是 mutation 类**（med，确认）：print 长等待占住 mutationDrain → 挡 daemon 自更新（80s drain 超时）；反向更新时 print 被 abort 丢最终输出。修法：挪只读/长等待类。 — 已修，落点：9286d44ef（headless completion read-only）
- [x] **F35 A8 resumeQueuedWork 吞错**（low，确认）：daemon-agent-connection.ts:690-697 只回 response.success，worker 侧失败静默。 — 已修，落点：900b0cc69（restore A8 wiring）
- [x] **F36 B9 行为变化未文档化**（low）：print 对永不收摊子代理最长挂 24h（原行为是立即杀子）。 — 已修，落点：111549589（docs: print quiescence）
- [ ] **F37 fence 期本地投递清 updateRestart 挂起标志**（low，待验证）：窗口极窄，下轮实测。（结案留档：k3 实证 _queuedWorkPauses 硬闸下不可达）

## scan2 第二轮新发现（预判链路法）

- [x] **F38 update-restart 回退楔死**（high，scan2-protocol，FIX-R5 已派 exec-runtime）：prepare 成功+shutdown 失败 → fallback restore 被 prepared 态拒绝 → checkpoint 清、phase 卡 prepared、prepare 永久 already preparing。 — 已修，落点：e5eea4a6b（R5 update-restart fallback）
- [x] **F39 半截尾行不修盘导致追加粘连丢数据**（high，scan2-persist，FIX-S3 已派）。 — 已修，落点：72f02cc76（S3 torn-tail repair）
- [x] **F40 交互模式无双开保护**（high→评估中，FIX-S5）：split-brain + rewrite 丢并发追加。 — 已修，落点：438956a80（S5 interactive session leases）
- [x] **F41 journal tmp 无 O_NOFOLLOW/无清理、orphan journal 权限**（med，FIX-S4 已派）。 — 已修，落点：70be3f3a8（S4 journal temp hardening）
- [x] **F42 分支切在工具对中间产生孤儿 toolCall 上下文**（med，scan2-persist）：请求层有 transformMessages 兜底不 400，但分支内容语义不完整。 — 已修，落点：43798f22d（W4 fork cut at tool pairs）
- [x] **F43 F1 唤醒误清 updateRestart 悬置标志**（high，L1+runtime 双撞，FIX-Q1 已派 exec-queue）。 — 已修，落点：d9364b034（Q1 agent-message wake in fence）
- [x] **F44 abort 后 deferred terminal notice 被驱逐丢弃**（med，FIX-Q2 已派）。 — 已修，落点：80290a3db（Q2 deferred notices resident）
- 协议口径备忘：版本握手是 schemaId+appVersion 精确匹配（无协商降级，旧客户端会把新 daemon 当 stale）；list_agent_peers 只有 schema 地板无 capability（与仓规「新命令走协商」不一致，B2 正按 capability 做）。

## scan2-kernel / scan2-compaction 新发现（修复工单已派）

- [x] **F45 快照半恢复覆盖好快照**（high，exec-kernel K1）：restore 单名失败仍半恢复且不置 pendingRestore → 下次成功 execute 把残命名空间覆盖磁盘好快照；resume restore 无超时。 — 已修，落点：da20d5b5c（K1 snapshot guard）
- [x] **F46 interrupt 不杀后台 bash 句柄**（med，K2）：h=bash() 后台句柄只在 shutdown 收；SIGINT 线程信号打不到 start_new_session 的子进程。 — 已修，落点：e2ed4344d（K2 interrupt kills bash handles）
- [x] **F47 shutdown FIFO 被 busy cell 堵死 + 不升级 SIGKILL**（med，K3）。 — 已修，落点：b3956e809（K3 shutdown TERM→KILL）
- [x] **F48 shouldCompact 阈值不 clamp**（high，mechanics C1）：小窗口/大 reserve → 每回合压缩风暴。 — 已修，落点：317bde3a9（C1 threshold clamp）
- [x] **F49 尾部大 toolResult 无切割点 → 永远「太短」压不成但每回合开火**（high，C2）。 — 已修，落点：6aea300c1 + dbbf7a975（C2 summary budget+boundary）
- [x] **F50 压缩中途切分支 → 摘要挂错叶污染新枝**（high，C3）。 — 已修，落点：a4af20f35（C3 pin compaction entries）
- [x] **F51 摘要请求无输入预算 + 失败无冷却**（high，C4）。 — 已修，落点：dbbf7a975（C4 summary budget+cooldown）
- [x] **F52 fileOps 只认 edit.path / 分支摘要不停在 compaction 边界**（med，C5/C6）。 — 已修，落点：abd6b56e1 + a4af20f35（C5/C6 fileOps）
- [x] **F53 pasteMode 会话切换不复位落进新会话**（med，exec-tui FIX-T7）+ F54 Esc 10ms 合并误伤（T8）+ F55 paste 期 Ctrl+C 被吞（T9）+ F56 拆分 CSI Esc 漏识（T10）。 — 已修，落点：d4c706724（T7）+ e81bfb306（T8）+ 054ced32e（T9）+ 964b19afc（T10）
- 内核扫描排除项：#1839 帧隔离真实成立（fd1 私有 dup + TaggedWriter 锁内整行）；并发 execute 串行化有保证。

## scan3 复扫轮（修代码本身）发现 + 合并事故记录

- [x] **F57 A8 被合并事故吃掉**（high，已修复派单 exec-memory）：exec-tui 返工分支 add/add 冲突整文件取 theirs，冲掉 A8 在 interactive-mode.ts 的接线；测试留存所以复扫抓到。**教训（已钉入流程）：每次并入后必跑常驻回归套件（所有已并分支的回归测试并集），不只跑当次分支的测试。** — 已修，落点：3df18c07a（restore A8 wiring）
- [x] **F58 torn-tail 修复时序**（high，FIX-S6 派 exec-security）：repair 在取租前+attach 路径修活文件+repair 在 symlink 校验前。 — 已修，落点：15dd45ebe（S6 torn-tail under write ownership）
- [x] **F59 Q2 deferred notice 钉死驱逐**（med，FIX-Q4 派 exec-queue）：abort 后 notice 永不 flush → isSessionActive 恒真 → 内存泄漏向。 — 已修，落点：2201e7357（Q4 abandon stale deferred notices）
- [x] **F60 MCP 死会话无重连**（high，exec-mcp M1）+ M1b 超时不断连/M2 结果无上限/M3 remove 泄漏 stdio。 — 已修，落点：9ddcefdf9 + 7aea0a937 + 52d80ba12（M1-M3）
- [x] **F61 扩展 hang 冻死 session 含 abort**（high，exec-ext E1）；**F62 /share 无脱敏无确认**（high，E2）；F63 refinement 三步非原子+mtime（med，E3）。 — 已修，落点：320b720f0（E1）+ 0092dd04a（E2）+ 6e3f081fe（E3）
- [x] **F64 heartbeat 已入队+abort → 泵悬置无人唤醒**（med-high，FIX-Q3 派 exec-queue）：用户「卡死」家族的又一变种。 — 已修，落点：648bf8891（Q3 heartbeat wakes queues）
- [x] **F65 trim 后 streaming 中开全屏 → 直播组件成幽灵**（med-high，FIX-T11 派 exec-tui）+ T12 Kitty Esc 吞同块剩余。 — 已修，落点：f5512dbeb（T11 reattach streaming after fullscreen）
- [ ] lease startId 边界/TZ 敏感（S8）、orphan journal 并发胶合与误杀（S9）、persist_failed 节流与覆盖面（S7）——均已派 exec-security。
- 复扫排除：base64 丢弃重建无碍、undo 帽对大粘贴友好、paste 状态机大部组合正确、F1×R1 主路径无重复结算。

## scan3-protocol 发现（FIX-Q5~Q7 派 exec-queue；FIX-R6~R8 派 exec-runtime）

- [x] **F66 R5 只盖同进程重试**（high）：supervisor 进程在 prepare 后被杀 → phase 不恢复+intentionalStop 不落盘+内存 checkpoint 丢失 → 换路径照样楔死。修法：phase/checkpoint 持久化进 manifest。 — 已修，落点：f384214e3（R6 supervisor death prepared recovery）
- [x] **F67 wait_for_headless_completion 名义只读实际可经 autonomous gate prompt**（med）：只读分类与突变异存。 — 已修，落点：9286d44ef（R7 headless completion read-only）
- [x] **F68 delta 链三窗**（med×3）：replaced+snapshotFollows 窗口丢 delta；TUI 无 seed 只 drop 不自请 catchup；attachClient 无条件 seed 共享 reconstructor 会 rewind 且污染历史消息对象。 — 已修，落点：72942804b（Q5-Q7 streaming seeds intact）
- [x] **F69 R5 边界**：memory+disk 皆空仍抛 already preparing；空工人 prepare 把 sessions:[] 盖盘。 — 已修，落点：e5eea4a6b（R8 edges: recover wedged update restart）

## 当前修复工时盘面（10 工人在跑）
exec-memory(A8 恢复) / exec-queue(Q3,Q4,Q5-7) / exec-security(S6-S9) / exec-tui(T11-12) / exec-runtime(R6-8) / mechanics(C1-7) / exec-kernel(K1-3) / exec-stuck(S-T4,S-T1) / exec-mcp(M1-3) / exec-ext(E1-3)

## 实战活现（dogfooding 实证）
- [x] **F70 回合级 provider 错误后子代理通知父代理**（high，exec-ext 活体案例）：grok-cli key 解析瞬时失败 → 回合 stopReason=error → 会话停 needs_input。修法（实际采用）：耗尽/永久错误 → agent_message 通知父代理（含错误摘要）；不做从零退避。落点：f98d84ada（agent-session.ts:3961,11476; agent-messages.ts:18,347）。

## k3 终审（慢模型深审，bf542ce7e..HEAD 全 diff）结果

总判：能发，先补三刀。亲验全部成立：
- [x] **F70a R1 结算洞**：queueVisible:false 的 RLM 终报 turn 派发中 abort 永不结算（FIX-Q8 派 exec-queue） — 已修，落点：eb916ed78（FIX-Q8 settle aborted terminal-notice turns）
- [x] **F70b harness symlink 口径矛盾**（FIX-S10 派 exec-security）：~/.prime 为 symlink 时全局 memory/skill 无声消失 — 已修，落点：feda1c4b7 + 62968fbbb（S10 harness symlink parity）
- [x] **F70c 老用户升级 daemon 起不来**（FIX-S11）：cron 迁移无 catch + 存量 0755 目录被严格读拒 — 已修，落点：3d935f674 + 62968fbbb（S11 cron migration + legacy dir）
- 另 7 条低危记录在案（watchdog 文案/_prompt fence 纵深/reconstructor 引用播种/checkpoint 幽灵文件/E3 回滚纠葛/patch 前缀误伤）
- k3 确认无问题区域：B2 增量分流、R6 复活、torn-tail、K1-K3、M1-M3、bash 超时、F1/Q3/A8、流 stall、C1-C4、退避、journal、print 门控

## 流程事故自记录
- 父代理自身两次被用户抓到：①对后台套件无看门狗干等 1h47m；②干等 k3 投递而不主动拉转录。已存全局 memory「我自己的等待纪律」。


---

# 收尾（2026-08-29 晚）

## 最终并入清单（merge/repl-kernel，共 27 趟）
内核合并(upstream 18提交含rlm.repl) + 9 官方PR(#1882/#367/#1700/#413/#1249摘/#1251/#1253语义移植部分/#1519/#887) + 审计修复群(F1-F69) + 复扫修复群(F29-F69) + k3 终审三刀(F70a/b/c) + 合并回归修复 6 起。

## 关键数字
- 全量测试：4505+ 绿（环境依赖与 flake 除外，全部有分类结论）
- npm run check：每并入必过（含 pre-commit 钩子）
- 文档：daemon.md/settings.md/usage.md/development.md 已与代码对齐

## 未做（下轮）
- B2 已完成（streaming_deltas 协议，schema 25）；TUI 大窗口化的进一步优化空间仍在
- B8 键绑定迁移 13 处（机械活）
- C 阶段：F4 Windows 管道 ACL（需 Windows 实机）、C2 supervisor capability 校验、C3 shutdown 鉴权
- F70 回合级 provider 错误的子代理自动重试/升级（exec-ext 活体案例）
- k3 终审的 7 条低危

## 流程教训（已固化）
1. 并行合并必跑常驻回归套件（A8 被吃掉事故）
2. 二分定罪要到 commit 粒度（waitForIdle 的 E1 纠偏）
3. 子代理 shell 环境污染清单：RLM_*/PRIME_AGENT_INTERNAL_*/FORCE_COLOR
4. 后台等待必须有看门狗（我自己的纪律 memory）
5. grok 预判链路法 + 父代理亲验；k3 慢而深做终审
