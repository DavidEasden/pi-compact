import type { MemoryRecord } from "../types.ts";

/** 单条记忆正文的字符上限；超过时拒绝写入，而不是静默截断。 */
export const MEMORY_MAX_CONTENT_CHARS = 8000;
/** sourceEntryIds 的条数/总字符上限；超出时截断并显式标记。 */
export const MEMORY_MAX_SOURCE_ENTRY_IDS = 64;
export const MEMORY_MAX_SOURCE_ID_CHARS = 4096;
/** 模型/规则 provisional 记录超过该天数后从默认列表和搜索中隐藏；显式 status 仍可查看。 */
export const MEMORY_PROVISIONAL_TTL_DAYS = 30;

export const contentTooLong = (content: string): boolean => content.length > MEMORY_MAX_CONTENT_CHARS;

/** 去重并限制 sourceEntryIds 的条数和总字符；只截断元数据，不改正文。 */
export const boundSourceEntryIds = (ids: string[]): { ids: string[]; truncated: boolean } => {
  const output: string[] = [];
  const seen = new Set<string>();
  let chars = 0;
  for (const id of ids) {
    if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
    if (output.length >= MEMORY_MAX_SOURCE_ENTRY_IDS || chars + id.length > MEMORY_MAX_SOURCE_ID_CHARS) {
      return { ids: output, truncated: true };
    }
    seen.add(id);
    output.push(id);
    chars += id.length;
  }
  return { ids: output, truncated: false };
};

/**
 * 只对模型/规则产生的 provisional 记录应用 TTL；
 * 用户写入的 active/pinned 记录不会因时间变旧而消失。
 */
export const isStaleProvisional = (record: MemoryRecord, now = Date.now()): boolean => {
  if (record.status !== "provisional" || record.author === "user") return false;
  const updated = Date.parse(record.updatedAt);
  if (!Number.isFinite(updated)) return false;
  return now - updated > MEMORY_PROVISIONAL_TTL_DAYS * 86_400_000;
};
