import type { CompactionDetails, CompactReason, HistoryRecord } from "../types.ts";
import { clip } from "./content.ts";
import { hashRecords } from "./session.ts";

export const renderLedger = (records: HistoryRecord[], reason: CompactReason, keptEntryId: string, maxChars: number): { text: string; omitted: number } => {
  const lines = [
    "[pi-compact deterministic context checkpoint]",
    `compaction reason: ${reason}`,
    `retained context starts at entry: ${keptEntryId}`,
    "The records below are extracted from the original session entries; they are not LLM-generated claims.",
    "",
  ];
  const sections: Array<[string, HistoryRecord[]]> = [
    ["User messages", records.filter((record) => record.kinds.includes("user"))],
    ["Assistant messages", records.filter((record) => record.kinds.includes("assistant") && !record.kinds.includes("tool_call"))],
    ["Tool calls", records.filter((record) => record.kinds.includes("tool_call"))],
    ["Tool results", records.filter((record) => record.kinds.includes("tool_result"))],
    ["Commands", records.filter((record) => record.kinds.includes("bash"))],
    ["Other session context", records.filter((record) => record.kinds.includes("custom"))],
  ];
  let omitted = 0;
  for (const [title, section] of sections) {
    if (section.length === 0) continue;
    lines.push(`## ${title}`);
    for (const record of section) {
      const files = record.files.length > 0 ? ` files=${record.files.join(",")}` : "";
      const line = `- [${record.entryId}]${files} ${clip(record.text.replace(/\s+/g, " "), title === "User messages" ? 900 : 500)}`;
      const candidate = `${lines.join("\n")}\n${line}`;
      if (candidate.length > maxChars - 900) { omitted++; continue; }
      lines.push(line);
    }
    lines.push("");
  }
  if (omitted > 0) lines.push(`(${omitted} records omitted from this checkpoint text; they remain available through pi_compact_recall.)`, "");
  lines.push("Use pi_compact_recall with an entry ID, file path, or exact keyword to recover full original entries.");
  return { text: lines.join("\n").slice(0, maxChars), omitted };
};

export const buildDetails = (records: HistoryRecord[], reason: CompactReason, keptEntryId: string, omittedRecordCount: number): CompactionDetails => ({
  compactor: "pi-compact",
  version: 1,
  reason,
  sourceEntryIds: [...new Set(records.map((record) => record.entryId))],
  sourceHash: hashRecords(records),
  sourceRecordCount: records.length,
  keptEntryId,
  omittedRecordCount,
});
