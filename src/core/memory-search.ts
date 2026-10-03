import { queryTerms } from "./content.ts";
import type { MemoryRecord } from "../types.ts";

const STATUS_ORDER: Record<MemoryRecord["status"], number> = {
  pinned: 0,
  active: 1,
  provisional: 2,
  superseded: 3,
  resolved: 4,
};

const PRIORITY_ORDER: Record<MemoryRecord["priority"], number> = { high: 0, normal: 1, low: 2 };
const AUTHOR_ORDER: Record<MemoryRecord["author"], number> = { user: 0, model: 1, rule: 2 };

/** 默认列表优先展示当前有效且可信度较高的记录，避免旧派生记录挤掉用户记忆。 */
export const sortMemoryRecords = (records: MemoryRecord[]): MemoryRecord[] => [...records].sort((left, right) => (
  STATUS_ORDER[left.status] - STATUS_ORDER[right.status]
  || PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority]
  || AUTHOR_ORDER[left.author] - AUTHOR_ORDER[right.author]
  || right.updatedAt.localeCompare(left.updatedAt)
  || left.id.localeCompare(right.id)
));

export interface MemorySearchOptions {
  /** 为测试和离线评估提供稳定的时间基准；未传入时使用当前时间。 */
  now?: string | number | Date;
}

const STATUS_WEIGHT: Record<MemoryRecord["status"], number> = {
  pinned: 0.8,
  active: 0.55,
  provisional: 0,
  superseded: -0.8,
  resolved: -1.2,
};

const AUTHOR_WEIGHT: Record<MemoryRecord["author"], number> = {
  user: 0.4,
  model: 0,
  rule: -0.2,
};

const PRIORITY_WEIGHT: Record<MemoryRecord["priority"], number> = {
  high: 0.2,
  normal: 0.08,
  low: 0,
};

const normalize = (value: string): string => value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();

const countOccurrences = (text: string, term: string): number => {
  if (!term) return 0;
  let count = 0;
  let offset = 0;
  while (offset < text.length) {
    const found = text.indexOf(term, offset);
    if (found < 0) break;
    count++;
    offset = found + Math.max(1, term.length);
  }
  return count;
};

const ageDays = (updatedAt: string, now: number): number => {
  const updated = Date.parse(updatedAt);
  if (!Number.isFinite(updated) || updated > now) return 0;
  return (now - updated) / 86_400_000;
};

const freshnessWeight = (record: MemoryRecord, now: number): number => {
  // 用户确认的长期事实不应因时间变旧而消失；时间衰减只作为很小的排序信号。
  if (record.author === "user" || record.status === "pinned" || record.status === "active") return 0;
  return 0.3 / (1 + ageDays(record.updatedAt, now) / 30);
};

const searchableText = (record: MemoryRecord): string => normalize([
  record.content,
  record.id,
  record.kind,
  record.provenance ?? "",
].join("\n"));

const tokenLength = (content: string): number => {
  if (typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
    return Math.max(1, [...segmenter.segment(content)].filter((item) => item.isWordLike).length);
  }
  return Math.max(1, content.match(/[\p{L}\p{N}_.\-/]+/gu)?.length ?? 0);
};

/**
 * 纯本地、可解释的记忆排序：BM25-lite 文本相关性叠加权威性、优先级和轻量新鲜度。
 * 不使用网络或 embedding，代码路径、命令和错误码仍按精确 token/子串匹配。
 */
export const searchMemoryRecords = (
  records: MemoryRecord[],
  query: string,
  options: MemorySearchOptions = {},
): MemoryRecord[] => {
  const terms = [...new Set(queryTerms(query).map(normalize).filter(Boolean))];
  if (terms.length === 0) return [];

  const searchable = records.map((record) => ({ record, text: searchableText(record), length: tokenLength(record.content) }));
  const averageLength = Math.max(1, searchable.reduce((total, item) => total + item.length, 0) / Math.max(1, searchable.length));
  const documentFrequency = new Map<string, number>();
  for (const term of terms) {
    documentFrequency.set(term, searchable.reduce((count, item) => count + (item.text.includes(term) ? 1 : 0), 0));
  }
  const nowValue = options.now instanceof Date
    ? options.now.getTime()
    : typeof options.now === "number" ? options.now : options.now ? Date.parse(options.now) : Date.now();
  const now = Number.isFinite(nowValue) ? nowValue : Date.now();
  const queryText = normalize(query);

  return searchable
    .map(({ record, text, length }) => {
      let textScore = 0;
      let matchedTerms = 0;
      for (const term of terms) {
        const frequency = countOccurrences(text, term);
        if (frequency === 0) continue;
        matchedTerms++;
        const documentFrequencyValue = documentFrequency.get(term) ?? 0;
        const inverseDocumentFrequency = Math.log(1 + (searchable.length + 1) / (documentFrequencyValue + 1));
        const saturatedFrequency = (Math.min(frequency, 8) * 2.2) / (Math.min(frequency, 8) + 1.2);
        const lengthNorm = 1 - 0.75 + 0.75 * (length / averageLength);
        textScore += inverseDocumentFrequency * saturatedFrequency / Math.max(0.5, lengthNorm);
      }
      if (matchedTerms === 0) return undefined;

      const allTermsBonus = matchedTerms === terms.length ? 1.6 : 0;
      const phraseBonus = terms.length > 1 && text.includes(queryText) ? 1.2 : 0;
      const score = textScore
        + allTermsBonus
        + phraseBonus
        + STATUS_WEIGHT[record.status]
        + AUTHOR_WEIGHT[record.author]
        + PRIORITY_WEIGHT[record.priority]
        + freshnessWeight(record, now);
      return { record, score, matchedTerms };
    })
    .filter((item): item is { record: MemoryRecord; score: number; matchedTerms: number } => item !== undefined)
    .sort((left, right) => (
      right.score - left.score
      || right.matchedTerms - left.matchedTerms
      || right.record.updatedAt.localeCompare(left.record.updatedAt)
      || left.record.id.localeCompare(right.record.id)
    ))
    .map((item) => item.record);
};
