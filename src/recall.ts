import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig } from "./config.ts";
import { clip } from "./core/content.ts";
import { activeEntryIds, rawEntryText, recordsForEntryIds, recordsFromEntries, searchRecords } from "./core/session.ts";

interface RecallInput {
  query?: string;
  entryIds?: string[];
  file?: string;
  kind?: string;
  scope?: "active-lineage" | "all";
  page?: number;
  limit?: number;
  raw?: boolean;
}

export const formatHits = (hits: ReturnType<typeof searchRecords>, raw = false, maxChars = 16000): string => {
  if (hits.length === 0) return "pi-compact recall: 未找到匹配的历史记录。";
  const chunks = hits.map((hit) => raw
    ? `[entry ${hit.entryId}]\n${rawEntryText(hit)}`
    : `[entry ${hit.entryId}] kinds=${hit.kinds.join(",")} files=${hit.files.join(", ")}\n${clip(hit.text, 2000)}\nsource snippet: ${clip(hit.snippet, 600)}`);
  return `pi-compact recall (${hits.length} result(s))\n\n${chunks.join("\n\n")}`.slice(0, maxChars);
};

const recallHits = (input: RecallInput, ctx: any) => {
  const entries = ctx.sessionManager.getEntries?.() ?? [];
  const allowed = input.scope === "all" ? undefined : activeEntryIds(ctx.sessionManager);
  const records = recordsFromEntries(entries, allowed);
  if (input.entryIds?.length) return recordsForEntryIds(records, input.entryIds).slice(0, input.limit ?? 8).map((record) => ({ ...record, score: 1, snippet: record.text }));
  return searchRecords(records, input.query ?? "", {
    file: input.file,
    kind: input.kind,
    page: input.page,
    maxResults: input.limit ?? 8,
  });
};

const parseCommand = (args: string): RecallInput => {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const plain: string[] = [];
  const result: RecallInput = {};
  for (const token of tokens) {
    const separator = token.indexOf(":");
    if (separator <= 0) {
      if (token.toLowerCase() === "raw") result.raw = true;
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
    else plain.push(token);
  }
  result.query = plain.join(" ");
  return result;
};

export const registerRecall = (pi: ExtensionAPI): void => {
  pi.registerTool({
    name: "pi_compact_recall",
    label: "Recall Pi session history",
    description: "从当前 Pi session 的原始 entries 精确恢复旧消息、工具调用、工具结果和命令。默认只搜索当前 branch；scope=all 搜索整个 session。",
    promptSnippet: "按 entry ID、文件路径或关键词精确召回旧 session 原文",
    promptGuidelines: ["使用 pi_compact_recall 恢复压缩前的具体历史细节，不要假设压缩 checkpoint 包含全部原文。"],
    parameters: Type.Object({
      query: Type.Optional(Type.String()),
      entryIds: Type.Optional(Type.Array(Type.String())),
      file: Type.Optional(Type.String()),
      kind: Type.Optional(Type.String()),
      scope: Type.Optional(Type.Union([Type.Literal("active-lineage"), Type.Literal("all")])),
      page: Type.Optional(Type.Integer({ minimum: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
      raw: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId: string, input: RecallInput, _signal: AbortSignal, _onUpdate: unknown, ctx: any) {
      const config = loadConfig(ctx.cwd);
      const hits = recallHits(input, ctx);
      return { content: [{ type: "text", text: formatHits(hits, input.raw === true, config.recallMaxChars) }], details: { source: "session-entries", count: hits.length } };
    },
  } as any);

  pi.registerCommand("pi-compact-recall", {
    description: "精确召回 Pi session 中的原始历史",
    handler: async (args: string, ctx: any) => {
      const input = parseCommand(args);
      const config = loadConfig(ctx.cwd);
      const hits = recallHits(input, ctx);
      pi.sendMessage({ customType: "pi-compact-recall", content: formatHits(hits, input.raw === true, config.recallMaxChars), display: true, details: { count: hits.length } }, { triggerTurn: true, deliverAs: "followUp" });
    },
  });
};
