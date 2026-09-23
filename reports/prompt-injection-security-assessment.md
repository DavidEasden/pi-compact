# pi-compact 提示词注入安全评估

## 范围与结论

评估范围为 `pi-compact` 当前源码、默认配置、Pi `0.86.0` 的扩展消息转换，以及隔离临时目录中的无害标记复现。

结论：项目存在可利用的间接提示词注入面。它不会把文本直接作为 shell 或 JavaScript 执行，因此不是传统字符串到代码执行漏洞；但默认配置会把来自历史 `toolResult`、命令输出和其他 primary session 记录的文本重新注入模型上下文，并在若干路径中将其转换为模型可见的 `user` 消息。攻击者控制的网页、文档、MCP 返回值或仓库文件可借此影响后续回合；在模型具备文件、网络或 MCP 工具时，影响可扩展为未授权工具调用或数据泄露。

未调用真实外部模型来验证某一模型是否服从恶意指令。该项不是本结论的前提：不可信数据已经可复现地进入提示词，模型服从概率取决于模型和系统提示词，而非本扩展的输入边界。

## 威胁模型

- 攻击者可以让 Pi 读取不可信文本，例如网页、README、Issue、日志、MCP 响应或命令输出。
- 用户随后提出包含相同路径、标识符、错误码或其他高置信关键词的正常请求。
- Pi 具有常见的读取、写入、shell、网络或 MCP 工具中的一部分。
- 具备项目写权限的主体还可改写 `.pi/pi-compact/memory.jsonl`；这包括被提示词诱导执行写操作的模型。

## 发现

### PI-001 高危：不可信历史被自动注入为模型的 user 消息，并可跨压缩持久化

`src/core/session.ts` 将绝大多数普通 session entry 都标记为 `primary`，其中包括 `toolResult` 和 bash 输出；`primary` 不是可信来源标签。默认配置启用了 `autoRecallMode: "full"`，`src/hooks.ts` 会把命中的原文片段作为 `custom` 消息加入请求，且 `display: false`。Pi `0.86.0` 的 `convertToLlm()` 会丢弃 `customType`/`details`，并将该消息转换为 `role: "user"`。

压缩路径同样将原始文本放入确定性 checkpoint。Pi 再把 `compactionSummary` 包装为 `user` 消息的 `<summary>` 内容。项目仅截断长度，不对记录内容进行可信来源过滤、结构转义或隔离。旧 compaction entry 还会被下一次 `renderLedger()` 重新渲染，因此恶意文本能在后续压缩中继续存活。

证据：隔离测试将无害标记置于一个历史 `toolResult`，验证其同时出现在自动召回、压缩 checkpoint 和手动 follow-up 中，三条路径在 Pi `0.86.0` 中均为 `user` 角色。输入中的 `</summary>` 也原样保留在外层 summary 包装内；上一轮 checkpoint 的标记会出现在下一轮 checkpoint。

影响：攻击者可以把间接提示词注入从一次读取放大为未来回合、重试和压缩后的持续影响。默认 `full` 模式最多可注入 5000 字符，且用户不可见，适合隐藏指令和上下文填充攻击。

相关位置：`src/config.ts:6-29`、`src/hooks.ts:154-170`、`src/hooks.ts:342-425`、`src/core/ledger.ts:48-84`、`resource/pi-0.86.0/packages/coding-agent/src/core/messages.ts:162-181`。

### PI-002 高危：提示词注入可诱导模型读取全 session 的原始历史，且单条 raw 不受预算限制

`pi_compact_recall` 是对模型开放的工具，接受 `scope: "all"` 和 `raw: true`。当 scope 为 `all` 时，代码直接使用 `getEntries()`，不再限制 active lineage。单独按 entry ID 请求 raw 时，代码刻意返回完整 JSON，即使超过 `recallMaxChars`。原始 entry 包含工具参数、工具输出、用户文本和会话关系。

证据：在 `recallMaxChars: 100` 的隔离配置中，工具成功读取兄弟分支的单条原始记录并返回 875 个字符。现有测试也明确断言单条 raw 可以超过预算。

影响：恶意历史文本一旦影响模型，可诱导其枚举或读取其他分支的敏感历史，再经已有网络、MCP 或写入工具泄露。这是数据访问能力与不可信指令之间的 confused-deputy 放大器。

相关位置：`src/recall.ts:55-60`、`src/recall.ts:130-133`、`src/recall.ts:192-235`、`tests/recall.test.ts:49-62`。

### PI-003 中危：memory 日志的“模型只能 provisional”不是投影层不变量

