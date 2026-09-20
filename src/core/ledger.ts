import type { CompactionDetails, CompactReason, HistoryRecord } from "../types.ts";
import { estimateTokensFromChars } from "./content.ts";
import { hashRecords } from "./session.ts";

/**
 * checkpoint 只保留计数和计算所得哈希。正文、路径、ID、自定义类型以及旧摘要
 * 均可能携带不可信文本，只存入本地 details，不复制进模型上下文。
 * 保留调用签名以兼容现有调用方；旧 header 参数不再渲染。
 */
export const renderLedger = (
  records: HistoryRecord[],
  _reason: CompactReason,
  _keptEntryId: string,
  maxChars: number,
  _options?: { extraHeaderLines?: string[] },
): { text: string; omitted: number } => {
  const omitted = new Set(records.map((record) => record.entryId)).size;
  const text = JSON.stringify({
    compactor: "pi-compact",
    sourceCount: omitted,
    sourceHash: hashRecords(records),
  });
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
