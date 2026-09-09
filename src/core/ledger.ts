import type { CompactionDetails, CompactReason, HistoryRecord } from "../types.ts";
import { clip, estimateTokensFromChars } from "./content.ts";
import { hashRecords } from "./session.ts";

const recordFiles = (record: HistoryRecord): string => (record.files.length > 0 ? ` files=${record.files.join(",")}` : "");

export const renderLedger = (
  records: HistoryRecord[],
  reason: CompactReason,
  keptEntryId: string,
  maxChars: number,
  options?: { extraHeaderLines?: string[] },
): { text: string; omitted: number } => {
  const lines = [
    "[pi-compact deterministic context checkpoint]",
    ...(options?.extraHeaderLines ?? []),
    `compaction reason: ${reason}`,
    `retained context starts at entry: ${keptEntryId}`,
    "The records below are extracted from the original session entries; they are not LLM-generated claims.",
    "",
  ];
  const uniqueRecordCount = new Set(records.map((record) => record.entryId)).size;
  const renderedEntryIds = new Set<string>();
  const footer = (renderedCount: number): string => {
    const omitted = Math.max(0, uniqueRecordCount - renderedCount);
    const omission = omitted > 0
      ? `(${omitted} records omitted from this checkpoint text; they remain available through pi_compact_recall.)\n\n`
      : "";
    return `${omission}Use pi_compact_recall with an entry ID, file path, or exact keyword to recover full original entries.`;
  };
  const fits = (candidateLines: string[], renderedCount: number): boolean => {
    const separator = candidateLines.length > 0 ? 1 : 0;
    return candidateLines.join("\n").length + separator + footer(renderedCount).length <= Math.max(0, maxChars);
  };
  const tryPushText = (line: string): boolean => {
    if (!fits([...lines, line], renderedEntryIds.size)) return false;
    lines.push(line);
    return true;
  };
  const tryPush = (line: string, record: HistoryRecord): boolean => {
    const nextCount = renderedEntryIds.has(record.entryId) ? renderedEntryIds.size : renderedEntryIds.size + 1;
    if (!fits([...lines, line], nextCount)) return false;
    lines.push(line);
    renderedEntryIds.add(record.entryId);
    return true;
  };

  // Timeline 按 sourceOrdinal 保留原始顺序；分类区块仍按 kind 分组，二者共用省略计数。
  const timeline = [...records].sort((left, right) => left.sourceOrdinal - right.sourceOrdinal);
  if (timeline.length > 0) {
    const sectionStart = lines.length;
    const hasHeading = tryPushText("## Timeline");
    let included = false;
    if (hasHeading) {
      for (const record of timeline) {
        included = tryPush(`- [${record.entryId}] kinds=${record.kinds.join(",")}${recordFiles(record)} ${clip(record.text.replace(/\s+/g, " "), 240)}`, record) || included;
      }
      if (included) tryPushText("");
      else lines.splice(sectionStart);
    }
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
    const sectionStart = lines.length;
    if (!tryPushText(`## ${title}`)) continue;
    let included = false;
    for (const record of section) {
      included = tryPush(`- [${record.entryId}]${recordFiles(record)} ${clip(record.text.replace(/\s+/g, " "), title === "User messages" ? 900 : 500)}`, record) || included;
    }
    if (included) tryPushText("");
    else lines.splice(sectionStart);
  }
  const omitted = uniqueRecordCount - renderedEntryIds.size;
  lines.push(footer(renderedEntryIds.size));
  return { text: lines.join("\n").slice(0, Math.max(0, maxChars)), omitted };
};

export const buildDetails = (
  records: HistoryRecord[],
  reason: CompactReason,
  keptEntryId: string,
  omittedRecordCount: number,
  checkpointChars: number,
  summaryMaxChars: number,
  window?: CompactionDetails["window"],
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
  ...(window ? { window } : {}),
});
