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

/** 只提取不需要语义推断的文件、命令、退出码和测试计数。 */
export const deriveFacts = (records: HistoryRecord[], windowSourceHash: string): DerivedDraft[] => {
  const drafts: DerivedDraft[] = [];
  const seen = new Set<string>();
  const push = (content: string, record: HistoryRecord, provenance: string) => {
    const key = `${content}\n${provenance}`;
    if (seen.has(key) || seen.has(content)) return;
    seen.add(key);
    seen.add(content);
    const recordId = `mem_rule_${contentHash(`${content}\n${provenance}`).slice(0, 16)}`;
    drafts.push({
      recordId,
      payload: {
        kind: "derived",
        content,
        scope: "project",
        status: "provisional",
        priority: "low",
        sourceEntryIds: [record.entryId],
        sourceHash: windowSourceHash,
        provenance,
      },
    });
  };

  for (const record of records) {
    if (record.sourceClass === "derived") continue;
    for (const file of record.files) push(`file: ${file}`, record, `rule:file:${record.entryId}`);
    if (!record.kinds.includes("bash") && !record.kinds.includes("tool_result")) continue;
    const raw = record.raw as SessionEntryLike;
    const command = raw?.message?.command;
    const exitCode = raw?.message?.exitCode;
    if (typeof command === "string" && command.trim()) {
      const exit = typeof exitCode === "number" ? ` exitCode=${exitCode}` : "";
      push(`command: ${command}${exit}`, record, `rule:command:${record.entryId}`);
    }
    const output = String(raw?.message?.output ?? record.text);
    const tests = testSummary(output);
    if (tests) push(tests, record, `rule:tests:${record.entryId}`);
  }
  return drafts.slice(0, 50);
};
