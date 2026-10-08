import type { CompactionDetails, CompactReason, HistoryRecord } from "../types.ts";
import { estimateTokensFromChars } from "./content.ts";
import { hashRecords } from "./session.ts";

/**
 * checkpoint 只保留计数、哈希和扩展生成的结构化元数据（方案 C）。
 * 正文、路径、用户数据等不可信文本均不进入 summary；windowId/keptEntryId 均为扩展生成，不复制历史内容。
 * 保留调用签名以兼容现有调用方；旧 header 参数不再渲染。
 */
export const renderLedger = (
  records: HistoryRecord[],
  _reason: CompactReason,
  keptEntryId: string,
  maxChars: number,
  options?: { extraHeaderLines?: string[]; windowId?: string },
): { text: string; omitted: number } => {
  const omitted = new Set(records.map((record) => record.entryId)).size;
  const sourceHash = hashRecords(records);
  // windowId 和 keptEntryId 均为扩展自身生成的标识符，不包含任何历史正文。
  const payload: Record<string, unknown> = {
    compactor: "pi-compact",
    sourceCount: omitted,
    sourceHash,
    keptEntryId,
  };
  if (options?.windowId) payload.windowId = options.windowId;
  const text = JSON.stringify(payload);
  // 不截断 JSON，也不在预算不足或异常时回填历史正文或行为提示词。
  return { text: text.length <= maxChars ? text : maxChars >= 2 ? "{}" : "", omitted };
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
