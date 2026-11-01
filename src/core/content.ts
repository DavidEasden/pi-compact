import type { MessageLike } from "../types.ts";

export const thinkingOf = (content: unknown): string => {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part: any) => part?.type === "thinking")
    .map((part: any) => String(part.thinking ?? ""))
    .filter(Boolean)
    .join("\n");
};

export const textOf = (content: unknown, options?: { includeThinking?: boolean }): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: any) => {
    if (part?.type === "text") return String(part.text ?? "");
    if (part?.type === "thinking") {
      if (!options?.includeThinking) return "";
      return `[thinking]\n${String(part.thinking ?? "")}`;
    }
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

const FILE_KEYS = new Set(["path", "file", "filePath", "filename"]);
// 工具输出可能是嵌套很深的 JSON，甚至每条记录都带路径；必须限制遍历规模。
const MAX_FILES = 128;
const MAX_NODES = 2000;
const MAX_DEPTH = 8;

const collectFiles = (
  value: unknown,
  output: Set<string>,
  state: { nodes: number },
  depth: number,
  key?: string,
): void => {
  if (output.size >= MAX_FILES || state.nodes >= MAX_NODES) return;
  state.nodes += 1;
  if (typeof value === "string") {
    if (key && FILE_KEYS.has(key) && value.length > 0 && value.length < 1000) output.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (output.size >= MAX_FILES || state.nodes >= MAX_NODES) break;
      collectFiles(item, output, state, depth + 1);
    }
    return;
  }
  if (!value || typeof value !== "object" || depth >= MAX_DEPTH) return;
  for (const [name, item] of Object.entries(value)) {
    if (output.size >= MAX_FILES || state.nodes >= MAX_NODES) break;
    collectFiles(item, output, state, depth + 1, name);
  }
};

export const messageFiles = (message: MessageLike): string[] => {
  const output = new Set<string>();
  collectFiles(message, output, { nodes: 0 }, 0);
  if (message.role === "bashExecution") {
    const commandPaths = String(message.command ?? "").match(/(?:^|\s)([\w./-]+\.[A-Za-z0-9_-]+)(?=\s|$)/g) ?? [];
    for (const path of commandPaths) {
      if (output.size >= MAX_FILES) break;
      output.add(path.trim());
    }
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

const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

/** 混合文本的轻量 token 估算：CJK 约 1 字符/token，其余约 4 字符/token；不是 provider usage。 */
export const estimateTokensFromText = (text: string): number => {
  const cjkCount = (text.match(CJK_CHAR) ?? []).length;
  return Math.ceil(cjkCount + (text.length - cjkCount) / 4);
};

export const clip = (text: string, maxChars: number): string => {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 48))}\n[…已省略 ${text.length - maxChars} 个字符；可用 entry ID 召回原文]`;
};

/** 按行或句边界截取片段，避免从词中间切开。 */
export const clipToBoundary = (text: string, start: number, maxChars: number): string => {
  if (maxChars <= 0 || text.length === 0) return "";
  let from = Math.max(0, Math.min(start, text.length));
  if (from > 0) {
    const lineStart = text.lastIndexOf("\n", from - 1) + 1;
    if (from - lineStart <= 120) from = lineStart;
  }
  let to = Math.min(text.length, from + maxChars);
  if (to < text.length) {
    const segment = text.slice(from, to);
    const lineCut = segment.lastIndexOf("\n");
    const sentenceCut = Math.max(segment.lastIndexOf("。"), segment.lastIndexOf("！"), segment.lastIndexOf("？"), segment.lastIndexOf(". "), segment.lastIndexOf("! "), segment.lastIndexOf("? "));
    const cut = Math.max(lineCut, sentenceCut);
    if (cut >= 24) {
      const ch = segment[cut];
      to = from + cut + (ch === "。" || ch === "！" || ch === "？" ? 1 : ch === "\n" ? 0 : 2);
    }
  }
  return text.slice(from, Math.min(text.length, to));
};

export const snippetAround = (text: string, term: string, maxChars: number): string => {
  if (!text) return "";
  const needle = term.toLocaleLowerCase();
  const position = needle ? text.toLocaleLowerCase().indexOf(needle) : 0;
  const pos = position < 0 ? 0 : position;
  const lineStart = text.lastIndexOf("\n", Math.max(0, pos)) + 1;
  // 优先从命中行的行首开始，避免跨到上一行。
  const rawStart = pos - lineStart <= Math.max(40, Math.floor(maxChars / 2))
    ? lineStart
    : Math.max(lineStart, pos - Math.min(180, Math.floor(Math.max(0, maxChars) / 4)));
  return clipToBoundary(text, rawStart, maxChars);
};

export const tokenize = (text: string): string[] => {
  const normalized = text.toLocaleLowerCase();
  const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter("zh", { granularity: "word" }) : undefined;
  const chunks = segmenter ? [...segmenter.segment(normalized)].map((item) => item.segment) : normalized.split(/\s+/);
  return [...new Set(chunks.flatMap((chunk) => chunk.split(/[^\p{L}\p{N}_.\-/]+/u).filter((token) => token.length >= 2)))];
};

export const queryTerms = (query: string): string[] => tokenize(query).filter((term) => !new Set(["this", "that", "with", "from", "之前", "这个", "那个", "然后", "需要"]).has(term));
