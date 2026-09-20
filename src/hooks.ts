import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { toolCallIds } from "./core/content.ts";
import { deriveFacts } from "./core/derive.ts";
import { buildDetails, renderLedger } from "./core/ledger.ts";
import { hashRecords, recordsFromEntries } from "./core/session.ts";
import { appendMemoryEvent, loadMemories, withMemoryLogLock, withWindowLogLock } from "./core/store.ts";
import { buildWindowManifest, persistWindowManifest } from "./core/window.ts";
import type { SessionEntryLike } from "./types.ts";

export const AUTO_RECALL_TYPE = "pi-compact-auto-recall";
export const MEMORY_HINT_TYPE = "pi-compact-memory-hint";

const CUT_POINT_ROLES = new Set(["user", "assistant", "bashExecution", "custom", "branchSummary", "compactionSummary"]);
const TERMINAL_ASSISTANT_REASONS = new Set(["error", "aborted"]);

type ToolCallCounts = Map<string, number>;

const countToolCalls = (entries: SessionEntryLike[], start: number, end: number): ToolCallCounts => {
  const counts: ToolCallCounts = new Map();
  for (let index = start; index < end; index++) {
    const message = entries[index]?.message;
    if (message?.role !== "assistant") continue;
    for (const id of toolCallIds(message)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
};

const countTerminalToolCalls = (entries: SessionEntryLike[], start: number, end: number): ToolCallCounts => {
  const counts: ToolCallCounts = new Map();
  for (let index = start; index < end; index++) {
    const message = entries[index]?.message;
    if (message?.role !== "assistant" || !TERMINAL_ASSISTANT_REASONS.has(message.stopReason ?? "")) continue;
    for (const id of toolCallIds(message)) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
};

const countToolResults = (entries: SessionEntryLike[], start: number, end: number): ToolCallCounts => {
  const counts: ToolCallCounts = new Map();
  for (let index = start; index < end; index++) {
    const message = entries[index]?.message;
    if (message?.role !== "toolResult" || typeof message.toolCallId !== "string") continue;
    const id = message.toolCallId;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
};

const hasMalformedToolMessage = (entries: SessionEntryLike[], start: number, end: number): boolean => {
  for (let index = start; index < end; index++) {
    const message = entries[index]?.message;
    if (message?.role === "toolResult" && typeof message.toolCallId !== "string") return true;
    if (message?.role === "assistant" && Array.isArray(message.content) && message.content.some((part: any) => part?.type === "toolCall" && typeof part.id !== "string")) return true;
  }
  return false;
};

const isValidCutEntry = (entry: SessionEntryLike | undefined): boolean => {
  if (!entry || entry.type === "compaction") return false;
  if (entry.type === "custom_message" || entry.type === "branch_summary") return true;
  if (entry.type !== "message") return false;
  return typeof entry.message?.role === "string" && CUT_POINT_ROLES.has(entry.message.role);
};

/**
 * Pi 不会把工具结果选为切点，但扩展仍需验证保留侧的完整调用/结果关系。
 * error/aborted assistant 响应中的调用可能没有结果，可以由被丢弃的检查点覆盖，
 * 不应因此阻塞后续压缩。
 */
export const isSafeCut = (branchEntries: SessionEntryLike[], keptEntryId: string): boolean => {
  const cut = branchEntries.findIndex((entry) => entry.id === keptEntryId);
  if (cut <= 0 || !isValidCutEntry(branchEntries[cut])) return false;
  if (hasMalformedToolMessage(branchEntries, cut, branchEntries.length)) return false;

  const callsBefore = countToolCalls(branchEntries, 0, cut);
  const terminalCallsBefore = countTerminalToolCalls(branchEntries, 0, cut);
  const resultsBefore = countToolResults(branchEntries, 0, cut);
  for (const [id, count] of callsBefore) {
    const missing = count - (resultsBefore.get(id) ?? 0);
    if (missing > (terminalCallsBefore.get(id) ?? 0)) return false;
  }
  for (const [id, count] of resultsBefore) {
    if (count > (callsBefore.get(id) ?? 0)) return false;
  }

  // 切点后的结果不能引用已经被丢弃的调用；终止的 error/aborted 调用可以没有结果。
  const callsAfter = countToolCalls(branchEntries, cut, branchEntries.length);
  const terminalCallsAfter = countTerminalToolCalls(branchEntries, cut, branchEntries.length);
  const resultsAfter = countToolResults(branchEntries, cut, branchEntries.length);
  for (const [id, count] of callsAfter) {
    const missing = count - (resultsAfter.get(id) ?? 0);
    if (missing > (terminalCallsAfter.get(id) ?? 0)) return false;
  }
  for (const id of resultsAfter.keys()) {
    if (!callsAfter.has(id)) return false;
  }

  // 按 entry 顺序回放保留尾部，避免接受结果先于调用或普通未完成调用。
  const openCalls = new Map<string, boolean[]>();
  for (let index = cut; index < branchEntries.length; index++) {
    const message = branchEntries[index]?.message;
    if (message?.role === "assistant") {
      const terminal = TERMINAL_ASSISTANT_REASONS.has(message.stopReason ?? "");
      for (const id of toolCallIds(message)) {
        const calls = openCalls.get(id) ?? [];
        calls.push(terminal);
        openCalls.set(id, calls);
      }
    } else if (message?.role === "toolResult") {
      const id = message.toolCallId;
      if (typeof id !== "string") return false;
      const calls = openCalls.get(id);
      if (!calls || calls.length === 0) return false;
      calls.shift();
      if (calls.length === 0) openCalls.delete(id);
    }
  }
  return [...openCalls.values()].every((calls) => calls.every((terminal) => terminal));
};

/**
 * Pi 给出的边界不安全时，向前回退寻找最近一个安全边界：
 * 回退只会让保留区变大（少摘要、多保留），不会引入新的断链风险。
 * 找不到任何安全边界时返回 undefined，由调用方决定取消。
 */
export const findEarlierSafeCut = (branch: SessionEntryLike[], proposedId: string): string | undefined => {
  const proposed = branch.findIndex((entry) => entry.id === proposedId);
  if (proposed <= 0) return undefined;
  for (let index = proposed; index >= 1; index--) {
    const entry = branch[index];
    if (typeof entry?.id !== "string" || !isValidCutEntry(entry)) continue;
    if (isSafeCut(branch, entry.id)) return entry.id;
  }
  return undefined;
};

const sessionIdOf = (ctx: any): string | undefined => {
  try {
    const id = ctx.sessionManager?.getSessionId?.();
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
};

const persistDerived = (cwd: string, records: ReturnType<typeof recordsFromEntries>, sourceHash: string, sessionId?: string): void => {
  withMemoryLogLock(cwd, () => {
    const existing = new Set(loadMemories(cwd).map((record) => record.id));
    for (const draft of deriveFacts(records, sourceHash)) {
      if (existing.has(draft.recordId)) continue;
      appendMemoryEvent(cwd, {
        type: "create",
        recordId: draft.recordId,
        author: "rule",
        sessionId,
        payload: draft.payload,
      });
      existing.add(draft.recordId);
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
      const cutIndex = branch.findIndex((entry: any) => entry.id === keptEntryId);
      const records = recordsFromEntries(branch.slice(0, cutIndex));
      const sourceHash = hashRecords(records);
      const sessionId = sessionIdOf(ctx);
      let window = undefined;
      if (config.window.manifest) {
        try {
          // build（读末条定 seq/parent）+ persist 必须在同一锁事务内，避免并发压缩写出重复 seq。
          window = withWindowLogLock(ctx.cwd, () => {
            const manifest = buildWindowManifest({
              cwd: ctx.cwd,
              records,
              sourceHash,
              keptEntryId,
              reason: event.reason,
              isSplitTurn,
              sessionId,
            });
            persistWindowManifest(ctx.cwd, manifest);
            return manifest;
          });
        } catch {
          window = undefined;
        }
      }
      if (config.memory.enabled && config.memory.deriveOnCompact) {
        try {
          persistDerived(ctx.cwd, records, sourceHash, sessionId);
        } catch {
          // 规则派生失败不得阻断压缩。
        }
      }
      const ledger = renderLedger(records, event.reason, keptEntryId, config.summaryMaxChars);
      const details = buildDetails(records, event.reason, keptEntryId, ledger.omitted, ledger.text.length, config.summaryMaxChars, window);
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
    if (event.fromExtension) ctx.ui.notify(`pi-compact: ${event.reason} 确定性压缩完成`, "info");
  });

  pi.on("session_compact_failed", (event: any, ctx: any) => {
    const extra = event.errorMessage ? `：${event.errorMessage}` : "";
    ctx.ui?.notify?.(`pi-compact: 压缩失败或已中止${extra}`, event.aborted ? "warning" : "error");
  });
};
