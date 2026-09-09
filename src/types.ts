export type CompactReason = "manual" | "threshold" | "overflow";
export type RecallScope = "active-lineage" | "all";
export type RecordKind = "user" | "assistant" | "tool_call" | "tool_result" | "bash" | "custom";

export interface PiCompactConfig {
  enabled: boolean;
  overrideDefaultCompaction: boolean;
  summaryMaxChars: number;
  autoRecall: boolean;
  autoRecallMaxChars: number;
  recallMaxResults: number;
  recallMaxChars: number;
  debug: boolean;
}

export interface HistoryRecord {
  entryId: string;
  parentId?: string | null;
  timestamp?: string;
  kinds: RecordKind[];
  text: string;
  files: string[];
  toolCallIds: string[];
  sourceOrdinal: number;
  raw: unknown;
}

export interface SearchHit extends HistoryRecord {
  score: number;
  snippet: string;
}

export interface CompactionDetails {
  compactor: "pi-compact";
  version: 1;
  reason: CompactReason;
  sourceEntryIds: string[];
  sourceHash: string;
  sourceRecordCount: number;
  keptEntryId: string;
  omittedRecordCount: number;
}

export interface SessionEntryLike {
  id?: string;
  parentId?: string | null;
  type?: string;
  timestamp?: string;
  message?: MessageLike;
  [key: string]: unknown;
}

export interface MessageLike {
  role?: string;
  content?: unknown;
  toolName?: string;
  toolCallId?: string;
  stopReason?: string;
  command?: string;
  output?: string;
  exitCode?: number;
  isError?: boolean;
  customType?: string;
  [key: string]: unknown;
}
