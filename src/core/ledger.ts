import type { CompactionDetails, CompactReason, HistoryRecord } from "../types.ts";
import { clip, estimateTokensFromChars } from "./content.ts";
import { hashRecords } from "./session.ts";

const recordFiles = (record: HistoryRecord): string => (record.files.length > 0 ? ` files=${record.files.join(",")}` : "");

export const renderLedger = (records: HistoryRecord[], reason: CompactReason, keptEntryId: string, maxChars: number): { text: string; omitted: number } => {
  const lines = [
    "[pi-compact deterministic context checkpoint]",
    `compaction reason: ${reason}`,
    `retained context starts at entry: ${keptEntryId}`,
    "The records below are extracted from the original session entries; they are not LLM-generated claims.",
    "",
  ];
  const renderedEntryIds = new Set<string>();
  const tryPush = (line: string, record: HistoryRecord): void => {
    const candidate = `${lines.join("\n")}\n${line}`;
    if (candidate.length > maxChars - 900) return;
    lines.push(line);
    renderedEntryIds.add(record.entryId);
  };

  // Timeline 按 sourceOrdinal 保留原始顺序；分类区块仍按 kind 分组，二者共用省略计数。
  const timeline = [...records].sort((left, right) => left.sourceOrdinal - right.sourceOrdinal);
  if (timeline.length > 0) {
    lines.push("## Timeline");
    for (const record of timeline) {
      tryPush(`- [${record.entryId}] kinds=${record.kinds.join(",")}${recordFiles(record)} ${clip(record.text.replace(/\s+/g, " "), 240)}`, record);
    }
    lines.push("");
  }

  const sections: Array<[string, HistoryRecord[]]> = [
    ["User messages", records.filter((record) => record.kinds.includes("user"))],
    ["Assistant messages", records.filter((record) => record.kinds.includes("assistant") && !record.kinds.includes("tool_call"))],
    ["Tool calls", records.filter((record) => record.kinds.includes("tool_call"))],
    ["Tool results", records.filter((record) => record.kinds.includes("tool_result"))],
    ["Commands", records.filter((record) => record.kinds.includes("bash"))],
    ["Other session context", records.filter((record) => record.kinds.includes("custom"))],
  ];
  for (const [title, section] of sections) {
    if (section.length === 0) continue;
    lines.push(`## ${title}`);
    for (const record of section) {
      tryPush(`- [${record.entryId}]${recordFiles(record)} ${clip(record.text.replace(/\s+/g, " "), title === "User messages" ? 900 : 500)}`, record);
    }
    lines.push("");
  }
  const omitted = new Set(records.map((record) => record.entryId)).size - renderedEntryIds.size;
  if (omitted > 0) lines.push(`(${omitted} records omitted from this checkpoint text; they remain available through pi_compact_recall.)`, "");
  lines.push("Use pi_compact_recall with an entry ID, file path, or exact keyword to recover full original entries.");
  return { text: lines.join("\n").slice(0, maxChars), omitted };
};

export const buildDetails = (
  records: HistoryRecord[],
  reason: CompactReason,
  keptEntryId: string,
  omittedRecordCount: number,
  checkpointChars: number,
  summaryMaxChars: number,
): CompactionDetails => ({
  compactor: "pi-compact",
  version: 1,
  reason,
  sourceEntryIds: [...new Set(records.map((record) => record.entryId))],
  sourceHash: hashRecords(records),
  sourceRecordCount: records.length,
  keptEntryId,
  omittedRecordCount,
  checkpointChars,
  summaryMaxChars,
  estimatedTokensAfter: estimateTokensFromChars(checkpointChars),
});
