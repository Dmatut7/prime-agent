# Fork 更新记录

本文件是这个 fork 的**更新日志，最新的在最上面**。每条记录写清楚：改了什么、为什么改、对用户 / AI 能力的影响。深入细节见每节末尾链接的 `docs/fork/` 文档。

- 主分支：`merge/repl-kernel`（推送到 `fork/merge/repl-kernel`，github.com/Dmatut7/prime-agent）
- 上游同步分支：`sync/upstream-r3`
- 旧审计文档（R1/R2）：`docs/fork/audit-findings.md`、`docs/fork/fix-plan-r1.md`、`docs/fork/fix-plan-r2.md`

---

## 2026-09-05 · R3 上游同步 + 全面复审 + 第一批修复

这一轮做了三件事：① 把官方又新增的 40 个提交同步进来（R3）；② 对整个 fork 做一次全面复审（6 个维度 × 两个不同模型交叉对质）；③ 把复审出的最高优先 7 个缺陷修掉、并入主分支、推送。下面按"你能不能感觉到"排。

### 一、R3 上游同步（官方 40 个新提交，2026-07-23 ~ 07-29）
- **做了什么**：把官方 main 自上次同步后新增的 40 个提交合并进 fork（merge commit `3367d85c4`，涉及 197 个文件，43 处冲突逐块手工解）。
- **最大件**：daemon 协议 schema revision 26→27（digest `589a2219bc8b`）；CHANGELOG 恢复"只写 fragment、不直接改 CHANGELOG.md"的流程；cherry-pick 了 3 个官方 PR（#2027 / #1947 / #1896）。
- **本地东西一个没丢**：264 个本地独有文件、54 个本地独有测试全部保住、零覆盖（硬约束：全程用 merge，绝不 `git checkout upstream/main -- .` 整树覆盖）。
- **状态**：已推送到 `fork/sync/upstream-r3` 分支；合并回主分支 `merge/repl-kernel` 还差一步（F4，见本节末）。

### 二、全面复审（6 维度 × qwen3.8-max-0902 + kimi-k3 双向交叉）
- **做了什么**：6 个 lane（正确性 / 性能 / 业务逻辑 / 代码质量 / 优雅性 / 垃圾代码审计），每个 lane 由两个**不同**模型独立审、再逐条对质收敛——避免单模型盲区。
- **产出**：全新记录 `REVIEW_FINDINGS.md`（28 个修复簇，编号 F1-F28）+ `FIX_PLAN.md`（修复计划，经多模型双审通过）。这两份取代旧的 `docs/fork/audit-findings.md`。
- **沉淀的复核纪律（62 条）里最关键三条**：
  - **总闸原则**：任何优化都不能降低 AI 的能力。这条抓出并修正了 2 个"看似优化、实则降能力"的修法。
  - **验收恒真检测**：每个断言 / CI 门必须有"植入已知违规 → 必须红"的正控，否则门是假的（恒真）。
  - **grep ≠ 可达性**：grep 到危险模式只证明模式存在，必须读包住它的代码确认它真能触发。

### 三、第一批修复（7 条，已并入主分支 + 推送，HEAD `4871d9223`）
全部满足"对 AI 能力提升或中性"（总闸零违例）；每条带回归测试（先红后绿证明）+ 变异测试（锁住每个修法分量，半变异也得红）。

