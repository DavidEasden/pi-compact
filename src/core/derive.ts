import type { HistoryRecord, MemoryCreatePayload, SessionEntryLike } from "../types.ts";
import { contentHash } from "./store.ts";

export interface DerivedDraft {
  recordId: string;
  payload: MemoryCreatePayload;
}

const testSummary = (output: string): string | undefined => {
  const passed = output.match(/\b(\d+)\s+(?:passed|passing)\b/i);
  const failed = output.match(/\b(\d+)\s+(?:failed|failing)\b/i);
  if (!passed && !failed) return undefined;
  return `tests: ${passed ? `${passed[1]} passed` : "unknown passed"}, ${failed ? `${failed[1]} failed` : "unknown failed"}`;
};

const CANDIDATE_RULES: Array<{ kind: "preference" | "constraint" | "decision"; durable: RegExp; explicit: RegExp }> = [
  { kind: "preference", durable: /(?:我(?:更)?(?:喜欢|偏好|习惯)|以后|今后|始终|默认|always|from now on|by default|every time)/i, explicit: /(?:我(?:更)?(?:喜欢|偏好|习惯|希望)|请(?:始终|优先|默认)|I (?:prefer|always|usually)|please always)/i },
  { kind: "constraint", durable: /(?:以后|今后|始终|任何情况下|本项目|这个项目|项目中|always|never|for this project|in this project|from now on)/i, explicit: /(?:必须|不得|禁止|不允许|不要|不能|只能|must(?: not| always)?|never|do not|don't|only use|avoid)/i },
  { kind: "decision", durable: /(?:本项目|这个项目|项目中|长期|默认|将继续|for this project|in this project|going forward|by default)/i, explicit: /(?:决定|采用|选用|选择|使用|decided to use|we will use|adopted)/i },
];
const SENSITIVE = /\b(?:api[_ -]?key|access[_ -]?token|password|secret|credential)\b/i;

const durableCandidates = (text: string): Array<{ kind: "preference" | "constraint" | "decision"; content: string }> => {
  const sentences = text.split(/(?<=[。！？；;])\s*|(?<=[.!?])\s+(?=[A-Z])|\n+/u).map((part) => part.trim()).filter(Boolean);
  const candidates: Array<{ kind: "preference" | "constraint" | "decision"; content: string }> = [];
  for (const sentence of sentences) {
    if (sentence.length > 240 || SENSITIVE.test(sentence)) continue;
    const rule = CANDIDATE_RULES.find(({ durable, explicit }) => durable.test(sentence) && explicit.test(sentence));
    if (rule) candidates.push({ kind: rule.kind, content: sentence });
  }
  return candidates;
};

export const derivedFactKey = (content: string): string => content.normalize("NFKC").replace(/\s+/g, " ").trim();

/** 仅从原文直接提取操作事实和带持续性标记的用户规则；所有候选均为 session provisional。 */
export const deriveFacts = (records: HistoryRecord[], windowSourceHash: string, sessionId: string): DerivedDraft[] => {
  const drafts: DerivedDraft[] = [];
  const seen = new Set<string>();
  const push = (content: string, record: HistoryRecord, memoryKind: "derived" | "preference" | "constraint" | "decision", ruleKind: string) => {
    const canonicalContent = derivedFactKey(content);
    const key = `${memoryKind}\n${canonicalContent}`;
    if (seen.has(key)) return;
    seen.add(key);
    const recordId = `mem_rule_${contentHash(`${sessionId}\n${key}`).slice(0, 16)}`;
    drafts.push({
      recordId,
      payload: {
        kind: memoryKind,
        content: canonicalContent,
        scope: "session",
        status: "provisional",
        priority: "low",
        sourceEntryIds: [record.entryId],
        sourceHash: windowSourceHash,
        provenance: `rule:${ruleKind}`,
      },
    });
  };

  for (const record of records) {
    if (record.sourceClass === "derived") continue;
    for (const file of record.files) push(`file: ${file}`, record, "derived", "file");
    if (record.kinds.includes("user")) {
      for (const candidate of durableCandidates(record.text)) {
        push(candidate.content, record, candidate.kind, candidate.kind);
      }
    }
    if (!record.kinds.includes("bash") && !record.kinds.includes("tool_result")) continue;
    const raw = record.raw as SessionEntryLike;
    const command = raw?.message?.command;
    const exitCode = raw?.message?.exitCode;
    if (typeof command === "string" && command.trim()) {
      const exit = typeof exitCode === "number" ? ` exitCode=${exitCode}` : "";
      push(`command: ${command}${exit}`, record, "derived", "command");
    }
    const output = String(raw?.message?.output ?? record.text);
    const tests = testSummary(output);
    if (tests) push(tests, record, "derived", "tests");
  }
  return drafts.slice(0, 50);
};
