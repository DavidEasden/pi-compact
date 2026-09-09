import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig } from "./config.ts";
import { queryTerms } from "./core/content.ts";
import { appendMemoryEvent, contentHash, loadMemories, newMemoryId, withMemoryLogLock } from "./core/store.ts";
import type { MemoryKind, MemoryPriority, MemoryRecord, MemoryScope, MemoryStatus } from "./types.ts";

const KINDS = new Set<MemoryKind>(["fact", "preference", "constraint", "decision", "working", "derived"]);
const SCOPES = new Set<MemoryScope>(["project", "session", "user"]);
const PRIORITIES = new Set<MemoryPriority>(["low", "normal", "high"]);
const STATUSES = new Set<MemoryStatus>(["provisional", "active", "pinned", "superseded", "resolved"]);

interface MemoryCommandInput {
  content: string;
  recordId?: string;
  kind?: MemoryKind;
  scope?: MemoryScope;
  priority?: MemoryPriority;
  status?: MemoryStatus;
  pin?: boolean;
  supersede?: string;
  query?: string;
}

const notify = (ctx: any, message: string, type: "info" | "warning" | "error" = "info"): void => {
  ctx.ui?.notify?.(message, type);
};

const sessionIdOf = (ctx: any): string | undefined => {
  try {
    const id = ctx.sessionManager?.getSessionId?.();
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
};

const parseTokens = (args: string): MemoryCommandInput => {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const plain: string[] = [];
  const result: MemoryCommandInput = { content: "" };
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower === "pin") {
      result.pin = true;
      continue;
    }
    const separator = token.indexOf(":");
    if (separator <= 0) {
      plain.push(token);
      continue;
    }
    const key = token.slice(0, separator).toLowerCase();
    const value = token.slice(separator + 1);
    if (key === "id" || key === "recordid") result.recordId = value;
    else if (key === "kind" && KINDS.has(value as MemoryKind)) result.kind = value as MemoryKind;
    else if (key === "scope" && SCOPES.has(value as MemoryScope)) result.scope = value as MemoryScope;
    else if (key === "priority" && PRIORITIES.has(value as MemoryPriority)) result.priority = value as MemoryPriority;
    else if (key === "status" && STATUSES.has(value as MemoryStatus)) result.status = value as MemoryStatus;
    else if (key === "supersede") result.supersede = value;
    else if (key === "pin" && (value === "true" || value === "1")) result.pin = true;
    else plain.push(token);
  }
  result.content = plain.join(" ");
  result.query = result.content;
  return result;
};

const formatRecord = (record: MemoryRecord): string => (
  `- [${record.id}] ${record.status} ${record.kind} prio=${record.priority} author=${record.author} v${record.version}${record.supersedes ? ` supersedes=${record.supersedes}` : ""}\n  ${record.content}`
);