| 编号 | 用户能感觉到的问题 | 根因 → 修法 | 对 AI 能力 |
|---|---|---|---|
| **T12** | 长时间跑后终端报 MaxListenersExceededWarning、最后废掉 | 每次 sleep 调用泄漏一个 abort 监听器 → `{once:true}` + settle 时 clearTimeout | 中性（行为逐字不变；变异测试锁两段修法） |
| **T0** | （看不见——是防回归的门） | 测试债无门拦截、私有探测泛滥 → 加 `test-hygiene` CI job（私有探测扫描器）+ 测试可信度三修 | 中性（零生产代码改动） |
| **T5** | google/vertex 返回畸形工具调用时，工具竟被执行了 | stopReason 把畸形调用洗白成 end_turn → 路由到 malformed-tool-call 错误路径 | **提升**（畸形工具不再被误执行） |
| **T3a** | 编辑器输入某些宽字符（不可断 grapheme）→ 栈溢出 → 整个终端崩溃（E6） | 递归无守卫 → 加 `subSegments.length < 2` 守卫 | **提升**（拼接还原逐 code point，不丢输入） |
| **T9** | anthropic/bedrock 带 thinking 的会话，每个后续回合必挂 400 | thinking 签名跨回合重放污染 → 剥掉非末回合签名 + 降级为 text | **提升**（每回合必挂 → 可降级续聊） |
| **T7** | 高频 mutating command 时 daemon journal 每条 fsync 拖慢 | per-record fsync → 去 append fsync、compact 时 fsync 保留、journal 限界 | 中性（掉电窗口 ≤4096 条 / ≈5.4 分钟，已在 changelog 诚实披露） |
| **T1c** | 大工具参数时 UI 每帧 O(n²) 重算 argsSignature、卡顿 | 每渲染重算 → O(1) 缓存 | 中性（rebuild 触发集合 ⊇ 修前，不漏渲染） |

- **合并怎么做的**：先建一条干净集成分支、验证 7 条改动文件级零重叠（任意顺序合并无冲突）→ `npm run check` 全绿 → 受影响包测试全绿（tui 200/0、ai 36 passed、coding-agent 137/0）→ ff-only 并入主分支 → 推送。**全程别车道的未提交工作完整保留**（porcelain 始终 13 行）。

### 四、还没做（下一批，全部 gated on F4）
复审出的 28 簇里，第一批做了 7 个最高优先、且与 R3 零交集的。剩下 21 簇几乎都要改 R3 也改过的文件（provider/daemon），必须在 R3 合并回主分支（schema27 基线）之后做，否则冲突：
- **第一批 R3-交集 10 条**：T1a/T1b（流式节流）、T2（fork 错误恢复四件套）、T4（崩溃放大器）、T6（压缩三机制）、T8（OSC133）、T10（retry 假死）、T11（BrandSplash）、T13（side-question 流停滞）、T14（refine 窗口）。
- **第二批 F9-F16**：bedrock token 口径、response.incomplete、schema digest 门、出站表、contract 工单、gpt-5.5 定价、handoff msg id、usage.input Math.max、垃圾代码纯删。
- **第三批架构 F17-F25**：god-object 拆分、循环依赖解除、测试与生产分歧。
- **F4 是什么**：别车道有一个未提交的 `packages/ai/src/providers/openai-completions.ts`（一个完整的 Bailian `preserve_thinking` + `enable_search` 特性），R3 也改这个文件，git 拒绝覆盖未提交改动 → R3 merge-back 卡住 → 上面 21 簇全卡住。解法三选一：别车道自己提交 / 授权代提交那一个文件 / 继续 hold。

细节文档：全面复审 `docs/fork/review-findings-r3.md`、修复计划 `docs/fork/fix-plan-r3.md`、R3 同步任务书 `docs/fork/sync-upstream-r3.md`（在 `sync/upstream-r3` 分支）。

---


## 2026-08-29 晚 · R2 迭代

在 R1 基线上追加了第二轮工作。

### upstream 二次合并（15 提交）

upstream/main 新增 15 个 squash commit，已并入（`71eeb5629`）。含 #1756（worker 恢复后再复用）、#1842（队列状态单一来源）、#1845（RLM 子快照单一投影）、#1859（quiescence 事件唤醒替代轮询）、#1882（官方版 bash 并发 abort）、#1864（in-flight open 所有权）等。冲突逐 hunk 解，并入后跑常驻回归套件。

### W0-W9 工单结果

