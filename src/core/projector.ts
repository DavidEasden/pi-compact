import type {
  MemoryAuthor,
  MemoryCreatePayload,
  MemoryEvent,
  MemoryEventType,
  MemoryKind,
  MemoryPriority,
  MemoryRecord,
  MemoryScope,
  MemoryStatus,
  MemorySupersedePayload,
} from "../types.ts";

const EVENT_TYPES = new Set<MemoryEventType>(["create", "supersede", "pin", "unpin", "resolve"]);
const AUTHORS = new Set<MemoryAuthor>(["user", "model", "rule"]);
const KINDS = new Set<MemoryKind>(["fact", "preference", "constraint", "decision", "working", "derived"]);
const SCOPES = new Set<MemoryScope>(["project", "session", "user"]);
const PRIORITIES = new Set<MemoryPriority>(["low", "normal", "high"]);
const CREATE_STATUSES = new Set<MemoryStatus>(["provisional", "active"]);

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

const asStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
};

export const isMemoryEvent = (value: unknown): value is MemoryEvent => {
  if (!isObject(value)) return false;
  if (!Number.isSafeInteger(value.seq) || (value.seq as number) < 1) return false;
  if (typeof value.ts !== "string" || typeof value.recordId !== "string" || value.recordId.length === 0) return false;
  if (typeof value.hash !== "string" || typeof value.prevHash !== "string") return false;
  if (typeof value.type !== "string" || !EVENT_TYPES.has(value.type as MemoryEventType)) return false;
  if (typeof value.author !== "string" || !AUTHORS.has(value.author as MemoryAuthor)) return false;
  if (value.sessionId !== undefined && typeof value.sessionId !== "string") return false;
  if (!isObject(value.payload)) return false;
  return true;
};

const validCreatePayload = (payload: Record<string, unknown>): payload is MemoryCreatePayload & Record<string, unknown> => (
  typeof payload.kind === "string" && KINDS.has(payload.kind as MemoryKind)
  && typeof payload.content === "string"
  && typeof payload.scope === "string" && SCOPES.has(payload.scope as MemoryScope)
  && typeof payload.status === "string" && CREATE_STATUSES.has(payload.status as MemoryStatus)
  && typeof payload.priority === "string" && PRIORITIES.has(payload.priority as MemoryPriority)
  && typeof payload.sourceHash === "string"
);

const validSupersedePayload = (payload: Record<string, unknown>): payload is MemorySupersedePayload & Record<string, unknown> => (
  typeof payload.newRecordId === "string" && payload.newRecordId.length > 0
  && typeof payload.content === "string"
);

const cloneRecord = (record: MemoryRecord): MemoryRecord => ({ ...record, sourceEntryIds: [...record.sourceEntryIds] });

/**
 * 纯函数：按 seq 折叠事件为当前记忆状态。
 * 重复 seq 以文件顺序首次出现为准；指向不存在或已终结记录的变更会被忽略，旧事件不能静默覆盖。
 */
export const projectMemories = (events: MemoryEvent[]): MemoryRecord[] => {
  const seenSeq = new Set<number>();
  const unique: MemoryEvent[] = [];
  for (const event of events) {
    if (!isMemoryEvent(event) || seenSeq.has(event.seq)) continue;
    seenSeq.add(event.seq);
    unique.push(event);
  }
  unique.sort((left, right) => left.seq - right.seq || left.ts.localeCompare(right.ts));

  const byId = new Map<string, MemoryRecord>();
  for (const event of unique) {
    if (event.type === "create") {
      if (byId.has(event.recordId) || !validCreatePayload(event.payload as Record<string, unknown>)) continue;
      const payload = event.payload as MemoryCreatePayload;
      byId.set(event.recordId, {
        id: event.recordId,
        kind: payload.kind,
        content: payload.content,
        scope: payload.scope,
        status: payload.status,
        priority: payload.priority,
        author: event.author,
        sourceEntryIds: asStringArray(payload.sourceEntryIds),
        sourceHash: payload.sourceHash,
        createdAt: event.ts,
        updatedAt: event.ts,
        version: 1,
        pinned: false,
        sessionId: event.sessionId,
        provenance: payload.provenance,
      });
      continue;
    }

    const current = byId.get(event.recordId);
    if (!current) continue;
    if (current.status === "superseded" || current.status === "resolved") continue;

    if (event.type === "pin") {
      current.pinned = true;
      current.status = "pinned";
      current.updatedAt = event.ts;
      continue;
    }
    if (event.type === "unpin") {
      current.pinned = false;
      if (current.status === "pinned") current.status = "active";
      current.updatedAt = event.ts;
      continue;
    }
    if (event.type === "resolve") {
      current.status = "resolved";
      current.pinned = false;
      current.updatedAt = event.ts;
      continue;
    }
    if (event.type === "supersede") {
      const payload = event.payload as Record<string, unknown>;
      if (!validSupersedePayload(payload) || byId.has(payload.newRecordId)) continue;
      const nextStatus = payload.status === "provisional" || payload.status === "active" ? payload.status : current.status === "provisional" ? "provisional" : "active";
      const next: MemoryRecord = {
        id: payload.newRecordId,
        kind: typeof payload.kind === "string" && KINDS.has(payload.kind as MemoryKind) ? payload.kind as MemoryKind : current.kind,
        content: payload.content,
        scope: typeof payload.scope === "string" && SCOPES.has(payload.scope as MemoryScope) ? payload.scope as MemoryScope : current.scope,
        status: nextStatus,
        priority: typeof payload.priority === "string" && PRIORITIES.has(payload.priority as MemoryPriority) ? payload.priority as MemoryPriority : current.priority,
        author: event.author,
        sourceEntryIds: payload.sourceEntryIds ? asStringArray(payload.sourceEntryIds) : [...current.sourceEntryIds],
        sourceHash: typeof payload.sourceHash === "string" ? payload.sourceHash : current.sourceHash,
        createdAt: event.ts,
        updatedAt: event.ts,
        version: current.version + 1,
        pinned: false,
        sessionId: event.sessionId ?? current.sessionId,
        provenance: typeof payload.provenance === "string" ? payload.provenance : current.provenance,
        supersedes: current.id,
      };
      current.status = "superseded";
      current.pinned = false;
      current.supersededBy = next.id;
      current.updatedAt = event.ts;
      byId.set(next.id, next);
    }
  }
  return [...byId.values()].map(cloneRecord);
};

export const liveMemories = (records: MemoryRecord[]): MemoryRecord[] => (
  records.filter((record) => record.status === "pinned" || record.status === "active" || record.status === "provisional")
);
