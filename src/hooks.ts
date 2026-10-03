import { buildSessionProjection, type ExtensionAPI, type ProjectedSessionEntry, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { toolCallIds } from "./core/content.ts";
import { deriveFacts, derivedFactKey } from "./core/derive.ts";
import { buildDetails, renderLedger } from "./core/ledger.ts";
import { hashRecords, recordsFromProjectedEntries } from "./core/session.ts";
import { appendMemoryEvent, contentHash, loadMemories, readWindowEvents, withMemoryLogLock, withWindowLogLock } from "./core/store.ts";
import { buildWindowManifest, persistWindowManifest } from "./core/window.ts";
import type { SessionEntryLike } from "./types.ts";

export const AUTO_RECALL_TYPE = "pi-compact-auto-recall";
export const MEMORY_HINT_TYPE = "pi-compact-memory-hint";

const CUT_POINT_ROLES = new Set(["user", "assistant", "bashExecution", "custom", "branchSummary", "compactionSummary"]);
const TERMINAL_ASSISTANT_REASONS = new Set(["error", "aborted"]);

// 在副本中追加候选 compaction，由 Pi 应用保留区内的最后一次 context_edit。
// 回退可能重新保留旧消息或旧编辑，不能直接切片压缩前的投影。
const projectCompactionTail = (branch: SessionEntryLike[], keptEntryId: string): ProjectedSessionEntry[] => {
  const ids = new Set(branch.map((entry) => entry.id));
  let previewId = "pi-compact-preview";
  while (ids.has(previewId)) previewId += "-";
  const preview: SessionEntry = {
    type: "compaction", id: previewId, parentId: branch.at(-1)?.id ?? null,
    timestamp: new Date(0).toISOString(), summary: "{}", firstKeptEntryId: keptEntryId, tokensBefore: 0,
  };
  return buildSessionProjection([...branch as SessionEntry[], preview]).entries.slice(1);
};

/**
 * 校验候选压缩提交后的消息投影；被省略的 toolResult 也可以是合法切点。
 * 被 checkpoint 替换的前缀不再参与配对，保留侧必须按顺序闭合工具调用。
 * Pi 的 error/aborted assistant 终态允许存在无结果调用。
 */
const isSafeProjectedTail = (entries: ReturnType<typeof projectCompactionTail>): boolean => {
  const first = entries[0];
  if (!first || (first.messages.length > 0 && !first.messages.some((message) => CUT_POINT_ROLES.has(message.role)))) return false;

  const openCalls = new Map<string, boolean[]>();
  for (const { messages } of entries) {
    for (const message of messages) {
      if (message.role === "assistant") {
        if (Array.isArray(message.content) && message.content.some((part: any) => part?.type === "toolCall" && typeof part.id !== "string")) return false;
        const terminal = TERMINAL_ASSISTANT_REASONS.has(message.stopReason ?? "");
        for (const id of toolCallIds({ content: message.content })) {
          const calls = openCalls.get(id) ?? [];
          calls.push(terminal);
          openCalls.set(id, calls);
        }
      } else if (message.role === "toolResult") {
        const id = message.toolCallId;
        if (typeof id !== "string") return false;
        const calls = openCalls.get(id);
        if (!calls || calls.length === 0) return false;
        calls.shift();
        if (calls.length === 0) openCalls.delete(id);
      }
    }
  }
  return [...openCalls.values()].every((calls) => calls.every((terminal) => terminal));
};

export const isSafeCut = (branchEntries: SessionEntryLike[], keptEntryId: string): boolean => {
  const cut = branchEntries.findIndex((entry) => entry.id === keptEntryId);
  if (cut <= 0 || branchEntries[cut].type === "compaction") return false;
  try {
    const entries = projectCompactionTail(branchEntries, keptEntryId);
    return entries[0]?.sourceEntry.id === keptEntryId && isSafeProjectedTail(entries);
  } catch {
    // 无法构造宿主等价投影时不放行压缩，避免把不完整工具链交给模型。
    return false;
  }
};

/** 向前逐个预演候选边界；只有最终投影安全时才回退，否则取消压缩。 */
export const findEarlierSafeCut = (branch: SessionEntryLike[], proposedId: string): string | undefined => {
  const proposed = branch.findIndex((entry) => entry.id === proposedId);
  if (proposed <= 0) return undefined;
  let activeIds: Set<string>;
  try {
    activeIds = new Set(buildSessionProjection(branch as SessionEntry[]).entries.map((entry) => entry.sourceEntry.id));
  } catch {
    return undefined;
  }
  for (let index = proposed; index >= 1; index--) {
    const entry = branch[index];
    if (typeof entry?.id === "string" && activeIds.has(entry.id) && isSafeCut(branch, entry.id)) return entry.id;
  }
  return undefined;
};

const isSplitAt = (branch: SessionEntryLike[], keptEntryId: string): boolean => {
  const entries = buildSessionProjection(branch as SessionEntry[]).entries;
  const cut = entries.findIndex((entry) => entry.sourceEntry.id === keptEntryId);
  const startsTurn = (entry: ProjectedSessionEntry) => entry.sourceEntry.type !== "compaction"
    && entry.messages.some((message) => message.role !== "assistant" && CUT_POINT_ROLES.has(message.role));
  return cut > 0 && !startsTurn(entries[cut]) && entries.slice(0, cut).some(startsTurn);
};

const recordsBeforeCut = (branch: SessionEntryLike[], keptEntryId: string, excludedEntryId?: string) => {
  const sourceBranch = excludedEntryId
    ? branch.filter((entry) => entry.id !== excludedEntryId)
    : branch;
  const projection = buildSessionProjection(sourceBranch as SessionEntry[]).entries;
  const cut = projection.findIndex((entry) => entry.sourceEntry.id === keptEntryId);
  if (cut < 0) throw new Error(`kept entry ${keptEntryId} is absent from the active projection`);
  return recordsFromProjectedEntries(projection.slice(0, cut));
};

const sessionIdOf = (ctx: any): string | undefined => {
  try {
    const id = ctx.sessionManager?.getSessionId?.();
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
};

const persistDerived = (cwd: string, records: ReturnType<typeof recordsFromProjectedEntries>, sourceHash: string, sessionId?: string): void => {
  withMemoryLogLock(cwd, () => {
    const existingRecords = loadMemories(cwd);
    const existing = new Set(existingRecords.map((record) => record.id));
    // 兼容升级前 provenance 含 entryId 的规则记忆，避免按新 ID 再写入相同事实。
    const existingFacts = new Set(existingRecords
      .filter((record) => record.author === "rule")
      .map((record) => derivedFactKey(record.content)));
    for (const draft of deriveFacts(records, sourceHash)) {
      const factKey = derivedFactKey(draft.payload.content);
      if (existing.has(draft.recordId) || existingFacts.has(factKey)) continue;
      appendMemoryEvent(cwd, {
        type: "create",
        recordId: draft.recordId,
        author: "rule",
        sessionId,
        payload: draft.payload,
      });
      existing.add(draft.recordId);
      existingFacts.add(factKey);
    }
  });
};

const fallbackCheckpoint = (reason: string, keptEntryId: string, tokensBefore: number, summaryMaxChars: number) => ({
  compaction: {
    // 降级路径也不复制历史、ID 或异常文本，不添加行为提示词。
    summary: summaryMaxChars >= 2 ? "{}" : "",
    firstKeptEntryId: keptEntryId,
    tokensBefore,
    details: {
      compactor: "pi-compact" as const,
      version: 1 as const,
      reason,
      sourceEntryIds: [] as string[],
      sourceHash: "",
      sourceRecordCount: 0,
      keptEntryId,
      omittedRecordCount: 0,
      checkpointChars: summaryMaxChars >= 2 ? 2 : 0,
      summaryMaxChars,
      estimatedTokensAfter: summaryMaxChars >= 2 ? 1 : 0,
    },
  },
});

export const registerHooks = (pi: ExtensionAPI): void => {
  pi.on("session_before_compact", async (event: any, ctx: any) => {
    const config = loadConfig(ctx.cwd);
    if (!config.enabled || !config.overrideDefaultCompaction) return;
    if (event.signal?.aborted) return { cancel: true };
    const proposedKeptEntryId = event.preparation?.firstKeptEntryId;
    const branch: SessionEntryLike[] = event.branchEntries ?? [];
    const preparation = event.preparation;
    const splitPrefix = Array.isArray(preparation?.turnPrefixMessages) ? preparation.turnPrefixMessages : [];
    // isSplitTurn 先规范化为布尔：字段缺失（undefined）按 false 处理，
    // 避免 pi API 形状变化时压缩被永久取消。
    const isSplitTurn = preparation?.isSplitTurn === true;
    if (isSplitTurn !== (splitPrefix.length > 0) || typeof proposedKeptEntryId !== "string") {
      ctx.ui?.notify?.("pi-compact: Pi 给出的压缩准备数据不一致（isSplitTurn 与 turnPrefixMessages 矛盾），本次压缩已取消。", "warning");
      return { cancel: true };
    }
    // Pi 边界不安全时优先回退到更早的安全边界，而不是直接取消：
    // 反复取消会让阈值/溢出触发的自动压缩失效，最终导致上下文溢出。
    let keptEntryId = proposedKeptEntryId;
    if (!isSafeCut(branch, keptEntryId)) {
      const fallbackId = findEarlierSafeCut(branch, keptEntryId);
      if (fallbackId === undefined) {
        ctx.ui?.notify?.("pi-compact: 未找到不破坏工具调用链的安全压缩边界（含更早回退），本次压缩已取消；请重试或暂时关闭扩展。", "warning");
        return { cancel: true };
      }
      keptEntryId = fallbackId;
      ctx.ui?.notify?.(`pi-compact: Pi 给出的压缩边界会破坏工具调用链，已回退到更早的安全边界 ${fallbackId}（保留更多内容）。`, "info");
    }
    try {
      // 审计与派生记忆都使用宿主相同的 context projection；只有工具链安全检查使用候选 compaction 预览。
      const records = recordsBeforeCut(branch, keptEntryId);
      // 准备阶段只计算。窗口与派生记忆在宿主确认提交之后才持久化。
      const ledger = renderLedger(records, event.reason, keptEntryId, config.summaryMaxChars);
      const details = buildDetails(records, event.reason, keptEntryId, ledger.omitted, ledger.text.length, config.summaryMaxChars);
      details.isSplitTurn = keptEntryId === proposedKeptEntryId ? isSplitTurn : isSplitAt(branch, keptEntryId);
      if (config.debug) {
        console.log(`[pi-compact] ${event.reason}: sourceRecordCount=${records.length} checkpointChars=${ledger.text.length} omitted=${ledger.omitted} estimatedTokensAfter=${details.estimatedTokensAfter} kept=${keptEntryId}`);
      }
      return { compaction: {
        summary: ledger.text,
        firstKeptEntryId: keptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        details,
      } };
    } catch {
      ctx.ui?.notify?.("pi-compact: 压缩处理出错，已降级为指针型 checkpoint，未回退到 LLM 摘要。", "warning");
      return fallbackCheckpoint(event.reason, keptEntryId, event.preparation?.tokensBefore ?? 0, config.summaryMaxChars);
    }
  });

  // 不注册 context 注入：旧配置也不能重新开启历史正文或工作记忆提示。

  pi.on("session_compact", (event: any, ctx: any) => {
    if (!event.fromExtension) return;
    const branch: SessionEntryLike[] = ctx.sessionManager?.getBranch?.() ?? [];
    // Pi 按 summary 查找事件 entry；摘要相同时可能返回旧条目，使用实际提交的分支末条。
    const entry = branch.filter((item) => item.type === "compaction").at(-1) ?? event.compactionEntry;
    const details = entry?.details;
    if (details?.compactor !== "pi-compact") return;
    const config = loadConfig(ctx.cwd);
    const sessionId = sessionIdOf(ctx);
    let records: ReturnType<typeof recordsFromProjectedEntries>;
    try {
      if (typeof entry.id !== "string" || typeof entry.firstKeptEntryId !== "string") throw new Error("missing committed compaction identity");
      // 提交后从分支中移除刚写入的 compaction，重建提交前 projection，避免重新读取已被 context_edit 隐藏的 raw 正文。
      records = recordsBeforeCut(branch, entry.firstKeptEntryId, entry.id);
    } catch {
      ctx.ui?.notify?.("pi-compact: 无法重建提交前的上下文投影，窗口日志和派生记忆未写入。", "warning");
      return;
    }
    if (typeof entry.id === "string" && hashRecords(records) === details.sourceHash) {
      if (config.window.manifest) {
        try {
          // 稳定 ID 用于成功事件去重；在同一锁中生成最终父窗口和哈希链，避免并发准备产生过期清单。
          const windowId = `win_${contentHash(`${sessionId ?? ""}\n${entry.id}`).slice(0, 24)}`;
          withWindowLogLock(ctx.cwd, () => {
            if (readWindowEvents(ctx.cwd).some((window) => window.windowId === windowId)) return;
            persistWindowManifest(ctx.cwd, buildWindowManifest({
              cwd: ctx.cwd,
              records,
              sourceHash: details.sourceHash,
              keptEntryId: entry.firstKeptEntryId,
              reason: event.reason,
              isSplitTurn: details.isSplitTurn === true,
              sessionId,
              createdAt: entry.timestamp,
              windowId,
            }));
          });
        } catch {
          ctx.ui?.notify?.("pi-compact: 压缩已完成，但窗口日志写入失败。", "warning");
        }
      }
      if (config.memory.enabled && config.memory.deriveOnCompact) {
        try {
          persistDerived(ctx.cwd, records, details.sourceHash, sessionId);
        } catch {
          ctx.ui?.notify?.("pi-compact: 压缩已完成，但派生记忆写入失败。", "warning");
        }
      }
    }
    ctx.ui?.notify?.(`pi-compact: ${event.reason} 确定性压缩完成`, "info");
  });

  pi.on("session_compact_failed", (event: any, ctx: any) => {
    const extra = event.errorMessage ? `：${event.errorMessage}` : "";
    ctx.ui?.notify?.(`pi-compact: 压缩失败或已中止${extra}`, event.aborted ? "warning" : "error");
  });
};
