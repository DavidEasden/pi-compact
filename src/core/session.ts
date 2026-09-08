import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { SessionRecord, HistoryRecord, RecallScope, SearchHit } from "../types.ts";
import { normalizeMessage, normalizeQueryTerms, clip } from "./content.ts";

export const readSessionRecords = (sessionFile: string): SessionRecord[] => {
  let text: string;
  try {
    text = readFileSync(sessionFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: SessionRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line) as SessionRecord); } catch { /* 损坏的行不影响其余历史 */ }
  }
  return records;
};

export const activeEntryIds = (sessionManager: any): Set<string> => {
  try {
    const branch = sessionManager.getBranch?.() ?? [];
    const ids = new Set(branch.map((entry: any) => entry.id).filter(Boolean));
    if (ids.size > 0) return ids;
  } catch { /* 使用全量 fallback */ }
  try {
    return new Set((sessionManager.getEntries?.() ?? []).map((entry: any) => entry.id).filter(Boolean));
  } catch {
    return new Set();
  }
};

export const historyRecords = (records: SessionRecord[], allowedIds?: Set<string>): HistoryRecord[] => {
  const result: HistoryRecord[] = [];
  let messageIndex = 0;
  for (const record of records) {
    if (record.type !== "message" || !record.message || !record.id) continue;
    const sourceIndex = messageIndex++;
    if (allowedIds && allowedIds.size > 0 && !allowedIds.has(record.id)) continue;
    result.push(...normalizeMessage(record.message, record.id, sourceIndex, record.timestamp));
  }
  return result;
};

export const sourceHash = (records: HistoryRecord[]): string => {
  const value = records.map(({ entryId, kind, text, toolName, files }) => ({ entryId, kind, text, toolName, files }));
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
};

const safeRegex = (query: string): RegExp | null => {
  try { return new RegExp(query, "i"); } catch { return null; }
};

export const searchHistory = (records: HistoryRecord[], query: string, options: { kind?: string; file?: string; maxResults?: number } = {}): SearchHit[] => {
  const terms = normalizeQueryTerms(query);
  const regex = /[|()[\]{}*+?^$\\]/.test(query) ? safeRegex(query) : null;
  const maxResults = options.maxResults ?? 8;
  const hits: SearchHit[] = [];
  for (const record of records) {
    if (options.kind && record.kind !== options.kind) continue;
    if (options.file && !record.files.some((file) => file.includes(options.file!))) continue;
    const haystack = `${record.text}\n${record.files.join(" ")}\n${record.toolName ?? ""}`;
    const lower = haystack.toLowerCase();
    const matched = regex ? regex.test(haystack) : terms.length > 0 && terms.some((term) => lower.includes(term));
    if (!matched) continue;
    const score = regex ? 1 : terms.reduce((sum, term) => sum + (lower.includes(term) ? (term.includes("/") || term.length > 7 ? 3 : 1) : 0), 0);
    const firstTerm = terms.find((term) => lower.includes(term));
    const position = firstTerm ? lower.indexOf(firstTerm) : 0;
    const start = Math.max(0, position - 120);
    hits.push({ ...record, score, snippet: clip(haystack.slice(start, start + 500), 500) });
  }
  return hits.sort((a, b) => b.score - a.score || b.sourceIndex - a.sourceIndex).slice(0, maxResults);
};

export const parseEntryIds = (records: SessionRecord[], ids: string[]): HistoryRecord[] => {
  const wanted = new Set(ids);
  return historyRecords(records).filter((record) => wanted.has(record.entryId));
};
