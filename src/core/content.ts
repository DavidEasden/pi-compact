import type { MessageLike } from "../types.ts";

export const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: any) => {
    if (part?.type === "text") return String(part.text ?? "");
    if (part?.type === "thinking") return `[thinking]\n${String(part.thinking ?? "")}`;
    if (part?.type === "toolCall") return `${String(part.name ?? "tool")}(${JSON.stringify(part.arguments ?? {})})`;
    if (part?.type === "image") return `[image:${String(part.mimeType ?? "unknown")}]`;
    return `[${String(part?.type ?? "content")}]`;
  }).filter(Boolean).join("\n");
};

export const messageText = (message: MessageLike): string => {
  if (message.role === "bashExecution") return `$ ${message.command ?? ""}\n${message.output ?? ""}`;
  if (message.role === "toolResult") return `[${message.toolName ?? "tool"}]\n${textOf(message.content)}`;
  if (message.role === "custom") return `[${message.customType ?? "custom"}]\n${textOf(message.content)}`;
  return textOf(message.content);
};

const fileKeys = new Set(["path", "file", "filePath", "filename", "cwd"]);
const collectFiles = (value: unknown, output: Set<string>, key?: string): void => {
  if (typeof value === "string") {
    if (key && fileKeys.has(key) && value.length < 1000) output.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectFiles(item, output);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [name, item] of Object.entries(value)) collectFiles(item, output, name);
};

export const messageFiles = (message: MessageLike): string[] => {
  const output = new Set<string>();
  collectFiles(message, output);
  if (message.role === "bashExecution") {
    const commandPaths = String(message.command ?? "").match(/(?:^|\s)([\w./-]+\.[A-Za-z0-9_-]+)(?=\s|$)/g) ?? [];
    for (const path of commandPaths) output.add(path.trim());
  }
  return [...output].filter((file) => file !== "." && file !== ".." && !file.startsWith("http"));
};

export const toolCallIds = (message: MessageLike): string[] => {
  if (!Array.isArray(message.content)) return [];
  return message.content.filter((part: any) => part?.type === "toolCall" && typeof part.id === "string").map((part: any) => part.id);
};

export const messageKinds = (message: MessageLike): string[] => {
  if (message.role === "user") return ["user"];
  if (message.role === "assistant") return ["assistant", ...(Array.isArray(message.content) && message.content.some((part: any) => part?.type === "toolCall") ? ["tool_call"] : [])];
  if (message.role === "toolResult") return ["tool_result"];
  if (message.role === "bashExecution") return ["bash"];
  return ["custom"];
};

/** Pi estimateTokens 启发式：字符数 / 4 向上取整。这不是 provider usage。 */
export const estimateTokensFromChars = (charCount: number): number => Math.ceil(Math.max(0, charCount) / 4);

export const clip = (text: string, maxChars: number): string => {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 48))}\n[…已省略 ${text.length - maxChars} 个字符；可用 entry ID 召回原文]`;
};

export const tokenize = (text: string): string[] => {
  const normalized = text.toLocaleLowerCase();
  const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter("zh", { granularity: "word" }) : undefined;
  const chunks = segmenter ? [...segmenter.segment(normalized)].map((item) => item.segment) : normalized.split(/\s+/);
  return [...new Set(chunks.flatMap((chunk) => chunk.split(/[^\p{L}\p{N}_.\-/]+/u).filter((token) => token.length >= 2)))];
};

export const queryTerms = (query: string): string[] => tokenize(query).filter((term) => !new Set(["this", "that", "with", "from", "之前", "这个", "那个", "然后", "需要"]).has(term));
