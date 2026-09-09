import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { clip, messageText, toolCallIds } from "./core/content.ts";
import { buildDetails, renderLedger } from "./core/ledger.ts";
import { recordsFromEntries, searchRecords } from "./core/session.ts";
import type { SessionEntryLike } from "./types.ts";

export const AUTO_RECALL_TYPE = "pi-compact-auto-recall";

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

const renderRecall = (hits: ReturnType<typeof searchRecords>, maxChars: number): string => {
  const lines = ["[pi-compact automatic exact-history recall]", "Matched original session records (not an LLM summary):"];
  for (const hit of hits) lines.push(`- [${hit.entryId}] ${hit.kinds.join(",")} ${clip(hit.snippet, 650)}`);
  return lines.join("\n").slice(0, maxChars);
};

interface AutoRecallCache {
  key: string;
  content: string;
  entryIds: string[];
}

export const registerHooks = (pi: ExtensionAPI): void => {
  let autoRecallCache: AutoRecallCache | null = null;

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
    const cutIndex = branch.findIndex((entry: any) => entry.id === keptEntryId);
    const records = recordsFromEntries(branch.slice(0, cutIndex));
    const ledger = renderLedger(records, event.reason, keptEntryId, config.summaryMaxChars);
    const details = buildDetails(records, event.reason, keptEntryId, ledger.omitted);
    if (config.debug) console.log(`[pi-compact] ${event.reason}: ${records.length} source records, kept=${keptEntryId}`);
    return { compaction: {
      summary: ledger.text,
      firstKeptEntryId: keptEntryId,
      tokensBefore: event.preparation.tokensBefore,
      details,
    } };
  });

  // `context` 只修改当前 provider 请求；Pi 不会把返回的 custom message 持久化为 session entry。
  pi.on("context", (event: any, ctx: any) => {
    const config = loadConfig(ctx.cwd);
    if (!config.enabled || !config.autoRecall) return;
    if (event.messages.some((message: any) => message.customType === AUTO_RECALL_TYPE)) return;
    const current = latestUser(event.messages);
    if (current.text.trim().length < 3) return;

    let currentBranch: SessionEntryLike[];
    try {
      const branch = ctx.sessionManager.getBranch?.();
      if (!Array.isArray(branch)) return;
      currentBranch = branch;
    } catch {
      return;
    }
    let latestUserIndex = -1;
    for (let index = currentBranch.length - 1; index >= 0; index--) {
      if (currentBranch[index]?.type === "message" && currentBranch[index]?.message?.role === "user") {
        latestUserIndex = index;
        break;
      }
    }
    const latestUserId = latestUserIndex >= 0 ? currentBranch[latestUserIndex]?.id : undefined;
    if (typeof latestUserId !== "string") return;

    const cacheKey = `${latestUserId}\u0000${current.text}\u0000${config.recallMaxResults}\u0000${config.autoRecallMaxChars}`;
    if (autoRecallCache?.key !== cacheKey) {
      // 只搜索当前 user entry 之前的历史，避免同一 turn 重复请求混入刚生成的工具结果。
      const historyEntries = currentBranch.slice(0, latestUserIndex);
      const records = recordsFromEntries(historyEntries);
      const hits = searchRecords(records, current.text, { maxResults: config.recallMaxResults });
      autoRecallCache = hits.length === 0
        ? { key: cacheKey, content: "", entryIds: [] }
        : { key: cacheKey, content: renderRecall(hits, config.autoRecallMaxChars), entryIds: hits.map((hit) => hit.entryId) };
    }
    if (!autoRecallCache.content) return;
    return { messages: [...event.messages, {
      role: "custom",
      customType: AUTO_RECALL_TYPE,
      content: autoRecallCache.content,
      display: false,
      details: { source: "request-context", entryIds: autoRecallCache.entryIds },
    }] };
  });

  pi.on("session_compact", (event: any, ctx: any) => {
    if (event.fromExtension) ctx.ui.notify(`pi-compact: ${event.reason} 确定性压缩完成`, "info");
  });
};
