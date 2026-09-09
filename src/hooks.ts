import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { clip, estimateTokensFromChars, messageText, toolCallIds } from "./core/content.ts";
import { deriveFacts } from "./core/derive.ts";
import { buildDetails, renderLedger } from "./core/ledger.ts";
import { contextEntryIds, hashRecords, recordsFromEntries, searchRecords } from "./core/session.ts";
import { appendMemoryEvent, loadMemories, withMemoryLogLock, withWindowLogLock } from "./core/store.ts";
import { buildWindowManifest, persistWindowManifest, windowHeaderLines } from "./core/window.ts";
import { MEMORY_HINT_TYPE, renderWorkingHint } from "./core/working.ts";
import type { AutoRecallMode, SessionEntryLike } from "./types.ts";

export const AUTO_RECALL_TYPE = "pi-compact-auto-recall";
export { MEMORY_HINT_TYPE };

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

const latestUser = (messages: any[]): { text: string } => {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === "user") return { text: messageText(messages[index]) };
  }
  return { text: "" };
};

const completeLines = (lines: string[], maxChars: number): string => {
  const assembled = lines.join("\n");
  if (assembled.length <= maxChars) return assembled;
  const boundary = assembled.lastIndexOf("\n", Math.max(0, maxChars));
  return boundary > 0 ? assembled.slice(0, boundary) : assembled.slice(0, maxChars);
};

const renderRecall = (hits: ReturnType<typeof searchRecords>, maxChars: number, mode: AutoRecallMode): string => {
  const lines = [
    "[pi-compact automatic exact-history recall]",
    mode === "hint"
      ? "Matched original session records (short hints, not an LLM summary):"
      : "Matched original session records (not an LLM summary):",
  ];
  for (const hit of hits) {
    const customType = hit.customType ? ` customType=${hit.customType}` : "";
    if (mode === "hint") {
      const files = hit.files.length > 0 ? ` files=${hit.files.join(",")}` : "";
      lines.push(`- [${hit.entryId}] kinds=${hit.kinds.join(",")}${customType}${files}`);
      continue;
    }
    lines.push(`- [${hit.entryId}] ${hit.kinds.join(",")}${customType} ${clip(hit.snippet.replace(/\s+/g, " "), 650)}`);
  }
  return completeLines(lines, maxChars);
};

interface InjectionCache {
  key: string;
  content: string;
  ids: string[];
  injectionCount: number;
}

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
    summary: [
      "[pi-compact deterministic context checkpoint]",
      `compaction reason: ${reason}`,
      `retained context starts at entry: ${keptEntryId}`,
      "Extension compaction recovered from an internal error. Original session entries remain retrievable via pi_compact_recall.",
      "This checkpoint is a deterministic pointer/audit extract, not primary memory.",
    ].join("\n"),
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
      checkpointChars: 0,
      summaryMaxChars,
      estimatedTokensAfter: 0,
    },
  },
});

