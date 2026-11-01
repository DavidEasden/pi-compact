import { createHash } from "node:crypto";
import type { HistoryRecord, MessageLike, SearchHit, SessionEntryLike, SourceClass } from "../types.ts";
import { messageFiles, messageKinds, messageText, queryTerms, snippetAround, thinkingOf, toolCallIds } from "./content.ts";

const DERIVED_CUSTOM_TYPES = new Set([
  "compaction",
  "branch_summary",
  "pi-compact-recall",
  "pi-compact-auto-recall",
  "pi-compact-memory-hint",
  "pi-compact-resume",
]);

const entryMessage = (entry: SessionEntryLike): MessageLike | undefined => {
  if (entry.type === "message" && entry.message) {
    const message = entry.message as MessageLike;
    // Pi 0.86+ 把当前 prompt 与工具声明持久化为 role=system 的 message entry，
    // 它不是对话历史；记录它只会产生 text 为空、files 误抓 sections.cwd 的噪音命中。
    if (message.role === "system") return undefined;
    return message;
  }
  if (entry.type === "custom_message") {
    return { role: "custom", customType: String(entry.customType ?? "custom"), content: entry.content };
  }
  if (entry.type === "branch_summary" && typeof entry.summary === "string") {
    return { role: "custom", customType: "branch_summary", content: entry.summary };
  }
  if (entry.type === "compaction" && typeof entry.summary === "string") {
    return { role: "custom", customType: "compaction", content: entry.summary };
  }
  return undefined;
};

export const classifySource = (entry: SessionEntryLike, message?: MessageLike): SourceClass => {
  if (entry.type === "compaction" || entry.type === "branch_summary") return "derived";
  const customType = String(entry.customType ?? message?.customType ?? "");
  if (DERIVED_CUSTOM_TYPES.has(customType)) return "derived";
  return "primary";
};

type IdentifiedSessionEntry = SessionEntryLike & { id: string };

const recordFromMessage = (entry: IdentifiedSessionEntry, message: MessageLike, sourceOrdinal: number): HistoryRecord => {
  const customType = typeof message.customType === "string"
    ? message.customType
    : typeof entry.customType === "string" ? entry.customType : undefined;
  const thinkingText = thinkingOf(message.content);
  return {
    entryId: entry.id,
    parentId: entry.parentId,
    timestamp: entry.timestamp,
    kinds: messageKinds(message) as HistoryRecord["kinds"],
    text: messageText(message),
    files: messageFiles(message),
    toolCallIds: toolCallIds(message),
    sourceOrdinal,
    raw: entry,
    sourceClass: classifySource(entry, message),
    customType,
    thinkingText: thinkingText || undefined,
  };
};

export const entryToRecord = (entry: SessionEntryLike, sourceOrdinal: number): HistoryRecord | undefined => {
  if (!entry.id) return undefined;
  const message = entryMessage(entry);
  return message ? recordFromMessage(entry as IdentifiedSessionEntry, message, sourceOrdinal) : undefined;
};

export const recordsFromProjectedEntries = (entries: Array<{ sourceEntry: unknown; messages: unknown[] }>): HistoryRecord[] => {
  const result: HistoryRecord[] = [];
  let ordinal = 0;
  for (const projected of entries) {
    const sourceEntry = projected.sourceEntry as SessionEntryLike;
    const message = projected.messages.find((candidate: any) => candidate?.role !== "system") as MessageLike | undefined;
    if (!message || !sourceEntry.id) continue;
    result.push(recordFromMessage(sourceEntry as IdentifiedSessionEntry, message, ordinal));
    ordinal++;
  }
  return result;
};

export const recordsFromEntries = (entries: SessionEntryLike[], allowedIds?: Set<string>): HistoryRecord[] => {
  const result: HistoryRecord[] = [];
  let ordinal = 0;
  for (const entry of entries) {
    // 先按 active lineage 过滤，避免为兄弟分支构造 text/files/kinds。
    if (allowedIds && (typeof entry.id !== "string" || !allowedIds.has(entry.id))) continue;
    const record = entryToRecord(entry, ordinal);
    if (!record) continue;
    ordinal++;
    result.push(record);
  }
  return result;
};

export const activeEntryIds = (sessionManager: any): Set<string> => {
  try {
    const branch = sessionManager.getBranch?.();
    if (!Array.isArray(branch)) return new Set<string>();
    return new Set<string>(branch.map((entry: any) => entry.id).filter((id: unknown): id is string => typeof id === "string"));
  } catch {
    // 查询 active lineage 失败时宁可不召回，也不扩大到兄弟分支。
    return new Set<string>();
  }
};

const stableEntryProjection = (record: HistoryRecord) => ({
  id: record.entryId,
  parentId: record.parentId ?? null,
  timestamp: record.timestamp ?? null,
  raw: record.raw,
});

export const hashRecords = (records: HistoryRecord[]): string => createHash("sha256").update(JSON.stringify(records.map(stableEntryProjection))).digest("hex");

