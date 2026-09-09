import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig } from "./config.ts";
import { clip } from "./core/content.ts";
import { activeEntryIds, listRecords, rawEntryText, recordsForEntryIds, recordsFromEntries, searchRecords } from "./core/session.ts";
import type { HistoryRecord, SearchHit, SourceClass } from "./types.ts";

interface RecallInput {
  query?: string;
  entryIds?: string[];
  file?: string;
  kind?: string;
  scope?: "active-lineage" | "all";
  page?: number;
  limit?: number;
  raw?: boolean;
  action?: "list" | "search" | "read";
  offset?: number;
  rawLimit?: number;
  sourceClass?: SourceClass | "all";
}

export interface FormattedHits {
  text: string;
  truncated: boolean;
}

type HitLike = SearchHit | (HistoryRecord & { score: number; snippet: string });

const serializeRawEntry = (hit: HitLike, slice?: { offset?: number; limit?: number }): { entryId: string; body: string; ok: boolean } => {
  try {
    return { entryId: hit.entryId, body: rawEntryText(hit, slice), ok: true };
  } catch (error) {
    return {
      entryId: hit.entryId,
      ok: false,
      body: JSON.stringify({
        error: "pi-compact recall: failed to serialize entry",
        entryId: hit.entryId,
        message: error instanceof Error ? error.message : String(error),
      }, null, 2),
    };
  }
};

const omittedNote = (ids: string[]): string => (
  ids.length === 0 ? "" : `\n\n(omitted entry IDs: ${ids.join(", ")}; use a single entry ID to retrieve full JSON)`
);

const rawSliceOf = (input?: { offset?: number; limit?: number }): { offset?: number; limit?: number } | undefined => {
  if (!input || (input.offset == null && input.limit == null)) return undefined;
  return { offset: input.offset, limit: input.limit };
};

const formatRawHits = (hits: HitLike[], maxChars: number, allowOversizeSingle: boolean, slice?: { offset?: number; limit?: number }): FormattedHits => {
  if (hits.length === 1 && (allowOversizeSingle || slice)) {
    // 按单个 entry ID 请求的 raw entry：无分段时必须返回完整 JSON；提供 offset/rawLimit 时按字符窗口读取。
    const serialized = serializeRawEntry(hits[0], slice);
    return { text: serialized.body, truncated: !serialized.ok || (slice != null && JSON.parse(serialized.body).truncated === true) };
  }

  const blocks = hits.map((hit) => {
    const serialized = serializeRawEntry(hit, slice);
    return { entryId: serialized.entryId, body: `[entry ${serialized.entryId}]\n${serialized.body}` };
  });
  const header = `pi-compact recall (${hits.length} result(s))\n\n`;
  const parts: string[] = [];
  for (let index = 0; index < blocks.length; index++) {
    const afterIds = blocks.slice(index + 1).map((block) => block.entryId);
    const candidate = header + [...parts, blocks[index].body].join("\n\n") + omittedNote(afterIds);
    if (candidate.length <= maxChars) {
      parts.push(blocks[index].body);
      continue;
    }
    const omittedIds = blocks.slice(index).map((block) => block.entryId);
    if (parts.length === 0) {
      return {
        text: `pi-compact recall (${hits.length} result(s); 0 included)\n\nNo complete raw entry fit in the ${maxChars}-char budget. Use a single entry ID to retrieve full JSON.\nomitted entry IDs: ${omittedIds.join(", ")}`,
        truncated: true,
      };
    }
    return { text: header + parts.join("\n\n") + omittedNote(omittedIds), truncated: true };
  }
  return { text: header + parts.join("\n\n"), truncated: false };
};

const formatPrettyHits = (hits: HitLike[], maxChars: number): FormattedHits => {
  const blocks = hits.map((hit) => {
    const customType = hit.customType ? ` customType=${hit.customType}` : "";
    const sourceClass = hit.sourceClass === "derived" ? " sourceClass=derived" : "";
    return `[entry ${hit.entryId}] kinds=${hit.kinds.join(",")}${customType}${sourceClass} files=${hit.files.join(", ")}\n${clip(hit.text, 2000)}\nsource snippet: ${clip(hit.snippet, 600)}`;
  });
  const header = `pi-compact recall (${hits.length} result(s))\n\n`;
  const parts: string[] = [];
  for (let index = 0; index < blocks.length; index++) {
    const candidate = header + [...parts, blocks[index]].join("\n\n");
    if (candidate.length <= maxChars) {
      parts.push(blocks[index]);
      continue;
    }
    if (parts.length === 0) {
      const fallback = `pi-compact recall (${hits.length} result(s); 0 included)`;
      return { text: fallback.slice(0, maxChars), truncated: true };
    }
    return { text: header + parts.join("\n\n"), truncated: true };
  }
  return { text: header + parts.join("\n\n"), truncated: false };
};

export const formatRecallOutput = (
  hits: HitLike[],
  raw = false,
  maxChars = 16000,
  allowOversizeSingleRaw = false,
  rawSlice?: { offset?: number; limit?: number },
): FormattedHits => {
  if (hits.length === 0) return { text: "pi-compact recall: 未找到匹配的历史记录。", truncated: false };
  if (raw) return formatRawHits(hits, maxChars, allowOversizeSingleRaw, rawSliceOf(rawSlice));
  return formatPrettyHits(hits, maxChars);
};

export const formatHits = (
  hits: HitLike[],
  raw = false,
  maxChars = 16000,
  allowOversizeSingleRaw = false,
  rawSlice?: { offset?: number; limit?: number },
): string => formatRecallOutput(hits, raw, maxChars, allowOversizeSingleRaw, rawSlice).text;

