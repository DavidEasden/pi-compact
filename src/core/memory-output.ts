import type { MemoryRecord } from "../types.ts";

/**
 * memory 工具的硬总输出预算（字符，不是 token）。search 与 read 的所有文本输出都不得超过它，
 * 避免单次工具调用把无界内容灌进上下文。固定常量，不新增配置项。
 */
export const MEMORY_TOOL_MAX_CHARS = 16000;

/** read 未显式给 limit 时的默认段长；显式 limit 过大时仍会按硬预算收紧。 */
export const MEMORY_READ_DEFAULT_CHARS = 4000;

/** search 单条摘要的内容字符上限；整段输出再受 MEMORY_TOOL_MAX_CHARS 约束。 */
export const MEMORY_SEARCH_ENTRY_CHARS = 600;

/** 元数据降级上限：sourceEntryIds 可能来自无界的模型输入，不能整段复制进输出。 */
const METADATA_MAX_IDS = 64;
const METADATA_MAX_ID_CHARS = 4096;
const METADATA_MAX_STRING_CHARS = 512;

const boundedString = (value: string | undefined, max: number): { value: string | undefined; truncated: boolean } => {
  if (value === undefined || value.length <= max) return { value, truncated: false };
  return { value: value.slice(0, max), truncated: true };
};

interface BoundedMetadata {
  metadata: Record<string, unknown>;
  truncated: boolean;
}

/** 把记录元数据裁剪到有界大小；sourceEntryIds 按条数与总字符双重限制，超出的部分显式标注省略条数。 */
const boundMetadata = (record: MemoryRecord): BoundedMetadata => {
  let truncated = false;
  const ids: string[] = [];
  let idChars = 0;
  for (const id of record.sourceEntryIds) {
    if (ids.length >= METADATA_MAX_IDS || idChars + id.length > METADATA_MAX_ID_CHARS) {
      truncated = true;
      break;
    }
    ids.push(id);
    idChars += id.length;
  }
  const omittedIds = record.sourceEntryIds.length - ids.length;
  const provenance = boundedString(record.provenance, METADATA_MAX_STRING_CHARS);
  const sessionId = boundedString(record.sessionId, METADATA_MAX_STRING_CHARS);
  truncated = truncated || provenance.truncated || sessionId.truncated;

  const metadata: Record<string, unknown> = {
    id: record.id,
    kind: record.kind,
    scope: record.scope,
    status: record.status,
    priority: record.priority,
    author: record.author,
    sourceEntryIds: ids,
    sourceHash: record.sourceHash,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    version: record.version,
    pinned: record.pinned,
  };
  if (omittedIds > 0) metadata.sourceEntryIdsOmitted = omittedIds;
  if (sessionId.value !== undefined) metadata.sessionId = sessionId.value;
  if (provenance.value !== undefined) metadata.provenance = provenance.value;
  if (record.supersedes !== undefined) metadata.supersedes = record.supersedes;
  if (record.supersededBy !== undefined) metadata.supersededBy = record.supersededBy;
  return { metadata, truncated };
};

/** 兜底降级：仅保留少量不可省略字段，保证即便是异常巨大的元数据也能产出有界有效 JSON。 */
const minimalMetadata = (record: MemoryRecord): Record<string, unknown> => ({
  id: record.id.slice(0, METADATA_MAX_STRING_CHARS),
  kind: record.kind,
  scope: record.scope,
  status: record.status,
  sourceEntryIds: [],
  sourceHash: record.sourceHash.slice(0, METADATA_MAX_STRING_CHARS),
});

export interface MemoryReadResult {
  text: string;
  truncated: boolean;
  nextOffset?: number;
  metadataTruncated: boolean;
}

const renderRead = (
  metadata: Record<string, unknown>,
  offset: number,
  totalChars: number,
  metadataTruncated: boolean,
  body: string,
  nextOffset: number,
  truncated: boolean,
): string => {
  const payload: Record<string, unknown> = { ...metadata, content: body, offset, totalChars, truncated };
  if (truncated) payload.nextOffset = nextOffset;
  if (metadataTruncated) payload.metadataTruncated = true;
  return JSON.stringify(payload, null, 2);
};

