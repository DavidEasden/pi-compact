import type { CompactionDetails, CompactReason, HistoryRecord } from "../types.ts";
import { clip } from "./content.ts";
import { sourceHash } from "./session.ts";

export interface LedgerInput {
  records: HistoryRecord[];
  reason: CompactReason;
  keptEntryId: string;
  previousSummary?: string;
  maxChars: number;
}

const label = (kind: HistoryRecord["kind"]): string => ({
  user: "用户",
  assistant: "助手",
  tool_call: "工具调用",
  tool_result: "工具结果",
  bash: "命令",
  custom: "自定义消息",
}[kind]);

export const renderLedger = (input: LedgerInput): string => {
  const { records, reason, keptEntryId, previousSummary, maxChars } = input;
  const lines: string[] = [
    "[pi-compact: deterministic working memory]",
    `压缩原因: ${reason}`,
    `历史记录数: ${records.length}`,
    `保留尾部起点: ${keptEntryId}`,
    "",
    "[历史操作账本]",
  ];
  const grouped = new Map<string, HistoryRecord[]>();
  for (const record of records) {
    const list = grouped.get(record.kind) ?? [];
    list.push(record);
    grouped.set(record.kind, list);
  }
  for (const kind of ["user", "assistant", "tool_call", "tool_result", "bash", "custom"] as const) {
    const items = grouped.get(kind) ?? [];
    if (items.length === 0) continue;
    lines.push(`## ${label(kind)} (${items.length})`);
    for (const item of items) {
      const files = item.files.length > 0 ? ` 文件: ${item.files.join(", ")}` : "";
      lines.push(`- [${item.entryId}]${files} ${clip(item.text.replace(/\s+/g, " "), kind === "tool_result" || kind === "bash" ? 280 : 420)}`);
    }
  }
  if (previousSummary) {
    lines.push("", "[上一次压缩状态]", clip(previousSummary, 1200));
  }
  lines.push(
    "",
    "[恢复说明]",
    "以上内容由 session 原文确定性提取，不是 LLM 摘要。完整历史仍保留在 Pi session JSONL 中。需要旧细节时使用 pi_compact_recall。",
  );
  return clip(lines.join("\n"), maxChars);
};

export const buildDetails = (records: HistoryRecord[], reason: CompactReason, keptEntryId: string): CompactionDetails => ({
  compactor: "pi-compact",
  version: 1,
  reason,
  sourceEntryIds: [...new Set(records.map((record) => record.entryId))],
  sourceHash: sourceHash(records),
  sourceRecordCount: records.length,
  keptEntryId,
  generatedAt: new Date().toISOString(),
});