正常工具入口正确地把模型提议写为 `provisional`，并阻止 `pi_memory_update` 修改用户权威记忆。可是 `projectMemories()` 接受 `author: "model"` 配合 `payload.status: "active"`，也允许任意 author 的 pin、resolve 与 supersede 事件；它没有将作者、事件类型和可达状态绑定为强制规则。

日志哈希链使用公开的无密钥 SHA-256 计算，因此它能检测损坏或未重算的改写，不能认证写入者。拥有项目写权限的主体可读取末条记录后构造有效追加事件。隔离测试直接写入一个哈希正确的 `author: "model", status: "active"` 事件，投影结果成为活动记忆，并由工作记忆 hook 在每个请求中作为隐藏 `user` 消息注入。

影响：在模型具有项目写入或 shell 工具时，一次提示词注入可升级为跨会话的持久工作记忆投毒。该问题需要本地写权限，因此不应描述为远程匿名漏洞；在 Pi 的高权限编码代理场景中，它是实质性放大器。

相关位置：`src/core/projector.ts:19-47`、`src/core/projector.ts:72-143`、`src/core/store.ts:23-34`、`src/core/working.ts:18-39`、`src/hooks.ts:342-371`。

### PI-004 中危：结构边界和来源标签不足以抵御数据到指令的混淆

自动召回和工作记忆使用普通文本标题作为唯一来源提示；Pi 转换后不保留 `customType`。压缩只使用 `<summary>` 文本包装，未转义内容中的结束标签。`primary`/`derived` 仅区分扩展生成物与其他 session entry，并不代表内容是否可信。攻击者可以使用常见项目路径、标识符或错误码触发高置信检索，也可以通过多条记录填满预算，降低正常历史的可用性。

相关位置：`src/core/session.ts:27-55`、`src/core/working.ts:18-20`、`src/hooks.ts:154-170`、`resource/pi-0.86.0/packages/coding-agent/src/core/messages.ts:11-17`、`resource/pi-0.86.0/packages/coding-agent/src/core/messages.ts:162-181`。

## 已有有效控制

- 模型通过 `pi_memory_propose` 和 `pi_memory_update` 的正常入口只能创建或修改自己的 provisional 记录。
- 自动召回默认限制在当前 lineage，并使用高置信关键词门控；这减少误召回，但不验证来源可信度。
- 日志链和锁对并发、损坏及未重算篡改有效。
- `.pi/` 已在 `.gitignore` 中，降低记忆日志被误提交的风险。
- 静态检查未发现扩展将提示文本传给动态 `eval`、外部网络请求或 shell 执行的路径；`src/core/lock.ts` 的进程调用仅使用经过整数校验的 PID。

## 修复优先级

1. 将默认 `autoRecallMode` 从 `full` 改为 `hint` 或 `off`。在未建立可信来源模型前，不应自动把历史正文重新放入模型上下文。
2. 为 session 记录建立真实的信任/来源分类，至少把 `toolResult`、bash 输出、MCP/网页/文件读取结果视为不可信；自动注入仅允许显式批准的数据。`primary` 不能再被当作安全筛选条件。
3. 将注入内容与模型指令严格隔离：在 Pi 的系统提示词或工具策略层明确规定，历史、工具输出、压缩摘要和记忆文本都是数据，不能授权工具调用；任何由这些数据请求的读敏感历史、写文件或网络发送都必须获得当前用户确认。只做 XML/Markdown 转义不足以解决自然语言注入，但应同时修复结构逃逸。
4. 收紧 `pi_compact_recall`：取消模型可用的 `scope:all`，或只允许用户显式命令触发；对 raw 强制分页和硬上限；为跨分支、原始历史和敏感内容读取增加用户确认。
5. 在 projector 层执行作者状态机：`model`/`rule` 只能创建和 supersede 为 `provisional`；只有 `user` 事件可使记录 active/pinned、pin/unpin 或修改用户记录。不要只在工具入口依赖此约束。
6. 将 memory 完整性视为本地访问控制问题：使用 workspace 之外、模型无写权限的位置保存状态，或采用保存于受保护位置的 HMAC/签名密钥。无密钥哈希链不应被描述为写入者认证。
7. 新增回归测试：不可信 `toolResult` 不会进入自动正文召回或 checkpoint；`</summary>` 等结构字符被安全编码；伪造 model-active 日志事件被拒绝；模型工具不能跨 branch/raw 越过确认边界；长文本不能挤占关键上下文预算。

## 验证结果

- `npm test`：65/65 通过。
- `npm run typecheck`：通过。
- `npm audit --omit=dev --json`：生产依赖未报告已知漏洞。
- 工作树在评估代码执行期间未修改；本文件是本次评估新增的唯一项目文件。
