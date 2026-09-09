# pi-compact

> English: [README.md](README.md)

面向 [Pi](https://pi.dev/) 的确定性 session 压缩与精确历史召回扩展。

`pi-compact` 不调用 LLM 生成压缩摘要，而是从 Pi 原始 session entries 中提取可追溯的上下文记录，并保留 entry ID、文件路径、工具调用 ID、原始记录和源 hash。被压缩文本中未容纳的历史内容，可以通过召回工具或命令重新读取。

## 功能

- 接管 Pi 原生的 `/compact` 命令，以及普通的 `manual`、`threshold` 和 `overflow` compaction。
- 使用 Pi 自己计算的压缩边界、token accounting、持久化和恢复流程。
- 在压缩前检查工具调用与工具结果是否完整配对；发现不安全边界时取消本次接管，避免破坏上下文。
- 生成确定性的事件 ledger，不把规则提取结果伪装成目标、决策或已完成任务。
- 提取并搜索用户消息、assistant 消息、工具调用、工具结果、bash 命令和其他 session context。
- 提供 `pi_compact_recall` 工具，支持 entry ID、关键词、文件路径、消息类型、分页和原始 entry 回放。
- 提供 `/pi-compact-recall` 命令，将召回结果作为 follow-up turn 发送给模型。
- 可选地根据当前 user 请求，在每次 provider 请求前自动召回当前 branch 中的旧记录。
- 自动创建项目级 `.pi/pi-compact.json` 配置，不覆盖已有项目或全局配置。

## 安装

需要已安装 Pi；当前验证版本为 `0.85.1`，该版本要求 Node.js `>=22.19.0`。以下内容假设该仓库位于 `github.com/DavidEasden/pi-compact`。

Pi package 会执行扩展代码，请在安装前审查源代码。

### 通过 GitHub 安装

推荐固定到发布 tag（固定后的 ref 不会被 `pi update --extensions` 或 `pi update --all` 移动）：

```bash
pi install git:github.com/DavidEasden/pi-compact@v0.1.0
```

或者不固定 ref，直接跟踪默认分支：

```bash
pi install git:github.com/DavidEasden/pi-compact
```

也支持 SSH 简写与原始 HTTPS URL：

```bash
pi install git:git@github.com:DavidEasden/pi-compact@v0.1.0
pi install https://github.com/DavidEasden/pi-compact@v0.1.0
```

说明：

- `git:` 前缀启用 `host/user/repo` 与 `git@host:user/repo` 简写；不带前缀时只接受协议 URL（`https://`、`http://`、`ssh://`、`git://`）。
- `v0.1.0` 必须是已存在的 tag 或 commit（首次可用 `git tag v0.1.0 && git push origin v0.1.0` 创建并推送）。以后升级到新 tag，重新执行 `pi install git:github.com/DavidEasden/pi-compact@<新tag>`。
- 全局安装会克隆到 `~/.pi/agent/git/github.com/DavidEasden/pi-compact`；使用 `-l`（项目 settings）时克隆位于 `.pi/git/github.com/DavidEasden/pi-compact`，项目信任后启动时会自动安装缺失的 package。
- 不安装也可以临时试用：

```bash
pi -e git:github.com/DavidEasden/pi-compact
```

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

当前项目使用 Pi 的 `@earendil-works/pi-coding-agent` API，并已按 Pi `0.85.1` 进行验证。Pi 和 `typebox` 是 peer dependencies，由 Pi 环境提供。

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
  "debug": false
}
```

配置项说明：

| 配置项 | 默认值 | 说明 |
| --- | ---: | --- |
| `enabled` | `true` | 是否启用压缩接管和自动召回；Pi 原生的 `/compact` 命令和召回工具仍然可用 |
| `overrideDefaultCompaction` | `true` | 是否接管 Pi 的普通 compaction；关闭后保留默认压缩 |
| `summaryMaxChars` | `12000` | 确定性 checkpoint 文本的最大字符数 |
| `autoRecall` | `true` | 兼容开关。已配置 `autoRecallMode` 时被忽略；未配置模式时，`false` 映射为 `off`，否则为 `full` |
| `autoRecallMode` | `full` | 自动召回模式：`full`（当前完整片段）、`hint`（短 ID/kind 提示）或 `off`（关闭）。合法模式优先于 `autoRecall` |
| `autoRecallMaxChars` | `5000` | 单次自动召回文本的最大字符数 |
| `recallMaxResults` | `8` | 自动召回最多返回的记录数 |
| `recallMaxChars` | `16000` | 手动召回结果的最大字符数；按单个 entry ID 的 `raw` 回放会返回完整 JSON，即使超过该预算 |
| `debug` | `false` | 是否输出扩展调试日志（只输出计数和字符数，不输出原文） |

数值配置必须是正安全整数。`summaryMaxChars`、`autoRecallMaxChars`、`recallMaxResults`、`recallMaxChars` 的上限依次为 `100000`、`50000`、`30`、`100000`；超过上限的合法值会被截断，非法值会回退到默认值；未知配置项会被忽略。字符预算不是 token 预算。

自动压缩阈值和保留尾部大小仍由 Pi 自身的 compaction settings 控制，本扩展不另设触发阈值。

## 使用

### 立即压缩

使用 Pi 原生命令：

```text
/compact
```

Pi 原生的 `/compact` 命令会调用正常的压缩流程。当 `enabled` 和 `overrideDefaultCompaction` 都为 `true` 时，本扩展接收 `session_before_compact` 事件，并用确定性 checkpoint 替换 Pi 默认的 LLM 摘要。扩展不再注册单独的压缩命令。当 `enabled` 或 `overrideDefaultCompaction` 为 `false` 时，`/compact` 保留 Pi 默认的摘要行为。

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

示例中的 entry ID 是占位符，请使用 checkpoint 或召回结果中显示的真实 ID。

指定 `ids` 后，按 ID 选择记录并应用 `scope` 和 `limit`，忽略关键词、`file`、`kind` 和 `page`；结果按 session 原有顺序返回。未指定 ID 时，需要关键词或 `file`，空查询或仅指定 `kind` 不会列出全部历史。

关键词搜索是分词后的文本匹配，不支持正则表达式或语义检索；文件过滤仅匹配已提取的路径，不读取磁盘文件。路径主要来自工具参数和简单 bash 命令，消息正文中的路径不一定被索引。命令按空白拆分参数，不支持带空格路径的引号解析；这类路径可通过工具的 `file` 字段传入。

命令会把召回内容作为 follow-up turn 发送，触发模型继续处理，并进入正常 session 历史。

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

可用字段与 `/pi-compact-recall` 参数对应：`query`、`entryIds`、`file`、`kind`、`scope`、`page`、`limit` 和 `raw`。

使用 `raw: true` 且只召回单个 entry ID 时，输出该原始 session entry 的完整 JSON，包含该 entry 存有的工具参数、工具输出、时间戳和父子 entry 关系。这条 JSON 不会被截断，即使超过 `recallMaxChars`；序列化失败时返回结构化错误对象，而不是截断的 JSON。多个 raw 命中时，只返回字符预算内的完整 entry，并附带 `omitted entry IDs` 提示，绝不会从 JSON 中间截断。关键词和 pretty（非 raw）输出仍受 `recallMaxChars` 限制。分页只划分记录，不划分单条 entry 内容。按单个 raw entry ID 查询时忽略默认 `limit` 8，避免丢掉请求的那一条。

## 自动召回行为

自动召回默认模式为 `full`（当前完整片段注入），由 `enabled && autoRecallMode !== "off"` 控制。满足以下条件时生效：

- 当前请求的最新 user 文本去除首尾空白后，长度至少为 3。
- 当前 session 可以取得有效的 active branch。
- 当前 branch 中存在带有效 ID 的 user entry。
- 当前 user entry 之前的历史记录中存在匹配结果。

自动召回只修改当前 provider 请求的 messages，不写入 session，也不会生成新的 session entry。同一 user turn 的多次 provider 请求会复用召回结果；新的 user entry 会重新计算。当前 turn 新产生的工具结果不会被混入该 turn 的自动召回范围。

如果 branch 查询失败、没有合法 user entry 或没有命中，扩展会安静跳过自动召回。手动召回在无法取得 active lineage 时也不会扩大为整个 session；只有显式指定 `scope:all` 才跨 branch 检索。

`full` 注入匹配记录的截短片段。`hint` 只注入紧凑的 `- [id] kinds=…` 行（若有已提取路径则附带 files），不含长片段。`off` 完全跳过注入，即使 `autoRecall` 仍为 `true`。搜索范围不变：只搜索当前 branch 中最新 user entry 之前的历史；自动召回不会扩大到其他 branch。

自动召回不要求已发生压缩，因此 `full` 可能与当前上下文中的历史重复，并增加请求 token 用量。注入的 custom message 会带成本统计（`chars`、`hitCount`、`estimatedTokens`、`mode`、`sameTurnInjectionCount`），`details` 不复制原文。同一 turn 的后续 provider 请求会复用缓存文本并增加 `sameTurnInjectionCount`；若请求中已有自动召回消息，则不再重复注入。召回内容会发送给当前模型提供方，可能包含原始工具输出或其他敏感文本；`raw` 不做脱敏，`scope:all` 还会包含其他分支的匹配记录。

## 压缩与数据边界

`pi-compact` 只接管普通 compaction，暂不接管 Pi 的 `session_before_tree` 分支摘要。

压缩时：

1. 使用 Pi 提供的 `firstKeptEntryId` 作为保留边界。
2. 将边界之前的原始 entries 转换成带 ID 的记录。
3. 生成 checkpoint：先按原始 entry 顺序写出 `## Timeline`（`sourceOrdinal`），再保留现有分类区块（用户消息、assistant 消息、工具调用、工具结果、命令和其他 session context）。Timeline 与分类区块共用字符预算和省略计数。
4. 保存 `sourceEntryIds`、`sourceHash`、`sourceRecordCount`、`keptEntryId`、`omittedRecordCount`、`checkpointChars`、`summaryMaxChars` 和 `estimatedTokensAfter`（字符数 / 4 向上取整，不是 provider usage）等 details。扩展不会伪造计费 `usage`；Pi 会自行计算包含完整上下文的压缩后估算值。
5. 校验工具调用与结果的边界关系，以及保留尾部中的配对顺序；不安全或已中止的接管请求返回 `{ cancel: true }`，不落回默认 LLM 摘要。Pi 的 `error`、`aborted` assistant 终态允许存在无结果的工具调用，不适用于普通未完成调用。