- **W0**（upstream 二次合并）：完成。15 提交并入，冲突 5 个文件逐 hunk 解。
- **W1**（F70 子代理错误通知父代理）：完成。耗尽/永久错误 → agent_message 通知父代理（`f98d84ada`）；不做从零退避。
- **W2**（F10 edit 原子写 + F11 exec 进程组/输出截断）：完成（`577f1032b` + `8dde3fdfa`）。
- **W3**（#1253 移植：宿主拆除取消在途 kernel host 请求）：完成（`4afca168e`）。
- **W4**（F42 分支切点对齐工具对）：完成（`43798f22d`）。
- **W5**（B8 键绑定迁移）：完成（`142022669`，12 处迁入配置表）。
- **W6**（k3 低危十条）：完成。5 修 5 留档（`204fe7811`）。
- **W7**（F5/F6 安全收口：supervisor capability 校验 + shutdown 鉴权）：**在跑**。
- **W8**（F4 Windows 管道 ACL）：完成（`2637973c1`），标注「Windows 未实机验证」。
- **W9**（F15/F17 窄时序窗）：留档未开工（k3 实证可达性极低）。

### 文档搬迁

fork 工作文档统一搬入 `docs/fork/`：审计总账 `audit-findings.md`、R1 任务书 `fix-plan-r1.md`（原 `FIX_PLAN_20260829.md`）、R2 任务书 `fix-plan-r2.md`。`FORK_NOTES.md` 保持为简洁入口（`acd9b3ed1`）。

### R2 遗留（截至 R2，部分已被 2026-09-05 全面复审重新评估）

- F5/F6 安全收口（W7，在跑）
- F15/F17 窄时序窗（W9，留档）
- F27e 次要内存项（subagentSnapshots/sideQuestionTurns 未加帽）
- Windows 管道 ACL 实机验证
- k3 终审 7 条低危

详见 `docs/fork/audit-findings.md` 未勾条目与 `docs/fork/fix-plan-r2.md` 状态列。

---

## 2026-08-29 · R1 大合入

## 这次更新是什么

一次大合入：官方最新内核 + 官方未合并 PR 精选 + 一整天源码审计出的缺陷自修。三管齐下，测试 4580+ 绿。

## 内容从哪来

1. **官方 main 合并（18 个提交）**：最大件是内核换血——Jupyter/ipykernel 换成官方自研的极简 CPython REPL（`rlm.repl`，启动 1.2s→30ms，内存更瘦）。注意：官方把 `%%bash`/`%cd` 这类魔法语法废了，改用 `bash('cmd')`/`os.chdir()`。
2. **官方未合并 PR 拿了 9 个**（官方合得太慢，不等了）：#1882（bash 并发 abort 修复）、#367（Anthropic 工具参数丢失）、#1700（消息重复投递）、#1249（文件权限 0600）、#1251、#1253、#1519、#413、#887。另外 60+ 个 PR 评估后放弃（名单与理由在 docs/fork/audit-findings.md）。
3. **自修 40+ 个缺陷**：9 个代理独立审计 + 多模型交叉对质 + 三轮逻辑复扫出来的，每一个都有代码级证据。

## 解决了什么问题（按你能不能感觉到排）

- **内存不再膨胀**：以前跑两三天 TUI 进程 2.4~3.5GB，现在聊天记录有上限、图片用完即释放。
- **「卡死」有救**：bash 命令默认 10 分钟超时；任何卡住 5 分钟报警+留现场日志、15 分钟自动救活会话；4 个具体卡死根因已修。
- **子代理可靠了**：父催子消息不再丢；print 模式不再误杀还在干活的子代理；子代理死了会被发现。
- **粘贴不再假死**：半截粘贴 30 秒自恢复，Esc 可取消。
- **安全收紧**：会话记录 0600（同机其他用户读不到）；/share 上传前扫描 API key 并警告。
- **MCP 断了能自愈**：MCP server 崩溃后自动重连。
- **compaction 不再风暴**：小窗口配置下不再每回合狂压。
- **老用户升级不炸**：cron 迁移失败降级为日志；存量 0755 目录自动收紧不报错。

## 验证口径

- 每次并入：`npm run check` 全绿 + 交叠区域测试并集
- 终检：全量套件 4580 绿；失败仅剩网络依赖（telemetry/git-update/version-check）与重负载偶发，均有分类结论
- 修复全部带回归测试（先红后绿验证）
