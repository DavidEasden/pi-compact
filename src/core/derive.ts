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

export const derivedFactKey = (content: string): string => content.normalize("NFKC").replace(/\s+/g, " ").trim();

/** 只提取不需要语义推断的文件、命令、退出码和测试计数。 */
export const deriveFacts = (records: HistoryRecord[], windowSourceHash: string): DerivedDraft[] => {
  const drafts: DerivedDraft[] = [];
  const seen = new Set<string>();
  const push = (content: string, record: HistoryRecord, kind: "file" | "command" | "tests") => {
    const canonicalContent = derivedFactKey(content);
    const key = `${kind}\n${canonicalContent}`;
    if (seen.has(key)) return;
    seen.add(key);
    const recordId = `mem_rule_${contentHash(key).slice(0, 16)}`;
    drafts.push({
      recordId,
      payload: {
        kind: "derived",
        content: canonicalContent,
        scope: "project",
        status: "provisional",
        priority: "low",
        sourceEntryIds: [record.entryId],
        sourceHash: windowSourceHash,
        provenance: `rule:${kind}`,
      },
    });
  };

  for (const record of records) {
    if (record.sourceClass === "derived") continue;
    for (const file of record.files) push(`file: ${file}`, record, "file");
    if (!record.kinds.includes("bash") && !record.kinds.includes("tool_result")) continue;
    const raw = record.raw as SessionEntryLike;
    const command = raw?.message?.command;
    const exitCode = raw?.message?.exitCode;
    if (typeof command === "string" && command.trim()) {
      const exit = typeof exitCode === "number" ? ` exitCode=${exitCode}` : "";
      push(`command: ${command}${exit}`, record, "command");
    }
    const output = String(raw?.message?.output ?? record.text);
    const tests = testSummary(output);
    if (tests) push(tests, record, "tests");
  }
  return drafts.slice(0, 50);
};