原始 session entries 才是事实来源。checkpoint 会折叠空白、截短长记录，并在预算不足时省略记录；它不是原文备份，也不会验证历史消息中的陈述是否正确。图片等非文本内容在文本提取中仅显示占位信息。

扩展不删除原始 session entries，也不建立独立备份；原文仍依赖 Pi 的 session 存储。保存原文和支持精确检索并不等于模型一定会自动召回所有相关细节，也不代表有限上下文能够同时展示全部历史。

## 开发

安装依赖：

```bash
npm ci
```

运行测试：

```bash
npm test
```

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
src/hooks.ts             compaction、context 和 session hooks
src/recall.ts            召回工具与 /pi-compact-recall 命令
src/core/content.ts      消息文本、文件和工具调用提取
src/core/ledger.ts       确定性 checkpoint 与 details
src/core/session.ts      session entry 转换、搜索和原文回放
src/types.ts             共享类型
tests/                   单元测试
```

## 验证范围

当前已验证：

- 确定性记录提取、关键词和文件搜索、原始记录保留与 hash。
- 工具调用与工具结果的压缩边界校验。
- 配置初始化与非法配置归一化。
- 通过模拟 hook 事件检查 `manual`、`threshold`、`overflow` 三种 compaction reason 及已中止请求。
- 空 active lineage 不扩大搜索范围；自动召回的同轮复用、新 user 更新、去重和 branch 查询异常处理。
- 干净依赖安装、TypeScript 类型检查和真实 Pi CLI 扩展加载。

尚未作为完整端到端场景验证：真实模型响应、overflow retry 的完整运行过程，以及跨 session 或 branch 切换下的长时间运行行为。

## 许可证

MIT
