export type CompactReason = "manual" | "threshold" | "overflow";
export type RecallScope = "active-lineage" | "all";
export type RecordKind = "user" | "assistant" | "tool_call" | "tool_result" | "bash" | "custom";
/** full=当前完整片段；hint=短提示；off=关闭。合法 autoRecallMode 优先于 autoRecall 布尔值。 */
export type AutoRecallMode = "full" | "hint" | "off";
export type SourceClass = "primary" | "derived";
export type MemoryKind = "fact" | "preference" | "constraint" | "decision" | "working" | "derived";
export type MemoryStatus = "provisional" | "active" | "pinned" | "superseded" | "resolved";
export type MemoryScope = "project" | "session" | "user";
export type MemoryAuthor = "user" | "model" | "rule";
export type MemoryPriority = "low" | "normal" | "high";
export type MemoryEventType = "create" | "supersede" | "pin" | "unpin" | "resolve";

export interface MemorySettings {
  enabled: boolean;
  pinnedInjection: boolean;
  /** 模型提议只能以 provisional 写入；即使为 false 也不会自动升级为 active/pinned。 */
  proposalsProvisionalOnly: boolean;
  hintMaxChars: number;
  deriveOnCompact: boolean;
}

export interface HistorySettings {
  autoRecallPrimaryOnly: boolean;
  excludeInContext: boolean;
}

export interface WindowSettings {
  manifest: boolean;
}

export interface PiCompactConfig {
  enabled: boolean;
  overrideDefaultCompaction: boolean;
  summaryMaxChars: number;
  autoRecall: boolean;
  autoRecallMode: AutoRecallMode;
  autoRecallMaxChars: number;
  recallMaxResults: number;
  recallMaxChars: number;
  debug: boolean;
  memory: MemorySettings;
  history: HistorySettings;
  window: WindowSettings;
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
  sourceClass: SourceClass;
  customType?: string;
  thinkingText?: string;
}

export interface SearchHit extends HistoryRecord {
  score: number;
  snippet: string;
}

export interface WindowManifest {
  windowId: string;
  parentWindowId?: string;
  keptEntryId: string;
  sourceCount: number;
  sourceHash: string;
  previousHash: string;
  sourceEntryIds: string[];
  reason: CompactReason;
  isSplitTurn: boolean;
  firstSourceEntryId?: string;
  lastSourceEntryId?: string;
  createdAt: string;
  sessionId?: string;
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
  /** checkpoint 文本字符数，不是 token。 */
  checkpointChars: number;
  summaryMaxChars: number;
  /** chars/4 向上取整，不是 provider usage。 */
  estimatedTokensAfter: number;
  window?: WindowManifest;
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

export interface MemoryRecord {
  id: string;
  kind: MemoryKind;
  content: string;
  scope: MemoryScope;
  status: MemoryStatus;
  priority: MemoryPriority;
  author: MemoryAuthor;
  sourceEntryIds: string[];
  sourceHash: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  pinned: boolean;
  sessionId?: string;
  provenance?: string;
  supersedes?: string;
  supersededBy?: string;
}

export interface MemoryCreatePayload {
  kind: MemoryKind;
  content: string;
  scope: MemoryScope;
  status: "provisional" | "active";
  priority: MemoryPriority;
  sourceEntryIds: string[];
  sourceHash: string;
  provenance?: string;
}

export interface MemorySupersedePayload {
  newRecordId: string;
  content: string;
  kind?: MemoryKind;
  scope?: MemoryScope;
  status?: "provisional" | "active";
  priority?: MemoryPriority;
  sourceEntryIds?: string[];
  sourceHash?: string;
  provenance?: string;
}

export interface MemoryResolvePayload {
  reason?: string;
}

export type MemoryEventPayload = MemoryCreatePayload | MemorySupersedePayload | MemoryResolvePayload | Record<string, never>;

export interface MemoryEvent {
  seq: number;
  ts: string;
  type: MemoryEventType;
  recordId: string;
  prevHash: string;
  hash: string;
  author: MemoryAuthor;
  sessionId?: string;
  payload: MemoryEventPayload;
}

export interface WindowEvent {
  seq: number;
  ts: string;
  type: "open";
  windowId: string;
  parentWindowId?: string;
  keptEntryId: string;
  sourceCount: number;
  sourceHash: string;
  previousHash: string;
  sourceEntryIds: string[];
  reason: CompactReason;
  isSplitTurn: boolean;
  firstSourceEntryId?: string;
  lastSourceEntryId?: string;
  sessionId?: string;
  prevHash: string;
  hash: string;
}