export const searchRecords = (records: HistoryRecord[], query: string, options: {
  file?: string;
  kind?: string;
  maxResults?: number;
  page?: number;
  sourceClass?: SourceClass | "all";
  /** 已规范化的检索词；提供时跳过 queryTerms，供自动召回高置信门控使用。手动检索不要传此字段。 */
  terms?: string[];
} = {}): SearchHit[] => {
  const terms = options.terms?.length
    ? [...new Set(options.terms.map((term) => term.toLocaleLowerCase()).filter((term) => term.length > 0))]
    : queryTerms(query);
  if (terms.length === 0 && !options.file) return [];
  const candidates = records.filter((record) => {
    if (options.sourceClass && options.sourceClass !== "all" && record.sourceClass !== options.sourceClass) return false;
    return true;
  });
  // df 只需要统计 query term 是否出现在记录中，与下面的 matched 共用一次 includes；
  // 不能对每条记录的全文重新分词，否则长历史或大 toolResult 会让搜索退化为秒级。
  const documentFrequency = new Map<string, number>();
  const matchedByRecord = new Map<HistoryRecord, string[]>();
  for (const record of candidates) {
    const lower = `${record.text}\n${record.files.join(" ")}`.toLocaleLowerCase();
    const matched = terms.filter((term) => lower.includes(term));
    matchedByRecord.set(record, matched);
    for (const term of matched) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }
  const hits: SearchHit[] = [];
  const firstById = new Map<string, string>();
  candidates.forEach((record) => {
    if (options.file && !record.files.some((file) => file.includes(options.file!))) return;
    if (options.kind && !record.kinds.includes(options.kind as any)) return;
    const matched = matchedByRecord.get(record) ?? [];
    if (terms.length > 0 && matched.length === 0) return;
    const fileBoost = options.file || record.files.some((file) => terms.some((term) => file.toLocaleLowerCase().includes(term))) ? 8 : 0;
    const lengthNorm = 1 / Math.log10(10 + record.text.length);
    const derivedWeight = record.sourceClass === "derived" ? 0.2 : 1;
    const score = (matched.reduce((total, term) => total + 1 + 4 / (documentFrequency.get(term) ?? 1), 0) + fileBoost) * lengthNorm * derivedWeight;
    const first = matched[0] ?? options.file ?? "";
    firstById.set(record.entryId, first);
    // snippet 只为最终分页结果生成，避免为所有命中记录各复制 700 字符。
    hits.push({ ...record, score, snippet: "" });
  });
  const page = Math.max(1, options.page ?? 1);
  const size = Math.max(1, options.maxResults ?? 8);
  const ranked = hits.sort((a, b) => b.score - a.score || b.sourceOrdinal - a.sourceOrdinal);
  const seenIds = new Set<string>();
  const seenText = new Set<string>();
  const unique: SearchHit[] = [];
  // 只需要凑够当前分页所需的唯一结果，不必为全部命中记录生成去重文本。
  const pageLimit = page * size;
  for (const hit of ranked) {
    if (unique.length >= pageLimit) break;
    const textKey = hit.text.slice(0, 960).replace(/\s+/g, " ").trim().slice(0, 240);
    if (seenIds.has(hit.entryId)) continue;
    if (textKey && seenText.has(textKey)) continue;
    seenIds.add(hit.entryId);
    if (textKey) seenText.add(textKey);
    unique.push(hit);
  }
  return unique.slice((page - 1) * size, pageLimit).map((hit) => ({
    ...hit,
    snippet: snippetAround(`${hit.text}\n${hit.files.join(" ")}`, firstById.get(hit.entryId) ?? options.file ?? "", 700),
  }));
};

export const listRecords = (records: HistoryRecord[], options: {
  page?: number;
  maxResults?: number;
  kind?: string;
  sourceClass?: SourceClass | "all";
} = {}): HistoryRecord[] => {
  const filtered = records.filter((record) => {
    if (options.sourceClass && options.sourceClass !== "all" && record.sourceClass !== options.sourceClass) return false;
    if (options.kind && !record.kinds.includes(options.kind as any)) return false;
    return true;
  });
  const page = Math.max(1, options.page ?? 1);
  const size = Math.max(1, options.maxResults ?? 8);
  return [...filtered].sort((left, right) => right.sourceOrdinal - left.sourceOrdinal).slice((page - 1) * size, page * size);
};

export const recordsForEntryIds = (records: HistoryRecord[], ids: string[]): HistoryRecord[] => {
  const wanted = new Set(ids);
  return records.filter((record) => wanted.has(record.entryId));
};

export const rawEntryText = (record: HistoryRecord, options?: { offset?: number; limit?: number }): string => {
  const full = JSON.stringify(record.raw, null, 2);
  if (options?.offset == null && options?.limit == null) return full;
  const offset = Math.max(0, options?.offset ?? 0);
  const limit = options?.limit;
  const body = limit == null ? full.slice(offset) : full.slice(offset, offset + Math.max(0, limit));
  return JSON.stringify({
    entryId: record.entryId,
    offset,
    limit: limit ?? null,
    totalChars: full.length,
    truncated: offset > 0 || offset + body.length < full.length,
    body,
  }, null, 2);
};
