import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: any) => {
    if (part?.type === "text") return String(part.text ?? "");
    if (part?.type === "thinking") return String(part.thinking ?? "");
    if (part?.type === "toolCall") return `${part.name ?? "tool"}(${JSON.stringify(part.arguments ?? {})})`;
    return "";
  }).filter(Boolean).join("\n");
};

export const messageText = (message: any): string => {
  if (message?.role === "bashExecution") {
    return `$ ${message.command ?? ""}\n${message.output ?? ""}`;
  }
  if (message?.role === "toolResult") {
    return `[${message.toolName ?? "tool"}]\n${textOf(message.content)}`;
  }
  return textOf(message?.content);
};

const collectStrings = (value: unknown, out: string[]): void => {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === "path" || key === "filePath" || key === "file") {
        if (typeof item === "string") out.push(item);
      } else if (key === "args" || key === "arguments" || key === "input") {
        collectStrings(item, out);
      }
    }
  }
};

export const filesOf = (message: any): string[] => {
  const values: string[] = [];
  if (Array.isArray(message?.content)) {
    for (const part of message.content) {
      if (part?.type === "toolCall") collectStrings(part.arguments, values);
    }
  }
  if (message?.role === "bashExecution") {
    const matches = String(message.command ?? "").match(/(?:^|\s)([\w./-]+\.[A-Za-z0-9_-]+)(?=\s|$)/g) ?? [];
    values.push(...matches.map((item) => item.trim()));
  }
  return [...new Set(values.filter((item) => item.includes("/") || /\.[A-Za-z0-9_-]+$/.test(item)))];
};

export const toolCallsOf = (message: any): Array<{ name: string; args: string; files: string[] }> => {
  if (!Array.isArray(message?.content)) return [];
  return message.content.filter((part: any) => part?.type === "toolCall").map((part: any) => ({
    name: String(part.name ?? "tool"),
    args: JSON.stringify(part.arguments ?? {}),
    files: filesOf({ content: [part] }),
  }));
};

export const normalizeMessage = (message: AgentMessage, entryId: string, sourceIndex: number, timestamp?: string) => {
  const anyMessage = message as any;
  const role = String(anyMessage.role ?? "custom");
  const text = messageText(anyMessage);
  const files = filesOf(anyMessage);
  const tools = toolCallsOf(anyMessage);
  if (tools.length > 0) {
    return tools.map((tool) => ({ entryId, kind: "tool_call" as const, text: `${tool.name}(${tool.args})`, toolName: tool.name, files: [...new Set([...files, ...tool.files])], timestamp, sourceIndex }));
  }
  if (role === "toolResult") return [{ entryId, kind: "tool_result" as const, text, toolName: anyMessage.toolName, files, timestamp, sourceIndex }];
  if (role === "bashExecution") return [{ entryId, kind: "bash" as const, text, files, timestamp, sourceIndex }];
  if (role === "user") return [{ entryId, kind: "user" as const, text, files, timestamp, sourceIndex }];
  if (role === "assistant") return [{ entryId, kind: "assistant" as const, text, files, timestamp, sourceIndex }];
  return [{ entryId, kind: "custom" as const, text, files, timestamp, sourceIndex }];
};

export const clip = (text: string, max: number): string => text.length <= max ? text : `${text.slice(0, Math.max(0, max - 20))}\n[…已截断 ${text.length - max} 字符]`;

export const normalizeQueryTerms = (query: string): string[] => [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}_./-]+/u).filter((term) => term.length >= 2))];