/**
 * 读取单条记忆：在 MEMORY_TOOL_MAX_CHARS 硬预算内返回有效 JSON。
 * 预算同时包含元数据与字符串转义，因此对正文长度做二分裁剪；结果带 truncated/nextOffset 便于继续分段。
 */
export const formatMemoryRead = (record: MemoryRecord, options?: { offset?: number; limit?: number }): MemoryReadResult => {
  const offset = Math.max(0, Math.floor(options?.offset ?? 0));
  const requested = options?.limit == null ? MEMORY_READ_DEFAULT_CHARS : Math.max(1, Math.floor(options.limit));
  const totalChars = record.content.length;
  const ceiling = Math.min(requested, Math.max(0, totalChars - offset), MEMORY_TOOL_MAX_CHARS);

  let metadata = boundMetadata(record);
  let metadataTruncated = metadata.truncated;
  // 除元数据外至少为下一个正文字符留空间，避免 nextOffset 停留原处而无法继续读取。
  if (renderRead(metadata.metadata, offset, totalChars, metadataTruncated, record.content.slice(offset, offset + 1), offset + 1, offset < totalChars).length > MEMORY_TOOL_MAX_CHARS) {
    metadata = { metadata: minimalMetadata(record), truncated: true };
    metadataTruncated = true;
  }

  let low = 0;
  let high = ceiling;
  let best = 0;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const body = record.content.slice(offset, offset + mid);
    if (renderRead(metadata.metadata, offset, totalChars, metadataTruncated, body, offset + mid, offset + mid < totalChars).length <= MEMORY_TOOL_MAX_CHARS) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  const body = record.content.slice(offset, offset + best);
  const nextOffset = offset + best;
  const truncated = nextOffset < totalChars;
  return { text: renderRead(metadata.metadata, offset, totalChars, metadataTruncated, body, nextOffset, truncated), truncated, nextOffset, metadataTruncated };
};

export interface MemorySearchResult {
  text: string;
  shown: number;
  truncated: boolean;
  nextOffset?: number;
}

/**
 * 搜索结果：先把每条记录压成有界摘要，再把整段输出收紧到 MEMORY_TOOL_MAX_CHARS。
 * 结果带 truncated/nextOffset（已展示条数）便于继续翻页。
 */
export const formatMemorySearch = (records: MemoryRecord[], options?: { header?: string }): MemorySearchResult => {
  const header = options?.header ?? `pi-compact memory (${records.length})`;
  const entryFor = (record: MemoryRecord): string => {
    const title = `- [${record.id}] ${record.status} ${record.kind} prio=${record.priority} author=${record.author} v${record.version}${record.supersedes ? ` supersedes=${record.supersedes}` : ""}`;
    const snippet = record.content.length > MEMORY_SEARCH_ENTRY_CHARS
      ? `${record.content.slice(0, MEMORY_SEARCH_ENTRY_CHARS)}\n  …[本条已截断，共 ${record.content.length} 字符；用 pi_memory_read 读取 ${record.id}]`
      : record.content;
    return `${title}\n  ${snippet}`;
  };
  const trailer = "\n…[输出已截断；用 pi_memory_read 读取条目，或按结果 details.nextOffset 继续搜索]";
  const render = (entries: string[], remaining: number): string => (
    `${header}${entries.map((entry) => `\n${entry}`).join("")}${remaining > 0 ? trailer : ""}`
  );

  const entries: string[] = [];
  let clippedEntry = false;
  for (const record of records) {
    const candidate = [...entries, entryFor(record)];
    if (render(candidate, records.length - candidate.length).length > MEMORY_TOOL_MAX_CHARS) break;
    entries.push(candidate[candidate.length - 1]);
  }
  if (entries.length === 0 && records.length > 0) {
    const room = Math.max(0, MEMORY_TOOL_MAX_CHARS - header.length - trailer.length - 1);
    entries.push(entryFor(records[0]).slice(0, room));
    clippedEntry = true;
  }

  const shown = entries.length;
  const remaining = records.length - shown;
  return {
    text: render(entries, remaining),
    shown,
    truncated: clippedEntry || remaining > 0 || records.slice(0, shown).some((record) => record.content.length > MEMORY_SEARCH_ENTRY_CHARS),
    ...(remaining > 0 ? { nextOffset: shown } : {}),
  };
};
