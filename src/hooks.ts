import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { buildDetails, renderLedger } from "./core/ledger.ts";
import { activeEntryIds, historyRecords, readSessionRecords, searchHistory } from "./core/session.ts";
import { clip, messageText, normalizeMessage } from "./core/content.ts";
import type { HistoryRecord, PiCompactConfig } from "./types.ts";

export const AUTO_RECALL_TYPE = "pi-compact-auto-recall";

const recordsFromBranch = (branchEntries: any[], keptEntryId: string): HistoryRecord[] => {
  const cutIndex = branchEntries.findIndex((entry) => entry.id === keptEntryId);
  if (cutIndex < 0) return [];
  const records: HistoryRecord[] = [];
  let sourceIndex = 0;
  for (let index = 0; index < cutIndex; index++) {
    const entry = branchEntries[index];
    if (entry.type !== "message" || !entry.message || !entry.id) continue;
    records.push(...normalizeMessage(entry.message, entry.id, sourceIndex++, entry.timestamp));
  }
  return records;
};

const fallbackSourceRecords = (branchEntries: any[], preparation: any): HistoryRecord[] => {
  const records: HistoryRecord[] = [];
  let sourceIndex = 0;
  for (const message of [...(preparation.messagesToSummarize ?? []), ...(preparation.turnPrefixMessages ?? [])]) {
    records.push({
      entryId: `message-${sourceIndex}`,
      kind: message.role === "user" ? "user" : message.role === "toolResult" ? "tool_result" : "assistant",
      text: messageText(message),
      files: [],
      sourceIndex: sourceIndex++,
    });
  }
  return records;
};

const renderAutoRecall = (hits: ReturnType<typeof searchHistory>, maxChars: number): string => {
  const lines = ["[pi-compact 自动历史召回]", "以下是与当前用户请求关键词匹配的旧原文片段："];
  for (const hit of hits) {
    lines.push(`- [${hit.entryId}] ${hit.kind}: ${clip(hit.snippet, 700)}`);
  }
  return clip(lines.join("\n"), maxChars);
};

const latestUserQuery = (messages: any[]): string => {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === "user") return messageText(messages[index]);
  }
  return "";
};

export const registerHooks = (pi: ExtensionAPI): void => {
  pi.on("session_before_compact", async (event: any, ctx: any) => {
    const config = loadConfig(ctx.cwd);
    if (!config.enabled || !config.overrideDefaultCompaction) return;
    if (event.signal?.aborted) return;

    const keptEntryId = event.preparation.firstKeptEntryId;
    if (!keptEntryId || !(event.branchEntries ?? []).some((entry: any) => entry.id === keptEntryId)) {
      ctx.ui.notify("pi-compact: 无法确认安全的保留边界，交由 Pi 默认压缩", "warning");
      return;
    }

    const records = recordsFromBranch(event.branchEntries, keptEntryId);
    const sourceRecords = records.length > 0 ? records : fallbackSourceRecords(event.branchEntries, event.preparation);
    const summary = renderLedger({
      records: sourceRecords,
      reason: event.reason,
      keptEntryId,
      previousSummary: event.preparation.previousSummary,
      maxChars: config.summaryMaxChars,
    });
    const details = buildDetails(sourceRecords, event.reason, keptEntryId);

    if (config.debug) {
      console.log(`[pi-compact] ${event.reason}: ${sourceRecords.length} records, keep=${keptEntryId}`);
    }

    return {
      compaction: {
        summary,
        firstKeptEntryId: keptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        details,
      },
    };
  });

  pi.on("context", (event: any, ctx: any) => {
    const config = loadConfig(ctx.cwd);
    if (!config.enabled || !config.autoRecall) return;
    if (event.messages.some((message: any) => message.customType === AUTO_RECALL_TYPE)) return;
    const query = latestUserQuery(event.messages);
    if (query.trim().length < 3) return;

    const sessionFile = ctx.sessionManager.getSessionFile?.();
    if (!sessionFile) return;
    try {
      const records = readSessionRecords(sessionFile);
      const allowed = activeEntryIds(ctx.sessionManager);
      const history = historyRecords(records, allowed);
      const hits = searchHistory(history, query, { maxResults: config.recallMaxResults });
      if (hits.length === 0) return;
      const content = renderAutoRecall(hits, config.autoRecallMaxChars);
      return {
        messages: [...event.messages, {
          role: "custom",
          customType: AUTO_RECALL_TYPE,
          content,
          display: false,
          details: { source: "pi-compact", entryIds: hits.map((hit) => hit.entryId) },
        }],
      };
    } catch (error) {
      if (config.debug) console.error("[pi-compact] 自动召回失败", error);
      return;
    }
  });

  pi.on("session_compact", (event: any, ctx: any) => {
    if (event.fromExtension) {
      ctx.ui.notify(`pi-compact: 已完成${event.reason === "threshold" ? "自动" : ""}确定性压缩`, "info");
    }
  });
};