const recallHits = (input: RecallInput, ctx: any): HitLike[] => {
  const entries = ctx.sessionManager.getEntries?.() ?? [];
  const allowed = input.scope === "all" ? undefined : activeEntryIds(ctx.sessionManager);
  let records = recordsFromEntries(entries, allowed);
  if (input.sourceClass === "primary" || input.sourceClass === "derived") {
    records = records.filter((record) => record.sourceClass === input.sourceClass);
  }
  if (input.action === "list" && !input.entryIds?.length) {
    const listed = listRecords(records, {
      page: input.page,
      maxResults: input.limit ?? 8,
      kind: input.kind,
      sourceClass: input.sourceClass,
    });
    return listed.map((record) => ({ ...record, score: 1, snippet: record.text }));
  }
  if (input.entryIds?.length || input.action === "read") {
    const matched = recordsForEntryIds(records, input.entryIds ?? []);
    const limited = input.raw === true && input.entryIds?.length === 1 ? matched : matched.slice(0, input.limit ?? 8);
    return limited.map((record) => ({ ...record, score: 1, snippet: record.text }));
  }
  return searchRecords(records, input.query ?? "", {
    file: input.file,
    kind: input.kind,
    page: input.page,
    maxResults: input.limit ?? 8,
    sourceClass: input.sourceClass,
  });
};

export const parseCommand = (args: string): RecallInput => {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const plain: string[] = [];
  const result: RecallInput = {};
  for (const token of tokens) {
    const separator = token.indexOf(":");
    if (separator <= 0) {
      if (token.toLowerCase() === "raw") result.raw = true;
      else if (token.toLowerCase() === "list") result.action = "list";
      else if (token.toLowerCase() === "read") result.action = "read";
      else plain.push(token);
      continue;
    }
    const key = token.slice(0, separator).toLowerCase();
    const value = token.slice(separator + 1);
    if (key === "file") result.file = value;
    else if (key === "kind") result.kind = value;
    else if (key === "scope" && (value === "all" || value === "active-lineage")) result.scope = value;
    else if (key === "ids") result.entryIds = value.split(",");
    else if (key === "page") result.page = Math.max(1, Number(value) || 1);
    else if (key === "limit") result.limit = Math.min(30, Math.max(1, Number(value) || 8));
    else if (key === "raw" && value === "true") result.raw = true;
    else if (key === "action" && (value === "list" || value === "search" || value === "read")) result.action = value;
    else if (key === "offset") result.offset = Math.max(0, Number(value) || 0);
    else if (key === "rawlimit") result.rawLimit = Math.max(1, Number(value) || 1);
    else if (key === "sourceclass" && (value === "primary" || value === "derived" || value === "all")) result.sourceClass = value;
    else plain.push(token);
  }
  result.query = plain.join(" ");
  return result;
};

const outputFor = (input: RecallInput, ctx: any) => {
  const config = loadConfig(ctx.cwd);
  const hits = recallHits(input, ctx);
  const sliced = input.offset != null || input.rawLimit != null;
  return {
    hits,
    formatted: formatRecallOutput(
      hits,
      input.raw === true,
      config.recallMaxChars,
      input.raw === true && input.entryIds?.length === 1 && !sliced,
      sliced ? { offset: input.offset, limit: input.rawLimit } : undefined,
    ),
  };
};

export const registerRecall = (pi: ExtensionAPI): void => {
  pi.registerTool({
    name: "pi_compact_recall",
    label: "Recall Pi session history",
    description: "从当前 Pi session 的原始 entries 精确恢复旧消息、工具调用、工具结果和命令。支持 list/search/read；长 raw 可用 offset 与 rawLimit 分段读取。默认只搜索当前 branch；scope=all 搜索整个 session。",
    promptSnippet: "按 entry ID、文件路径或关键词精确召回旧 session 原文；长条目请用 offset/rawLimit 分段读取",
    promptGuidelines: ["使用 pi_compact_recall 恢复压缩前的具体历史细节，不要假设压缩 checkpoint 包含全部原文。", "长 raw 默认不要整段灌入上下文，使用 offset 与 rawLimit 分段读取。"],
    parameters: Type.Object({
      query: Type.Optional(Type.String()),
      entryIds: Type.Optional(Type.Array(Type.String())),
      file: Type.Optional(Type.String()),
      kind: Type.Optional(Type.String()),
      scope: Type.Optional(Type.Union([Type.Literal("active-lineage"), Type.Literal("all")])),
      page: Type.Optional(Type.Integer({ minimum: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
      raw: Type.Optional(Type.Boolean()),
      action: Type.Optional(Type.Union([Type.Literal("list"), Type.Literal("search"), Type.Literal("read")])),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      rawLimit: Type.Optional(Type.Integer({ minimum: 1 })),
      sourceClass: Type.Optional(Type.Union([Type.Literal("primary"), Type.Literal("derived"), Type.Literal("all")])),
    }),
    async execute(_toolCallId: string, input: RecallInput, _signal: AbortSignal, _onUpdate: unknown, ctx: any) {
      const { hits, formatted } = outputFor(input, ctx);
      return {
        content: [{ type: "text", text: formatted.text }],
        details: { source: "session-entries", count: hits.length, chars: formatted.text.length, truncated: formatted.truncated },
      };
    },
  } as any);

  pi.registerCommand("pi-compact-recall", {
    description: "精确召回 Pi session 中的原始历史；支持 list/search/read 与 raw 分段读取",
    handler: async (args: string, ctx: any) => {
      const input = parseCommand(args);
      const { hits, formatted } = outputFor(input, ctx);
      pi.sendMessage({
        customType: "pi-compact-recall",
        content: formatted.text,
        display: true,
        details: { count: hits.length, chars: formatted.text.length, truncated: formatted.truncated },
      }, { triggerTurn: true, deliverAs: "followUp" });
    },
  });
};
