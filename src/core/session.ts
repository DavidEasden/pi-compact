import { createHash } from "node:crypto";
import type { HistoryRecord, MessageLike, SearchHit, SessionEntryLike } from "../types.ts";
import { messageFiles, messageKinds, messageText, queryTerms, toolCallIds } from "./content.ts";

const entryMessage = (entry: SessionEntryLike): MessageLike | undefined => {
  if (entry.type === "message" && entry.message) return entry.message as MessageLike;
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

export const entryToRecord = (entry: SessionEntryLike, sourceOrdinal: number): HistoryRecord | undefined => {
  if (!entry.id) return undefined;
  const message = entryMessage(entry);
  if (!message) return undefined;
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
  };
};

export const recordsFromEntries = (entries: SessionEntryLike[], allowedIds?: Set<string>): HistoryRecord[] => {
  const result: HistoryRecord[] = [];
  let ordinal = 0;
  for (const entry of entries) {
    const record = entryToRecord(entry, ordinal);
    if (!record) continue;
    ordinal++;
    if (allowedIds && !allowedIds.has(record.entryId)) continue;
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

export const searchRecords = (records: HistoryRecord[], query: string, options: { file?: string; kind?: string; maxResults?: number; page?: number } = {}): SearchHit[] => {
  const terms = queryTerms(query);
  if (terms.length === 0 && !options.file) return [];
  const documentFrequency = new Map<string, number>();
  const tokenSets = records.map((record) => new Set(queryTerms(`${record.text}\n${record.files.join(" ")}`)));
  for (const tokens of tokenSets) for (const token of tokens) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
  const hits: SearchHit[] = [];
  records.forEach((record) => {
    if (options.file && !record.files.some((file) => file.includes(options.file!))) return;
    if (options.kind && !record.kinds.includes(options.kind as any)) return;
    const haystack = `${record.text}\n${record.files.join(" ")}`;
    const lower = haystack.toLocaleLowerCase();
    const matched = terms.filter((term) => lower.includes(term));
    if (terms.length > 0 && matched.length === 0) return;
    const score = matched.reduce((total, term) => total + 1 + 4 / (documentFrequency.get(term) ?? 1), 0) + (options.file ? 8 : 0);
    const first = matched[0] ?? options.file ?? "";
    const position = lower.indexOf(first.toLocaleLowerCase());
    const start = Math.max(0, position - 180);
    hits.push({ ...record, score, snippet: haystack.slice(start, start + 700) });
  });
  const page = Math.max(1, options.page ?? 1);
  const size = Math.max(1, options.maxResults ?? 8);
  return hits.sort((a, b) => b.score - a.score || b.sourceOrdinal - a.sourceOrdinal).slice((page - 1) * size, page * size);
};

export const recordsForEntryIds = (records: HistoryRecord[], ids: string[]): HistoryRecord[] => {
  const wanted = new Set(ids);
  return records.filter((record) => wanted.has(record.entryId));
};

export const rawEntryText = (record: HistoryRecord): string => JSON.stringify(record.raw, null, 2);
