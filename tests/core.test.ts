import assert from "node:assert/strict";
import type { SessionEntryLike } from "../src/types.ts";
import test from "node:test";
import { buildDetails, renderLedger } from "../src/core/ledger.ts";
import { messageFiles, messageText } from "../src/core/content.ts";
import { isSafeCut } from "../src/hooks.ts";
import { activeEntryIds, entryToRecord, hashRecords, recordsFromEntries, searchRecords } from "../src/core/session.ts";

const entries: SessionEntryLike[] = [
  { type: "message", id: "u1", parentId: null, timestamp: "2024-01-01T00:00:00Z", message: { role: "user", content: "修复 src/auth/session.ts 的 token 刷新问题" } },
  { type: "message", id: "a1", parentId: "u1", timestamp: "2024-01-01T00:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "我会先检查 session 实现" }, { type: "toolCall", id: "call1", name: "read", arguments: { path: "src/auth/session.ts" } }] } },
  { type: "message", id: "t1", parentId: "a1", timestamp: "2024-01-01T00:00:02Z", message: { role: "toolResult", toolCallId: "call1", toolName: "read", content: [{ type: "text", text: "refreshToken() 缺少调用" }], isError: false } },
  { type: "message", id: "b1", parentId: "t1", timestamp: "2024-01-01T00:00:03Z", message: { role: "bashExecution", command: "npm test", output: "failed: timeout", exitCode: 1 } },
];

test("从真实 session entry 确定性提取记录", () => {
  const records = recordsFromEntries(entries);
  assert.equal(records.length, 4);
  assert.deepEqual(records[1].kinds, ["assistant", "tool_call"]);
  assert.deepEqual(records[1].files, ["src/auth/session.ts"]);
  assert.equal(records[3].kinds[0], "bash");
});

test("上下文 entry 也可记录，但扩展状态 entry 不进入上下文记录", () => {
  const contextEntries: SessionEntryLike[] = [
    ...entries,
    { type: "custom_message", id: "cm1", parentId: "b1", customType: "note", content: "上下文备注", display: false },
    { type: "branch_summary", id: "bs1", parentId: "cm1", fromId: "cm1", summary: "分支摘要" },
    { type: "compaction", id: "cp1", parentId: "bs1", summary: "旧压缩摘要", firstKeptEntryId: "b1", tokensBefore: 100 },
    { type: "custom", id: "state1", parentId: "cp1", customType: "internal", data: { value: 1 } },
  ];
  const records = recordsFromEntries(contextEntries);
  assert.equal(records.length, 7);
  assert.match(records[4].text, /上下文备注/);
  assert.match(records[5].text, /分支摘要/);
  assert.match(records[6].text, /旧压缩摘要/);
  assert.equal(records.some((record) => record.entryId === "state1"), false);
});

test("active lineage 为空时不会退化为全量历史", () => {
  assert.equal(activeEntryIds({ getBranch: () => [], getEntries: () => entries }).size, 0);
  assert.equal(activeEntryIds({ getBranch: () => [entries[0], entries[1]] }).size, 2);
});

test("搜索按稀有词和文件匹配，并支持分页", () => {
  const records = recordsFromEntries(entries);
  assert.equal(searchRecords(records, "src/auth/session.ts", { maxResults: 2 })[0].entryId, "a1");
  assert.equal(searchRecords(records, "timeout", { maxResults: 2 })[0].entryId, "b1");
  assert.equal(searchRecords(records, "src", { file: "src/auth/session.ts" })[0].entryId, "a1");
});

test("原始 entry 可回放，hash 稳定", () => {
  const record = entryToRecord(entries[0], 0)!;
  assert.match(JSON.stringify(record.raw), /src\/auth\/session\.ts/);
  assert.equal(hashRecords([record]), hashRecords([record]));
  assert.notEqual(hashRecords([record]), hashRecords([entryToRecord({ ...entries[0], id: "other" }, 0)!]));
});

test("ledger 不声称不存在的事实，并明确省略可召回", () => {
  const records = recordsFromEntries(entries);
  const result = renderLedger(records, "threshold", "tail", 800);
  assert.match(result.text, /not LLM-generated claims/);
  assert.match(result.text, /pi_compact_recall/);
  assert.ok(result.omitted < records.length);
  const renderedIds = new Set(records.filter((record) => result.text.includes(`[${record.entryId}]`)).map((record) => record.entryId));
  assert.equal(result.omitted, records.length - renderedIds.size);
  const details = buildDetails(records, "threshold", "tail", result.omitted, result.text.length, 800);
  assert.equal(details.compactor, "pi-compact");
  assert.equal(details.version, 1);
  assert.equal(details.checkpointChars, result.text.length);
  assert.equal(details.summaryMaxChars, 800);
  assert.equal(details.sourceRecordCount, records.length);
  assert.equal(details.omittedRecordCount, result.omitted);
  assert.equal(details.estimatedTokensAfter, Math.ceil(result.text.length / 4));
});

test("ledger 在部分预算下按 entry 去重计算省略数量", () => {
  const records = recordsFromEntries(entries);
  const result = renderLedger(records, "threshold", "tail", 550);
  const renderedIds = new Set(records.filter((record) => result.text.includes(`[${record.entryId}]`)).map((record) => record.entryId));
  assert.ok(renderedIds.size > 0);
  assert.ok(renderedIds.size < records.length);
  assert.equal(result.omitted, records.length - renderedIds.size);
  assert.ok(result.text.length <= 550);
});

test("ledger Timeline 保留原始 entry 顺序且不移除分类区块", () => {
  const records = recordsFromEntries(entries);
  const result = renderLedger(records, "threshold", "tail", 12000);
  assert.match(result.text, /## Timeline/);
  assert.match(result.text, /## User messages/);
  assert.match(result.text, /## Tool calls/);
  assert.match(result.text, /## Tool results/);
  assert.match(result.text, /## Commands/);
  const timelineStart = result.text.indexOf("## Timeline");
  const groupsStart = result.text.indexOf("## User messages");
  assert.ok(timelineStart >= 0 && groupsStart > timelineStart);
  const timeline = result.text.slice(timelineStart, groupsStart);
  assert.match(timeline, /\[u1\][\s\S]*\[a1\][\s\S]*\[t1\][\s\S]*\[b1\]/);
  assert.match(timeline, /\[a1\] kinds=assistant,tool_call/);
  assert.equal((timeline.match(/\[a1\]/g) ?? []).length, 1);
  const toolCalls = result.text.slice(result.text.indexOf("## Tool calls"));
  assert.match(toolCalls, /\[a1\]/);
});

test("messageText 保留工具结果文本", () => {
  assert.match(messageText(entries[2].message!), /refreshToken/);
  assert.deepEqual(messageFiles({ role: "bashExecution", command: "npm test src/auth/session.ts", output: "" }), ["src/auth/session.ts"]);
});

test("压缩边界必须保留完整的工具调用和结果配对", () => {
  const user = entries[0];
  const call = entries[1];
  const result = entries[2];
  const nextAssistant: SessionEntryLike = {
    type: "message",
    id: "a2",
    parentId: "t1",
    message: { role: "assistant", content: "继续处理" },
  };
  const nextCall: SessionEntryLike = {
    type: "message",
    id: "a3",
    parentId: "t1",
    message: { role: "assistant", content: [{ type: "toolCall", id: "call2", name: "read", arguments: {} }] },
  };
  const nextResult: SessionEntryLike = {
    type: "message",
    id: "t2",
    parentId: "a3",
    message: { role: "toolResult", toolCallId: "call2", content: "done" },
  };

  assert.equal(isSafeCut([user, call, result], "a1"), true);
  assert.equal(isSafeCut([user, call, result], "t1"), false);
  assert.equal(isSafeCut([user, call, nextAssistant], "a2"), false);
  assert.equal(isSafeCut([user, call, result, nextCall, nextResult], "a3"), true);
  assert.equal(isSafeCut([user, call, result, nextCall], "a3"), false);

  const abortedCall: SessionEntryLike = {
    type: "message",
    id: "aborted-call",
    parentId: "u1",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-aborted", name: "read", arguments: {} }],
      stopReason: "aborted",
    },
  };
  const afterAbort: SessionEntryLike = {
    type: "message",
    id: "after-abort",
    parentId: "aborted-call",
    message: { role: "user", content: "继续处理" },
  };
  assert.equal(isSafeCut([user, abortedCall, afterAbort], "after-abort"), true);
  assert.equal(isSafeCut([user, abortedCall], "aborted-call"), true);

  const errorCall: SessionEntryLike = {
    type: "message",
    id: "error-call",
    parentId: "u1",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-error", name: "read", arguments: {} }],
      stopReason: "error",
    },
  };
  assert.equal(isSafeCut([user, errorCall], "error-call"), true);

  const customMessage: SessionEntryLike = {
    type: "custom_message",
    id: "custom-1",
    parentId: "u1",
    customType: "note",
    content: "保留的扩展上下文",
  };
  assert.equal(isSafeCut([user, customMessage], "custom-1"), true);
  const branchSummary: SessionEntryLike = {
    type: "branch_summary",
    id: "branch-summary-1",
    parentId: "u1",
    fromId: "u1",
    summary: "切分后的上下文摘要",
  };
  assert.equal(isSafeCut([user, branchSummary], "branch-summary-1"), true);
  assert.equal(isSafeCut([user, { type: "custom", id: "state-1", parentId: "u1" }], "state-1"), false);
});
