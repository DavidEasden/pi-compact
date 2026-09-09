import { createHash } from "node:crypto";
import type { HistoryRecord, MessageLike, SearchHit, SessionEntryLike, SourceClass } from "../types.ts";
import { messageFiles, messageKinds, messageText, queryTerms, snippetAround, thinkingOf, toolCallIds } from "./content.ts";

const DERIVED_CUSTOM_TYPES = new Set([
  "compaction",
  "branch_summary",
  "pi-compact-recall",
  "pi-compact-auto-recall",
  "pi-compact-memory-hint",
]);

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

export const classifySource = (entry: SessionEntryLike, message?: MessageLike): SourceClass => {
  if (entry.type === "compaction" || entry.type === "branch_summary") return "derived";
  const customType = String(entry.customType ?? message?.customType ?? "");
  if (DERIVED_CUSTOM_TYPES.has(customType)) return "derived";
  return "primary";
};

export const entryToRecord = (entry: SessionEntryLike, sourceOrdinal: number): HistoryRecord | undefined => {
  if (!entry.id) return undefined;
  const message = entryMessage(entry);
  if (!message) return undefined;
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

export const contextEntryIds = (sessionManager: any): Set<string> => {
  try {
    const entries = sessionManager.buildContextEntries?.();
    if (!Array.isArray(entries)) return new Set<string>();
    return new Set<string>(entries.map((entry: any) => entry.id).filter((id: unknown): id is string => typeof id === "string"));
  } catch {
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
} = {}): SearchHit[] => {
  const terms = queryTerms(query);
  if (terms.length === 0 && !options.file) return [];
  const candidates = records.filter((record) => {
    if (options.sourceClass && options.sourceClass !== "all" && record.sourceClass !== options.sourceClass) return false;
    return true;
  });
  const documentFrequency = new Map<string, number>();
  const tokenSets = candidates.map((record) => new Set(queryTerms(`${record.text}\n${record.files.join(" ")}`)));
  for (const tokens of tokenSets) for (const token of tokens) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
  const hits: SearchHit[] = [];
  candidates.forEach((record) => {
    if (options.file && !record.files.some((file) => file.includes(options.file!))) return;
    if (options.kind && !record.kinds.includes(options.kind as any)) return;
    const haystack = `${record.text}\n${record.files.join(" ")}`;
    const lower = haystack.toLocaleLowerCase();
    const matched = terms.filter((term) => lower.includes(term));
    if (terms.length > 0 && matched.length === 0) return;
    const fileBoost = options.file || record.files.some((file) => terms.some((term) => file.toLocaleLowerCase().includes(term))) ? 8 : 0;
    const lengthNorm = 1 / Math.log10(10 + record.text.length);
    const derivedWeight = record.sourceClass === "derived" ? 0.2 : 1;
    const score = (matched.reduce((total, term) => total + 1 + 4 / (documentFrequency.get(term) ?? 1), 0) + fileBoost) * lengthNorm * derivedWeight;
    const first = matched[0] ?? options.file ?? "";
    hits.push({ ...record, score, snippet: snippetAround(haystack, first, 700) });
  });
  const page = Math.max(1, options.page ?? 1);
  const size = Math.max(1, options.maxResults ?? 8);
  const ranked = hits.sort((a, b) => b.score - a.score || b.sourceOrdinal - a.sourceOrdinal);
  const seenIds = new Set<string>();
  const seenText = new Set<string>();
  const unique: SearchHit[] = [];
  for (const hit of ranked) {
    const textKey = hit.text.replace(/\s+/g, " ").trim().slice(0, 240);
    if (seenIds.has(hit.entryId)) continue;
    if (textKey && seenText.has(textKey)) continue;
    seenIds.add(hit.entryId);
    if (textKey) seenText.add(textKey);
    unique.push(hit);
  }
  return unique.slice((page - 1) * size, page * size);
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
