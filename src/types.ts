import type { AgentMessage } from "@earendil-works/pi-agent-core";

export type CompactReason = "manual" | "threshold" | "overflow";
export type RecallScope = "active-lineage" | "all";
export type RecordKind = "user" | "assistant" | "tool_call" | "tool_result" | "bash" | "custom";

export interface PiCompactConfig {
  enabled: boolean;
  overrideDefaultCompaction: boolean;
  keepRecentTokens: number;
  summaryMaxChars: number;
  recentUserTurns: number;
  autoRecall: boolean;
  autoRecallMaxChars: number;
  recallMaxResults: number;
  debug: boolean;
}

export interface HistoryRecord {
  entryId: string;
  kind: RecordKind;
  text: string;
  toolName?: string;
  files: string[];
  timestamp?: string;
  sourceIndex: number;
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
  generatedAt: string;
}

export interface SessionRecord {
  id?: string;
  type?: string;
  timestamp?: string;
  message?: AgentMessage;
  [key: string]: unknown;
}