const searchMemoryRecords = (records: MemoryRecord[], query: string): MemoryRecord[] => {
  const terms = queryTerms(query);
  if (terms.length === 0) return records;
  return records
    .map((record) => {
      const haystack = `${record.content}\n${record.id}\n${record.kind}\n${record.provenance ?? ""}`.toLocaleLowerCase();
      const matched = terms.filter((term) => haystack.includes(term));
      return { record, score: matched.length };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || right.record.updatedAt.localeCompare(left.record.updatedAt))
    .map((item) => item.record);
};

const createUserMemory = (cwd: string, ctx: any, input: MemoryCommandInput, pin: boolean): MemoryRecord | undefined => {
  const content = input.content.trim();
  if (!content) return undefined;
  const recordId = newMemoryId();
  // create(+pin) 是一个完整事务，放在同一把锁内；失败会抛出，不会假报成功。
  return withMemoryLogLock(cwd, (): MemoryRecord | undefined => {
    appendMemoryEvent(cwd, {
      type: "create",
      recordId,
      author: "user",
      sessionId: sessionIdOf(ctx),
      payload: {
        kind: input.kind ?? "fact",
        content,
        scope: input.scope ?? "project",
        status: "active",
        priority: input.priority ?? "normal",
        sourceEntryIds: [],
        sourceHash: contentHash(content),
        provenance: "user:/remember",
      },
    });
    if (pin) {
      appendMemoryEvent(cwd, { type: "pin", recordId, author: "user", sessionId: sessionIdOf(ctx), payload: {} });
    }
    return loadMemories(cwd).find((record) => record.id === recordId);
  });
};

const supersedeUserMemory = (cwd: string, ctx: any, targetId: string, input: MemoryCommandInput, pin: boolean): MemoryRecord | undefined => {
  const newRecordId = newMemoryId();
  // 读取 current + supersede/pin 是一个事务，都在同一把锁内；成功返回前根据重读的 projected record 验证已生效。
  return withMemoryLogLock(cwd, (): MemoryRecord | undefined => {
    const current = loadMemories(cwd).find((record) => record.id === targetId);
    if (!current || current.status === "superseded" || current.status === "resolved") return undefined;
    const content = input.content.trim() || current.content;
    appendMemoryEvent(cwd, {
      type: "supersede",
      recordId: targetId,
      author: "user",
      sessionId: sessionIdOf(ctx),
      payload: {
        newRecordId,
        content,
        kind: input.kind ?? current.kind,
        scope: input.scope ?? current.scope,
        status: "active",
        priority: input.priority ?? current.priority,
        sourceEntryIds: current.sourceEntryIds,
        sourceHash: contentHash(content),
        provenance: "user:/remember",
      },
    });
    if (pin || current.pinned) {
      appendMemoryEvent(cwd, { type: "pin", recordId: newRecordId, author: "user", sessionId: sessionIdOf(ctx), payload: {} });
    }
    const projected = loadMemories(cwd).find((record) => record.id === newRecordId);
    if (!projected || projected.supersedes !== targetId) {
      throw new Error(`supersede 后重读未发现新记录 ${newRecordId} 生效，事务结果与预期不符`);
    }
    return projected;
  });
};

export const registerMemory = (pi: ExtensionAPI): void => {
  pi.registerCommand("remember", {
    description: "把用户给出的事实写入权威长期记忆；可 pin，也可用 supersede:<id> 替换旧记忆",
    handler: async (args: string, ctx: any) => {
      const config = loadConfig(ctx.cwd);
      if (!config.memory.enabled) {
        notify(ctx, "pi-compact: 记忆功能已关闭。", "warning");
        return;
      }
      const input = parseTokens(args);
      if (!input.content && !input.supersede && !input.recordId) {
        notify(ctx, "用法：/remember [pin] [kind:fact] [scope:project] 文本  或  /remember supersede:<id> 新文本", "warning");
        return;
      }
      const target = input.supersede ?? input.recordId;
      let record: MemoryRecord | undefined;
      try {
        record = target
          ? supersedeUserMemory(ctx.cwd, ctx, target, input, input.pin === true)
          : createUserMemory(ctx.cwd, ctx, input, input.pin === true);
      } catch (error) {
        notify(ctx, `pi-compact: 记忆写入失败：${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }
      if (!record) {
        notify(ctx, "pi-compact: 未能写入记忆。请检查内容或目标 ID。", "warning");
        return;
      }
      notify(ctx, `pi-compact: 已写入记忆 ${record.id}（${record.status}）。这是用户权威记忆，不是模型摘要。`);
    },
  });

  pi.registerCommand("memories", {
    description: "列出或搜索长期记忆；可按 status:pinned 等过滤",
    handler: async (args: string, ctx: any) => {
      const config = loadConfig(ctx.cwd);
      if (!config.memory.enabled) {
        notify(ctx, "pi-compact: 记忆功能已关闭。", "warning");
        return;
      }
      const input = parseTokens(args);
      let records = loadMemories(ctx.cwd);
      if (input.status) records = records.filter((record) => record.status === input.status);
      else records = records.filter((record) => record.status === "pinned" || record.status === "active" || record.status === "provisional");
      if (input.kind) records = records.filter((record) => record.kind === input.kind);
      if (input.query) records = searchMemoryRecords(records, input.query);
      records = records.slice(0, 30);
      if (records.length === 0) {
        notify(ctx, "pi-compact: 没有匹配的记忆。使用 /remember 写入权威事实。");
        return;
      }
      notify(ctx, `pi-compact 记忆 ${records.length} 条：\n${records.map(formatRecord).join("\n")}`);
    },
  });

  pi.registerCommand("forget", {
    description: "将一条记忆标记为 resolved，不再进入工作记忆",
    handler: async (args: string, ctx: any) => {
      const config = loadConfig(ctx.cwd);
      if (!config.memory.enabled) {
        notify(ctx, "pi-compact: 记忆功能已关闭。", "warning");
        return;
      }
      const input = parseTokens(args);
      const recordId = input.recordId ?? args.trim().split(/\s+/).filter(Boolean)[0];
      if (!recordId) {
        notify(ctx, "用法：/forget <id>", "warning");
        return;
      }
      try {
        // 存在检查 + resolve 追加放在同一把锁内；返回成功前根据重读的 projected record 验证已 resolve。
        const resolved = withMemoryLogLock(ctx.cwd, (): boolean => {
          const current = loadMemories(ctx.cwd).find((record) => record.id === recordId);
          if (!current) return false;
          appendMemoryEvent(ctx.cwd, { type: "resolve", recordId, author: "user", sessionId: sessionIdOf(ctx), payload: { reason: "user:/forget" } });
          const projected = loadMemories(ctx.cwd).find((record) => record.id === recordId);
          if (!projected || projected.status !== "resolved") {
            throw new Error(`resolve 后重读发现记忆 ${recordId} 仍为 ${projected?.status ?? "缺失"}，事务结果与预期不符`);
          }
          return true;
        });
        if (!resolved) {
          notify(ctx, `pi-compact: 找不到记忆 ${recordId}。`, "warning");
          return;
        }
      } catch (error) {
        notify(ctx, `pi-compact: 记忆写入失败：${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }
      notify(ctx, `pi-compact: 已 resolve 记忆 ${recordId}。`);
    },
  });

  pi.registerTool({
    name: "pi_memory_search",
    label: "Search long-term memory",
    description: "搜索项目长期记忆。结果可能包含用户权威记忆与模型 provisional 提议；不要把 provisional 当成已确认事实。",
    promptSnippet: "搜索跨压缩仍保留的长期记忆",
    promptGuidelines: ["使用 pi_memory_search 查找长期记忆，不要把压缩 checkpoint 或模型自己的提议当成用户已确认事实。"],
    parameters: Type.Object({
      query: Type.Optional(Type.String()),
      status: Type.Optional(Type.String()),
      kind: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
    }),
    async execute(_toolCallId: string, input: { query?: string; status?: string; kind?: string; limit?: number }, _signal: AbortSignal, _onUpdate: unknown, ctx: any) {
      const config = loadConfig(ctx.cwd);
      if (!config.memory.enabled) {
        return { content: [{ type: "text", text: "pi-compact: 记忆功能已关闭。" }], details: { count: 0 } };
      }
      let records = loadMemories(ctx.cwd);
      if (input.status && STATUSES.has(input.status as MemoryStatus)) records = records.filter((record) => record.status === input.status);
      if (input.kind && KINDS.has(input.kind as MemoryKind)) records = records.filter((record) => record.kind === input.kind);
      if (input.query?.trim()) records = searchMemoryRecords(records, input.query);
      else records = records.filter((record) => record.status === "pinned" || record.status === "active" || record.status === "provisional");
      records = records.slice(0, input.limit ?? 8);
      const text = records.length === 0
        ? "pi-compact memory: 未找到匹配记忆。"
        : `pi-compact memory (${records.length})\n${records.map(formatRecord).join("\n")}`;
      return { content: [{ type: "text", text }], details: { source: "memory-log", count: records.length } };
    },
  } as any);

  pi.registerTool({
    name: "pi_memory_read",
    label: "Read a memory record",
    description: "按 ID 读取一条长期记忆。长内容可用 offset/limit 分段，不要默认把全文灌入上下文。",
    promptSnippet: "按 ID 读取长期记忆，长内容请分段",
    promptGuidelines: ["读取记忆时使用 offset/limit 控制长度。"],
    parameters: Type.Object({
      recordId: Type.String(),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    async execute(_toolCallId: string, input: { recordId: string; offset?: number; limit?: number }, _signal: AbortSignal, _onUpdate: unknown, ctx: any) {
      const record = loadMemories(ctx.cwd).find((item) => item.id === input.recordId);
      if (!record) {
        return { content: [{ type: "text", text: `pi-compact memory: 找不到 ${input.recordId}` }], details: { count: 0 } };
      }
      const offset = Math.max(0, input.offset ?? 0);
      const limit = input.limit;
      const body = limit == null ? record.content.slice(offset) : record.content.slice(offset, offset + limit);
      const truncated = offset > 0 || offset + body.length < record.content.length;
      return {
        content: [{ type: "text", text: JSON.stringify({ ...record, content: body, offset, totalChars: record.content.length, truncated }, null, 2) }],
        details: { source: "memory-log", count: 1, truncated },
      };
    },
  } as any);

  pi.registerTool({
    name: "pi_memory_propose",
    label: "Propose a provisional memory",
    description: "提出一条 provisional 记忆。模型提议不会自动变成 active 或 pinned，必须由用户 /remember 确认。",
    promptSnippet: "提出待用户确认的 provisional 记忆",
    promptGuidelines: ["只能提出 provisional 记忆；不要声称已经写入权威记忆。"],
    parameters: Type.Object({
      content: Type.String(),
      kind: Type.Optional(Type.String()),
      scope: Type.Optional(Type.String()),
      priority: Type.Optional(Type.String()),
      sourceEntryIds: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_toolCallId: string, input: { content: string; kind?: string; scope?: string; priority?: string; sourceEntryIds?: string[] }, _signal: AbortSignal, _onUpdate: unknown, ctx: any) {
      const config = loadConfig(ctx.cwd);
      if (!config.memory.enabled) {
        return { content: [{ type: "text", text: "pi-compact: 记忆功能已关闭。" }], details: { count: 0 } };
      }
      const content = input.content.trim();
      if (!content) {
        return { content: [{ type: "text", text: "pi-compact: content 不能为空。" }], details: { count: 0 } };
      }
      const recordId = newMemoryId();
      try {
        appendMemoryEvent(ctx.cwd, {
          type: "create",
          recordId,
          author: "model",
          sessionId: sessionIdOf(ctx),
          payload: {
            kind: input.kind && KINDS.has(input.kind as MemoryKind) ? input.kind as MemoryKind : "fact",
            content,
            scope: input.scope && SCOPES.has(input.scope as MemoryScope) ? input.scope as MemoryScope : "project",
            status: "provisional",
            priority: input.priority && PRIORITIES.has(input.priority as MemoryPriority) ? input.priority as MemoryPriority : "normal",
            sourceEntryIds: input.sourceEntryIds ?? [],
            sourceHash: contentHash(content),
            provenance: "model:pi_memory_propose",
          },
        });
      } catch (error) {
        return {
          content: [{ type: "text", text: `pi-compact: 记忆写入失败，本次没有写入任何内容：${error instanceof Error ? error.message : String(error)}` }],
          details: { count: 0, error: true },
        };
      }
      return {
        content: [{ type: "text", text: `已记录 provisional 记忆 ${recordId}。在用户 /remember 确认前，它不是权威事实，也不会被自动 pin。` }],
        details: { source: "memory-log", recordId, status: "provisional" },
      };
    },
  } as any);

  pi.registerTool({
    name: "pi_memory_update",
    label: "Update a provisional memory",
    description: "只能修改或撤回模型自己的 provisional 记忆。不能把提议升级为 active/pinned，也不能改写用户权威记忆。",
    promptSnippet: "修改或撤回 provisional 记忆",
    promptGuidelines: ["不要用 pi_memory_update 修改用户写入的 active/pinned 记忆。"],
    parameters: Type.Object({
      recordId: Type.String(),
      action: Type.Union([Type.Literal("edit"), Type.Literal("resolve")]),
      content: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId: string, input: { recordId: string; action: "edit" | "resolve"; content?: string }, _signal: AbortSignal, _onUpdate: unknown, ctx: any) {
      const newRecordId = newMemoryId();
      // 读取 provisional + resolve/supersede 追加放在同一把锁内；返回成功前根据重读的 projected record 验证已生效。
      try {
        return withMemoryLogLock(ctx.cwd, (): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } => {
          const current = loadMemories(ctx.cwd).find((record) => record.id === input.recordId);
          if (!current) {
            return { content: [{ type: "text", text: `找不到记忆 ${input.recordId}` }], details: { count: 0 } };
          }
          if (current.status !== "provisional" || current.author !== "model") {
            return {
              content: [{ type: "text", text: `记忆 ${input.recordId} 不是模型 provisional 提议。请让用户使用 /remember 或 /forget。` }],
              details: { count: 0, rejected: true },
            };
          }
          if (input.action === "resolve") {
            appendMemoryEvent(ctx.cwd, { type: "resolve", recordId: current.id, author: "model", sessionId: sessionIdOf(ctx), payload: { reason: "model:withdraw" } });
            const projected = loadMemories(ctx.cwd).find((record) => record.id === current.id);
            if (!projected || projected.status !== "resolved") {
              throw new Error(`resolve 后重读发现记忆 ${current.id} 仍为 ${projected?.status ?? "缺失"}，事务结果与预期不符`);
            }
            return { content: [{ type: "text", text: `已撤回 provisional 记忆 ${current.id}。` }], details: { recordId: current.id, status: "resolved" } };
          }
          const content = input.content?.trim();
          if (!content) {
            return { content: [{ type: "text", text: "edit 需要提供 content。" }], details: { count: 0 } };
          }
          appendMemoryEvent(ctx.cwd, {
            type: "supersede",
            recordId: current.id,
            author: "model",
            sessionId: sessionIdOf(ctx),
            payload: {
              newRecordId,
              content,
              kind: current.kind,
              scope: current.scope,
              status: "provisional",
              priority: current.priority,
              sourceEntryIds: current.sourceEntryIds,
              sourceHash: contentHash(content),
              provenance: "model:pi_memory_update",
            },
          });
          const projected = loadMemories(ctx.cwd).find((record) => record.id === newRecordId);
          if (!projected || projected.status !== "provisional" || projected.supersedes !== current.id) {
            throw new Error(`supersede 后重读未发现新记录 ${newRecordId} 生效，事务结果与预期不符`);
          }
          return { content: [{ type: "text", text: `已更新 provisional 记忆 ${newRecordId}（替换 ${current.id}）。仍需用户确认才会成为权威记忆。` }], details: { recordId: newRecordId, status: "provisional" } };
        });
      } catch (error) {
        const action = input.action === "resolve" ? "撤回" : "更新";
        return { content: [{ type: "text", text: `pi-compact: 记忆写入失败，未${action}：${error instanceof Error ? error.message : String(error)}` }], details: { count: 0, error: true } };
      }
    },
  } as any);

  pi.registerTool({
    name: "pi_compact_new_context",
    label: "Request a new context window",
    description: "请求开启新的上下文窗口。若当前 Pi API 提供 ctx.compact，则调用原生 compact；否则提示使用 /compact。不会删除原始 session，也不会把压缩摘要当作记忆。",
    promptSnippet: "在上下文将满时请求 Pi 原生 compact 以开启新窗口",
    promptGuidelines: ["需要新窗口时调用 pi_compact_new_context 或请用户执行 /compact；不要把 checkpoint 当成长期记忆。"],
    parameters: Type.Object({}),
    async execute(_toolCallId: string, _input: Record<string, never>, _signal: AbortSignal, _onUpdate: unknown, ctx: any) {
      if (typeof ctx.compact === "function") {
        try {
          ctx.compact();
          return {
            content: [{ type: "text", text: "已请求 Pi 原生 compact 以开启新上下文窗口。原始 session 仍保留；长期记忆来自 /remember 与 memory 日志，而不是压缩摘要。" }],
            details: { requested: true, degraded: false },
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: `调用 ctx.compact 失败：${error instanceof Error ? error.message : String(error)}。请使用 Pi 原生 /compact。` }],
            details: { requested: false, degraded: true },
          };
        }
      }
      return {
        content: [{ type: "text", text: "当前扩展上下文没有 ctx.compact。请使用 Pi 原生 /compact。这是安全兼容降级，不会删除原始 session。" }],
        details: { requested: false, degraded: true },
      };
    },
  } as any);
};
