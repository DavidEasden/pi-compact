import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig } from "./config.ts";
import { clip } from "./core/content.ts";
import { activeEntryIds, historyRecords, parseEntryIds, readSessionRecords, searchHistory } from "./core/session.ts";

export const formatHits = (hits: ReturnType<typeof searchHistory>, title = "pi-compact 历史召回"): string => {
  if (hits.length === 0) return `${title}\n未找到匹配的历史记录。`;
  return [title, ...hits.map((hit) => {
    const files = hit.files.length > 0 ? `\n文件: ${hit.files.join(", ")}` : "";
    return `\n[${hit.entryId}] ${hit.kind}${hit.toolName ? `:${hit.toolName}` : ""}${files}\n${clip(hit.text, 1400)}\n片段: ${clip(hit.snippet, 500)}`;
  })].join("\n");
};

const parseArgs = (args: string): { query: string; file?: string; kind?: string; scope: "active-lineage" | "all"; ids?: string[] } => {
  let query = args.trim();
  let file: string | undefined;
  let kind: string | undefined;
  let scope: "active-lineage" | "all" = "active-lineage";
  let ids: string[] | undefined;
  const fileMatch = query.match(/(?:^|\s)file:([^\s]+)/i);
  if (fileMatch) { file = fileMatch[1]; query = query.replace(fileMatch[0], " "); }
  const kindMatch = query.match(/(?:^|\s)kind:(user|assistant|tool_call|tool_result|bash|custom)(?:\s|$)/i);
  if (kindMatch) { kind = kindMatch[1]; query = query.replace(kindMatch[0], " "); }
  const scopeMatch = query.match(/(?:^|\s)scope:(all|active-lineage)(?:\s|$)/i);
  if (scopeMatch) { scope = scopeMatch[1] as "all" | "active-lineage"; query = query.replace(scopeMatch[0], " "); }
  const idsMatch = query.match(/(?:^|\s)ids:([^\s]+)/i);
  if (idsMatch) { ids = idsMatch[1].split(",").filter(Boolean); query = query.replace(idsMatch[0], " "); }
  return { query: query.trim(), file, kind, scope, ids };
};

const getHits = (args: { query?: string; file?: string; kind?: string; scope?: "active-lineage" | "all"; entryIds?: string[] }, ctx: any) => {
  const sessionFile = ctx.sessionManager.getSessionFile?.();
  if (!sessionFile) return [];
  const raw = readSessionRecords(sessionFile);
  const allowed = args.scope === "all" ? undefined : activeEntryIds(ctx.sessionManager);
  const records = historyRecords(raw, allowed);
  if (args.entryIds && args.entryIds.length > 0) return parseEntryIds(raw, args.entryIds).slice(0, args.limit ?? 8).map((record) => ({ ...record, score: 1, snippet: clip(record.text, 500) }));
  return searchHistory(records, args.query ?? "", { file: args.file, kind: args.kind, maxResults: args.limit ?? 8 });
};

export const registerRecall = (pi: ExtensionAPI): void => {
  pi.registerTool({
    name: "pi_compact_recall",
    label: "Recall Pi history",
    description: "从未删除的 Pi session 原文中精确检索旧消息、工具调用、工具结果、命令和文件操作。不会调用 LLM 做二次摘要。",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "关键词或正则表达式" })),
      entryIds: Type.Optional(Type.Array(Type.String())),
      file: Type.Optional(Type.String()),
      kind: Type.Optional(Type.String()),
      scope: Type.Optional(Type.Union([Type.Literal("active-lineage"), Type.Literal("all")])),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
    }),
    async execute(_toolCallId: string, input: any, _signal: AbortSignal, _onUpdate: unknown, ctx: any) {
      const hits = getHits(input, ctx);
      return { content: [{ type: "text", text: formatHits(hits) }], details: { count: hits.length, source: "session-jsonl" } };
    },
  } as any);

  pi.registerCommand("pi-compact-recall", {
    description: "从 Pi session 原文中精确召回历史细节",
    handler: async (args: string, ctx: any) => {
      const parsed = parseArgs(args);
      const hits = getHits({ query: parsed.query, file: parsed.file, kind: parsed.kind, scope: parsed.scope, entryIds: parsed.ids }, ctx);
      const text = formatHits(hits);
      pi.sendMessage({ customType: "pi-compact-recall", content: text, display: true, details: { count: hits.length } }, { triggerTurn: true, deliverAs: "followUp" });
    },
  });
};
