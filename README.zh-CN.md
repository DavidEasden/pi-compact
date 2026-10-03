# pi-compact

> English: [README.md](README.md)

面向 [Pi](https://pi.dev/) 的长期记忆、确定性 session 压缩与精确历史召回扩展。

`pi-compact` 的核心是长期记忆。压缩负责窗口容量管理：历史可恢复，长期记忆在多次压缩、重启和 context window 切换后仍可重建，并通过工具按需查询。扩展不调用 LLM 生成压缩摘要，也不把压缩 checkpoint 或模型笔记当成事实源。原始 session entries 始终保留，可通过召回工具重新读取。

## 功能

- 在项目 `.pi/pi-compact/` 中维护 append-only 记忆事件日志；当前记忆状态由纯函数从事件重放，旧事件不能静默覆盖。
- 用户通过 `/remember`、`/memories`、`/forget` 写入权威记忆；模型只能提出 provisional 提议，不会自动变成 active 或 pinned。
- 模型通过工具按需查询历史与记忆；扩展不注册 context 注入，不自动附加历史正文或 pinned/active 提示。
- 接管 Pi 原生的 `/compact` 命令，以及普通的 `manual`、`threshold` 和 `overflow` compaction。
- 使用 Pi 自己计算的压缩边界、token accounting、持久化和恢复流程；checkpoint 是确定性指针/审计内容，不是 primary memory。
- 记录 WindowManifest（windowId、父窗口、保留边界、sourceCount、sourceHash、previousHash）。
- 在压缩前检查工具调用与工具结果是否完整配对；发现不安全边界时优先回退到更早的安全边界，找不到任何安全边界才取消本次接管，避免破坏上下文。
- 生成确定性的事件 ledger，不把规则提取结果伪装成目标、决策或已完成任务。规则派生只提取文件、命令、退出码、测试计数等不需要语义推断的字段，并带 provenance。
- 历史记录区分 primary/derived：`compaction` 与 `branch_summary` 属于 derived，可用 `sourceClass` 过滤；thinking 保留在 raw 中，不进入默认搜索文本。
- 提供 `pi_compact_recall` 工具，支持 list/search/read、entry ID、关键词、文件路径、消息类型、分页和原始 entry 回放；长 raw 可用 `offset`/`rawLimit` 分段读取。
- 提供 `/pi-compact-recall` 命令，仅通过 UI 显示召回结果，不触发模型 turn。
- 提供 `pi_memory_search`、`pi_memory_read`、`pi_memory_propose`、`pi_memory_update` 与 `pi_compact_new_context`。
- 自动创建项目级 `.pi/pi-compact.json` 配置，不覆盖已有项目或全局配置。

## 安装

当前源码要求 Pi `>=0.87.1`，开发与集成测试固定在 `0.87.1`；该版本要求 Node.js `>=22.19.0`。以下内容假设该仓库位于 `github.com/DavidEasden/pi-compact`。已发布的 `v0.4.0` 与当前源码一致。

Pi package 会执行扩展代码，请在安装前审查源代码。

### 通过 GitHub 安装

推荐固定到发布 tag（固定后的 ref 不会被 `pi update --extensions` 或 `pi update --all` 移动）：

```bash
pi install git:github.com/DavidEasden/pi-compact@v0.4.0
```

或者不固定 ref，直接跟踪默认分支：

```bash
pi install git:github.com/DavidEasden/pi-compact
```

也支持 SSH 简写与原始 HTTPS URL：

```bash
pi install git:git@github.com:DavidEasden/pi-compact@v0.4.0
pi install https://github.com/DavidEasden/pi-compact@v0.4.0
```

说明：

- `git:` 前缀启用 `host/user/repo` 与 `git@host:user/repo` 简写；不带前缀时只接受协议 URL（`https://`、`http://`、`ssh://`、`git://`）。
- `v0.4.0` 必须是已存在的 tag 或 commit（首次可用 `git tag v0.4.0 && git push origin v0.4.0` 创建并推送）。以后升级到新 tag，重新执行 `pi install git:github.com/DavidEasden/pi-compact@<新tag>`。
- 全局安装会克隆到 `~/.pi/agent/git/github.com/DavidEasden/pi-compact`；使用 `-l`（项目 settings）时克隆位于 `.pi/git/github.com/DavidEasden/pi-compact`，项目信任后启动时会自动安装缺失的 package。
- 不安装也可以临时试用：

```bash
pi -e git:github.com/DavidEasden/pi-compact
```

### 通过 npm 安装

同一份代码已发布到 npm，包名为 `pi-compact`：

```bash
pi install npm:pi-compact@0.4.0
```

或者跟踪最新发布版本：

```bash
pi install npm:pi-compact
```

不安装也可以临时试用：

```bash
pi -e npm:pi-compact
```

说明：

- 形如 `npm:pi-compact@0.4.0` 的带版本 spec 会被固定，`pi update --extensions` 与 `pi update --all` 会跳过它。
- 全局安装位于 `~/.pi/agent/npm/`；使用 `-l`（项目 settings）时位于 `.pi/npm/`。

### 临时加载本地版本

在项目根目录执行：

```bash
npm ci
pi -e /absolute/path/to/pi-compact
```

也可以直接指定入口文件：

```bash
pi -e /absolute/path/to/pi-compact/index.ts
```

### 安装本地 package

```bash
pi install /absolute/path/to/pi-compact
```

默认写入全局 Pi settings。使用 `-l` 可以写入当前项目的 `.pi/settings.json`：

```bash
pi install -l /absolute/path/to/pi-compact
```

当前项目使用 Pi 的 `@earendil-works/pi-coding-agent` API，并按 Pi `0.87.1` 验证 `context_edit` 与压缩后的消息投影。Pi 和 `typebox` 是 peer dependencies，由 Pi 环境提供；开发依赖固定 Pi `0.87.1`，用于可重复的宿主集成测试。

## 配置

首次启动扩展时，如果项目中没有配置文件且用户目录中也没有全局配置，扩展会创建：

```text
.pi/pi-compact.json
```

配置优先级为：

1. 当前项目的 `.pi/pi-compact.json`
2. 全局的 `~/.pi/agent/pi-compact.json`
3. 内置默认值

扩展使用第一个存在的配置文件，并以默认值补齐缺失字段；项目配置与全局配置不会逐字段合并。如果项目配置存在但 JSON 无法解析，扩展使用默认配置，不会继续读取全局配置。

默认配置如下：

```json
{
  "enabled": true,
  "overrideDefaultCompaction": true,
  "summaryMaxChars": 12000,
  "autoRecall": true,
  "autoRecallMode": "full",
  "autoRecallMaxChars": 5000,
  "recallMaxResults": 8,
  "recallMaxChars": 16000,
  "debug": false,
  "memory": {
    "enabled": true,
    "pinnedInjection": true,
    "proposalsProvisionalOnly": true,
    "hintMaxChars": 4000,
    "deriveOnCompact": true
  },
  "history": {
    "autoRecallPrimaryOnly": true,
    "excludeInContext": true
  },
  "window": {
    "manifest": true
  }
}
```

配置项说明：

| 配置项 | 默认值 | 说明 |
| --- | ---: | --- |
| `enabled` | `true` | 是否启用压缩接管；召回工具仍可使用，记忆功能由 `memory.enabled` 控制 |
| `overrideDefaultCompaction` | `true` | 是否接管 Pi 的普通 compaction；关闭后保留默认压缩 |
| `summaryMaxChars` | `12000` | 确定性 checkpoint 文本的最大字符数 |
| `autoRecall` | `true` | 仅兼容旧配置，当前不启用自动召回 |
| `autoRecallMode` | `full` | 仅解析旧的 `full`/`hint`/`off` 模式，当前均不注入历史 |
| `autoRecallMaxChars` | `5000` | 旧自动召回预算，当前无运行时作用 |
| `recallMaxResults` | `8` | 旧自动召回条数，当前无运行时作用；手动查询使用 `limit` |
| `recallMaxChars` | `16000` | 召回输出字符预算；模型工具始终遵守，只有 UI 命令可显式读取超预算的单条完整 raw |
| `debug` | `false` | 是否输出扩展调试日志（只输出计数和字符数，不输出原文） |
| `memory.enabled` | `true` | 是否启用长期记忆命令、工具读写与规则派生 |
| `memory.pinnedInjection` | `true` | 旧提示注入开关，当前无运行时作用 |
| `memory.proposalsProvisionalOnly` | `true` | 模型提议只能以 provisional 写入；即使设为 `false` 也不会自动升级为 active/pinned |
| `memory.hintMaxChars` | `4000` | 旧工作记忆提示预算，当前无运行时作用 |
| `memory.deriveOnCompact` | `true` | 压缩成功提交后是否写入规则派生的 provisional 记录（文件/命令/退出码/测试计数） |
| `history.autoRecallPrimaryOnly` | `true` | 旧自动召回来源过滤，当前无运行时作用 |
| `history.excludeInContext` | `true` | 旧自动召回去重开关，当前无运行时作用 |
| `window.manifest` | `true` | 压缩成功提交后是否写入 WindowManifest 与窗口事件日志；取消不写入 |

也接受扁平别名，例如 `memoryEnabled`、`memoryHintMaxChars`、`historyAutoRecallPrimaryOnly`、`windowManifest`。嵌套对象优先。数值配置必须是正安全整数。`summaryMaxChars`、`autoRecallMaxChars`、`recallMaxResults`、`recallMaxChars`、`memory.hintMaxChars` 的上限依次为 `100000`、`50000`、`30`、`100000`、`50000`；超过上限的合法值会被截断，非法值会回退到默认值；未知配置项会被忽略。字符预算不是 token 预算。默认策略：记忆开启、模型提议仅 provisional；历史与记忆都通过工具按需查询。旧注入配置仍可解析，但不会重新启用已移除的 context hook。

自动压缩阈值和保留尾部大小仍由 Pi 自身的 compaction settings 控制，本扩展不另设触发阈值。

## 使用

### 立即压缩

使用 Pi 原生命令：

```text
/compact
```

Pi 原生的 `/compact` 命令会调用正常的压缩流程。当 `enabled` 和 `overrideDefaultCompaction` 都为 `true` 时，本扩展接收 `session_before_compact` 事件，并用确定性 checkpoint 替换 Pi 默认的 LLM 摘要。扩展不再注册单独的压缩命令。当 `enabled` 或 `overrideDefaultCompaction` 为 `false` 时，`/compact` 保留 Pi 默认的摘要行为。

### 权威长期记忆

长期记忆存放在项目目录 `.pi/pi-compact/memory.jsonl`（append-only 事件日志）。当前状态由纯函数 projector 重放得到。用户写入是权威来源；模型提议默认且始终为 provisional，必须由用户 `/remember` 确认后才成为 active/pinned。扩展不能保证模型一定遵守这些记忆。

`memory.jsonl`（及 `windows.jsonl`）的追加受按日志文件的同步文件锁（`.pi/pi-compact/memory.jsonl.lock`、`windows.jsonl.lock`）保护，避免多个 Pi 进程交叉执行「读末条 → 算 seq → 追加」而丢失事件。`PI_COMPACT_LOCK_TIMEOUT_MS` 只是有限等待超时（主要供测试），不是活锁租约：持有者 PID 仍存活时，不会因为锁文件年龄而回收。崩溃恢复只在以下情况删除锁：所有者 PID 明确死亡；锁内 startTime 与实时启动时间都能读到且明确不同（PID 复用）；或能用当前进程的 startTime 证明这是本进程遗留且当前未持有。Linux 读取 `/proc/<pid>/stat`；macOS 和其他可用 Unix 平台尝试设置 `TZ=UTC` 后同步执行 `ps`；Windows 尝试标准系统能力（如 PowerShell `Get-Process` StartTime）。启动时间身份是尽力而为——并非所有平台都能读到，失败一律视为无法验证。无法解析、空的或缺少有效 owner token/pid 的锁在宽限期内不会被自动删除（可能正处在创建写入窗口）；超过宽限期（`PI_COMPACT_STALE_LOCK_GRACE_MS`，默认 1000 毫秒，主要供测试覆盖）后按崩溃遗留自动回收，避免空锁文件把写入永久卡死。宽限期内无法验证身份时会等到超时，并抛出明确错误：所有者 metadata 无法验证或锁仍被持有，且本次写入未完成。人工删除 `.lock` 文件仍是明确的恢复途径。锁在进程内可重入，事务结束时必然释放。释放与回收必须核对锁文件中的 owner token，并在存在 pid/startTime 时一并核对；expected metadata 缺失或不匹配时不会删除他人的新锁。写入失败会显式报错并告知用户或模型，失败后不会声称写入成功。

读取任一日志时，事件必须构成完整链：`seq` 从 1 起严格连续递增，`prevHash` 必须等于上一条被接受事件的 hash，且每条事件自身 hash 正确。遇到首个非法、重复、跳号或被篡改的事件即停止，只重放可信前缀。一旦存在这样的事件，该日志的后续追加会被拒绝并报出明确错误：用户必须先人工修复日志才能继续写入，扩展不会通过截断或重写日志来掩盖问题。EOF 处无法解析的半行仍被容忍——读取时跳过，下次追加前补齐换行，因此写入中途崩溃仍可恢复。

```text
/remember 使用 pnpm 而不是 npm
/remember pin kind:constraint 不要修改生产数据库
/remember supersede:mem_abc 新的权威表述
/memories
/memories status:pinned token
/forget mem_abc
```

`/remember` 支持 `pin`、`kind:`、`scope:`、`priority:`、`supersede:<id>`。`/memories` 可按 `status:`、`kind:` 和关键词过滤。`/forget` 将记忆标记为 resolved，不再出现在默认记忆查询中。这些命令只做本地确定性写入并通过 UI 通知，不触发模型 turn。

记忆工具：

| 工具 | 说明 |
| --- | --- |
| `pi_memory_search` | 搜索记忆；无关键词且无显式 status 时列出 pinned/active/provisional；支持 offset/limit 分页 |
| `pi_memory_read` | 按 ID 读取；默认读取 4000 字符，长内容通过 offset/limit 分段 |
| `pi_memory_propose` | 模型提出 provisional 记忆，不会自动变成 active/pinned |
| `pi_memory_update` | 只能 edit/resolve 模型自己的 provisional 提议 |
| `pi_compact_new_context` | 登记换窗请求；同批工具全部完成后压缩，成功后继续当前任务；不支持时提示使用 `/compact` |

`memory.enabled=false` 会同时禁用记忆命令、搜索、读取、提议和修改。`scope:session` 的记录仅在创建它的同一 sessionId 下可见、可修改；没有有效 sessionId 时不能创建或访问会话范围记录。`project` 和 `user` 保持当前项目内共享的行为，不会转存到用户全局目录。

记忆搜索和读取的总文本输出上限固定为 16000 字符，包含 JSON 元数据与转义。搜索对每条正文生成最多 600 字符的片段，省略的完整内容可按 ID 读取；读取默认段长为 4000，显式大 limit 也受总预算限制。搜索的 `details.nextOffset` 是下一页记录偏移；读取 JSON 的 `nextOffset` 是下一段正文字符偏移。显式查询 `status:resolved` 或 `status:superseded` 无需同时提供关键词。过大的元数据会标记 `metadataTruncated`，原始记忆仍保留在日志中。

换窗工具只在压缩成功回调之后发起一次续跑。工具批次被用户中止、压缩失败或取消、会话切换，或已有新输入时，不会擅自续跑；失败仍可使用 Pi 原生 `/compact` 重试。

规则派生记忆带 `author=rule` 与 provenance，状态为 provisional，不是用户确认的事实。

### 手动召回

在 Pi 中执行：

```text
/pi-compact-recall token 刷新
```

支持的参数形式：

```text
/pi-compact-recall file:src/auth/session.ts
/pi-compact-recall kind:tool_result timeout
/pi-compact-recall ids:entry-123,entry-456 raw
/pi-compact-recall scope:all 旧配置 page:2 limit:5
/pi-compact-recall raw:true file:src/auth.ts
```

参数说明：

| 参数 | 说明 |
| --- | --- |
| 普通文本 | 按关键词搜索原始 session records |
| `ids:id1,id2` | 按 entry ID 精确选择记录 |
| `file:path` | 匹配记录中的文件路径 |
| `kind:type` | 按 `user`、`assistant`、`tool_call`、`tool_result`、`bash` 或 `custom` 过滤 |
| `scope:active-lineage` | 只搜索当前 branch，默认值 |
| `scope:all` | 搜索整个 session，包括其他 branch |
| `page:N` | 结果分页，从 1 开始 |
| `limit:N` | 每页结果数，默认 8，范围为 1 到 30；不受 `recallMaxResults` 影响 |
| `raw` 或 `raw:true` | 输出原始 session entry JSON |
| `list` 或 `action:list` | 按最近记录有界列出，不需要关键词 |
| `offset:N` | raw 分段读取的字符偏移 |
| `rawLimit:N` | raw 分段读取的字符长度 |
| `sourceClass:primary\|derived\|all` | 按来源类别过滤 |

示例中的 entry ID 是占位符，请使用召回结果中显示的真实 ID。

指定 `ids` 后，按 ID 选择记录并应用 `scope` 和 `limit`，忽略关键词、`file`、`kind` 和 `page`；结果按 session 原有顺序返回。未指定 ID 时，需要关键词或 `file`（`action` 为 `list` 除外），空查询或仅指定 `kind` 不会列出全部历史。

关键词搜索是分词后的文本匹配，不支持正则表达式或语义检索；文件过滤仅匹配已提取的路径，不读取磁盘文件。路径主要来自工具参数和简单 bash 命令，消息正文中的路径不一定被索引。命令按空白拆分参数，不支持带空格路径的引号解析；这类路径可通过工具的 `file` 字段传入。

命令仅通过 UI 通知显示召回内容，不发送给模型，也不新增 session 消息。UI 命令可使用 `scope:all` 查看其他 branch；模型工具始终限定为当前 branch。

### `pi_compact_recall` 工具

模型可以直接调用：

```json
{
  "query": "token 刷新",
  "file": "src/auth/session.ts",
  "kind": "tool_call",
  "scope": "active-lineage",
  "page": 1,
  "limit": 8,
  "raw": false
}
```

可用字段与 `/pi-compact-recall` 参数对应：`query`、`entryIds`、`file`、`kind`、`scope`、`page`、`limit`、`raw`、`action`、`offset`、`rawLimit` 和 `sourceClass`。

`action` 为 `list`/`search`/`read`。模型工具的所有输出（包括单个 entry ID 的 `raw`）均受 `recallMaxChars` 硬预算限制。单条 raw 超预算时返回包含 `entryId`、`offset`、`limit`、`totalChars`、`truncated` 与 `body` 的有效 JSON，可用 `offset`/`rawLimit` 继续分段读取。只有 UI 命令显式指定单个 `ids`、`raw` 且不指定分段参数时，才返回不受该预算限制的完整原始 entry JSON。

多条 raw 只输出预算内的完整 entry，并提示省略的 ID；不会从 JSON 中间截断。pretty 输出按完整结果块裁剪。分页划分记录，`offset`/`rawLimit` 划分单条原文。原始工具参数、输出、时间戳和父子关系保留在 raw 中；thinking 不进入默认搜索文本。`compaction` 与 `branch_summary` 属于 derived，可用 `sourceClass` 过滤。

## 历史与记忆的按需查询

当前版本不注册 `context` hook，不自动注入 `pi-compact-auto-recall` 或 `pi-compact-memory-hint`。旧的 `autoRecall*`、`memory.pinnedInjection`、`memory.hintMaxChars` 和 `history.*` 字段保留配置兼容性，不能重新开启注入。pinned/active 记忆可通过 `pi_memory_search` 和 `pi_memory_read` 查询。

模型调用 `pi_compact_recall` 时只搜索当前 branch；active lineage 无法取得时不会扩大到整个 session。用户可在 `/pi-compact-recall` 命令中显式指定 `scope:all` 查看其他 branch。工具返回内容会作为普通工具结果进入模型上下文，UI 命令返回内容只显示在界面中。

保存在 session 中的原文可精确回查；按需查询不保证模型主动召回所有相关细节，也不保证它遵守全部记忆。

## 压缩与数据边界

`pi-compact` 只接管普通 compaction，暂不接管 Pi 的 `session_before_tree` 分支摘要。

压缩时：

1. 使用 Pi 提供的 `firstKeptEntryId` 作为保留边界，包括无上下文消息的元数据和被 `context_edit` 省略的条目。
2. 使用 Pi 提交前的 context projection，将边界之前的可见消息转换成带 ID 的审计记录。`context_edit` 的省略会影响 checkpoint 的计数和哈希，替换会影响派生记忆使用的投影记录内容；原始 entry 仍可通过显式召回回放。
3. 生成只含 `compactor`、`sourceCount`、`sourceHash` 的确定性 checkpoint；不复制历史正文，checkpoint 不是 primary memory。
4. 保存 `sourceEntryIds`、`sourceHash`、`sourceRecordCount`、`keptEntryId`、`omittedRecordCount`、`checkpointChars`、`summaryMaxChars`、`isSplitTurn`、`estimatedTokensAfter`（字符数 / 4 向上取整，不是 provider usage）。扩展不会伪造计费 `usage`；Pi 会自行计算包含完整上下文的压缩后估算值。
5. 使用 Pi 0.87.1 的 `buildSessionProjection()` 预演候选 compaction，检查应用 `context_edit` 省略与替换后的保留尾部。结果必须跟在对应调用之后，普通调用必须有结果；已被 checkpoint 替换的前缀不阻塞压缩。边界不安全时在当前 compaction window 内逐个预演更早边界；没有安全边界、无法构造投影或请求中止时取消，不落回 LLM 摘要。Pi 的 `error`、`aborted` assistant 终态允许无结果调用。安全校验通过后，checkpoint 生成出错会降级为指针型 JSON；回退后重新计算 `isSplitTurn`。
6. Pi 提交 compaction 并发出成功事件后，才在同一文件锁中生成窗口清单并写入 `.pi/pi-compact/windows.jsonl`；窗口 ID 绑定 sessionId 与实际 compaction entry，重复事件不会重复写入。规则派生记忆也在成功后写入。失败或取消不会留下窗口及派生记录。旧 checkpoint 中的 `details.window` 仍可读取，新清单以窗口日志为准。

原始 session entries 才是历史事实来源；用户写入的 memory log 才是长期记忆事实来源。checkpoint 只保存计数和哈希，不是原文备份，也不会验证历史消息中的陈述是否正确。图片等非文本内容在文本提取中仅显示占位信息。

扩展不删除原始 session entries，也不建立独立备份；原文仍依赖 Pi 的 session 存储。有限上下文不能同时展示全部历史。

## 开发

安装依赖：

```bash
npm ci
```

运行测试：

```bash
npm test
```

`npm test` 同时运行单元测试与 Pi SDK 集成测试；仅运行宿主生命周期回归可使用 `npm run test:integration`。集成测试使用本地 Faux provider，不需要 API key，不访问线上模型，所有会话和日志都写入临时目录。

运行 TypeScript 类型检查：

```bash
npm run typecheck
```

检查发布包内容：

```bash
npm pack --dry-run
```

运行源码的发布白名单为 `index.ts` 和 `src/`；npm 还会自动包含 `package.json` 和本 README。测试文件与 `tsconfig.json` 不会进入 package。

## 项目结构

```text
index.ts                 Pi 扩展入口
src/config.ts            配置读取、归一化和初始化
src/hooks.ts             压缩投影校验与 session hooks
src/recall.ts            召回工具与 /pi-compact-recall 命令
src/memory.ts            记忆命令与记忆/新窗口工具
src/core/content.ts      消息文本、文件、thinking 分离和片段边界
src/core/auto-recall.ts  旧自动召回门控纯函数，未接入运行时
src/core/lock.ts         同步日志锁、owner-token 回收、跨平台启动时间身份
src/core/ledger.ts       确定性 checkpoint 与 details
src/core/session.ts      session entry 转换、sourceClass、搜索和原文回放
src/core/jsonl.ts        损坏安全的 JSONL 读写
src/core/projector.ts    记忆事件纯函数投影
src/core/store.ts        `.pi/pi-compact/` 事件日志
src/core/window.ts       WindowManifest 与哈希链
src/core/working.ts      旧工作记忆提示纯函数，未接入运行时
src/core/derive.ts       无语义推断的规则派生
src/types.ts             共享类型
tests/                   单元测试
```

## 验证范围

当前已验证：

- 确定性记录提取、关键词和文件搜索、原始记录保留与 hash。
- thinking 不进入默认搜索；primary/derived 来源过滤和模型工具的当前分支限制。
- 记忆事件重放确定性、supersede/pin、EOF 半行容忍与断链后拒绝追加。
- 窗口哈希链、记忆命令/工具入口、长 raw 分段读取。
- 工具调用与工具结果的压缩边界校验。
- 配置初始化与非法配置归一化，包括 memory/history/window。
- 通过模拟 hook 事件检查 `manual`、`threshold`、`overflow` 三种 compaction reason 及已中止请求。
- 空 active lineage 不扩大搜索范围；无 context hook，因此不自动注入历史与工作记忆。
- 保留的旧自动召回门控与工作记忆渲染纯函数仍有单元测试，但不代表运行时存在注入行为。
- 日志锁在 token/metadata 不匹配时不删除，活锁不按年龄回收；无效 metadata 在宽限期后可回收。跨平台启动时间身份（Linux `/proc`、Unix `ps`、Windows `Get-Process`）与无法验证时的保守等待均有不依赖切换 `process.platform` 或真实 PID 复用的单测。
- 干净依赖安装、TypeScript 类型检查和真实 Pi CLI 扩展加载。

- Pi 0.87.1 真实 SDK 的元数据切点、完整 overflow retry、`context_edit` 省略/替换与切点预演、孤立工具结果取消、并行及顺序工具换窗后续跑、用户中止、取消后的无副作用、成功事件去重和会话保存恢复。
- 记忆工具禁用、session 范围隔离、显式历史状态查询、长正文与 JSON 元数据预算、搜索和读取分页。

尚未覆盖线上模型 API 的真实网络响应和计费，以及交互 TUI 的人工操作与长时间运行。

## 许可证

MIT