export const registerHooks = (pi: ExtensionAPI): void => {
  let autoRecallCache: InjectionCache | null = null;
  let memoryHintCache: InjectionCache | null = null;

  pi.on("session_before_compact", async (event: any, ctx: any) => {
    const config = loadConfig(ctx.cwd);
    if (!config.enabled || !config.overrideDefaultCompaction) return;
    if (event.signal?.aborted) return { cancel: true };
    const keptEntryId = event.preparation?.firstKeptEntryId;
    const branch: SessionEntryLike[] = event.branchEntries ?? [];
    const preparation = event.preparation;
    const splitPrefix = Array.isArray(preparation?.turnPrefixMessages) ? preparation.turnPrefixMessages : [];
    if (preparation?.isSplitTurn !== (splitPrefix.length > 0) || typeof keptEntryId !== "string" || !isSafeCut(branch, keptEntryId)) {
      ctx.ui.notify("pi-compact: Pi 给出的压缩边界不是完整消息边界，本次压缩已取消以避免丢失工具调用；请重试或暂时关闭扩展。", "warning");
      return { cancel: true };
    }
    try {
      const cutIndex = branch.findIndex((entry: any) => entry.id === keptEntryId);
      const records = recordsFromEntries(branch.slice(0, cutIndex));
      const sourceHash = hashRecords(records);
      const sessionId = sessionIdOf(ctx);
      let extraHeaderLines: string[] = ["This checkpoint is a deterministic pointer/audit extract, not primary memory."];
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
              isSplitTurn: preparation?.isSplitTurn === true,
              sessionId,
            });
            persistWindowManifest(ctx.cwd, manifest);
            return manifest;
          });
          extraHeaderLines = [...windowHeaderLines(window), extraHeaderLines[0]];
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
      const ledger = renderLedger(records, event.reason, keptEntryId, config.summaryMaxChars, { extraHeaderLines });
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

  // `context` 只修改当前 provider 请求；Pi 不会把返回的 custom message 持久化为 session entry。
  pi.on("context", (event: any, ctx: any) => {
    const config = loadConfig(ctx.cwd);
    if (!config.enabled) return;
    const messages = [...event.messages];
    const sessionId = sessionIdOf(ctx) ?? "";
    let currentBranch: SessionEntryLike[] | undefined;
    try {
      const branch = ctx.sessionManager?.getBranch?.();
      if (Array.isArray(branch)) currentBranch = branch;
    } catch {
      currentBranch = undefined;
    }
    // 本回合最新的 user entry：作为工作记忆 hint 的回合键，新回合重置注入计数。
    let latestUserEntry: { index: number; id?: string } | undefined;
    if (currentBranch) {
      for (let index = currentBranch.length - 1; index >= 0; index--) {
        const entry = currentBranch[index];
        if (entry?.type === "message" && entry.message?.role === "user") {
          latestUserEntry = { index, id: typeof entry.id === "string" ? entry.id : undefined };
          break;
        }
      }
    }
    let changed = false;

    if (config.memory.enabled && config.memory.pinnedInjection && !messages.some((message: any) => message.customType === MEMORY_HINT_TYPE)) {
      const memories = loadMemories(ctx.cwd);
      const liveKey = memories
        .filter((record) => record.status === "pinned" || record.status === "active")
        .map((record) => `${record.id}:${record.updatedAt}:${record.status}`)
        .join(",");
      // 回合键：本回合最新 user entry id；branch 不可用时退化为当前 user 文本。
      const turnKey = latestUserEntry?.id ?? latestUser(event.messages).text;
      const hintKey = `${sessionId}\u0000${turnKey}\u0000${liveKey}\u0000${config.memory.hintMaxChars}`;
      if (memoryHintCache?.key !== hintKey) {
        const hint = renderWorkingHint(memories, config.memory.hintMaxChars);
        memoryHintCache = { key: hintKey, content: hint.content, ids: [...hint.pinnedIds, ...hint.activeIds], injectionCount: 0 };
      }
      if (memoryHintCache.content) {
        memoryHintCache.injectionCount += 1;
        const chars = memoryHintCache.content.length;
        messages.push({
          role: "custom",
          customType: MEMORY_HINT_TYPE,
          timestamp: Date.now(),
          content: memoryHintCache.content,
          display: false,
          details: {
            source: "working-memory",
            memoryIds: memoryHintCache.ids,
            chars,
            estimatedTokens: estimateTokensFromChars(chars),
            sameTurnInjectionCount: memoryHintCache.injectionCount,
          },
        });
        changed = true;
      }
    }

    if (config.autoRecallMode !== "off" && !messages.some((message: any) => message.customType === AUTO_RECALL_TYPE)) {
      const current = latestUser(event.messages);
      if (current.text.trim().length >= 3 && currentBranch) {
        const latestUserId = latestUserEntry?.id;
        const latestUserIndex = latestUserEntry?.index ?? -1;
        if (typeof latestUserId === "string" && latestUserIndex >= 0) {
          const cacheKey = `${sessionId}\u0000${latestUserId}\u0000${current.text}\u0000${config.recallMaxResults}\u0000${config.autoRecallMaxChars}\u0000${config.autoRecallMode}\u0000${config.history.autoRecallPrimaryOnly}\u0000${config.history.excludeInContext}`;
          if (autoRecallCache?.key !== cacheKey) {
            const historyEntries = currentBranch.slice(0, latestUserIndex);
            let records = recordsFromEntries(historyEntries);
            if (config.history.autoRecallPrimaryOnly) records = records.filter((record) => record.sourceClass === "primary");
            if (config.history.excludeInContext) {
              const inContext = contextEntryIds(ctx.sessionManager);
              if (inContext.size > 0) records = records.filter((record) => !inContext.has(record.entryId));
            }
            const hits = searchRecords(records, current.text, { maxResults: config.recallMaxResults, sourceClass: config.history.autoRecallPrimaryOnly ? "primary" : "all" });
            autoRecallCache = hits.length === 0
              ? { key: cacheKey, content: "", ids: [], injectionCount: 0 }
              : { key: cacheKey, content: renderRecall(hits, config.autoRecallMaxChars, config.autoRecallMode), ids: hits.map((hit) => hit.entryId), injectionCount: 0 };
          }
          if (autoRecallCache.content) {
            autoRecallCache.injectionCount += 1;
            const chars = autoRecallCache.content.length;
            const estimatedTokens = estimateTokensFromChars(chars);
            if (config.debug) {
              console.log(`[pi-compact] auto-recall: hitCount=${autoRecallCache.ids.length} chars=${chars} mode=${config.autoRecallMode} sameTurnInjectionCount=${autoRecallCache.injectionCount} estimatedTokens=${estimatedTokens}`);
            }
            messages.push({
              role: "custom",
              customType: AUTO_RECALL_TYPE,
              timestamp: Date.now(),
              content: autoRecallCache.content,
              display: false,
              details: {
                source: "request-context",
                entryIds: autoRecallCache.ids,
                chars,
                hitCount: autoRecallCache.ids.length,
                estimatedTokens,
                mode: config.autoRecallMode,
                sameTurnInjectionCount: autoRecallCache.injectionCount,
              },
            });
            changed = true;
          }
        }
      }
    }

    if (!changed) return;
    return { messages };
  });

  pi.on("session_compact", (event: any, ctx: any) => {
    if (event.fromExtension) ctx.ui.notify(`pi-compact: ${event.reason} 确定性压缩完成`, "info");
  });

  pi.on("session_compact_failed", (event: any, ctx: any) => {
    const extra = event.errorMessage ? `：${event.errorMessage}` : "";
    ctx.ui?.notify?.(`pi-compact: 压缩失败或已中止${extra}`, event.aborted ? "warning" : "error");
  });
};
