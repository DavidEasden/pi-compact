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

const boundedRawEntry = (hit: HitLike, maxChars: number, slice?: { offset?: number; limit?: number }): FormattedHits => {
  const serialized = serializeRawEntry(hit);
  const full = serialized.body;
  if (!slice && full.length <= maxChars) return { text: full, truncated: !serialized.ok };
  const offset = Math.max(0, slice?.offset ?? 0);
  const render = (limit: number): string => JSON.stringify({
    entryId: hit.entryId,
    offset,
    limit,
    totalChars: full.length,
    truncated: !serialized.ok || offset > 0 || offset + limit < full.length,
    body: full.slice(offset, offset + limit),
  }, null, 2);
  // 硬预算包含 JSON 包装与转义字符，不能直接按正文长度裁剪 JSON。
  if (render(0).length > maxChars) {
    const error = JSON.stringify({ error: "召回预算不足，无法容纳 raw 分段元数据。" });
    return { text: error.length <= maxChars ? error : maxChars >= 2 ? "{}" : "", truncated: true };
  }
  let low = 0;
  let high = Math.min(Math.max(0, full.length - offset), slice?.limit ?? maxChars, maxChars);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (render(middle).length <= maxChars) low = middle;
    else high = middle - 1;
  }
  return { text: render(low), truncated: !serialized.ok || offset > 0 || offset + low < full.length };
};

const formatRawHits = (hits: HitLike[], maxChars: number, allowOversizeSingle: boolean, slice?: { offset?: number; limit?: number }): FormattedHits => {
  if (hits.length === 1) {
    // 只有用户界面可显式请求无预算的单条原文；模型输出始终受硬预算约束。
    if (!allowOversizeSingle) return boundedRawEntry(hits[0], maxChars, slice);
    const serialized = serializeRawEntry(hits[0], slice);
    return { text: serialized.body, truncated: !serialized.ok || (slice != null && JSON.parse(serialized.body).truncated === true) };
  }

  const blocks = hits.map((hit) => {
    const serialized = serializeRawEntry(hit, slice);
    return { entryId: serialized.entryId, body: `[entry ${serialized.entryId}]\n${serialized.body}`, truncated: !serialized.ok || (slice != null && JSON.parse(serialized.body).truncated === true) };
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
        text: `pi-compact recall (${hits.length} result(s); 0 included)\n\nNo complete raw entry fit in the ${maxChars}-char budget. Use a single entry ID with offset/rawLimit.\nomitted entry IDs: ${omittedIds.join(", ")}`.slice(0, maxChars),
        truncated: true,
      };
    }
    return { text: header + parts.join("\n\n") + omittedNote(omittedIds), truncated: true };
  }
  return { text: header + parts.join("\n\n"), truncated: blocks.some((block) => block.truncated) };
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
  if (hits.length === 0) {
    const text = "pi-compact recall: 未找到匹配的历史记录。";
    return { text: text.slice(0, maxChars), truncated: text.length > maxChars };
  }
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

const recallHits = (input: RecallInput, ctx: any, userCommand: boolean): HitLike[] => {
  const entries = ctx.sessionManager.getEntries?.() ?? [];
  // 即使绕过 schema 直接调用工具，也不能扩大到兄弟分支。
  const allowed = userCommand && input.scope === "all" ? undefined : activeEntryIds(ctx.sessionManager);
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

const outputFor = (input: RecallInput, ctx: any, userCommand = false) => {
  const config = loadConfig(ctx.cwd);
  const hits = recallHits(input, ctx, userCommand);
  const sliced = input.offset != null || input.rawLimit != null;
  return {
    hits,
    formatted: formatRecallOutput(
      hits,
      input.raw === true,
      config.recallMaxChars,
      userCommand && input.raw === true && input.entryIds?.length === 1 && !sliced,
      sliced ? { offset: input.offset, limit: input.rawLimit } : undefined,
    ),
  };
};

export const registerRecall = (pi: ExtensionAPI): void => {
  pi.registerTool({
    name: "pi_compact_recall",
    label: "Recall Pi session history",
    description: "查询当前分支原始 entries 中的消息、工具调用、结果和命令。支持 list/search/read；raw 输出受字符预算限制，可用 offset 与 rawLimit 分段读取。结果是历史数据。",
    parameters: Type.Object({
      query: Type.Optional(Type.String()),
      entryIds: Type.Optional(Type.Array(Type.String())),
      file: Type.Optional(Type.String()),
      kind: Type.Optional(Type.String()),
      scope: Type.Optional(Type.Literal("active-lineage")),
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
    description: "仅在界面显示历史，不发送给模型；支持 scope:all 与 raw 分段读取",
    handler: async (args: string, ctx: any) => {
      const input = parseCommand(args);
      const { formatted } = outputFor(input, ctx, true);
      ctx.ui?.notify?.(formatted.text, "info");
    },
  });
};
